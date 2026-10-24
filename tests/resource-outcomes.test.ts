import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { ResourceProtocolBindingSchema, ResourceProtocolBindingV2Schema, VersionedResourceProtocolBindingSchema, validateObservedResourceProtocol, validateResourceProtocol, type ResourceProtocolBindingV2 } from '../src/resource-protocol.js';
import { lowerSymbolicModel } from '../src/symbolic-lower.js';
import { inspectSymbolicOrbits, stepSymbolic } from '../src/symbolic-semantics.js';
import { parseSanyXml } from '../src/sany-xml.js';
import { runSymbolicTlc } from '../src/symbolic-tlc.js';
import { verifySymbolicWitness } from '../src/symbolic-witness.js';
import { symbolicModel, type SymbolicModelV3 } from '../src/symbolic-types.js';
import { generateVisualization } from '../src/visualize.js';

const jar = process.env.TLA2TOOLS_JAR;
const execute = promisify(execFile);
const binding: ResourceProtocolBindingV2 = {
  version: 2, inputs: { resource: 'r', event: 'event' },
  variables: { phase: 'phase', selected: 'selected', loaded: 'loaded', prepared: 'prepared', attempted: 'attempted', loadOutcome: 'loadOutcome', decision: 'decision', coverage: 'coverage', attempts: 'attempts', replacements: 'replacements', effect: 'effect', writeOutcome: 'writeOutcome' },
};
async function compile(configName: 'Fixture.cfg' | 'ResourceOutcomes.cfg', change?: (source: string) => string, configChange?: (source: string) => string): Promise<SymbolicModelV3> {
  assert.ok(jar, 'real pinned TLC JAR is required');
  const directory = await mkdtemp(join(tmpdir(), 'sgd-write-outcomes-'));
  try {
    await cp(resolve('tests/fixtures/resource-outcomes'), directory, { recursive: true });
    const spec = join(directory, 'ResourceOutcomes.tla'); const config = join(directory, configName);
    if (change) await writeFile(spec, change(await readFile(spec, 'utf8')));
    if (configChange) await writeFile(config, configChange(await readFile(config, 'utf8')));
    const run = await runSymbolicTlc({ spec, config, jar: resolve(jar) });
    const model = lowerSymbolicModel({ name: 'ResourceOutcomes', semantic: parseSanyXml(run.xml), config: run.config, profile: 'protocol' });
    assert.equal(model.version, 3);
    if (!change && !configChange) {
      const witness = await verifySymbolicWitness({ model, run, spec, config, jar: resolve(jar) });
      assert.ok(witness.evidence.acceptedCases > 0 && witness.evidence.disabledCases > 0);
    }
    return model;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
let corePromise: Promise<SymbolicModelV3> | undefined;
let coveredPromise: Promise<SymbolicModelV3> | undefined;
const core = () => corePromise ??= compile('Fixture.cfg');
const covered = () => coveredPromise ??= compile('ResourceOutcomes.cfg');
function changed(original: SymbolicModelV3, change: (model: SymbolicModelV3) => void): SymbolicModelV3 {
  const model = structuredClone(original); change(model);
  const { source: _source, ...program } = model;
  const result = symbolicModel(program); assert.equal(result.version, 3); return result;
}
function action(model: SymbolicModelV3, name: string) {
  const found = model.branches.find(branch => branch.action === name); assert.ok(found, name); return found;
}

test('resource v2 requires its twelfth role and retains strict versioned syntax', () => {
  assert.deepEqual(ResourceProtocolBindingV2Schema.parse(binding), binding);
  assert.equal(ResourceProtocolBindingSchema.shape.version.value, 1);
  assert.equal(ResourceProtocolBindingSchema.safeParse(binding).success, false);
  const { writeOutcome: _outcome, ...variables } = binding.variables;
  assert.equal(VersionedResourceProtocolBindingSchema.safeParse({ ...binding, variables }).success, false);
  assert.equal(VersionedResourceProtocolBindingSchema.safeParse({ ...binding, version: 1 }).success, false);
  assert.equal(VersionedResourceProtocolBindingSchema.safeParse({ ...binding, version: 1, variables }).success, true);
  assert.equal(VersionedResourceProtocolBindingSchema.safeParse({ ...binding, trustedWriter: 'writer' }).success, false);
});

test('the original schema object and inferred validator result remain v1 in TypeScript 7', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sgd-resource-api-'));
  const source = `import {ResourceProtocolBindingSchema, validateResourceProtocol, validateObservedResourceProtocol} from ${JSON.stringify(resolve('src/resource-protocol.js'))};
const schemaVersion: 1 = ResourceProtocolBindingSchema.shape.version.value;
const selected = ResourceProtocolBindingSchema.pick({version:true});
declare const oldResult: ReturnType<typeof validateResourceProtocol>;
declare const observedResult: ReturnType<typeof validateObservedResourceProtocol>;
const oldVersion: 1 = oldResult.binding.version;
const observedVersion: 2 = observedResult.binding.version;
void [schemaVersion, selected, oldVersion, observedVersion];
`;
  try {
    const path = join(directory, 'api.mts'); await writeFile(path, source);
    await execute(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--types', 'node', path], { timeout: 30_000 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('real source and original-action oracle retain all four Write results and both coverage relations', { skip: !jar }, async () => {
  const model = await core();
  const result = validateObservedResourceProtocol({ model, binding, coverage: 'independent' });
  assert.equal(result.storageAuthority, false); assert.equal(result.profile, 'observed-write-v2');
  const observed = result.proof.states.filter(state => state.effect?.value === 'Write');
  for (const [phase, outcome, replacements] of [['Attempted', 'Pending', '0'], ['Done', 'Replaced', '1'], ['Failed', 'NotReplaced', '0'], ['Failed', 'Indeterminate', '0'], ['Failed', 'Replaced', '1']]) {
    assert.ok(observed.some(state => state.phase?.value === phase && state.writeOutcome?.value === outcome && state.replacements?.value === replacements), `${phase}/${outcome}/${replacements}`);
  }
  const production = validateObservedResourceProtocol({ model: await covered(), binding, coverage: 'required-before-write' });
  assert.ok(production.proof.states.every(state => state.effect?.value !== 'Write' || state.coverage?.value === true));
  assert.throws(() => validateObservedResourceProtocol({ model, binding, coverage: 'required-before-write' }), /TLC305: missing configured coverage/);
  const { writeOutcome: _outcome, ...variables } = binding.variables;
  assert.throws(() => validateObservedResourceProtocol({ model, binding: { ...binding, version: 1, variables }, coverage: 'independent' }), /TLC305: invalid resource role binding/);
  assert.throws(() => validateResourceProtocol({ model, binding, coverage: 'independent' }), /TLC305: invalid resource role binding/);
  const html = generateVisualization([model]).find(file => file.path === 'index.html')?.content ?? '';
  assert.match(html, /writeOutcome/); assert.match(html, /Indeterminate/);
});

test('terminal replacement observations preserve selected identity, disable reuse and freeze all twelve roles', { skip: !jar }, async () => {
  const model = await covered();
  for (const [event, phase, outcome, replacements] of [['finishok', 'Done', 'Replaced', '1'], ['finishnotreplaced', 'Failed', 'NotReplaced', '0'], ['finishindeterminate', 'Failed', 'Indeterminate', '0'], ['finishposterror', 'Failed', 'Replaced', '1']]) {
    let state = model.initial;
    for (const event of ['select', 'present', 'preparewrite', 'coversuccess', 'attemptwrite']) {
      const step = stepSymbolic(model, state, { r: 'actual-selected-resource', event: { kind: 'string', value: event } });
      assert.equal(step.kind, 'accepted'); if (step.kind === 'accepted') state = step.state;
    }
    assert.equal(state.writeOutcome?.value, 'Pending');
    assert.equal(stepSymbolic(model, state, { r: 'other-resource', event: { kind: 'string', value: event } }).kind, 'disabled');
    const finish = stepSymbolic(model, state, { r: 'actual-selected-resource', event: { kind: 'string', value: event } });
    assert.equal(finish.kind, 'accepted'); if (finish.kind !== 'accepted') continue;
    assert.equal(finish.state.phase?.value, phase); assert.equal(finish.state.writeOutcome?.value, outcome); assert.equal(finish.state.replacements?.value, replacements);
    assert.equal(finish.state.attempted?.value, 'actual-selected-resource');
    assert.equal(stepSymbolic(model, finish.state, { r: 'actual-selected-resource', event: { kind: 'string', value: 'attemptwrite' } }).kind, 'disabled');
    const idle = stepSymbolic(model, finish.state, { r: 'other-resource', event: { kind: 'string', value: 'idle' } });
    assert.equal(idle.kind, 'accepted'); if (idle.kind === 'accepted') assert.deepEqual(idle.state, finish.state);
  }
});

test('safe behavior cannot replace required v2 source laws with TRUE', { skip: !jar }, async () => {
  for (const [name, next] of [['WriteOnly', 'WriteObservation'], ['WriteObservation', 'TerminalStep'], ['TerminalStep', 'Terminal']]) {
    const model = await compile('ResourceOutcomes.cfg', source => {
      const start = source.indexOf(`${name} ==`); const end = source.indexOf(`\n${next} ==`, start);
      assert.ok(start >= 0 && end > start); return source.slice(0, start) + `${name} == TRUE` + source.slice(end);
    });
    inspectSymbolicOrbits(model);
    assert.throws(() => validateObservedResourceProtocol({ model, binding, coverage: 'required-before-write' }), /TLC305: missing configured/);
  }
});

test('v2 complete relation refuses lost confirmation, false certainty and omitted difficult branches', { skip: !jar }, async () => {
  const model = await core();
  const mutations: [string, (model: SymbolicModelV3) => void][] = [
    ['lost confirmed count', model => { action(model, 'WritePostError').updates.replacements = { kind: 'literal', value: { kind: 'integer', value: '0' } }; }],
    ['uncertain error called unchanged', model => { action(model, 'WriteIndeterminate').updates.writeOutcome = { kind: 'literal', value: { kind: 'string', value: 'NotReplaced' } }; }],
    ['success called uncertain', model => { action(model, 'FinishWrite').updates.writeOutcome = { kind: 'literal', value: { kind: 'string', value: 'Indeterminate' } }; }],
    ['Noop has Write observation', model => { action(model, 'AttemptNoop').updates.writeOutcome = { kind: 'literal', value: { kind: 'string', value: 'Pending' } }; }],
    ['wrong failed resource', model => { const branch = action(model, 'WritePostError'); branch.updates.attempted = { kind: 'literal', value: { kind: 'string', value: 'other' } }; }],
    ['terminal observation reset', model => { action(model, 'Idle').updates.writeOutcome = { kind: 'literal', value: { kind: 'string', value: 'none' } }; }],
    ['post-error path only for present baseline', model => { const branch = action(model, 'WritePostError'); branch.guard = { kind: 'and', terms: [branch.guard, { kind: 'equal', left: { kind: 'state', variable: 'loadOutcome' }, right: { kind: 'literal', value: { kind: 'string', value: 'Present' } } }] }; }],
    ['uncertainty omitted after coverage', model => { const branch = action(model, 'WriteIndeterminate'); branch.guard = { kind: 'and', terms: [branch.guard, { kind: 'equal', left: { kind: 'state', variable: 'coverage' }, right: { kind: 'literal', value: { kind: 'boolean', value: false } } }] }; }],
    ...['FinishWrite', 'WriteNotReplaced', 'WriteIndeterminate', 'WritePostError'].map((name): [string, (model: SymbolicModelV3) => void] => [name, model => { model.branches = model.branches.filter(branch => branch.action !== name); }]),
  ];
  for (const [name, mutation] of mutations) assert.throws(() => validateObservedResourceProtocol({ model: changed(model, mutation), binding, coverage: 'independent' }), /TLC305:/, name);
});

test('new outcome role, properties, actions and events are syntax bindings rather than trusted names', { skip: !jar }, async () => {
  const aliases = (source: string) => source.replaceAll('writeOutcome', 'observedResult').replaceAll('WriteObservation', 'RequiredObservation').replaceAll('WritePostError', 'AfterAcknowledgmentFailure').replaceAll('finishposterror', 'later-failure');
  const model = await compile('ResourceOutcomes.cfg', aliases, aliases);
  const renamed = ResourceProtocolBindingV2Schema.parse({ ...binding, variables: { ...binding.variables, writeOutcome: 'observedResult' } });
  assert.equal(validateObservedResourceProtocol({ model, binding: renamed, coverage: 'required-before-write' }).storageAuthority, false);
});
