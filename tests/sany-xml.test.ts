import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { FINITE_TLC_JAR_SHA256 } from '../src/finite-tlc.js';
import { parseSanyXml, type SanyExpression, type SanyModule } from '../src/sany-xml.js';

const ref = (type: string, id: string): string => `<${type}Ref><UID>${id}</UID></${type}Ref>`;
const entry = (id: string, value: string): string => `<entry><UID>${id}</UID>${value}</entry>`;
const parameter = (id: string, name: string): string => entry(id, `<FormalParamNode><uniquename>${name}</uniquename><arity>0</arity></FormalParamNode>`);
const source = '<location><column><begin>1</begin><end>9</end></column><line><begin>4</begin><end>4</end></line><filename>Example</filename></location><level>1</level>';
const literal = (value: string): string => `<StringNode>${source}<StringValue>${value}</StringValue></StringNode>`;
const application = (operator: string, operands: string, bounds = ''): string => `<OpApplNode>${source}<operator>${operator}</operator><operands>${operands}</operands>${bounds}</OpApplNode>`;
const variable = ref('OpDeclNode', '1');
const formal = ref('FormalParamNode', '2');
const builtin = ref('BuiltInKind', '3');
const variableExpression = application(variable, '');
const parameterExpression = application(formal, '');
const body = application(builtin, variableExpression + parameterExpression);
const definition = (expression: string): string => entry('4', `<UserDefinedOpKind>${source}<uniquename>Next</uniquename><arity>1</arity><body>${expression}</body><params><leibnizparam>${formal}<leibniz/></leibnizparam></params></UserDefinedOpKind>`);
const moduleEntry = entry('5', `<ModuleNode>${source}<uniquename>Example</uniquename>${variable}${ref('UserDefinedOpKind', '4')}</ModuleNode>`);
function document(expression = body): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?><modules><context>${entry('1', '<OpDeclNode>' + source + '<uniquename>x</uniquename><arity>0</arity><kind>3</kind></OpDeclNode>')}${parameter('2', 'v')}${entry('3', `<BuiltInKind><uniquename>=</uniquename><arity>2</arity><params><leibnizparam>${ref('FormalParamNode', '6')}</leibnizparam><leibnizparam>${ref('FormalParamNode', '7')}</leibnizparam></params></BuiltInKind>`)}${definition(expression)}${moduleEntry}${parameter('6', 'Formal_0')}${parameter('7', 'Formal_1')}</context><RootModule>Example</RootModule>${ref('ModuleNode', '5')}</modules>`;
}

function next(model: SanyModule): SanyExpression {
  const result = model.definitions.find(definition => definition.name === 'Next');
  assert.ok(result);
  return result.body;
}

test('semantic adapter retains symbol identity, order, level, and source spans', () => {
  const model = parseSanyXml(document());
  assert.equal(model.root, 'Example');
  assert.deepEqual(model.variables.map(variable => variable.name), ['x']);
  assert.deepEqual(model.definitions[0]?.parameters.map(parameter => parameter.uid), ['2']);
  const expression = next(model);
  assert.equal(expression.kind, 'apply');
  if (expression.kind !== 'apply') return;
  assert.equal(expression.operator.name, '=');
  assert.deepEqual(expression.arguments.map(arg => arg.kind === 'apply' ? arg.operator.uid : ''), ['1', '2']);
  assert.deepEqual(expression.source, { module: 'Example', beginLine: 4, beginColumn: 1, endLine: 4, endColumn: 9 });
  assert.equal(expression.level, 1);
  const repeated = next(parseSanyXml(document(application(builtin, variableExpression + variableExpression))));
  if (repeated.kind !== 'apply') return assert.fail('expected repeated operands');
  assert.deepEqual(repeated.arguments.map(arg => arg.kind === 'apply' ? arg.operator.uid : ''), ['1', '1']);
});

test('strings preserve exact whitespace, Unicode, and standard XML escapes; integers remain exact', () => {
  const value = ' &amp;&lt;&gt;&quot;&apos; 한글 😀\n ';
  const string = next(parseSanyXml(document(literal(value))));
  assert.equal(string.kind, 'literal');
  if (string.kind === 'literal') assert.deepEqual(string.value, { kind: 'string', value: ' &<>"\' 한글 😀\n ' });
  const integer = next(parseSanyXml(document('<NumeralNode><IntValue>900719925474099312345</IntValue></NumeralNode>')));
  if (integer.kind === 'literal') assert.deepEqual(integer.value, { kind: 'integer', value: '900719925474099312345' });
  else assert.fail('integer literal was not preserved');
});

test('quantified and operator formals with the same name remain distinct; tuple and range order survive', () => {
  const bounds = `<boundSymbols><bound>${ref('FormalParamNode', '8')}${ref('FormalParamNode', '9')}<tuple/>${variableExpression}</bound></boundSymbols>`;
  const expression = application(builtin, application(ref('FormalParamNode', '8'), '') + application(ref('FormalParamNode', '9'), ''), bounds);
  const xml = document(expression).replace('</context>', parameter('8', 'v') + parameter('9', 'v') + '</context>');
  const model = parseSanyXml(xml);
  const result = next(model);
  if (result.kind !== 'apply') return assert.fail('expected application');
  assert.deepEqual(model.definitions[0]?.parameters.map(parameter => parameter.uid), ['2']);
  assert.deepEqual(result.bounded[0]?.parameters.map(parameter => [parameter.uid, parameter.name]), [['8', 'v'], ['9', 'v']]);
  assert.equal(result.bounded[0]?.tuple, true);
  assert.deepEqual(result.arguments.map(arg => arg.kind === 'apply' ? arg.operator.uid : ''), ['8', '9']);
  const range = result.bounded[0]?.range;
  assert.equal(range?.kind, 'apply');
  if (range?.kind === 'apply') assert.equal(range.operator.uid, '1');
});

test('unsupported semantic nodes survive as explicit unsupported expressions', () => {
  const model = parseSanyXml(document(`<FutureNode>${source}<future>${variable}</future></FutureNode>`));
  const expression = next(model);
  assert.equal(expression.kind, 'unsupported');
  if (expression.kind === 'unsupported') {
    assert.equal(expression.nodeType, 'FutureNode');
    assert.equal(expression.raw.children.at(-1)?.name, 'future');
    assert.equal(expression.source?.module, 'Example');
  }
});

test('malformed symbol tables, references, arities, binders, and known expression fields fail closed', () => {
  const valid = document();
  for (const xml of [
    valid.slice(0, -1),
    valid.replace('</context>', parameter('2', 'duplicate') + '</context>'),
    valid.replace('<UID>1</UID></OpDeclNodeRef>', '<UID>999</UID></OpDeclNodeRef>'),
    valid.replace('<OpDeclNodeRef><UID>1</UID></OpDeclNodeRef>', '<FormalParamNodeRef><UID>1</UID></FormalParamNodeRef>'),
    valid.replace('<uniquename>x</uniquename>', ''),
    valid.replace('<kind>3</kind>', '<kind>3</kind><kind>3</kind>'),
    valid.replace('</context>', entry('8', '<OpDeclNode><uniquename>x</uniquename><arity>0</arity><kind>3</kind></OpDeclNode>') + '</context>')
      .replace(moduleEntry, moduleEntry.replace(variable, variable + ref('OpDeclNode', '8'))),
    valid.replace('<arity>2</arity>', '<arity>1</arity>'),
    valid.replace('<operator>', '<operator><extra/>'),
    document('<StringNode><StringValue/><StringValue/></StringNode>'),
    document('<NumeralNode><IntValue>01</IntValue></NumeralNode>'),
    document(application(builtin, variableExpression + parameterExpression, `<boundSymbols><bound>${formal}</bound></boundSymbols>`)),
    document(application(builtin, variableExpression + parameterExpression, `<boundSymbols><bound>${formal}${formal}${variableExpression}</bound></boundSymbols>`)),
    valid.replace('<RootModule>Example</RootModule>', '<RootModule>Missing</RootModule>'),
  ]) assert.throws(() => parseSanyXml(xml), /TLC203/);
});

test('XML features that could resolve external data or hide semantic content are rejected', () => {
  const valid = document();
  for (const xml of [
    valid.replace('<modules>', '<!DOCTYPE modules [<!ENTITY x SYSTEM "file:///etc/passwd">]><modules>'),
    valid.replace('<modules>', '<!DOCTYPE modules SYSTEM "https://example.invalid/schema"><modules>'),
    valid.replace('<modules>', '<?instruction ignored?><modules>'),
    valid.replace('<modules>', '<modules xmlns="https://example.invalid/">'),
    valid.replace('<modules>', '<modules><!-- hidden -->'),
    document('<StringNode><StringValue>&custom;</StringValue></StringNode>'),
    document('<StringNode><StringValue><![CDATA[hidden]]></StringValue></StringNode>'),
    '<modules>' + '<nested>'.repeat(257) + '</nested>'.repeat(257) + '</modules>',
    ' '.repeat(16 * 1024 * 1024 + 1),
  ]) assert.throws(() => parseSanyXml(xml), /TLC203/);
});

const execute = promisify(execFile);
const jar = process.env.TLA2TOOLS_JAR === undefined ? undefined : resolve(process.env.TLA2TOOLS_JAR);
async function exportModel(name: string, model: string): Promise<SanyModule> {
  assert.ok(jar);
  assert.equal(createHash('sha256').update(await readFile(jar)).digest('hex'), FINITE_TLC_JAR_SHA256);
  const directory = await mkdtemp(join(tmpdir(), 'sgd-sany-xml-test-'));
  try {
    await mkdir(join(directory, 'home'));
    await mkdir(join(directory, 'java-tmp'));
    await writeFile(join(directory, `${name}.tla`), model);
    const { stdout, stderr } = await execute('java', ['-Xmx128m', `-Duser.home=${join(directory, 'home')}`, `-Djava.io.tmpdir=${join(directory, 'java-tmp')}`, '-cp', jar,
      'tla2sany.xml.XMLExporter', '-o', `${name}.tla`], { cwd: directory, timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, ...(process.env.JAVA_HOME === undefined ? {} : { JAVA_HOME: process.env.JAVA_HOME }) } });
    assert.doesNotMatch(stderr, /(?:Error|Warning|Abort)/);
    return parseSanyXml(stdout);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const manifest = String.raw`---- MODULE ManifestWrite ----
EXTENDS Integers
CONSTANTS Values
VARIABLES phase, stored, rejected
vars == <<phase, stored, rejected>>
Init == /\ phase = "absent" /\ stored = "none" /\ rejected = "none"
Insert(v) == /\ phase = "absent" /\ v \in Values /\ phase' = "present" /\ stored' = v /\ rejected' = "none"
Same(v) == /\ phase \in {"present", "conflict"} /\ v = stored /\ UNCHANGED vars
Clash(v) == /\ phase \in {"present", "conflict"} /\ v \in Values /\ v # stored /\ phase' = "conflict" /\ rejected' = v /\ UNCHANGED stored
Next ==
  \E v \in Values:
    \/ Insert(v)
    \/ Same(v)
    \/ Clash(v)
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"absent", "present", "conflict"}
          /\ (phase = "absent") <=> (stored = "none")
          /\ phase = "conflict" => (rejected \in Values /\ rejected # stored)
          /\ phase = "present" => rejected = "none"
          /\ phase = "absent" => rejected = "none"
          /\ stored = "none" \/ stored \in Values
ConflictKeepsStored == phase = "conflict" => stored \in Values
StoredStable == [][stored # "none" => stored' = stored]_vars
====
`;

test('pinned exporter retains actual Manifest action parameters, outer domain guard, and every state variable', { skip: !jar }, async () => {
  const model = await exportModel('ManifestWrite', manifest);
  assert.deepEqual(model.variables.map(variable => variable.name).sort(), ['phase', 'rejected', 'stored']);
  assert.deepEqual(model.constants.map(constant => constant.name), ['Values']);
  for (const action of ['Insert', 'Same', 'Clash']) {
    const definition = model.definitions.find(definition => definition.name === action);
    assert.equal(definition?.parameters.length, 1);
    assert.equal(definition?.level, 2);
  }
  const expression = next(model);
  if (expression.kind !== 'apply') return assert.fail('expected bounded application');
  assert.equal(expression.bounded.length, 1);
  assert.equal(expression.bounded[0]?.parameters[0]?.name, 'v');
  const range = expression.bounded[0]?.range;
  if (range?.kind !== 'apply') return assert.fail('expected domain range');
  assert.equal(range.operator.name, 'Values');
  const alternatives = expression.arguments[0];
  if (alternatives?.kind !== 'apply') return assert.fail('expected action alternatives');
  assert.deepEqual(alternatives.arguments.map(action => action.kind === 'apply' ? action.operator.name : ''), ['Insert', 'Same', 'Clash']);
  for (const action of alternatives.arguments) {
    if (action.kind !== 'apply') return assert.fail('expected action call');
    const input = action.arguments[0];
    if (input?.kind !== 'apply') return assert.fail('expected input reference');
    assert.equal(input.operator.uid, expression.bounded[0]?.parameters[0]?.uid);
  }
});

test('pinned exporter retains finite Approval Boolean operators without inventing types from levels', { skip: !jar }, async () => {
  const model = await exportModel('Approval', await readFile(resolve('examples/approval/Approval.tla'), 'utf8'));
  assert.deepEqual(model.variables.map(variable => variable.name).sort(), ['approved', 'phase']);
  assert.deepEqual(model.definitions.filter(definition => definition.level === 2).map(definition => definition.name).sort(), ['Approve', 'Next', 'Submit', 'Wait']);
  const operatorNames = [...model.symbols.values()].filter(symbol => symbol.kind === 'builtin').map(symbol => symbol.name);
  assert.ok(operatorNames.includes('TRUE'));
  assert.ok(operatorNames.includes('FALSE'));
});

test('pinned exporter keeps renamed and shadowed binders, tuples, unbounded quantifiers, and unsupported LET', { skip: !jar }, async () => {
  const model = await exportModel('Binders', String.raw`---- MODULE Binders ----
CONSTANTS Values
VARIABLES x
Act(v) == v = v
Next == \E v \in Values: Act(v)
Renamed == \E other \in Values: Act(other)
Pair == \E <<a,b>> \in Values: a = b
Unbound == \E z: z = x
Local == LET F(v) == v IN F(x)
====
`);
  const action = model.definitions.find(definition => definition.name === 'Act');
  const expression = next(model);
  if (expression.kind !== 'apply') return assert.fail('expected Next');
  assert.notEqual(expression.bounded[0]?.parameters[0]?.uid, action?.parameters[0]?.uid);
  assert.notEqual(expression.bounded[0]?.parameters[0]?.uid, model.variables[0]?.uid);
  const renamed = model.definitions.find(definition => definition.name === 'Renamed')?.body;
  if (renamed?.kind !== 'apply') return assert.fail('expected renamed quantifier');
  assert.equal(renamed.bounded[0]?.parameters[0]?.name, 'other');
  const pair = model.definitions.find(definition => definition.name === 'Pair')?.body;
  if (pair?.kind !== 'apply') return assert.fail('expected pair quantifier');
  assert.equal(pair.bounded[0]?.tuple, true);
  assert.deepEqual(pair.bounded[0]?.parameters.map(parameter => parameter.name), ['a', 'b']);
  const unbound = model.definitions.find(definition => definition.name === 'Unbound')?.body;
  if (unbound?.kind !== 'apply') return assert.fail('expected unbounded quantifier');
  assert.deepEqual(unbound.unbounded.map(parameter => parameter.name), ['z']);
  const local = model.definitions.find(definition => definition.name === 'Local')?.body;
  assert.equal(local?.kind, 'unsupported');
  if (local?.kind === 'unsupported') assert.equal(local.nodeType, 'LetInNode');
});
