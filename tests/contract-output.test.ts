import assert from 'node:assert/strict';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { captureOutputLocation, recheckOutputLocation, type CapturedInputLocation, type CapturedSourceDirectory } from '../src/contract-output.js';

async function fixture(work: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'sgd-contract-output-'));
  try { await work(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
async function original(path: string): Promise<CapturedInputLocation> {
  const stat = await lstat(path, { bigint: true });
  return { path, physicalPath: await realpath(path), device: stat.dev, inode: stat.ino };
}
async function sourceDirectory(path: string): Promise<CapturedSourceDirectory> { return { path, physicalPath: await realpath(path) }; }
const files = [{ path: 'comparison.json' }];
const refusal = /TLC103:/;

test('missing separate output resolves without mkdir and path prefixes are not containment', async () => {
  await fixture(async root => {
    const source = join(root, 'models'); await mkdir(source);
    const out = join(root, 'models-output', 'not-created');
    const location = await captureOutputLocation(out);
    await recheckOutputLocation(location, { files, inputs: [], directories: [await sourceDirectory(source)] });
    await assert.rejects(readdir(out), { code: 'ENOENT' });
  });
});

test('output equal to, inside, or containing a watched source directory is refused', async () => {
  await fixture(async root => {
    const source = join(root, 'source'); await mkdir(source);
    for (const out of [source, join(source, 'generated'), root]) {
      await assert.rejects(recheckOutputLocation(await captureOutputLocation(out), { files, inputs: [], directories: [await sourceDirectory(source)] }), refusal);
    }
    assert.deepEqual(await readdir(source), []);
  });
});

test('protected root, binding, or JAR files cannot be contained in output', async () => {
  await fixture(async root => {
    const out = join(root, 'candidate'); await mkdir(out);
    const source = join(out, 'root.json'); await writeFile(source, 'original input');
    await assert.rejects(recheckOutputLocation(await captureOutputLocation(out), { files, inputs: [await original(source)], directories: [] }), refusal);
    assert.equal(await readFile(source, 'utf8'), 'original input');
  });
});

test('existing and missing output aliases into a watched source directory are refused', async () => {
  await fixture(async root => {
    const source = join(root, 'source'); await mkdir(source);
    const alias = join(root, 'selected'); await symlink(source, alias, 'junction');
    const watched = [await sourceDirectory(source)];
    for (const out of [alias, join(alias, 'missing', 'generated')]) {
      await assert.rejects(recheckOutputLocation(await captureOutputLocation(out), { files, inputs: [], directories: watched }), refusal);
    }
    assert.deepEqual(await readdir(source), []);
  });
});

test('an ancestor symlink swap cannot redirect a captured missing output', async () => {
  await fixture(async root => {
    const first = join(root, 'first'); const second = join(root, 'second');
    await mkdir(first); await mkdir(second);
    const alias = join(root, 'selected'); await symlink(first, alias, 'junction');
    const location = await captureOutputLocation(join(alias, 'missing'));
    await rm(alias); await symlink(second, alias, 'junction');
    await assert.rejects(recheckOutputLocation(location, { files, inputs: [], directories: [] }), /ancestor changed|root changed/);
    assert.deepEqual(await readdir(first), []); assert.deepEqual(await readdir(second), []);
  });
});

test('replacing an existing output directory at the same path changes its captured identity', async () => {
  await fixture(async root => {
    const out = join(root, 'out'); await mkdir(out);
    const location = await captureOutputLocation(out);
    await rename(out, join(root, 'retained')); await mkdir(out);
    await assert.rejects(recheckOutputLocation(location, { files, inputs: [], directories: [] }), /ancestor changed/);
  });
});

test('planned target hardlinks to captured originals are refused without altering bytes', async () => {
  await fixture(async root => {
    const source = join(root, 'root.json'); await writeFile(source, 'original input');
    const out = join(root, 'out'); await mkdir(out);
    await link(source, join(out, 'comparison.json'));
    await assert.rejects(recheckOutputLocation(await captureOutputLocation(out), { files, inputs: [await original(source)], directories: [] }), /aliases a captured original/);
    assert.equal(await readFile(source, 'utf8'), 'original input');
    assert.equal(await readFile(join(out, 'comparison.json'), 'utf8'), 'original input');
  });
});

test('obsolete inventory targets and the inventory itself cannot hardlink original inputs', async () => {
  await fixture(async root => {
    const source = join(root, 'root.json'); await writeFile(source, 'original input');
    const out = join(root, 'out'); await mkdir(out);
    const input = await original(source);
    const inventory = join(out, '.sgd-generated.json');
    await writeFile(inventory, JSON.stringify({ version: 1, files: ['obsolete.json'] }));
    await link(source, join(out, 'obsolete.json'));
    await assert.rejects(recheckOutputLocation(await captureOutputLocation(out), { files, inputs: [input], directories: [] }), /aliases a captured original/);
    await rm(join(out, 'obsolete.json')); await rm(inventory); await link(source, inventory);
    await assert.rejects(recheckOutputLocation(await captureOutputLocation(out), { files, inputs: [input], directories: [] }), /aliases a captured original/);
    assert.equal(await readFile(source, 'utf8'), 'original input');
  });
});

test('managed target directory aliases are rejected before following them to original inputs', async () => {
  await fixture(async root => {
    const source = join(root, 'source'); await mkdir(source);
    const originalPath = join(source, 'root.json'); await writeFile(originalPath, 'original input');
    const out = join(root, 'out'); await mkdir(out);
    await symlink(source, join(out, 'evidence'), 'junction');
    await assert.rejects(recheckOutputLocation(await captureOutputLocation(out), { files: [{ path: 'evidence/root.json' }], inputs: [await original(originalPath)], directories: [] }), /symbolic link/);
    assert.equal(await readFile(originalPath, 'utf8'), 'original input');
  });
});

test('prior inventory paths are validated before obsolete-target traversal', async () => {
  await fixture(async root => {
    const out = join(root, 'out'); await mkdir(out);
    for (const names of [['../outside.json'], ['.sgd-output.lock/entry'], ['one/../two.json', 'two.json'], ['two.json', 'two.json']]) {
      await writeFile(join(out, '.sgd-generated.json'), JSON.stringify({ version: 1, files: names }));
      await assert.rejects(recheckOutputLocation(await captureOutputLocation(out), { files, inputs: [], directories: [] }), refusal);
    }
    await writeFile(join(out, '.sgd-generated.json'), '{"version":2,"files":[]}');
    await assert.rejects(recheckOutputLocation(await captureOutputLocation(out), { files, inputs: [], directories: [] }), /invalid.*inventory/);
  });
});

test('case-insensitive and Unicode-equivalent planned targets are refused before creating output', async () => {
  await fixture(async root => {
    const out = join(root, 'not-created');
    const location = await captureOutputLocation(out);
    for (const names of [
      ['metadata/Baseline/A.tla', 'metadata/baseline/a.tla'],
      ['metadata/\u00e9.tla', 'metadata/e\u0301.tla'],
      ['Evidence', 'evidence/source.json'],
      ['Evidence', 'evidence-backup.json', 'evidence/source.json'],
    ]) {
      await assert.rejects(recheckOutputLocation(location, { files: names.map(path => ({ path })), inputs: [], directories: [] }), /case-insensitive.*collide/);
      await assert.rejects(readdir(out), { code: 'ENOENT' });
    }
  });
});

test('case-insensitive collisions include obsolete inventory targets without changing published inventory', async () => {
  await fixture(async root => {
    const out = join(root, 'out'); await mkdir(out);
    const inventory = join(out, '.sgd-generated.json');
    for (const names of [['metadata/Baseline/A.tla'], ['metadata/Baseline/A.tla', 'metadata/baseline/a.tla']]) {
      const original = JSON.stringify({ version: 1, files: names });
      await writeFile(inventory, original);
      await assert.rejects(recheckOutputLocation(await captureOutputLocation(out), { files: [{ path: 'metadata/baseline/a.tla' }], inputs: [], directories: [] }), /case-insensitive.*collide/);
      assert.equal(await readFile(inventory, 'utf8'), original);
      assert.deepEqual(await readdir(out), ['.sgd-generated.json']);
    }
  });
});

test('case-insensitive comparison preserves POSIX literal backslash components', { skip: process.platform === 'win32' }, async () => {
  await fixture(async root => {
    const out = join(root, 'not-created');
    await recheckOutputLocation(await captureOutputLocation(out), { files: [
      { path: 'literal\\name/A.json' }, { path: 'literal/name/a.json' },
    ], inputs: [], directories: [] });
    await assert.rejects(readdir(out), { code: 'ENOENT' });
  });
});

test('an existing independent output directory alias retains its physical publication root', async () => {
  await fixture(async root => {
    const physical = join(root, 'physical'); await mkdir(physical);
    const alias = join(root, 'selected'); await symlink(physical, alias, 'junction');
    const location = await captureOutputLocation(alias);
    assert.equal(location.out, await realpath(physical));
    await recheckOutputLocation(location, { files, inputs: [], directories: [] });
  });
});

test('POSIX backslashes remain literal path characters in managed evidence paths', { skip: process.platform === 'win32' }, async () => {
  await fixture(async root => {
    const out = join(root, 'out'); await mkdir(out);
    await recheckOutputLocation(await captureOutputLocation(out), { files: [{ path: 'literal\\name/evidence.json' }], inputs: [], directories: [] });
    const source = join(root, 'source'); await mkdir(source);
    await symlink(source, join(out, 'literal\\name'), 'junction');
    await assert.rejects(recheckOutputLocation(await captureOutputLocation(out), { files: [{ path: 'literal\\name/evidence.json' }], inputs: [], directories: [] }), /symbolic link/);
  });
});
