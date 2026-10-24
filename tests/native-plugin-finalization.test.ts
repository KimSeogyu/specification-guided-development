import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { finalizeOperation } from '../scripts/verify-native-plugin-lifecycle.mjs';

test('a failed owned command remains the primary error when finalization also fails', async () => {
  const child = spawnSync(process.execPath, ['-e', 'process.stderr.write("owned command failed"); process.exit(7);'], {
    encoding: 'utf8', timeout: 2_000, killSignal: 'SIGKILL', maxBuffer: 4_096,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 7);
  const primary = Object.assign(new Error('The owned command did not complete successfully.'), {
    code: 'COMMAND_FAILED', details: { exitCode: child.status, stderr: child.stderr },
  });
  const denied = Object.assign(new Error('Controlled cleanup-denial regression; no signal is sent.'), { code: 'EPERM' });
  const observations: unknown[] = [];
  await assert.rejects(finalizeOperation({
    operation: async () => { throw primary; },
    cleanup: async () => { throw denied; },
    observe: (outcome: unknown) => { observations.push(outcome); },
  }), error => error === primary);
  assert.deepEqual(observations, [{ operation: { status: 'failed', error: primary }, cleanup: { status: 'failed', error: denied } }]);
});

test('a completed operation retains its result in diagnostics but fails if cleanup cannot be proved', async () => {
  const value = { completed: true, scope: 'local finalization regression; no native agent run' };
  const denied = Object.assign(new Error('Controlled cleanup-denial regression; no signal is sent.'), { code: 'EPERM' });
  const observations: unknown[] = [];
  await assert.rejects(finalizeOperation({
    operation: async () => value,
    cleanup: async () => { throw denied; },
    observe: (outcome: unknown) => { observations.push(outcome); },
  }), error => error === denied);
  assert.deepEqual(observations, [{ operation: { status: 'succeeded', value }, cleanup: { status: 'failed', error: denied } }]);
});

test('successful finalization returns the actual result after its evidence is observed', async () => {
  const order: string[] = [];
  const value = await finalizeOperation({
    operation: async () => { order.push('operation'); return 'completed value'; },
    cleanup: async () => { order.push('cleanup'); },
    observe: () => { order.push('observe'); },
  });
  assert.equal(value, 'completed value');
  assert.deepEqual(order, ['operation', 'cleanup', 'observe']);
});
