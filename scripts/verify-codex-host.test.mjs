import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { commandArgv, shellCommand, validateProtocol } from './verify-codex-host.mjs';

const captured = JSON.parse(await readFile(new URL('../tests/fixtures/codex-host-events.json', import.meta.url), 'utf8'));
const replay = () => structuredClone(captured);
const verify = value => validateProtocol(value.events, value.scratch, value.commands);
const fails = (value, code) => assert.throws(() => verify(value), error => error.code === code);
function addCommand(value, command, marker) {
  const item = { id: 'extra-command', type: 'command_execution', command, aggregated_output: '', exit_code: null, status: 'in_progress' };
  const index = value.events.findLastIndex(event => event.type === 'turn.completed');
  value.events.splice(index, 0, { type: 'item.started', item }, { type: 'item.completed', item: { ...item, aggregated_output: marker, exit_code: 0, status: 'completed' } });
}

test('captured successful protocol admits repeated identical read-only helpers', () => {
  const value = replay();
  const checked = verify(value);
  assert.equal(checked.calls.length, 5);
  assert.equal(checked.matchedCommands.get('native').length, 1);
  assert.equal(checked.matchedCommands.get('modeling').length, 2);
  assert.equal(checked.matchedCommands.get('partition').length, 2);
  assert.equal(checked.matchedCommands.get('application').length, 2);
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
