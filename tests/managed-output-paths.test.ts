import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeGenerated, validateManagedOutputPaths } from '../src/managed-output.js';
import { captureOutputLocation, recheckOutputLocation } from '../src/contract-output.js';

test('common writer and contract preflight refuse reserved aliases from previous inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sgd-reserved-output-'));
  try {
    for (const [index, name] of [
      '.SGD-GENERATED.JSON', '.SGD-OUTPUT.LOCK/owner.json', '.SGD-TRANSACTION.JSON', '.SGD-RETIRED-LOCK-test/owner.json',
    ].entries()) {
      const out = join(root, String(index)); await mkdir(out);
      const inventory = join(out, '.sgd-generated.json');
      const original = JSON.stringify({ version: 1, files: [name] });
      await writeFile(inventory, original);
      await assert.rejects(recheckOutputLocation(await captureOutputLocation(out), {
        files: [{ path: 'next.json' }], inputs: [], directories: [],
      }), /invalid output path/);
      await assert.rejects(writeGenerated({ out, files: [{ path: 'next.json', content: 'new' }] }), /invalid output path/);
      assert.equal(await readFile(inventory, 'utf8'), original);
      assert.deepEqual(await readdir(out), ['.sgd-generated.json']);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shared path validation refuses case and canonical-Unicode aliases and ancestor collisions', () => {
  for (const names of [['A.json', 'a.json'], ['é.json', 'e\u0301.json'], ['Upper', 'upper/child.json']]) {
    assert.throws(() => validateManagedOutputPaths(resolveRoot(), names), /case-insensitive.*collide/);
  }
  assert.equal(validateManagedOutputPaths(resolveRoot(), ['a.json', 'nested/b.json']).length, 2);
});

function resolveRoot(): string { return join(tmpdir(), 'sgd-path-validation'); }

test('case-only output migration refuses before deleting or replacing the previous artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sgd-case-migration-'));
  try {
    const out = join(root, 'out');
    await writeGenerated({ out, files: [{ path: 'Value.json', content: 'original' }] });
    const inventory = await readFile(join(out, '.sgd-generated.json'));
    await assert.rejects(writeGenerated({ out, files: [{ path: 'value.json', content: 'replacement' }] }), /case-insensitive.*collide/);
    assert.equal(await readFile(join(out, 'Value.json'), 'utf8'), 'original');
    assert.deepEqual(await readFile(join(out, '.sgd-generated.json')), inventory);
    assert.deepEqual((await readdir(out)).sort(), ['.sgd-generated.json', 'Value.json'].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});
