import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { commandArgv, resolveEvidenceOutput, shellCommand, validateBuildSummaryArtifacts, validateProtocol } from './verify-codex-host.mjs';

const captured = JSON.parse(await readFile(new URL('../tests/fixtures/codex-host-events.json', import.meta.url), 'utf8'));
const replay = () => structuredClone(captured);
const verify = value => validateProtocol(value.events, value.scratch, value.commands);
const fails = (value, code) => assert.throws(() => verify(value), error => error.code === code);
function changeSummary(value, checked, change) {
  const item = value.events.find(event => event.type === 'item.completed' && event.item?.tool === 'sgd_build' && (event.item.arguments.check === true) === checked).item;
  const summary = JSON.parse(item.result.content[0].text);
  item.result.content[0].text = JSON.stringify(change(summary) ?? summary);
}
function addCommand(value, command, marker) {
  const item = { id: 'extra-command', type: 'command_execution', command, aggregated_output: '', exit_code: null, status: 'in_progress' };
  const index = value.events.findLastIndex(event => event.type === 'turn.completed');
  value.events.splice(index, 0, { type: 'item.started', item }, { type: 'item.completed', item: { ...item, aggregated_output: marker, exit_code: 0, status: 'completed' } });
}

test('synthetic default-summary protocol retains the historical repeated read-only helpers', () => {
  const value = replay();
  assert.equal(value.version, 2);
  assert.equal(value.provenance.kind, 'synthetic-protocol-fixture');
  assert.equal(value.provenance.freshHostExecution, false);
  const checked = verify(value);
  assert.equal(checked.calls.length, 5);
  assert.equal(checked.matchedCommands.get('native').length, 1);
  assert.equal(checked.matchedCommands.get('modeling').length, 2);
  assert.equal(checked.matchedCommands.get('partition').length, 2);
  assert.equal(checked.matchedCommands.get('application').length, 2);
});

test('full IR cannot replace a default build summary', () => {
  const value = replay();
  const inspected = value.events.find(event => event.type === 'item.completed' && event.item?.tool === 'sgd_inspect');
  changeSummary(value, false, () => JSON.parse(inspected.item.result.content[0].text));
  fails(value, 'HOST_SUMMARY');
});

test('the host workflow exercises the omitted detail default for both build calls', () => {
  for (const checked of [false, true]) {
    const value = replay();
    for (const event of value.events) if (event.item?.tool === 'sgd_build' && (event.item.arguments.check === true) === checked) event.item.arguments.detail = 'full';
    fails(value, 'HOST_MISSING_TOOL');
  }
});

test('summary cannot promote row, controller, or composition scope', () => {
  for (const [kind, field, replacement] of [
    ['controlled-tlc', 'scope', 'unbounded-model'], ['whole-row-binding', 'scope', 'all-targets'],
    ['partition-metadata', 'tlcScope', 'application-state'], ['partition-composition', 'storageAuthority', true],
  ]) {
    const value = replay();
    changeSummary(value, false, summary => { summary.verification.checks.find(check => check.kind === kind)[field] = replacement; });
    fails(value, 'HOST_SUMMARY');
  }
});

test('summary keeps current generation and historical check log freshness separate', () => {
  for (const checked of [false, true]) for (const field of ['output', 'freshInvocationLogRetained', 'evidence']) {
    const value = replay();
    changeSummary(value, checked, summary => {
      if (field === 'output') summary.verification.output = checked ? 'generated' : 'checked';
      if (field === 'freshInvocationLogRetained') summary.verification.freshInvocationLogRetained = checked;
      if (field === 'evidence') summary.evidence[0].freshness = checked ? 'current-invocation' : 'retained-output';
    });
    fails(value, 'HOST_SUMMARY');
  }
});

test('summary rejects guessed logs, escaped paths, and missing scoped evidence', () => {
  for (const change of [
    summary => { summary.output.artifacts.push('tlc.log'); },
    summary => { summary.output.artifacts.push('../outside.log'); },
    summary => { summary.evidence[0].path = '/fixture/outside/verification.json'; },
    summary => { summary.evidence = summary.evidence.filter(item => !item.path.endsWith('/models/families/tlc.log')); },
  ]) {
    const value = replay();
    changeSummary(value, false, change);
    fails(value, 'HOST_SUMMARY');
  }
});

test('summary artifacts agree with emitted data and inventory and reject missing or escaped evidence', { skip: process.platform === 'win32' }, async t => {
  const generated = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sgd-host-summary-test-')));
  t.after(() => rm(generated, { recursive: true, force: true }));
  const value = replay();
  const built = value.events.find(event => event.type === 'item.completed' && event.item?.tool === 'sgd_build').item;
  const summary = JSON.parse(built.result.content[0].text);
  const oldDirectory = summary.output.directory;
  summary.output.directory = generated;
  for (const evidence of summary.evidence) evidence.path = path.join(generated, path.relative(oldDirectory, evidence.path));
  const automaton = { kind: 'exact-finite', name: 'LedgerControl', variables: summary.graph.variables.map(name => ({ name })),
    nodes: Array.from({ length: 2 }, (_, id) => ({ id: `s${id}` })),
    edges: [{ from: 's0', event: 'Next', to: 's1' }], initial: ['s0'] };
  summary.graph.states = automaton.nodes.length;
  summary.graph.edges = automaton.edges.length;
  summary.graph.initialStates = automaton.initial.length;
  const inventory = { version: 1, files: [...summary.output.artifacts] };
  for (const file of inventory.files) {
    await mkdir(path.dirname(path.join(generated, file)), { recursive: true });
    await writeFile(path.join(generated, file), 'synthetic artifact for verifier control\n');
  }
  await writeFile(path.join(generated, 'automaton.json'), JSON.stringify(automaton));
  await writeFile(path.join(generated, '.sgd-generated.json'), JSON.stringify(inventory));
  const actualAutomaton = JSON.parse(await readFile(path.join(generated, 'automaton.json'), 'utf8'));
  const actualInventory = JSON.parse(await readFile(path.join(generated, '.sgd-generated.json'), 'utf8'));
  await validateBuildSummaryArtifacts(summary, generated, false, actualAutomaton, actualInventory);
  const wrongGraph = structuredClone(summary); wrongGraph.graph.states++;
  await assert.rejects(validateBuildSummaryArtifacts(wrongGraph, generated, false, actualAutomaton, actualInventory), { code: 'HOST_SUMMARY' });
  const missingInventoryEntry = { ...actualInventory, files: actualInventory.files.slice(1) };
  await assert.rejects(validateBuildSummaryArtifacts(summary, generated, false, actualAutomaton, missingInventoryEntry), { code: 'HOST_SUMMARY' });
  await rm(path.join(generated, 'models/control/tlc.log'));
  await assert.rejects(validateBuildSummaryArtifacts(summary, generated, false, actualAutomaton, actualInventory), { code: 'HOST_SUMMARY' });
  const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sgd-host-summary-outside-')));
  t.after(() => rm(outside, { recursive: true, force: true }));
  for (const file of ['tlc.log', 'verification.json']) await writeFile(path.join(outside, file), 'external synthetic evidence\n');
  await rm(path.join(generated, 'models/control'), { recursive: true });
  await symlink(outside, path.join(generated, 'models/control'), 'dir');
  await assert.rejects(validateBuildSummaryArtifacts(summary, generated, false, actualAutomaton, actualInventory), { code: 'HOST_SUMMARY' });
});

test('unknown command cannot coexist with a successful workflow', () => {
  const value = replay();
  addCommand(value, shellCommand(['/fixture/node', '/fixture/scratch/app/unknown.mjs']), 'SGD_HOST_NATIVE_OK ');
  fails(value, 'HOST_COMMAND');
});

test('trailing mutating statements cannot masquerade as an approved helper', () => {
  const value = replay();
  addCommand(value, `${shellCommand(value.commands[0].argv)}; touch '/fixture/changed'`, value.commands[0].marker);
  fails(value, 'HOST_COMMAND');
});

test('a second exact native checker remains forbidden', () => {
  const value = replay();
  const native = value.commands.find(command => command.id === 'native');
  addCommand(value, shellCommand(native.argv), native.marker);
  fails(value, 'HOST_COMMAND');
});

test('an extra successful MCP call remains forbidden', () => {
  const value = replay();
  const original = value.events.find(event => event.type === 'item.completed' && event.item?.tool === 'sgd_build');
  const item = { ...structuredClone(original.item), id: 'extra-mcp' };
  value.events.splice(-1, 0, { type: 'item.started', item: { ...item, status: 'in_progress', result: null } }, { type: 'item.completed', item });
  fails(value, 'HOST_MISSING_TOOL');
});

test('all required context reads are still mandatory', () => {
  const value = replay();
  value.events = value.events.filter(event => !event.item?.command?.includes("'skill'"));
  fails(value, 'HOST_COMMAND');
});

test('file-writing actions remain forbidden', () => {
  const value = replay();
  value.events.splice(-1, 0, { type: 'item.completed', item: { id: 'file-write', type: 'file_change', changes: [{ path: '/fixture/scratch/app/src/main.rs', kind: 'add' }], status: 'completed' } });
  fails(value, 'HOST_ACTION');
});

test('a started action without a terminal event fails', () => {
  const value = replay();
  value.events.splice(-1, 0, { type: 'item.started', item: { id: 'abandoned', type: 'command_execution', command: shellCommand(value.commands[0].argv), status: 'in_progress' } });
  fails(value, 'HOST_EVENT');
});

test('a repeated read completion without its start fails', () => {
  const value = replay();
  const original = value.events.find(event => event.type === 'item.completed' && event.item?.command?.includes("'modeling'"));
  value.events.splice(-1, 0, { type: 'item.completed', item: { ...structuredClone(original.item), id: 'orphan-completion' } });
  fails(value, 'HOST_EVENT');
});

test('native checker must start after check:true completes', () => {
  const value = replay();
  const startIndex = value.events.findIndex(event => event.type === 'item.started' && event.item?.command?.includes('verify-native.mjs'));
  const [start] = value.events.splice(startIndex, 1);
  const checkIndex = value.events.findIndex(event => event.type === 'item.completed' && event.item?.tool === 'sgd_build' && event.item.arguments.check === true);
  value.events.splice(checkIndex, 0, start);
  fails(value, 'HOST_TOOL_ORDER');
});

test('actual approval failure takes precedence over missing later steps', () => {
  const value = replay();
  const index = value.events.findIndex(event => event.type === 'item.completed' && event.item?.tool === 'sgd_build');
  value.events = value.events.slice(0, index + 1);
  Object.assign(value.events[index].item, { status: 'failed', result: null, error: { message: 'MCP tool call requires approval, but approval policy is never' } });
  value.events.push({ type: 'turn.completed' });
  fails(value, 'HOST_APPROVAL');
});

test('failed turn cannot be overridden by successful action records', () => {
  const value = replay();
  value.events.push({ type: 'turn.failed', error: { message: 'native turn failed' } });
  fails(value, 'HOST_TURN');
});

test('quoted paths round-trip through known native shell serialization', () => {
  const argv = ['/fixture/node', "/fixture/path with space/agent's helper.mjs", '$literal'];
  const command = shellCommand(argv);
  assert.deepEqual(commandArgv(command), argv);
  assert.deepEqual(commandArgv(`/bin/zsh -lc ${shellCommand([command])}`), argv);
  for (const source of ['node helper | tee output', 'node $(whoami)', 'node "$HOME/file"', 'node helper\ntrue']) assert.throws(() => commandArgv(source));
});

async function paths(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sgd-host-output-test-')));
  t.after(() => rm(base, { recursive: true }));
  const plugin = path.join(base, 'plugin');
  const original = path.join(base, 'fixture');
  await mkdir(plugin);
  await mkdir(original);
  return { base, plugin, original };
}

test('CLI rejects output through a plugin alias before creating evidence', { skip: process.platform === 'win32' }, async t => {
  const { base, plugin } = await paths(t);
  const alias = path.join(base, 'alias');
  await symlink(plugin, alias, 'dir');
  const script = fileURLToPath(new URL('./verify-codex-host.mjs', import.meta.url));
  // Node cannot act as a native agent. A regression must never reach one.
  const child = spawnSync(process.execPath, [script, '--plugin', plugin, '--out', path.join(alias, 'evidence'), '--jar', path.join(base, 'unused.jar'), '--codex', process.execPath], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /HOST_ARGUMENT: Evidence output must remain physically outside/);
  await assert.rejects(lstat(path.join(plugin, 'evidence')), { code: 'ENOENT' });
});

test('fixture aliases and aliased plugin roots cannot admit internal output', { skip: process.platform === 'win32' }, async t => {
  const { base, plugin, original } = await paths(t);
  const alias = path.join(base, 'fixture-alias');
  const pluginAlias = path.join(base, 'plugin-alias');
  await symlink(original, alias, 'dir');
  await symlink(plugin, pluginAlias, 'dir');
  await assert.rejects(resolveEvidenceOutput(plugin, path.join(alias, 'new', 'evidence'), original), { code: 'HOST_ARGUMENT' });
  await assert.rejects(resolveEvidenceOutput(pluginAlias, path.join(plugin, 'new', 'evidence'), original), { code: 'HOST_ARGUMENT' });
});

test('allowed output captures its physical ancestor without creating directories', { skip: process.platform === 'win32' }, async t => {
  const { base, plugin, original } = await paths(t);
  const sibling = path.join(base, 'plugin-evidence');
  const alias = path.join(base, 'safe-alias');
  await mkdir(sibling);
  await symlink(sibling, alias, 'dir');
  const output = await resolveEvidenceOutput(plugin, path.join(alias, 'new', 'evidence'), original);
  assert.equal(output, path.join(sibling, 'new', 'evidence'));
  await assert.rejects(lstat(path.join(sibling, 'new')), { code: 'ENOENT' });
});

test('dangling output ancestors fail before publication', { skip: process.platform === 'win32' }, async t => {
  const { base, plugin, original } = await paths(t);
  const alias = path.join(base, 'dangling');
  await symlink(path.join(plugin, 'missing'), alias, 'dir');
  await assert.rejects(resolveEvidenceOutput(plugin, path.join(alias, 'evidence'), original), { code: 'HOST_ARGUMENT' });
  await assert.rejects(lstat(path.join(plugin, 'missing')), { code: 'ENOENT' });
});
