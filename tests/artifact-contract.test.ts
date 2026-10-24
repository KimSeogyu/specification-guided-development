import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const jar = process.env.TLA2TOOLS_JAR;

test('artifact contract admits canonical publication and rejects bad ordering and captured-evidence mutation', { skip: !jar, timeout: 120_000 }, async () => {
  assert.ok(jar);
  const root = await mkdtemp(join(tmpdir(), 'sgd-artifact-contract-'));
  try {
    for (const [mode, invariant] of [
      ['Good', null],
      ['BadOrder', 'CanonicalPublished'],
      ['BadOwnership', 'EvidencePreserved'],
    ] satisfies [string, string | null][]) {
      const args = ['-Xmx512m', '-cp', resolve(jar), 'tlc2.TLC', '-workers', '1',
        '-metadir', join(root, mode), '-config', resolve(`docs/contracts/ArtifactLifecycle${mode}.cfg`),
        resolve('docs/contracts/ArtifactLifecycle.tla')];
      if (invariant === null) {
        const result = await execute('java', args, { cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
        assert.match(result.stdout, /Model checking completed\. No error has been found\./);
      } else {
        await assert.rejects(execute('java', args, { cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }), error => {
          assert.ok(error instanceof Error && 'stdout' in error && typeof error.stdout === 'string');
          assert.ok('code' in error && error.code === 12, 'The pinned TLC process must finish with its invariant-violation exit code.');
          assert.match(error.stdout, new RegExp(`Invariant ${invariant} is violated`));
          assert.match(error.stdout, /The behavior up to this point is/);
          return true;
        });
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
