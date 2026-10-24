#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const temporary = await mkdtemp(join(tmpdir(), 'sgd-plugin-install-'));
const results = [];
const jar = resolve(process.env.TLA2TOOLS_JAR ?? '.runtime/tla2tools.jar');

function toolValue(result) {
  assert.ok(!result.isError, JSON.stringify(result));
  const content = result.content;
  assert.ok(Array.isArray(content) && content.length === 1 && content[0].type === 'text', JSON.stringify(result));
  return JSON.parse(content[0].text);
}

async function verifyFiniteOwned({ client, plugin, name }) {
  const out = join(temporary, name, 'finite-owned');
  toolValue(await client.callTool({ name: 'sgd_build', arguments: {
    project: resolve('examples/approval/project.json'), jar, out,
  } }));
  const graph = toolValue(await client.callTool({ name: 'sgd_inspect', arguments: { ir: join(out, 'automaton.json') } }));
  assert.equal(graph.kind, 'exact-finite');
  assert.equal(graph.nodes.length, 3);
  assert.deepEqual(graph.variables.map(variable => [variable.name, variable.kind]).sort(), [['approved', 'boolean'], ['phase', 'string']]);
  const valuations = new Map(graph.nodes.map(node => [JSON.stringify([node.values.phase.value, node.values.approved.value]), node.id]));
  assert.deepEqual([...valuations.keys()].sort(), ['["New",false]', '["New",true]', '["Submitted",true]']);
  const unapproved = valuations.get('["New",false]');
  const approved = valuations.get('["New",true]');
  const submitted = valuations.get('["Submitted",true]');
  assert.deepEqual(graph.initial, [unapproved]);
  assert.ok(!graph.edges.some(edge => edge.from === unapproved && edge.event === 'Submit'));
  assert.ok(graph.edges.some(edge => edge.from === unapproved && edge.event === 'Approve' && edge.to === approved));
  assert.ok(graph.edges.some(edge => edge.from === approved && edge.event === 'Submit' && edge.to === submitted));
  const receipt = JSON.parse(await readFile(join(out, 'verification.json'), 'utf8'));
  assert.equal(receipt.kind, 'tlc-finite-completed');
  assert.equal(receipt.profile, 'finite-owned-v1');

  const compiler = join(plugin, 'runtime/node_modules/typescript/bin/tsc');
  assert.match(execFileSync(process.execPath, [compiler, '--version'], { encoding: 'utf8', timeout: 30_000 }), /^Version 7\.0\.2\s*$/);
  execFileSync(process.execPath, [compiler, '-p', join(out, 'typescript/tsconfig.json')], {
    cwd: temporary, encoding: 'utf8', timeout: 30_000,
  });
  const runner = join(temporary, name, 'verify-owned.mjs');
  await writeFile(runner, `import assert from 'node:assert/strict';
const { createApprovalMachine, isApprovalMachine } = await import(process.argv[2]);
const machine = createApprovalMachine();
assert.equal(isApprovalMachine(machine), true);
assert.equal(isApprovalMachine({ ...machine }), false);
assert.equal(isApprovalMachine(new Proxy(machine, {})), false);
const initial = machine.read();
assert.deepEqual(initial.values, { approved: { kind: 'boolean', value: false }, phase: { kind: 'string', value: 'New' } });
assert.equal(initial.revision, '0');
assert.equal(Reflect.set(initial.values.approved, 'value', true), false);
assert.equal(Reflect.set(initial.values, 'approved', { kind: 'boolean', value: true }), false);
assert.equal(Reflect.set(initial, 'nodeId', 'forged'), false);
assert.equal(Reflect.set(machine, 'send', () => ({ ok: true })), false);
assert.equal(Reflect.set(machine, 'state', 'Submitted'), false);
const denied = machine.send('Submit');
assert.equal(denied.ok, false);
assert.equal(denied.reason, 'disabled');
assert.deepEqual(machine.read(), initial);
const approval = machine.send('Approve');
assert.equal(approval.ok, true);
assert.deepEqual(approval.before, initial);
assert.equal(approval.after.values.approved.value, true);
assert.equal(approval.after.values.phase.value, 'New');
assert.equal(approval.after.revision, '1');
assert.equal(initial.values.approved.value, false);
const submission = machine.send('Submit');
assert.equal(submission.ok, true);
assert.deepEqual(submission.before, approval.after);
assert.equal(submission.after.values.approved.value, true);
assert.equal(submission.after.values.phase.value, 'Submitted');
assert.equal(submission.after.revision, '2');
assert.equal(machine.send('Approve').reason, 'disabled');
assert.equal(machine.send('Unmodeled').reason, 'unknown-event');
assert.deepEqual(machine.read(), submission.after);
const waited = machine.send('Wait');
assert.equal(waited.ok, true);
assert.equal(waited.after.nodeId, submission.after.nodeId);
assert.equal(waited.after.revision, '3');
process.stdout.write(JSON.stringify({ guard: 'enforced', trace: ['Approve', 'Submit', 'Wait'], tampering: 'rejected', annotationRequired: false }));
`);
  const executed = JSON.parse(execFileSync(process.execPath, [runner, pathToFileURL(join(out, 'typescript/dist/machine.js')).href], {
    cwd: temporary, encoding: 'utf8', timeout: 30_000,
  }));
  assert.deepEqual(executed, { guard: 'enforced', trace: ['Approve', 'Submit', 'Wait'], tampering: 'rejected', annotationRequired: false });

  const view = join(temporary, name, 'finite-view');
  toolValue(await client.callTool({ name: 'sgd_visualize', arguments: { ir: [join(out, 'automaton.json')], out: view } }));
  const html = await readFile(join(view, 'index.html'), 'utf8');
  assert.match(html, /3 full concrete states/);
  assert.match(html, /approved = FALSE/);
  assert.match(html, /approved = TRUE/);
  assert.deepEqual(JSON.parse(await readFile(join(view, 'models.json'), 'utf8')), [graph]);
  const forbiddenOut = join(temporary, name, 'unverified-authority');
  const imported = await client.callTool({ name: 'sgd_compile', arguments: {
    project: resolve('examples/approval/project.json'), dot: join(out, 'model.dot'), out: forbiddenOut,
  } });
  assert.equal(imported.isError, true, JSON.stringify(imported));
  assert.match(JSON.stringify(imported.content), /TLC206: imported DOT cannot generate finite-owned authority/);
  await assert.rejects(access(forbiddenOut), { code: 'ENOENT' });
  return { modelCheck: 'completed', concreteStates: 3, nativeTypeScript: '7.0.2', ...executed, pele: 'full-state rendered', unverifiedAuthority: 'rejected without output' };
}

async function verifySymbolicOwned({ client, plugin, name }) {
  const out = join(temporary, name, 'symbolic-owned');
  toolValue(await client.callTool({ name: 'sgd_build', arguments: {
    project: resolve('examples/fact-merge/project.json'), jar, out,
  } }));
  const witness = toolValue(await client.callTool({ name: 'sgd_inspect', arguments: { ir: join(out, 'automaton.json') } }));
  const program = toolValue(await client.callTool({ name: 'sgd_inspect', arguments: { ir: join(out, 'symbolic-model.json') } }));
  assert.equal(witness.kind, 'symbolic-witness');
  assert.deepEqual(witness.atoms, ['v1', 'v2']);
  assert.deepEqual(witness.variables, ['phase', 'rejected', 'stored']);
  assert.equal(witness.nodes.length, 5);
  assert.equal(program.kind, 'symbolic-owned');
  assert.deepEqual(program.branches.map(branch => branch.action), ['Insert', 'Same', 'Clash']);
  assert.deepEqual(program.invariants.map(item => item.name), ['TypeOK', 'ConflictKeepsStored']);
  assert.deepEqual(program.actionProperties.map(item => item.name), ['StoredStable']);
  const receipt = JSON.parse(await readFile(join(out, 'verification.json'), 'utf8'));
  assert.equal(receipt.kind, 'tlc-symbolic-completed');
  assert.equal(receipt.profile, 'symbolic-owned-v1');
  assert.equal(receipt.extractor, 'SANY-XML-v1');
  assert.equal(receipt.generation, 'symbolic-authority');
  assert.equal(receipt.semanticSha256, program.source.semanticSha256);
  const oracle = JSON.parse(await readFile(join(out, 'input-verification.json'), 'utf8'));
  assert.equal(oracle.kind, 'tlc-finite-input-oracle');
  assert.equal(oracle.scope, 'configured-reachable-state-input-product');
  assert.equal(oracle.checkedCases, witness.nodes.length * witness.atoms.length);
  assert.equal(oracle.acceptedCases, oracle.checkedCases);
  assert.equal(oracle.disabledCases, 0);
  assert.match(await readFile(join(out, 'input-oracle.log'), 'utf8'), /Model checking completed\. No error has been found\./);

  const compiler = join(plugin, 'runtime/node_modules/typescript/bin/tsc');
  assert.match(execFileSync(process.execPath, [compiler, '--version'], { encoding: 'utf8', timeout: 30_000 }), /^Version 7\.0\.2\s*$/);
  execFileSync(process.execPath, [compiler, '-p', join(out, 'typescript/tsconfig.json')], { cwd: temporary, encoding: 'utf8', timeout: 30_000 });
  const runner = join(temporary, name, 'verify-symbolic.mjs');
  await writeFile(runner, `import assert from 'node:assert/strict';
const { createFactMachine, isFactMachine } = await import(process.argv[2]);
const modelRevision = process.argv[3];
const scalar = value => ({ kind: 'string', value });
const data = value => ({ kind: 'data', domain: 'Values', value });
const snapshot = (revision, phase, stored, rejected) => ({ model: 'ManifestWrite', modelRevision, revision: String(revision), values: { phase: scalar(phase), stored, rejected } });
const origin = variable => ({ kind: 'state', variable });
const unchanged = { phase: origin('phase'), rejected: origin('rejected'), stored: origin('stored') };
const literal = value => ({ kind: 'literal', value: scalar(value) });
function run(inputs) {
  const machine = createFactMachine();
  assert.equal(isFactMachine(machine), true);
  assert.equal(isFactMachine({ ...machine }), false);
  assert.equal(isFactMachine(new Proxy(machine, {})), false);
  assert.equal(Reflect.set(machine, 'send', () => ({ ok: true })), false);
  return inputs.map(input => {
    const initial = machine.read();
    assert.equal(Reflect.set(initial.values.stored, 'value', 'forged'), false);
    const result = machine.send(input);
    assert.equal(result.ok, true);
    assert.deepEqual(result.before, initial);
    assert.deepEqual(result.after, machine.read());
    assert.equal(Reflect.set(result.updates, 'stored', { kind: 'input' }), false);
    const { action, before, after, updates } = result;
    return { input, action, before, after, updates };
  });
}
const initial = snapshot(0, 'absent', scalar('none'), scalar('none'));
const inserted = snapshot(1, 'present', data('A'), scalar('none'));
const conflictB = snapshot(2, 'conflict', data('A'), data('B'));
const conflictC = snapshot(3, 'conflict', data('A'), data('C'));
const repeatedA = snapshot(4, 'conflict', data('A'), data('C'));
const clashUpdates = { phase: literal('conflict'), rejected: { kind: 'input' }, stored: origin('stored') };
const trace = run(['A', 'B', 'C', 'A']);
assert.deepEqual(trace, [
  { input: 'A', action: 'Insert', before: initial, after: inserted, updates: { phase: literal('present'), rejected: literal('none'), stored: { kind: 'input' } } },
  { input: 'B', action: 'Clash', before: inserted, after: conflictB, updates: clashUpdates },
  { input: 'C', action: 'Clash', before: conflictB, after: conflictC, updates: clashUpdates },
  { input: 'A', action: 'Same', before: conflictC, after: repeatedA, updates: unchanged },
]);
const sentinel = run(['none', 'none', 'A', 'none']);
assert.deepEqual(sentinel.map(step => step.action), ['Insert', 'Same', 'Clash', 'Same']);
assert.deepEqual(sentinel[0].before.values.stored, scalar('none'));
assert.deepEqual(sentinel[0].after.values.stored, data('none'));
assert.deepEqual(sentinel[3].after.values, { phase: scalar('conflict'), rejected: data('A'), stored: data('none') });
const namesAreData = run(['Same', 'Clash', 'Insert']);
assert.deepEqual(namesAreData.map(step => step.action), ['Insert', 'Clash', 'Clash']);
assert.deepEqual(namesAreData[2].after.values.stored, data('Same'));
assert.deepEqual(namesAreData[2].after.values.rejected, data('Insert'));
process.stdout.write(JSON.stringify({ actions: trace.map(step => step.action), stored: 'A', latestRejected: 'C', sentinel: 'typed distinctly', actionSelection: 'generated guards', annotationRequired: false, tampering: 'rejected', completeReceipts: 'matched' }));
`);
  const executed = JSON.parse(execFileSync(process.execPath, [runner, pathToFileURL(join(out, 'typescript/dist/machine.js')).href, program.source.semanticSha256], { cwd: temporary, encoding: 'utf8', timeout: 30_000 }));
  assert.deepEqual(executed.actions, ['Insert', 'Clash', 'Clash', 'Same']);
  const view = join(temporary, name, 'symbolic-view');
  toolValue(await client.callTool({ name: 'sgd_visualize', arguments: { ir: [join(out, 'automaton.json'), join(out, 'symbolic-model.json')], out: view } }));
  const html = await readFile(join(view, 'index.html'), 'utf8');
  assert.match(html, /configured finite witness states/);
  assert.match(html, /equality\/copy orbits/);
  assert.match(html, /input-verification\.json/);
  assert.match(html, /data\(Values/);
  assert.deepEqual(JSON.parse(await readFile(join(view, 'models.json'), 'utf8')), [witness, program]);
  const forbiddenOut = join(temporary, name, 'unverified-symbolic-authority');
  const imported = await client.callTool({ name: 'sgd_compile', arguments: { project: resolve('examples/fact-merge/project.json'), dot: join(out, 'model.dot'), out: forbiddenOut } });
  assert.equal(imported.isError, true, JSON.stringify(imported));
  assert.match(JSON.stringify(imported.content), /TLC206: imported DOT cannot generate symbolic-owned authority/);
  await assert.rejects(access(forbiddenOut), { code: 'ENOENT' });
  return { modelCheck: 'completed', sany: 'lowered original parameterized actions', finiteInputOracle: 'all configured state/input pairs matched', nativeTypeScript: '7.0.2', ...executed, pele: 'finite witness and symbolic relation rendered', unverifiedAuthority: 'rejected without output' };
}

async function verifyProductOwned({ client, plugin, name, abstractIr }) {
  const out = join(temporary, name, 'product-owned');
  toolValue(await client.callTool({ name: 'sgd_build', arguments: {
    project: resolve('examples/fact-envelope/project.json'), jar, out,
  } }));
  const witness = toolValue(await client.callTool({ name: 'sgd_inspect', arguments: { ir: join(out, 'automaton.json') } }));
  const program = toolValue(await client.callTool({ name: 'sgd_inspect', arguments: { ir: join(out, 'symbolic-model.json') } }));
  assert.equal(witness.kind, 'symbolic-witness');
  assert.equal(witness.version, 2);
  assert.deepEqual(witness.domains, { Receipts: ['p1', 'p2'], Values: ['v1', 'v2'] });
  assert.deepEqual(witness.variables, ['phase', 'rejected', 'rejectedProvenance', 'stored', 'storedProvenance']);
  assert.equal(program.version, 2);
  assert.deepEqual(program.inputs, [{ parameter: 'v', domain: 'Values' }, { parameter: 'provenance', domain: 'Receipts' }]);
  assert.deepEqual(program.actionProperties.map(item => item.name), ['StoredStable', 'ProvenanceStable']);
  const receipt = JSON.parse(await readFile(join(out, 'verification.json'), 'utf8'));
  assert.equal(receipt.kind, 'tlc-symbolic-completed');
  assert.equal(receipt.profile, 'symbolic-owned-v1');
  assert.equal(receipt.symbolicIrVersion, 2);
  assert.equal(receipt.inputProfile, 'disjoint-input-product-v1');
  assert.deepEqual(receipt.runtimeDomain, { kind: 'disjoint-untyped-opaque-unicode-string-identities', inputs: program.inputs,
    domains: { Values: { finiteWitnessAtoms: ['v1', 'v2'] }, Receipts: { finiteWitnessAtoms: ['p1', 'p2'] } } });
  const oracle = JSON.parse(await readFile(join(out, 'input-verification.json'), 'utf8'));
  assert.equal(oracle.kind, 'tlc-finite-input-oracle');
  assert.deepEqual(oracle.inputs, program.inputs);
  assert.deepEqual(oracle.domains, witness.domains);
  assert.equal(oracle.checkedCases, witness.nodes.length * 2 * 2);
  assert.equal(oracle.acceptedCases, oracle.checkedCases);
  assert.equal(oracle.disabledCases, 0);
  assert.match(await readFile(join(out, 'input-oracle.log'), 'utf8'), /Model checking completed\. No error has been found\./);

  const compiler = join(plugin, 'runtime/node_modules/typescript/bin/tsc');
  assert.match(execFileSync(process.execPath, [compiler, '--version'], { encoding: 'utf8', timeout: 30_000 }), /^Version 7\.0\.2\s*$/);
  execFileSync(process.execPath, [compiler, '-p', join(out, 'typescript/tsconfig.json')], { cwd: temporary, encoding: 'utf8', timeout: 30_000 });
  const runner = join(temporary, name, 'verify-product.mjs');
  await writeFile(runner, `import assert from 'node:assert/strict';
const { createFactEnvelopeMachine, isFactEnvelopeMachine } = await import(process.argv[2]);
const modelRevision = process.argv[3];
const scalar = value => ({ kind: 'string', value });
const data = (domain, value) => ({ kind: 'data', domain, value });
const values = (phase, stored, rejected, storedProvenance, rejectedProvenance) => ({ phase: scalar(phase), stored, rejected, storedProvenance, rejectedProvenance });
const snapshot = (revision, state) => ({ model: 'FactWriteEnvelope', modelRevision, revision: String(revision), values: state });
const origin = variable => ({ kind: 'state', variable });
const literal = value => ({ kind: 'literal', value: scalar(value) });
const machine = createFactEnvelopeMachine();
assert.equal(isFactEnvelopeMachine(machine), true);
assert.equal(isFactEnvelopeMachine({ ...machine }), false);
assert.equal(Reflect.set(machine, 'send', () => ({ ok: true })), false);
const initial = snapshot(0, values('absent', scalar('none'), scalar('none'), scalar('none'), scalar('none')));
assert.deepEqual(machine.read(), initial);
const inputPairs = [['A', 'r1'], ['B', 'r2'], ['B', 'r3'], ['A', 'r4']];
const trace = inputPairs.map(([v, provenance]) => {
  const before = machine.read();
  const result = machine.send(v, provenance);
  assert.equal(result.ok, true);
  assert.deepEqual(result.before, before);
  assert.deepEqual(result.after, machine.read());
  assert.equal(Reflect.set(result.after.values.storedProvenance, 'value', 'forged'), false);
  const { action, after, updates } = result;
  return { input: { v, provenance }, action, before, after, updates };
});
const inserted = snapshot(1, values('present', data('Values', 'A'), scalar('none'), data('Receipts', 'r1'), scalar('none')));
const rejectedB2 = snapshot(2, values('conflict', data('Values', 'A'), data('Values', 'B'), data('Receipts', 'r1'), data('Receipts', 'r2')));
const rejectedB3 = snapshot(3, values('conflict', data('Values', 'A'), data('Values', 'B'), data('Receipts', 'r1'), data('Receipts', 'r3')));
const repeatedA = snapshot(4, rejectedB3.values);
const clashUpdates = { phase: literal('conflict'), rejected: { kind: 'input', parameter: 'v' }, rejectedProvenance: { kind: 'input', parameter: 'provenance' }, stored: origin('stored'), storedProvenance: origin('storedProvenance') };
assert.deepEqual(trace, [
  { input: { v: 'A', provenance: 'r1' }, action: 'Insert', before: initial, after: inserted, updates: { phase: literal('present'), stored: { kind: 'input', parameter: 'v' }, rejected: literal('none'), storedProvenance: { kind: 'input', parameter: 'provenance' }, rejectedProvenance: literal('none') } },
  { input: { v: 'B', provenance: 'r2' }, action: 'Clash', before: inserted, after: rejectedB2, updates: clashUpdates },
  { input: { v: 'B', provenance: 'r3' }, action: 'Clash', before: rejectedB2, after: rejectedB3, updates: clashUpdates },
  { input: { v: 'A', provenance: 'r4' }, action: 'Same', before: rejectedB3, after: repeatedA, updates: { phase: origin('phase'), stored: origin('stored'), rejected: origin('rejected'), storedProvenance: origin('storedProvenance'), rejectedProvenance: origin('rejectedProvenance') } },
]);
assert.equal(Reflect.set(trace[2].updates.rejectedProvenance, 'parameter', 'v'), false);
const beforeInvalid = machine.read();
assert.equal(machine.send('A').reason, 'invalid-input');
assert.equal(machine.send({ v: 'A', provenance: 'r5' }).reason, 'invalid-input');
assert.deepEqual(machine.read(), beforeInvalid);
const sentinel = createFactEnvelopeMachine().send('none', 'none');
assert.equal(sentinel.ok, true);
assert.deepEqual(sentinel.before.values.stored, scalar('none'));
assert.deepEqual(sentinel.after.values.stored, data('Values', 'none'));
assert.deepEqual(sentinel.after.values.storedProvenance, data('Receipts', 'none'));
process.stdout.write(JSON.stringify({ actions: trace.map(step => step.action), stored: 'A@r1', latestRejected: 'B@r3', namedOrigins: 'matched', sentinel: 'distinct scalar and domain tags', completeReceipts: 'matched', invalidTuple: 'rejected unchanged' }));
`);
  const executed = JSON.parse(execFileSync(process.execPath, [runner, pathToFileURL(join(out, 'typescript/dist/machine.js')).href, program.source.semanticSha256], { cwd: temporary, encoding: 'utf8', timeout: 30_000 }));
  assert.deepEqual(executed.actions, ['Insert', 'Clash', 'Clash', 'Same']);
  const refinement = toolValue(await client.callTool({ name: 'sgd_refine', arguments: {
    abstract: abstractIr, concrete: join(out, 'symbolic-model.json'), binding: resolve('examples/fact-envelope/erasure.json'),
  } }));
  assert.equal(refinement.kind, 'symbolic-enabled-input-erasure');
  assert.equal(refinement.scope, 'admitted-equality-copy-orbits');
  assert.equal(refinement.concrete.semanticSha256, program.source.semanticSha256);
  assert.equal(refinement.abstract.semanticSha256, JSON.parse(await readFile(abstractIr, 'utf8')).source.semanticSha256);
  assert.equal(refinement.acceptedCases, refinement.checkedCases);
  const view = join(temporary, name, 'product-view');
  toolValue(await client.callTool({ name: 'sgd_visualize', arguments: { ir: [join(out, 'automaton.json'), join(out, 'symbolic-model.json')], out: view } }));
  const html = await readFile(join(view, 'index.html'), 'utf8');
  assert.match(html, /storedProvenance/);
  assert.match(html, /rejectedProvenance/);
  assert.match(html, /v\[Values\]/);
  assert.match(html, /provenance\[Receipts\]/);
  assert.doesNotMatch(html, /\[object Object\]/);
  assert.deepEqual(JSON.parse(await readFile(join(view, 'models.json'), 'utf8')), [witness, program]);
  const forbiddenOut = join(temporary, name, 'unverified-product-authority');
  const imported = await client.callTool({ name: 'sgd_compile', arguments: { project: resolve('examples/fact-envelope/project.json'), dot: join(out, 'model.dot'), out: forbiddenOut } });
  assert.equal(imported.isError, true, JSON.stringify(imported));
  assert.match(JSON.stringify(imported.content), /TLC206: imported DOT cannot generate symbolic-owned authority/);
  await assert.rejects(access(forbiddenOut), { code: 'ENOENT' });
  return { modelCheck: 'completed', finiteInputOracle: 'all configured state/input tuples matched', nativeTypeScript: '7.0.2', ...executed,
    erasure: 'supplied IR enabled inputs, actions, and projected successors matched', pele: 'all provenance and domain labels rendered', unverifiedAuthority: 'rejected without output' };
}

async function verifyRowOwned({ client, plugin, name }) {
  const helper = join(plugin, 'runtime/bin', `sgd-rust-bindings${process.platform === 'win32' ? '.exe' : ''}`);
  await access(helper);
  await assert.rejects(access(join(plugin, 'runtime/tools/rust-bindings/Cargo.toml')), { code: 'ENOENT' });
  const application = join(temporary, name, 'row-application');
  const model = join(temporary, name, 'row-model');
  await cp(resolve('tests/fixtures/rust-facts/parangsae'), application, { recursive: true });
  await mkdir(model);
  for (const file of ['FactWriteEnvelope.tla', 'FactWriteEnvelope.cfg']) await cp(resolve('examples/fact-envelope', file), join(model, file));
  const row = JSON.parse(await readFile(resolve('tests/fixtures/rust-facts/binding.json'), 'utf8'));
  const project = join(model, 'project.json');
  await writeFile(project, JSON.stringify({ version: 5, profile: 'row-owned', name: 'FactWriteEnvelope', spec: 'FactWriteEnvelope.tla', config: 'FactWriteEnvelope.cfg',
    application: '../row-application', targets: ['typescript', 'rust'], binding: { className: 'FactAuthority', row, rustCrateMode: 'standalone' } }));
  const out = join(application, 'generated/fact-write');
  toolValue(await client.callTool({ name: 'sgd_build', arguments: { project, jar, out } }));
  const program = toolValue(await client.callTool({ name: 'sgd_inspect', arguments: { ir: join(out, 'symbolic-model.json') } }));
  const witness = toolValue(await client.callTool({ name: 'sgd_inspect', arguments: { ir: join(out, 'automaton.json') } }));
  const plan = JSON.parse(await readFile(join(out, 'row-binding-plan.json'), 'utf8'));
  assert.deepEqual(plan.facts.map(fact => [fact.name, fact.fields.length]), [['KlineFact', 18], ['FundingFact', 9], ['MetricsFact', 13], ['BookFact', 10]]);
  const kline = plan.facts.find(fact => fact.name === 'KlineFact');
  assert.deepEqual(kline.fields.find(field => field.name === 'schema_version').classes, [[1, 2]]);
  assert.deepEqual(kline.fields.find(field => field.name === 'received_ts').codec, { kind: 'i64', getters: ['micros', 'micros'] });
  assert.ok(plan.sources.some(source => source.path === 'crates/core/src/timestamps.rs'));
  assert.ok(plan.sources.every(source => !source.path.startsWith('generated/')));
  const receipt = JSON.parse(await readFile(join(out, 'verification.json'), 'utf8'));
  assert.equal(receipt.generation, 'whole-row-authority');
  assert.equal(receipt.rowBinding.profile, 'rust-whole-row-v1');
  assert.equal(receipt.rowBinding.sourceScope, 'production-library-and-audited-local-type-closure');
  assert.deepEqual(receipt.rowBinding.sources, plan.sources);
  assert.equal(receipt.rowBinding.formatter.profile, 'rustfmt-2021-v1');
  const oracle = JSON.parse(await readFile(join(out, 'input-verification.json'), 'utf8'));
  assert.equal(oracle.checkedCases, witness.nodes.length * 4); assert.equal(oracle.acceptedCases, oracle.checkedCases);
  const compiler = join(plugin, 'runtime/node_modules/typescript/bin/tsc');
  assert.match(execFileSync(process.execPath, [compiler, '--version'], { encoding: 'utf8', timeout: 30_000 }), /^Version 7\.0\.2\s*$/);
  execFileSync(process.execPath, [compiler, '-p', join(out, 'typescript/tsconfig.json')], { cwd: temporary, encoding: 'utf8', timeout: 30_000 });
  const runner = join(temporary, name, 'verify-rows.mjs');
  await writeFile(runner, `import assert from 'node:assert/strict';
import fs from 'node:fs';
const module=await import(process.argv[2]);const plan=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
function raw(fact){return Object.fromEntries(fact.fields.map(field=>{let value;switch(field.codec.kind){case'i64':value=1n;break;case'u32':value=field.name==='schema_version'?({KlineFact:1,FundingFact:3,MetricsFact:4,BookFact:5}[fact.name]):1;break;case'bool':value=true;break;case'string':value='BTCUSDT';break;case'enum':value=field.codec.variants[0];break;}return[field.name,value];}));}
const fields={};for(const fact of plan.facts){const make=module['create'+fact.name+'Row'];const owner=module['create'+fact.name+'Owner']();const source=raw(fact);const token=make(source);source.received_ts=999n;assert.equal(owner.write(token).effect,'Insert');assert.equal(owner.write(make({...raw(fact),received_ts:2n})).effect,'Same');assert.equal(owner.read().stored.received_ts,1n);assert.equal(Object.keys(owner.read().stored).length,fact.fields.length);fields[fact.name]=fact.fields.length;}
const fact=plan.facts.find(fact=>fact.name==='KlineFact');const make=module.createKlineFactRow;const owner=module.createKlineFactOwner();const base=raw(fact);base.open_ticks=42n;
const token=make(base);const inputs=[token,make({...base,schema_version:2,received_ts:2n}),make({...base,open_ticks:43n,schema_version:2,received_ts:3n}),make({...base,open_ticks:43n,schema_version:2,received_ts:4n}),make({...base,schema_version:2,received_ts:5n}),make({...base,schema_version:99,received_ts:6n})];
const results=inputs.map(row=>{const result=owner.write(row);assert.equal(result.ok,true);return{effect:result.effect,observation:owner.read()};});assert.deepEqual(results.map(step=>step.effect),['Insert','Same','Clash','Clash','Same','Clash']);
for(const result of results){assert.equal(result.observation.stored.open_ticks,42n);assert.equal(result.observation.stored.schema_version,1);assert.equal(result.observation.stored.received_ts,1n);assert.equal(Object.keys(result.observation.stored).length,18);}
assert.equal(results[4].observation.rejected.open_ticks,43n);assert.equal(results[4].observation.rejected.received_ts,4n);assert.equal(results[5].observation.rejected.schema_version,99);assert.equal(results[5].observation.rejected.received_ts,6n);
const before=owner.read();for(const forged of [base,{...token},null,'Same'])assert.equal(owner.write(forged).reason,'invalid-row');assert.deepEqual(owner.read(),before);assert.equal(Reflect.set(token,'received_ts',1000n),false);
const accessor={...base};Object.defineProperty(accessor,'received_ts',{enumerable:true,get(){throw new Error('must not call accessor');}});assert.throws(()=>make(accessor),/ROW303.*accessors/);
process.stdout.write(JSON.stringify({fieldCounts:fields,effects:results.map(step=>step.effect),originalMetadata:'retained',latestRejectedMetadata:'replaced',schemaClasses:'native Eq derived',forgery:'rejected unchanged',representation:'portable DTO from audited Rust schema'}));
`);
  const executed = JSON.parse(execFileSync(process.execPath, [runner, pathToFileURL(join(out, 'typescript/dist/machine.js')).href, join(out, 'row-binding-plan.json')], { cwd: temporary, encoding: 'utf8', timeout: 30_000 }));
  const view = join(temporary, name, 'row-view');
  toolValue(await client.callTool({ name: 'sgd_visualize', arguments: { ir: [join(out, 'automaton.json'), join(out, 'symbolic-model.json')], out: view } }));
  const html = await readFile(join(view, 'index.html'), 'utf8'); assert.match(html, /storedProvenance/); assert.match(html, /provenance\[Receipts\]/);
  assert.deepEqual(JSON.parse(await readFile(join(view, 'models.json'), 'utf8')), [witness, program]);
  const forbiddenOut = join(application, 'unverified-row-authority');
  const imported = await client.callTool({ name: 'sgd_compile', arguments: { project, dot: join(out, 'model.dot'), out: forbiddenOut } });
  assert.equal(imported.isError, true, JSON.stringify(imported)); assert.match(JSON.stringify(imported.content), /TLC206: imported DOT cannot generate row-owned authority/);
  await assert.rejects(access(forbiddenOut), { code: 'ENOENT' });
  return {
    fixture: { application, model, project, out },
    details: { sourceAnalyzer: 'bundled host-native binary; Cargo source fallback absent', sourceScope: receipt.rowBinding.sourceScope, modelCheck: 'completed', finiteInputOracle: 'all configured tuples matched', nativeTypeScript: '7.0.2', ...executed,
      pele: 'complete payload/provenance views rendered', unverifiedAuthority: 'rejected without output', actualParangsaeAdoption: 'not established by this copied-cache fixture' },
  };
}

async function verifyPartitionOwned({ client, plugin, name, fixture }) {
  const { application, model, project: rowProject, out } = fixture;
  const previousPlan = JSON.parse(await readFile(join(out, 'row-binding-plan.json'), 'utf8'));
  const references = join(plugin, 'skills/specification-guided-development/references');
  for (const file of ['PartitionControl.tla', 'PartitionControl.cfg']) await cp(join(references, file), join(model, file));
  assert.match(await readFile(join(references, 'partition-fold.md'), 'utf8'), /storage gap/);
  const controlProject = join(model, 'partition-control.json');
  const project = join(model, 'partition.json');
  await writeFile(controlProject, JSON.stringify({ version: 2, profile: 'finite-owned', name: 'PartitionControl', spec: 'PartitionControl.tla', config: 'PartitionControl.cfg', targets: ['typescript', 'rust'], binding: { className: 'PartitionControl' } }));
  // These audited fixture names are test data. User family policy remains in the
  // original literal TLA+ module, outside the controlled generated output root.
  const families = [
    { name: 'KlineFact', key: ['open_time'], time: 'open_time', datasets: ['um-kline', 'mark-price-kline', 'index-price-kline', 'premium-index-kline', 'spot-kline'] },
    { name: 'FundingFact', key: ['funding_time'], time: 'funding_time', datasets: ['funding-rate'] },
    { name: 'MetricsFact', key: ['create_time'], time: 'create_time', datasets: ['metrics'] },
    { name: 'BookFact', key: ['timestamp', 'percentage'], time: 'timestamp', datasets: ['book-depth'] },
  ];
  await writeFile(join(model, 'PartitionFamilies.tla'), `---- MODULE PartitionFamilies ----
PartitionFamilies ==
 [version |-> 1, calendar |-> "utc-micros-nonnegative-day-v1", families |->
  [${families.map(family => `${family.name} |-> [key |-> <<${family.key.map(value => JSON.stringify(value)).join(', ')}>>, symbol |-> "symbol", time |-> ${JSON.stringify(family.time)}, datasets |-> {${family.datasets.map(value => JSON.stringify(value)).join(', ')}}]`).join(',\n   ')}]]
====
`);
  await writeFile(project, JSON.stringify({ version: 6, profile: 'partition-fold', name: 'FactPartition', application: '../row-application', targets: ['typescript', 'rust'],
    models: { row: { project: 'project.json' }, control: { project: 'partition-control.json' }, families: { spec: 'PartitionFamilies.tla', operator: 'PartitionFamilies' } }, binding: { className: 'FactAuthority', rustCrateMode: 'standalone' } }));
  assert.equal(rowProject, join(model, 'project.json'));
  toolValue(await client.callTool({ name: 'sgd_build', arguments: { project, jar, out } }));
  const plan = JSON.parse(await readFile(join(out, 'partition-plan.json'), 'utf8'));
  assert.equal(plan.runtimeProfile, 'unbound-partition-v1');
  assert.deepEqual(plan.row.plan, previousPlan);
  assert.deepEqual(plan.contract.families.map(family => family.name), ['BookFact', 'FundingFact', 'KlineFact', 'MetricsFact']);
  const receipt = JSON.parse(await readFile(join(out, 'verification.json'), 'utf8'));
  assert.equal(receipt.kind, 'controlled-partition-fold'); assert.equal(receipt.generation, 'closed-data-fold'); assert.equal(receipt.storageAuthority, false);
  for (const path of ['model.dot', 'semantic.xml', 'orbit-proof.json', 'input-verification.json']) await assert.rejects(access(join(out, path)), { code: 'ENOENT' });
  for (const path of ['models/row/semantic.xml', 'models/control/semantic.xml', 'models/families/semantic.xml', 'rust/adapter.rs']) await access(join(out, path));
  const compiler = join(plugin, 'runtime/node_modules/typescript/bin/tsc');
  assert.match(execFileSync(process.execPath, [compiler, '--version'], { encoding: 'utf8', timeout: 30_000 }), /^Version 7\.0\.2\s*$/);
  execFileSync(process.execPath, [compiler, '-p', join(out, 'typescript/tsconfig.json')], { cwd: temporary, encoding: 'utf8', timeout: 30_000 });
  const runner = join(temporary, name, 'verify-partition.mjs');
  await writeFile(runner, `import assert from 'node:assert/strict';
import fs from 'node:fs';
const module=await import(process.argv[2]);const plan=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
function raw(fact){return Object.fromEntries(fact.fields.map(field=>{let value;switch(field.codec.kind){case'i64':value=1n;break;case'u32':value=field.name==='schema_version'?({KlineFact:1,FundingFact:3,MetricsFact:4,BookFact:5}[fact.name]):1;break;case'bool':value=true;break;case'string':value='BTCUSDT';break;case'enum':value=field.codec.variants[0];break;}return[field.name,value];}));}
function consume(folded){assert.equal(folded.ok,true);assert.ok(Object.isFrozen(folded.value));const consumed=folded.value.intoReport();assert.equal(consumed.ok,true);assert.deepEqual(folded.value.intoReport(),{ok:false,reason:'already-consumed'});return consumed.value;}
const changedFields={KlineFact:'open_ticks',FundingFact:'rate',MetricsFact:'sum_open_interest',BookFact:'depth'};
const fieldCounts={};
for(const fact of plan.row.plan.facts){
 const family=plan.contract.families.find(family=>family.name===fact.name);assert.ok(family);
 const make=module['create'+fact.name+'Row'];const fold=module['fold'+fact.name];assert.equal(module['create'+fact.name+'Owner'],undefined);
 const base=raw(fact);const first=make(base);const last=make({...base,received_ts:77n});const equal=make({...base,received_ts:99n,...(fact.name==='KlineFact'?{schema_version:2}:{})});
 const empty=consume(fold({baseline:[],incoming:[]}));assert.equal(empty.kind,'Noop');assert.deepEqual(empty.rows,[]);assert.equal(empty.group,null);
 const noop=consume(fold({baseline:[first,last],incoming:[equal]}));assert.equal(noop.kind,'Noop');assert.deepEqual(noop.rows,[first,last]);assert.deepEqual(noop.counts,{inserted:0n,unchanged:1n});assert.equal(noop.rows[0].received_ts,1n);assert.equal(noop.rows[1].received_ts,77n);
 const changed=changedFields[fact.name];assert.ok(changed);const rejected=make({...base,[changed]:2n,received_ts:2n});const provisional=make({...base,[family.key[0]]:2n,received_ts:3n});
 const refused=consume(fold({baseline:[first],incoming:[provisional,rejected,rejected,equal]}));assert.equal(refused.kind,'Refused');assert.deepEqual(refused.original,[first]);assert.deepEqual(refused.counts,{inserted:0n,unchanged:1n});assert.deepEqual(refused.conflicts,[{stored:first,rejected},{stored:first,rejected}]);
 assert.equal(Object.keys(refused.original[0]).length,fact.fields.length);assert.deepEqual(refused.original[0],first);
 for(const pair of refused.conflicts){assert.deepEqual(pair.stored,first);assert.deepEqual(pair.rejected,rejected);assert.equal(Object.keys(pair.stored).length,fact.fields.length);assert.equal(Object.keys(pair.rejected).length,fact.fields.length);assert.equal(pair.stored.received_ts,1n);assert.equal(pair.rejected.received_ts,2n);}
 for(const value of [noop,noop.rows,noop.counts,refused,refused.original,refused.conflicts,...refused.conflicts])assert.ok(Object.isFrozen(value));
 for(const forged of [base,{...first},null,'Same'])assert.deepEqual(fold({baseline:[],incoming:[forged]}),{ok:false,reason:'invalid-row'});
 const closed=fold({baseline:[first],incoming:[]}).value;assert.deepEqual(closed.intoReport.call({...closed}),{ok:false,reason:'invalid-closed'});assert.equal(closed.intoReport().ok,true);
 fieldCounts[fact.name]=fact.fields.length;
}
assert.equal(module.createFactAuthorityControl,undefined);
process.stdout.write(JSON.stringify({fieldCounts,noop:'original order, duplicates and metadata retained',refused:'provisional insert rolled back; every repeated complete conflict retained',same:'counted after conflict',handles:'authenticated, frozen and consumed once',forgery:'refused',storageAuthority:false}));
`);
  const executed = JSON.parse(execFileSync(process.execPath, [runner, pathToFileURL(join(out, 'typescript/dist/machine.js')).href, join(out, 'partition-plan.json')], { cwd: temporary, encoding: 'utf8', timeout: 30_000 }));
  const graph = toolValue(await client.callTool({ name: 'sgd_inspect', arguments: { ir: join(out, 'automaton.json') } }));
  const program = toolValue(await client.callTool({ name: 'sgd_inspect', arguments: { ir: join(out, 'symbolic-model.json') } }));
  assert.equal(graph.kind, 'exact-finite'); assert.equal(program.kind, 'symbolic-owned');
  assert.deepEqual(graph.variables.map(variable => variable.name).sort(), ['hasConflict', 'hasInserted', 'phase']);
  const view = join(temporary, name, 'partition-view');
  toolValue(await client.callTool({ name: 'sgd_visualize', arguments: { ir: [join(out, 'automaton.json'), join(out, 'symbolic-model.json')], out: view } }));
  const html = await readFile(join(view, 'index.html'), 'utf8');
  for (const label of [/hasInserted/, /hasConflict/, /ReadyRefused/, /storedProvenance/, /rejectedProvenance/, /equality\/copy orbits/]) assert.match(html, label);
  assert.deepEqual(JSON.parse(await readFile(join(view, 'models.json'), 'utf8')), [graph, program]);
  const inventoryBytes = await readFile(join(out, '.sgd-generated.json'));
  const inventory = JSON.parse(inventoryBytes.toString('utf8'));
  const before = await Promise.all(inventory.files.map(path => readFile(join(out, path))));
  toolValue(await client.callTool({ name: 'sgd_build', arguments: { project, jar, out, check: true } }));
  assert.deepEqual(await readFile(join(out, '.sgd-generated.json')), inventoryBytes);
  assert.deepEqual(await Promise.all(inventory.files.map(path => readFile(join(out, path)))), before);
  execFileSync(process.execPath, [join(plugin, 'scripts/run.mjs'), 'build', '--project', project, '--jar', jar, '--out', out, '--check'], { cwd: temporary, encoding: 'utf8', timeout: 90_000 });
  assert.deepEqual(await readFile(join(out, '.sgd-generated.json')), inventoryBytes);
  assert.deepEqual(await Promise.all(inventory.files.map(path => readFile(join(out, path)))), before);
  const forbiddenOut = join(application, 'unverified-partition-authority');
  const imported = await client.callTool({ name: 'sgd_compile', arguments: { project, dot: join(out, 'models/control/model.dot'), out: forbiddenOut } });
  assert.equal(imported.isError, true, JSON.stringify(imported)); assert.match(JSON.stringify(imported.content), /TLC206: imported DOT cannot generate partition-fold authority/);
  await assert.rejects(access(forbiddenOut), { code: 'ENOENT' });
  return { controlTemplate: 'loaded from this copied native package', modelCheck: 'both original models and literal metadata completed', migration: 'same v5 output root; original source plan preserved; obsolete managed row outputs removed', nativeTypeScript: 'packaged 7.0.2', ...executed,
    pele: 'complete finite control and symbolic row relations rendered', check: 'MCP check:true and packaged CLI --check preserved every managed byte', unverifiedAuthority: 'rejected without output', rustRuntime: 'not executed in this copied-cache flow', installedAgentHost: 'not exercised', actualParangsaeAdoption: 'not established by this copied-cache fixture' };
}


async function verifySourceScope({ plugin, name }) {
  const root = join(temporary, name, 'source-scope');
  await mkdir(join(root, 'src/bin'), { recursive: true });
  await writeFile(join(root, 'Cargo.toml'), '[package]\nname = "source_scope_fixture"\nversion = "0.1.0"\nedition = "2021"\n[workspace]\n');
  await writeFile(join(root, 'Cargo.lock'), 'version = 4\n[[package]]\nname = "source_scope_fixture"\nversion = "0.1.0"\n');
  await writeFile(join(root, 'src/lib.rs'), 'pub fn keep(value: i64) -> i64 { value }\n');
  for (const bin of ['one', 'two']) {
    await writeFile(join(root, `src/bin/${bin}.rs`), 'fn main() { let keep = source_scope_fixture::keep; let _ = keep(1); }\n');
  }
  const binary = join(plugin, 'runtime/bin', `sgd-rust-bindings${process.platform === 'win32' ? '.exe' : ''}`);
  const arguments_ = ['source-scope', '--root', root];
  const options = { cwd: root, encoding: 'utf8', timeout: 90_000, maxBuffer: 16 * 1024 * 1024 };
  const report = JSON.parse(execFileSync(binary, arguments_, options));
  assert.equal(report.profile, 'rust-source-scope-v1');
  assert.equal(report.scope, 'all-discovered-targets-unconditional-closed-source');
  assert.equal(report.storageAuthority, false);
  assert.deepEqual(report.targets.map(target => target.name).sort(), ['one', 'source_scope_fixture', 'two']);
  assert.ok(report.references.some(reference => reference.resolved.includes('keep')));
  await writeFile(join(root, 'src/bin/escape.rs'), 'use std::fs::write as save; fn main() { let _ = save("never-executed", b"probe"); }\n');
  assert.throws(() => execFileSync(binary, arguments_, options), error => {
    assert.equal(error.status, 2);
    const diagnostic = JSON.parse(String(error.stderr));
    assert.equal(diagnostic.ruleId, 'TLC308');
    assert.equal(diagnostic.storageAuthority, false);
    assert.match(diagnostic.message, /std::fs::write/);
    return true;
  });
  await assert.rejects(access(join(root, 'never-executed')), { code: 'ENOENT' });
  return { pureTargets: 'library and two auto-binaries admitted', addedWriter: 'reexported std::fs::write refused in new auto-binary', storageAuthority: false };
}

async function verifyCodecRecipe({ plugin, name }) {
  const root = join(temporary, name, 'codec-recipe');
  await cp(resolve('tests/fixtures/rust-codec-recipe/parangsae'), root, { recursive: true });
  const binding = JSON.parse(await readFile(resolve('tests/fixtures/rust-codec-recipe/codec-binding.json'), 'utf8'));
  const { analyzeCodecRecipe, recheckCodecRecipe } = await import(pathToFileURL(join(plugin, 'runtime/dist/codec-recipe.js')).href);
  const report = await analyzeCodecRecipe({ application: root, binding });
  assert.equal(report.profile, 'rust-codec-recipe-v1');
  assert.equal(report.storageAuthority, false);
  assert.equal(report.scope, 'selected-codec-and-native-constructor-closure');
  assert.equal(report.discovery.scope, 'discovered-targets-only');
  assert.equal(report.columns.length, 9);
  assert.ok(report.columns.some(column => column.column === 'received_ts_us' && column.field === 'received_ts'));
  assert.ok(Object.isFrozen(report));
  await recheckCodecRecipe({ report });
  await assert.rejects(recheckCodecRecipe({ report: JSON.parse(JSON.stringify(report)) }), /TLC309:/);
  const source = join(root, 'crates/collector/src/funding_codec.rs');
  const original = await readFile(source, 'utf8');
  const needle = 'raw_calc_time_us: row.raw_calc_time.micros(),';
  assert.equal(original.split(needle).length, 2);
  await writeFile(source, original.replace(needle, 'raw_calc_time_us: row.funding_time.micros(),'));
  await assert.rejects(analyzeCodecRecipe({ application: root, binding }), error => {
    assert.match(error.message, /TLC309:/);
    assert.match(error.message, /funding_codec\.rs/);
    assert.match(error.message, /encode_funding_row/);
    return true;
  });
  await assert.rejects(recheckCodecRecipe({ report }), /TLC309:/);
  return { nativeFields: 'all nine Funding fields and checked constructors', rawFieldSubstitution: 'same-scalar wrong source refused', capturedReport: 'complete reanalysis; copied report cannot restore context', storageAuthority: false };
}

try {
  for (const name of ['codex', 'claude-code']) {
    const plugin = join(temporary, `${name} copied cache`);
    await cp(resolve('plugins', name), plugin, { recursive: true });
    const client = new Client({ name: 'sgd-package-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(plugin, 'scripts/run.mjs'), 'mcp'], cwd: temporary });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
      assert.deepEqual(tools, ['sgd_build', 'sgd_compile', 'sgd_inspect', 'sgd_model', 'sgd_refine', 'sgd_visualize']);
      const out = join(temporary, name, 'generated');
      const built = await client.callTool({ name: 'sgd_build', arguments: {
        project: resolve('examples/order/project.json'), jar, out,
      } });
      assert.ok(!built.isError, JSON.stringify(built));
      const inspected = await client.callTool({ name: 'sgd_inspect', arguments: { ir: join(out, 'automaton.json') } });
      assert.ok(!inspected.isError, JSON.stringify(inspected));
      await writeFile(join(temporary, 'contract.ts'), 'transition("Pending", "Ack", "Acked");\n');
      const checked = execFileSync(process.execPath, [join(out, 'typescript/checker.mjs'), '--root', temporary, 'contract.ts'], {
        cwd: join(plugin, 'runtime'), encoding: 'utf8', timeout: 30_000,
      });
      assert.deepEqual(JSON.parse(checked), []);
      const visualized = await client.callTool({ name: 'sgd_visualize', arguments: { ir: [join(out, 'automaton.json')], out: join(temporary, name, 'view') } });
      assert.ok(!visualized.isError, JSON.stringify(visualized));
      assert.match(await readFile(join(temporary, name, 'view/index.html'), 'utf8'), /Model explorer/);
      const finiteOwned = await verifyFiniteOwned({ client, plugin, name });
      const symbolicOwned = await verifySymbolicOwned({ client, plugin, name });
      const productOwned = await verifyProductOwned({ client, plugin, name, abstractIr: join(temporary, name, 'symbolic-owned/symbolic-model.json') });
      const row = await verifyRowOwned({ client, plugin, name });
      const partitionOwned = await verifyPartitionOwned({ client, plugin, name, fixture: row.fixture });
      const sourceScope = await verifySourceScope({ plugin, name });
      const codecRecipe = await verifyCodecRecipe({ plugin, name });
      results.push({ plugin: name, environment: 'isolated copied plugin cache; not an installed agent host', actualInstalledAgentHost: 'not exercised', nativeRuntime: `${process.platform}-${process.arch}`, tools, modelCheck: 'completed', generatedTypeScript: 'accepted', pele: 'rendered', finiteOwned, symbolicOwned, productOwned, rowOwned: row.details, partitionOwned, sourceScope, codecRecipe });
    } finally { await client.close(); }
  }
  await mkdir(resolve('.runtime'), { recursive: true });
  await writeFile(resolve('.runtime/plugin-verification.json'), JSON.stringify(results, null, 2) + '\n');
  process.stdout.write('Both isolated copied plugin caches completed MCP, real TLC, v1 diagnostics, v2 finite-owned, v3 symbolic-owned, v4 product-input, v5 source-bound whole rows, and v6 closed partition data folds with their bundled control templates. The bundled Rust analyzer, packaged TypeScript 7.0.2, complete payload/provenance behavior, input-tuple oracle, supplied-IR erasure, Pele, v5-to-v6 migration, Noop/Refused complete-row behavior, immutable --check, tamper checks, unverified DOT refusal, the bundled closed source-scope pure-target/writer-refusal checks, and complete Funding codec/constructor analysis with wrong-field refusal passed. Codec reports retain no storage authority. Actual installed-agent hosts and completed Parangsae adoption were not established by these copied-cache fixtures.\n');
} finally { await rm(temporary, { recursive: true, force: true }); }
