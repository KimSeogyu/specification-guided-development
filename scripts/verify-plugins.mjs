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

try {
  for (const name of ['codex', 'claude-code']) {
    const plugin = join(temporary, `${name} copied cache`);
    await cp(resolve('plugins', name), plugin, { recursive: true });
    const client = new Client({ name: 'sgd-package-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(plugin, 'scripts/run.mjs'), 'mcp'], cwd: temporary });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
      assert.deepEqual(tools, ['sgd_build', 'sgd_compile', 'sgd_inspect', 'sgd_model', 'sgd_visualize']);
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
      results.push({ plugin: name, environment: 'isolated copied plugin cache; not an installed agent host', actualInstalledAgentHost: 'not exercised', nativeRuntime: `${process.platform}-${process.arch}`, tools, modelCheck: 'completed', generatedTypeScript: 'accepted', pele: 'rendered', finiteOwned, symbolicOwned });
    } finally { await client.close(); }
  }
  await mkdir(resolve('.runtime'), { recursive: true });
  await writeFile(resolve('.runtime/plugin-verification.json'), JSON.stringify(results, null, 2) + '\n');
  process.stdout.write('Both isolated copied plugin caches completed MCP, real TLC, v1 diagnostics, v2 finite-owned and v3 symbolic-owned authority with packaged native TypeScript 7.0.2, complete fact-merge receipts and assignment origins, finite input oracle, Pele, tamper checks, and unverified DOT refusal. Actual installed-agent hosts were not exercised.\n');
} finally { await rm(temporary, { recursive: true, force: true }); }
