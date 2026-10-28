import { inspectSymbolicOrbits } from '../symbolic-semantics.js';
import { symbolicInputDefinitions, symbolicInputs, validateSymbolicModel, type SymbolicBackendInput, type SymbolicExpression, type SymbolicGuard } from '../symbolic-types.js';
import type { FiniteValue } from '../finite-types.js';
import type { GeneratedFile } from '../types.js';

const literal = (value: string): string => JSON.stringify(value);
function nativeFiniteValue(value: FiniteValue): string {
  switch (value.kind) {
    case 'string': return literal(value.value);
    case 'boolean': return String(value.value);
    case 'integer': return `${value.value}n`;
  }
}
function expression(value: SymbolicExpression, inputs: ReadonlyMap<string, string>, singleInput: string | undefined): string {
  switch (value.kind) {
    case 'literal': return `Object.freeze(${JSON.stringify(value.value)})`;
    case 'state': return `state[${literal(value.variable)}]`;
    case 'input': {
      const name = 'parameter' in value ? inputs.get(value.parameter) : singleInput;
      if (name === undefined) throw new Error('TLC301: unknown symbolic input parameter');
      return name;
    }
    case 'next-state': throw new Error('TLC301: primed expressions cannot execute in guards or assignment values');
  }
}
function predicate(guard: SymbolicGuard, inputs: ReadonlyMap<string, string>, singleInput: string | undefined): string {
  const render = (value: SymbolicExpression): string => expression(value, inputs, singleInput);
  const nested = (value: SymbolicGuard): string => predicate(value, inputs, singleInput);
  switch (guard.kind) {
    case 'boolean': return String(guard.value);
    case 'equal': return `same(${render(guard.left)}, ${render(guard.right)})`;
    case 'not-equal': return `!same(${render(guard.left)}, ${render(guard.right)})`;
    case 'member': return `(${guard.elements.map(value => `same(${render(guard.value)}, Object.freeze(${JSON.stringify(value)}))`).join(' || ') || 'false'})`;
    case 'in-domain': return `belongs(${render(guard.value)}, ${literal(guard.domain)})`;
    case 'and': return `(${guard.terms.map(nested).join(' && ') || 'true'})`;
    case 'or': return `(${guard.terms.map(nested).join(' || ') || 'false'})`;
    case 'not': return `!(${nested(guard.term)})`;
    case 'implies': return `(!(${nested(guard.left)}) || (${nested(guard.right)}))`;
    case 'equivalent': return `((${nested(guard.left)}) === (${nested(guard.right)}))`;
  }
}

export function generateSymbolicTypeScript(input: SymbolicBackendInput): GeneratedFile[] {
  const model = validateSymbolicModel(input.model);
  inspectSymbolicOrbits(model);
  const parameters = symbolicInputs(model);
  const definitions = symbolicInputDefinitions(model);
  const inputNames = new Map(parameters.map((parameter, index) => [parameter.parameter, model.version === 1 ? 'inputValue' : `inputValue${index}`]));
  const singleInput = model.version === 1 ? 'inputValue' : undefined;
  const render = (value: SymbolicExpression): string => expression(value, inputNames, singleInput);
  const argumentNames = parameters.map((_parameter, index) => model.version === 1 ? 'input' : `input_${index}`);
  const signature = argumentNames.map((name, index) => {
    const definition = definitions[index];
    if (definition === undefined) throw new Error('TLC301: incomplete symbolic input definitions');
    return `${name}: ${definition.kind === 'opaque' ? 'string' : definition.values.map(nativeFiniteValue).join(' | ')}`;
  }).join(', ');
  const domainType = definitions.filter(definition => definition.kind === 'opaque').map(parameter => literal(parameter.domain)).join(' | ');
  const inputExpression = model.version === 1 ? "{ readonly kind: 'input' }" : `{ readonly kind: 'input'; readonly parameter: ${parameters.map(parameter => literal(parameter.parameter)).join(' | ')} }`;
  const inputValidation = argumentNames.map((name, index) => {
    const definition = definitions[index];
    if (definition === undefined) throw new Error('TLC301: incomplete symbolic input definitions');
    if (definition.kind === 'finite') {
      const kind = definition.values[0]?.kind;
      if (kind === undefined) throw new Error('TLC301: empty finite input domain');
      return `    if (typeof ${name} !== '${kind === 'integer' ? 'bigint' : kind}' || !(${definition.values.map(value => `${name} === ${nativeFiniteValue(value)}`).join(' || ')})) return reject('invalid-input');`;
    }
    return `    if (typeof ${name} !== 'string') return reject('invalid-input');
    for (const character of ${name}) {
      const code = character.codePointAt(0);
      if (code !== undefined && code >= 0xd800 && code <= 0xdfff) return reject('invalid-input');
    }`;
  }).join('\n');
  const inputValues = definitions.map((parameter, index) => {
    const name = inputNames.get(parameter.parameter);
    const argument = argumentNames[index];
    let fields: string;
    if (parameter.kind === 'opaque') fields = `kind: 'data', domain: ${literal(parameter.domain)}, value: ${argument}`;
    else {
      const first = parameter.values[0];
      if (first === undefined) throw new Error('TLC301: empty finite input domain');
      fields = `kind: '${first.kind}', value: ${argument}${first.kind === 'integer' ? '.toString()' : ''}`;
    }
    return `    const ${name}: ${input.className}Value = Object.freeze({ ${fields} });`;
  }).join('\n');
  const name = input.className;
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) throw new Error('TLC301: className must be an uppercase identifier');
  const variables = [...model.variables].sort();
  const values = (entries: (variable: string) => string): string => variables.map(variable => `      [${literal(variable)}]: ${entries(variable)},`).join('\n');
  const initial = values(variable => {
    const value = model.initial[variable];
    if (!value) throw new Error('TLC301: incomplete symbolic Init');
    return `Object.freeze(${JSON.stringify(value)})`;
  });
  const choices = model.branches.map((branch, index) => `    if (${predicate(branch.guard, inputNames, singleInput)}) {
      if (selected !== -1) return reject('ambiguous');
      selected = ${index};
    }`).join('\n');
  const actions = model.branches.map((branch, index) => `      case ${index}: {
        const next: ${name}Values = Object.freeze({
${values(variable => { const value = branch.updates[variable]; if (!value) throw new Error('TLC301: incomplete update'); return render(value); })}
        });
        const updates: { readonly [variable: string]: ${name}Expression } = Object.freeze({
${values(variable => { const value = branch.updates[variable]; if (!value) throw new Error('TLC301: incomplete update'); return value.kind === 'literal' ? `Object.freeze({ kind: 'literal', value: Object.freeze(${JSON.stringify(value.value)}) })` : `Object.freeze(${JSON.stringify(value)})`; })}
        });
        const before = snapshot(state, revision);
        const preparedRevision = revision;
        const nextRevision = revision + 1n;
        const after = snapshot(next, nextRevision);
        const receipt: ${name}Receipt = Object.freeze({ action: ${literal(branch.action)}, before, after, updates });
        const result: ${name}Result = Object.freeze({ ok: true, ...receipt });
        let consumed = false;
        const commit = Object.freeze((): ${name}Result => {
          if (consumed) return reject('consumed-preparation');
          consumed = true;
          if (revision !== preparedRevision) return reject('stale-preparation');
          state = next;
          revision = nextRevision;
          return result;
        });
        return Object.freeze({ ok: true, receipt, commit });
      }`).join('\n');
  const source = `// Generated from the validated TLA+ equality/copy relation. Regenerate; do not edit policy.
export type ${name}Value =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'integer'; readonly value: string }
  | { readonly kind: 'data'; readonly domain: ${domainType}; readonly value: string };
export type ${name}Expression =
  | { readonly kind: 'literal'; readonly value: ${name}Value }
  | { readonly kind: 'state' | 'next-state'; readonly variable: string }
  | ${inputExpression};
export interface ${name}Values {
${variables.map(variable => `  readonly [${literal(variable)}]: ${name}Value;`).join('\n')}
}
export interface ${name}Snapshot {
  readonly model: ${literal(model.name)};
  readonly modelRevision: ${literal(model.source.semanticSha256)};
  readonly revision: string;
  readonly values: ${name}Values;
}
export interface ${name}Receipt {
  readonly action: string;
  readonly before: ${name}Snapshot;
  readonly after: ${name}Snapshot;
  readonly updates: { readonly [variable: string]: ${name}Expression };
}
export interface ${name}Rejection {
  readonly ok: false;
  readonly reason: 'invalid-input' | 'disabled' | 'ambiguous' | 'revision-exhausted' | 'stale-preparation' | 'consumed-preparation';
  readonly state: ${name}Snapshot;
}
export type ${name}Result = (${name}Receipt & { readonly ok: true }) | ${name}Rejection;
export type ${name}Preparation =
  | { readonly ok: true; readonly receipt: ${name}Receipt; readonly commit: () => ${name}Result }
  | ${name}Rejection;
export interface ${name} {
  readonly read: () => ${name}Snapshot;
  readonly prepare: (${signature}) => ${name}Preparation;
  readonly send: (${signature}) => ${name}Result;
}
const members = new globalThis.WeakSet<object>();
const maxRevision = 18446744073709551615n;
function same(a: ${name}Value, b: ${name}Value): boolean {
  return a.kind === b.kind && a.value === b.value && (a.kind !== 'data' || (b.kind === 'data' && a.domain === b.domain));
}
function belongs(value: ${name}Value, domain: string): boolean { return value.kind === 'data' && value.domain === domain; }
function snapshot(state: ${name}Values, revision: bigint): ${name}Snapshot {
  return Object.freeze({ model: ${literal(model.name)}, modelRevision: ${literal(model.source.semanticSha256)}, revision: revision.toString(), values: Object.freeze({
${values(variable => `Object.freeze({ ...state[${literal(variable)}] })`)}
  }) });
}
export function is${name}(value: unknown): value is ${name} { return typeof value === 'object' && value !== null && members.has(value); }
${model.version === 3 ? '/** Each new owner starts at Init. Inputs are opaque string identities and exact finite scalar choices. */' : '/** Each new owner starts at Init. Payloads are immutable string identities, not external objects. */'}
export function create${name}(): ${name} {
  let state: ${name}Values = Object.freeze({
${initial}
  });
  let revision = 0n;
  const read = Object.freeze((): ${name}Snapshot => snapshot(state, revision));
  const reject = (reason: ${name}Rejection['reason']): ${name}Rejection => Object.freeze({ ok: false, reason, state: read() });
  const prepare = Object.freeze(${model.version === 1 ? `(${signature}): ${name}Preparation => {` : `function (${signature}): ${name}Preparation {\n    if (arguments.length !== ${parameters.length}) return reject('invalid-input');`}
${inputValidation}
${inputValues}
    let selected = -1;
${choices}
    if (selected === -1) return reject('disabled');
    if (revision === maxRevision) return reject('revision-exhausted');
    switch (selected) {
${actions}
      default: throw new Error('Corrupt generated symbolic branch');
    }
  });
  const send = Object.freeze(${model.version === 1 ? `(${signature}): ${name}Result => {` : `function (${signature}): ${name}Result {\n    if (arguments.length !== ${parameters.length}) return reject('invalid-input');`}
    const prepared = prepare(${argumentNames.join(', ')});
    return prepared.ok ? prepared.commit() : prepared;
  });
  const facade: ${name} = Object.freeze({ read, prepare, send });
  members.add(facade);
  return facade;
}
`;
  return [
    { path: 'machine.ts', content: source },
    { path: 'package.json', content: JSON.stringify({ name: 'sgd-generated-symbolic-owner', private: true, type: 'module', scripts: { build: 'node node_modules/typescript/bin/tsc -p tsconfig.json' }, devDependencies: { typescript: '7.0.2' } }, null, 2) + '\n' },
    { path: 'tsconfig.json', content: JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, declaration: true, noEmitOnError: true, outDir: 'dist', types: [] }, include: ['machine.ts'] }, null, 2) + '\n' },
    { path: 'README.md', content: model.version === 3 ? `# Generated mixed-input TypeScript authority\n\nRun \`npm install\` and \`npm run build\`. Import \`create${name}\` and \`is${name}\` from \`./dist/machine.js\`. Call \`send(${argumentNames.join(', ')})\` or \`prepare(${argumentNames.join(', ')})\` in model input order:\n\n${definitions.map((parameter, index) => `- \`${argumentNames[index]}\` maps to \`${parameter.parameter}\` in \`${parameter.domain}\`: ${parameter.kind === 'opaque' ? 'an immutable Unicode string identity in its distinct opaque namespace' : `the exact scalar union \`${parameter.values.map(nativeFiniteValue).join(' | ')}\``}.`).join('\n')}\n\nFinite strings and Booleans use their primitive values; integers use exact bigint literals. The fixed-arity methods reject missing, surplus, non-primitive, out-of-vocabulary, and malformed opaque Unicode input before guard selection or revision changes. A finite scalar string and an opaque identity with the same spelling remain distinct tagged values. Guards select the model action; inputs never select an action directly. Snapshots and receipts retain every variable and named input assignment origin. Integer snapshots use decimal strings.\n\nPreparation returns a frozen rejection or a frozen \`{ ok: true, receipt, commit }\` without changing state or revision. The frozen \`commit()\` closure belongs to its original owner, succeeds once, and rejects consumed or stale preparations without changing current state. Dropping a preparation has no effect. Guards and updates read the complete old state simultaneously. The owner has no restore, arbitrary-state constructor, or mutable state reference. Frozen snapshots cannot mutate its private state.\n\nThis abstract owner covers one live object in a trusted JavaScript realm with unchanged generated source and platform primitives. Equality/copy orbit validation covers the supported mixed-input grammar. Controlled SANY/TLC and original-action oracle checks must complete separately to establish source provenance and the configured finite check. A finite event does not attest any real file operation. This does not establish file or resource authority, persistence, external-effect atomicity, application-wide source coverage, or arbitrary TLA+ semantics.\n` : `# Generated symbolic TypeScript authority\n\nRun \`npm install\` and \`npm run build\`. Import \`create${name}\` and \`is${name}\` from \`./dist/machine.js\`. ${model.version === 1 ? 'Submit an immutable Unicode string identity with `send(input)`; generated guards select the model action.' : `Submit immutable Unicode string identities with \`send(${argumentNames.join(', ')})\`, in model input order (${parameters.map(parameter => `${parameter.parameter}: ${parameter.domain}`).join(', ')}); generated guards select the model action.`} A string such as \`Same\` is data, not a caller-selected action. ${model.version === 2 ? 'The fixed-arity method rejects missing, surplus, non-string, and malformed Unicode input without changing state. Each parameter has a distinct tagged domain, even when texts match. ' : ''}\`read()\` returns frozen copied tagged values. Data atoms and scalar model strings remain distinct, including the spelling \`none\`. Receipts include simultaneous assignment origins in \`updates\`${model.version === 2 ? ', with the source parameter on each input assignment' : ''}.\n\nUse \`prepare(${argumentNames.join(', ')})\` when an adapter must validate and copy application values before committing. Preparation returns a frozen rejection or a frozen \`{ ok: true, receipt, commit }\` without changing state or revision. Inspect the complete frozen proposed receipt, then call its frozen \`commit()\` closure. A successful commit returns the same flat success shape as \`send\`. Each preparation belongs to its original owner and can commit once. A reused preparation rejects with \`consumed-preparation\`; one whose owner advanced rejects with \`stale-preparation\`. Both leave the current state unchanged. Dropping a preparation has no effect. \`send\` uses the same private prepare/commit path. No caller callback runs during preparation or commit.\n\nThe accepted compiler implements equality/copy over string identities. TLC checks the separate configured finite model-value instance. The orbit checker explores equality patterns under the supported grammar. No claim extends this to arbitrary TLA+ operators, application objects, custom equality, persistence, restart, or external effects. An actual payload adapter must preserve application equality (including metadata exclusions) and connect the protected state to the real application. This authority covers one live object in a trusted JavaScript realm with unchanged generated source and platform primitives.\n` },
  ];
}
