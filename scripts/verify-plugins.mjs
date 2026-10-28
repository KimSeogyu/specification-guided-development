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

async function verifyRetainedOperation({ client, plugin, name }) {
  const model = join(temporary, name, 'retained-model');
  const out = join(temporary, name, 'retained-operation');
  const references = join(plugin, 'skills/specification-guided-development/references');
  await mkdir(model, { recursive: true });
  for (const file of ['ReportCustody.tla', 'ReportCustody.cfg']) {
    await cp(join(references, file), join(model, file));
  }
  const project = join(model, 'project.json');
  await writeFile(project, JSON.stringify({
    version: 2, profile: 'finite-owned', name: 'ReportCustody',
    spec: 'ReportCustody.tla', config: 'ReportCustody.cfg', targets: ['typescript'],
    binding: { className: 'ReportCustody', operation: {
      kind: 'retained-operation', start: 'StartReport', success: 'ReportSucceeded',
      failure: 'ReportFailed', retainedVariable: 'resident',
    } },
  }));
  const summary = toolValue(await client.callTool({ name: 'sgd_build', arguments: { project, jar, out } }));
  assert.equal(summary.schema, 'sgd-build-summary-v2');
  assert.equal(summary.operation, 'build');
  assert.deepEqual(summary.verification.checks.find(check => check.kind === 'retained-operation'), {
    kind: 'retained-operation', role: 'model', scope: 'one-borrowed-synchronous-callback', payload: 'retained-on-all-return-paths',
  });
  assert.deepEqual(summary.limits, {
    applicationIntegration: 'not-established', persistence: 'not-established', externalEffects: 'not-established',
  });
  assert.ok(!('nodes' in summary.graph));
  const inventory = JSON.parse(await readFile(join(out, '.sgd-generated.json'), 'utf8'));
  for (const file of ['automaton.json', 'binding.json', 'verification.json', 'typescript/operation.ts']) {
    assert.ok(summary.output.artifacts.includes(file), `retained summary omitted ${file}`);
    assert.ok(inventory.files.includes(file), `retained ownership inventory omitted ${file}`);
    await access(join(out, file));
  }
  const graph = toolValue(await client.callTool({ name: 'sgd_inspect', arguments: { ir: join(out, 'automaton.json') } }));
  assert.equal(graph.kind, 'exact-finite');
  assert.ok(graph.nodes.every(node => node.values.resident.kind === 'boolean' && node.values.resident.value === true));
  const view = join(temporary, name, 'retained-view');
  toolValue(await client.callTool({ name: 'sgd_visualize', arguments: { ir: [join(out, 'automaton.json')], out: view } }));
  const html = await readFile(join(view, 'index.html'), 'utf8');
  assert.match(html, /full concrete states/);
  assert.match(html, /resident = TRUE/);
  for (const variable of ['phase', 'ready', 'resident']) assert.ok(graph.variables.some(item => item.name === variable));
  assert.deepEqual(JSON.parse(await readFile(join(view, 'models.json'), 'utf8')), [graph]);
  const receipt = JSON.parse(await readFile(join(out, 'verification.json'), 'utf8'));
  assert.equal(receipt.kind, 'tlc-finite-completed');
  assert.equal(receipt.profile, 'finite-owned-v1');
  const compiler = join(plugin, 'runtime/node_modules/typescript/bin/tsc');
  assert.match(execFileSync(process.execPath, [compiler, '--version'], { encoding: 'utf8', timeout: 30_000 }), /^Version 7\.0\.2\s*$/);
  execFileSync(process.execPath, [compiler, '-p', join(out, 'typescript/tsconfig.json')], {
    cwd: temporary, encoding: 'utf8', timeout: 30_000,
  });
  const runner = join(temporary, name, 'verify-retained.mjs');
  await writeFile(runner, `import assert from 'node:assert/strict';
const { finalize, isFinalized } = await import(process.argv[2]);
for (const ok of [true, false]) {
  const executionError = new Error('original execution failure');
  const payload = {units:[{raw:[1,2],metrics:42}],executionError,ledger:'terminal-uncertain'};
  const observed = {path:'report',stage:ok?'complete':'sync'};
  let calls = 0;
  const finalized = finalize(payload, borrowed => {
    calls++;
    assert.equal(borrowed, payload);
    return ok ? {ok:true,value:observed} : {ok:false,error:observed};
  });
  assert.equal(calls,1);
  assert.equal(finalized.payload(),payload);
  assert.equal(finalized.payload().executionError,executionError);
  assert.equal(finalized.payload().ledger,'terminal-uncertain');
  assert.equal(finalized.status().kind,'completed');
  const outcome = finalized.status().observation;
  assert.equal(outcome.kind,'returned');
  assert.equal(outcome.outcome.ok,ok);
  assert.equal(outcome.outcome[ok?'value':'error'],observed);
  assert.equal(finalized.snapshot().values.phase.value,ok?'Succeeded':'Failed');
  assert.equal(finalized.snapshot().values.resident.value,true);
  assert.equal(finalized.snapshot().revision,'2');
  assert.equal(isFinalized(finalized),true);
  assert.equal(isFinalized({...finalized}),false);
  assert.equal('send' in finalized,false);
  assert.equal(Reflect.set(finalized,'payload',()=>null),false);
}
process.stdout.write(JSON.stringify({payload:'same object retained on success and failure',callback:'one borrowed synchronous invocation',completion:'selected from actual callback result',priorFacts:'execution error and ledger uncertainty retained separately',publicDispatch:'absent',forgery:'rejected'}));
`);
  const executed = JSON.parse(execFileSync(process.execPath, [runner, pathToFileURL(join(out, 'typescript/dist/operation.js')).href], {
    cwd: temporary, encoding: 'utf8', timeout: 30_000,
  }));
  assert.equal(executed.payload, 'same object retained on success and failure');
  return {
    modelTemplate: 'loaded from this copied native package', modelCheck: 'completed',
    nativeTypeScript: 'packaged 7.0.2', ...executed,
    artifactOwnership: 'TypeScript outputs listed in managed inventory',
    pele: 'full finite model view emitted with phase, ready, and resident; browser rendering not exercised',
    installedAgentHost: 'not exercised', applicationIntegration: 'not established by this copied-cache fixture',
    persistence: 'not established', enclosingModelRefinement: 'not established',
  };
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

async function verifyDomain({ client, plugin, name }) {
  const lean = process.env.SGD_LEAN_BINARY;
  if (!lean) {
    process.stdout.write(`[${name}] Domain proof/runtime verification skipped: set SGD_LEAN_BINARY to Lean 4.35.0.\n`);
    return { status: 'skipped', reason: 'SGD_LEAN_BINARY is not set' };
  }
  const references = join(plugin, 'skills/specification-guided-development/references');
  const model = join(temporary, name, 'domain-model');
  const out = join(temporary, name, 'domain');
  await mkdir(model, { recursive: true });
  for (const file of ['Approval.tla', 'Approval.cfg']) await cp(join(references, file), join(model, file));
  const project = JSON.parse(await readFile(join(references, 'domain-project.json'), 'utf8'));
  project.targets = ['typescript', 'rust'];
  await writeFile(join(model, 'project.json'), JSON.stringify(project));
  const packagedProof = await readFile(join(plugin, 'runtime/proofs/domain/DomainProtocol.lean'), 'utf8');
  const summary = toolValue(await client.callTool({ name: 'sgd_build', arguments: {
    project: join(model, 'project.json'), jar, lean: resolve(lean), out,
  } }));
  assert.equal(summary.verification.checks.find(check => check.kind === 'domain-protocol')?.proof, 'lean4-kernel');
  assert.equal(await readFile(join(out, 'proof/DomainProtocol.lean'), 'utf8'), packagedProof);
  const proof = JSON.parse(await readFile(join(out, 'proof/verification.json'), 'utf8'));
  const compiler = join(plugin, 'runtime/node_modules/typescript/bin/tsc');
  execFileSync(process.execPath, [compiler, '-p', join(out, 'typescript/tsconfig.json')], { cwd: temporary, encoding: 'utf8', timeout: 30_000 });
  execFileSync('cargo', ['test', '--offline', '--manifest-path', join(out, 'rust/Cargo.toml')],
    { cwd: temporary, encoding: 'utf8', timeout: 60_000, stdio: 'pipe' });
  const runner = join(temporary, name, 'verify-domain.mjs');
  await writeFile(runner, `import assert from 'node:assert/strict';
const {createApprovalDomain,isApprovalDomain} = await import(process.argv[2]);
let calls=0, settle;
const actual={id:'real input'};
const owner=createApprovalDomain({publisher: input => {calls++;assert.equal(input,actual);return new Promise(resolve=>{settle=resolve;});}});
assert.equal(isApprovalDomain(owner),true);
assert.equal((await owner.publish(actual)).kind,'refused');assert.equal(calls,0);
assert.equal(owner.send('Approve').ok,true);
for(const event of ['StartPublish','PublishSucceeded','PublishFailed']){const before=owner.read();assert.equal(owner.send(event).ok,false);assert.deepEqual(owner.read(),before);}
const pending=owner.publish(actual);assert.equal(calls,1);assert.equal(owner.read().values.phase.value,'Publishing');
assert.equal((await owner.publish(actual)).kind,'refused');assert.equal(calls,1);
assert.equal(owner.send('PublishSucceeded').ok,false);assert.equal(owner.read().values.phase.value,'Publishing');
const value={written:true};settle(value);const success=await pending;assert.equal(success.kind,'success');assert.equal(success.value,value);assert.equal(owner.read().values.phase.value,'Published');
const cause={message:'real port error'};const failed=createApprovalDomain({publisher:async()=>{throw cause;}});assert.equal(failed.send('Approve').ok,true);const failure=await failed.publish(actual);assert.equal(failure.kind,'failure');assert.equal(failure.error,cause);assert.equal(failed.read().values.phase.value,'Draft');
process.stdout.write(JSON.stringify({approval:'required before effect',hiddenEvents:'refused unchanged',pending:'exclusive until actual settlement',success:'actual value retained',failure:'actual cause retained'}));
`);
  const behavior = JSON.parse(execFileSync(process.execPath, [runner, pathToFileURL(join(out, 'typescript/dist/domain.js')).href], { cwd: temporary, encoding: 'utf8', timeout: 30_000 }));
  const retainedModel = join(temporary, name, 'retained-domain-model');
  const retainedOut = join(temporary, name, 'retained-domain');
  await mkdir(retainedModel, { recursive: true });
  for (const file of ['ReportCustody.tla', 'ReportCustody.cfg', 'retained-rust-project.json']) {
    await cp(join(references, file), join(retainedModel, file));
  }
  const retainedSummary = toolValue(await client.callTool({ name: 'sgd_build', arguments: {
    project: join(retainedModel, 'retained-rust-project.json'), jar, lean: resolve(lean), out: retainedOut,
  } }));
  assert.equal(retainedSummary.verification.checks.find(check => check.kind === 'domain-protocol')?.proof, 'lean4-kernel');
  const retainedProof = JSON.parse(await readFile(join(retainedOut, 'proof/verification.json'), 'utf8'));
  assert.equal(retainedProof.retainedProof?.scope, 'abstract-owner-token-and-graph-residency');
  execFileSync('cargo', ['test', '--offline', '--manifest-path', join(retainedOut, 'rust/Cargo.toml')],
    { cwd: temporary, encoding: 'utf8', timeout: 60_000, stdio: 'pipe', env: { ...process.env, RUSTFLAGS: '-Dwarnings' } });
  return { status: 'passed', model: 'packaged Approval and ReportCustody templates', proof: 'packaged trusted modules and real Lean kernel', proofScope: proof.scope, nativeTypeScript: 'packaged 7.0.2', rust: 'generated crates compile with cargo', ...behavior };
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
      assert.deepEqual(tools, ['sgd_build', 'sgd_check_contracts', 'sgd_compile', 'sgd_inspect', 'sgd_model', 'sgd_refine', 'sgd_update_status', 'sgd_visualize']);
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
      const retainedOperation = await verifyRetainedOperation({ client, plugin, name });
      const symbolicOwned = await verifySymbolicOwned({ client, plugin, name });
      const productOwned = await verifyProductOwned({ client, plugin, name, abstractIr: join(temporary, name, 'symbolic-owned/symbolic-model.json') });
      const domain = await verifyDomain({ client, plugin, name });
      results.push({ plugin: name, environment: 'isolated copied plugin cache; not an installed agent host', actualInstalledAgentHost: 'not exercised', nativeRuntime: `${process.platform}-${process.arch}`, tools, modelCheck: 'completed', generatedTypeScript: 'accepted', pele: 'rendered', finiteOwned, retainedOperation, symbolicOwned, productOwned, domain });
    } finally { await client.close(); }
  }
  await mkdir(resolve('.runtime'), { recursive: true });
  await writeFile(resolve('.runtime/plugin-verification.json'), JSON.stringify(results, null, 2) + '\n');
  process.stdout.write('Both copied plugin caches passed MCP, real TLC, TypeScript v1 diagnostics, v2 finite/retained owners, v3/v4 symbolic inputs, Pele and freshness checks. Domain proof/runtime results are recorded separately; skipped checks are not passes. These fixtures do not establish installed-agent or production application adoption.\n');
} finally { await rm(temporary, { recursive: true, force: true }); }
