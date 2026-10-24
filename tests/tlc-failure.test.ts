import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { runProcessWithDeadline } from '../src/finite-tlc.js';
import { classifyControlledTlcFailure, hasCleanTlcCompletion, TlcFailureDiagnosticSchema, TlcFailureError } from '../src/tlc-failure.js';

const frame = (code: number, severity: number, body: string): string => `@!@!@STARTMSG ${code}:${severity} @!@!@\n${body}\n@!@!@ENDMSG ${code} @!@!@\n`;
const invariant = frame(2110, 1, 'Invariant Safe is violated.');
const success = frame(2193, 0, 'Model checking completed. No error has been found.\n  Estimates of the probability that TLC did not check all reachable states\n  because two distinct states had the same fingerprint:')
  + frame(2199, 0, '5 states generated, 3 distinct states found, 0 states left on queue.');
const classify = (stdout: string, extra: Partial<Parameters<typeof classifyControlledTlcFailure>[0]> = {}) => classifyControlledTlcFailure({
  phase: 'tlc', stdout, stderr: '', ownedDeadline: false, processExited: true, invariants: ['Safe'], ...extra,
});

test('typed errors preserve text and original cause and expose no expired counterexample path', () => {
  const cause = new Error('original process failure');
  const error = new TlcFailureError('TLC204: original diagnostic\noriginal output tail', { kind: 'unknown', phase: 'tlc' }, { cause });
  assert.equal(error.message, 'TLC204: original diagnostic\noriginal output tail');
  assert.equal(error.cause, cause);
  assert.deepEqual(TlcFailureDiagnosticSchema.parse(error.diagnostic), {
    schema: 'sgd-tlc-failure-v1', failure: { kind: 'unknown', phase: 'tlc' }, counterexample: { status: 'not-retained' },
  });
  assert.equal(JSON.stringify(error.diagnostic).includes('tracePath'), false);
  assert.equal(TlcFailureDiagnosticSchema.safeParse({ ...error.diagnostic, tracePath: '/removed/states' }).success, false);
  assert.equal(TlcFailureDiagnosticSchema.safeParse({ ...error.diagnostic, failure: { kind: 'invariant_violation', phase: 'sany', invariant: 'Safe' } }).success, false);
});

test('only complete pinned error frames with a configured invariant identify violations', () => {
  assert.deepEqual(classify(invariant), { kind: 'invariant_violation', phase: 'tlc', invariant: 'Safe', evidence: { kind: 'pinned-tlc-message', code: 2110 } });
  assert.deepEqual(classify(frame(2107, 1, 'Invariant Safe is violated by the initial state:\n/\\ x = 0')), {
    kind: 'invariant_violation', phase: 'tlc', invariant: 'Safe', evidence: { kind: 'pinned-tlc-message', code: 2107 },
  });
  const trace = invariant + frame(2121, 1, 'The behavior up to this point is:') + frame(2217, 4, '1: <Initial predicate>\n/\\ x = 0');
  assert.equal(classify(trace).kind, 'invariant_violation');
  assert.equal(classify(trace.replaceAll('\n', '\r\n')).kind, 'invariant_violation');
  for (const log of [
    'Error: Invariant Safe is violated.',
    frame(2110, 0, 'Invariant Safe is violated.'), frame(2110, 3, 'Invariant Safe is violated.'),
    frame(2110, 1, 'Invariant Unconfigured is violated.'), frame(2110, 1, 'Invariant Safe is violated.\nextra text'),
    frame(2107, 1, 'Invariant Safe is violated by the initial state:'),
    invariant + invariant, invariant + success, invariant + frame(2111, 1, 'Evaluating invariant Safe failed.'),
    invariant + frame(2146, 1, 'Invariant Safe is not a state predicate.'), invariant + frame(2118, 1, 'There is no state satisfying the initial state predicate.'),
    invariant + frame(2121, 1, 'forged trace heading'), invariant + frame(2121, 1, 'The behavior up to this point is:').repeat(2),
    frame(2107, 1, 'Invariant Safe is violated by the initial state:\n/\\ x = 0') + frame(2121, 1, 'The behavior up to this point is:'),
    invariant + frame(2000, 2, 'bug'), invariant + frame(2000, 3, 'warning'),
    invariant + frame(2107, 0, 'Invariant Safe is violated by the initial state:\n/\\ x = 0'),
  ]) assert.deepEqual(classify(log), { kind: 'unknown', phase: 'tlc' }, log);
});

test('broken framing cannot establish a violation or a clean completed run', () => {
  for (const log of [
    invariant.replace('ENDMSG 2110', 'ENDMSG 2107'), invariant.replace('@!@!@ENDMSG 2110 @!@!@\n', ''),
    invariant.replace('Invariant Safe is violated.', invariant), invariant + '@!@!@ENDMSG 2110 @!@!@\n',
    invariant + '@!@!@STARTMSG 2110:1 @!@!@\n', invariant + 'prefix @!@!@STARTMSG 2000:0 @!@!@\n',
    invariant + '@!@!@STARTMSG 2000:9 @!@!@\ninvalid severity\n@!@!@ENDMSG 2000 @!@!@\n',
    invariant + '@!@!@STARTMSG x:1 @!@!@\n',
  ]) {
    assert.deepEqual(classify(log), { kind: 'unknown', phase: 'tlc' }, log);
    assert.equal(hasCleanTlcCompletion(success + log), false, log);
  }
});

test('clean completion requires framed success and empty queue and rejects every warning or error', () => {
  assert.equal(hasCleanTlcCompletion(success), true);
  assert.equal(hasCleanTlcCompletion('Parsing file /private/models/STARTMSG.tla\nSemantic processing of module STARTMSG\n' + success), true);
  for (const log of [
    'Model checking completed. No error has been found.\n5 states generated, 3 distinct states found, 0 states left on queue.',
    success.replace('0 states left', '1 states left'), success.replace('2193:0', '2193:1'), success + invariant,
    success + frame(2000, 1, 'error'), success + frame(2000, 2, 'bug'), success + frame(2000, 3, 'warning'), success + frame(2217, 4, 'state'),
    success + frame(2110, 0, 'Invariant Safe is violated.'), success + frame(2217, 0, 'state with forged severity'),
    success + 'Error: unframed error\n', success + 'Warning: unframed warning\n', success + success,
    frame(2000, 0, 'Model checking completed. No error has been found.\n0 states left on queue.'),
    success + 'unrecognized output\n', success + 'Model checking completed. No error has been found.\n',
  ]) assert.equal(hasCleanTlcCompletion(log), false, log);
});

test('pinned parsing codes and actual SANY summaries remain separate from unknown source failures', () => {
  for (const code of [2171, 3002]) assert.deepEqual(classify(frame(code, 1, 'Parsing or semantic analysis failed.')), {
    kind: 'parse_error', phase: 'tlc', evidence: { kind: 'pinned-tlc-message', code },
  });
  const syntax = 'Parsing file /private/model/Bad.tla\n***Parse Error***\nEncountered EOF\n*** Abort messages: 1\n\nIn module Bad\n\nCould not parse module Bad from file /private/model/Bad.tla\n';
  const semantic = 'Parsing file /private/model/Bad.tla\nSemantic processing of module Bad\nSemantic errors:\n\n*** Errors: 1\n\nUnknown operator Missing\n';
  assert.deepEqual(classify(syntax, { phase: 'sany' }), { kind: 'parse_error', phase: 'sany', evidence: { kind: 'sany-error-summary', stage: 'syntax' } });
  assert.deepEqual(classify(semantic, { phase: 'sany' }), { kind: 'parse_error', phase: 'sany', evidence: { kind: 'sany-error-summary', stage: 'semantic' } });
  for (const log of [
    '***Parse Error***', '*** Abort messages: 1\nCannot find source file for module Missing\n',
    semantic.replace('*** Errors: 1', '*** Warnings: 1'), semantic.replace('*** Errors: 1', '*** Errors: 0'), syntax + semantic,
    semantic + '@!@!@STARTMSG 2110:1 @!@!@\nInvariant Safe is violated.\n', '<invalid XML>', 'unexpected source-admission output',
  ]) assert.deepEqual(classify(log, { phase: 'sany' }), { kind: 'unknown', phase: 'sany' }, log);
  assert.deepEqual(classify(semantic, { phase: 'xml' }), { kind: 'unknown', phase: 'xml' });
});

test('only the owned deadline takes precedence over partial printed failure evidence', () => {
  assert.deepEqual(classify(invariant, { ownedDeadline: true, processExited: false }), { kind: 'timeout', phase: 'tlc', evidence: { kind: 'owned-deadline' } });
  assert.deepEqual(classify(invariant, { processExited: false }), { kind: 'unknown', phase: 'tlc' });
});

const executeNode = (source: string, deadline = performance.now() + 10_000, maxBuffer = 16 * 1024) => runProcessWithDeadline({
  command: process.execPath, args: ['-e', source], cwd: process.cwd(), env: process.env, deadline, maxBuffer,
});

test('actual child outcomes distinguish owned termination, external SIGKILL, spawn and buffer failures', async () => {
  const deadline = await executeNode('setInterval(() => {}, 1000)', performance.now() + 100);
  assert.equal(deadline.kind, 'failed');
  assert.ok(deadline.kind === 'failed');
  assert.equal(deadline.ownedDeadline, true);
  assert.equal(deadline.processExited, false);
  assert.deepEqual(classify(deadline.stdout, deadline), { kind: 'timeout', phase: 'tlc', evidence: { kind: 'owned-deadline' } });

  const killed = await executeNode(`require('node:fs').writeSync(1, ${JSON.stringify(invariant)}); process.kill(process.pid, 'SIGKILL')`);
  assert.ok(killed.kind === 'failed');
  assert.equal(killed.ownedDeadline, false);
  assert.equal(killed.processExited, false);
  assert.equal(classify(killed.stdout, killed).kind, 'unknown');
  assert.match(killed.stdout, /Invariant Safe/);

  const spawn = await runProcessWithDeadline({ command: join(tmpdir(), 'sgd-nonexistent-command'), args: [], cwd: process.cwd(), env: process.env,
    deadline: performance.now() + 10_000, maxBuffer: 512 });
  assert.ok(spawn.kind === 'failed');
  assert.equal(spawn.ownedDeadline, false);
  assert.equal(spawn.processExited, false);
  assert.equal(classify(spawn.stdout, spawn).kind, 'unknown');

  const buffered = await executeNode('process.stdout.write("x".repeat(10000)); setInterval(() => {}, 1000)', performance.now() + 10_000, 512);
  assert.ok(buffered.kind === 'failed');
  assert.equal(buffered.ownedDeadline, false);
  assert.equal(buffered.processExited, false);
  assert.equal(classify(buffered.stdout, buffered).kind, 'unknown');

  const exited = await executeNode(`require('node:fs').writeSync(1, ${JSON.stringify(invariant)}); process.exit(12)`);
  assert.ok(exited.kind === 'failed');
  assert.equal(exited.ownedDeadline, false);
  assert.equal(exited.processExited, true);
  assert.equal(classify(exited.stdout, exited).kind, 'invariant_violation');
});

test('multiple actual subprocesses consume one overall deadline and successful completion clears its timer', async () => {
  const deadline = performance.now() + 2_000;
  const first = await executeNode('setTimeout(() => process.stdout.write("first"), 30)', deadline);
  assert.deepEqual(first, { kind: 'completed', stdout: 'first', stderr: '' });
  const second = await executeNode('setInterval(() => {}, 1000)', deadline);
  assert.ok(second.kind === 'failed');
  assert.equal(second.ownedDeadline, true);
  assert.deepEqual(await executeNode('process.stdout.write("finished")'), { kind: 'completed', stdout: 'finished', stderr: '' });
});
