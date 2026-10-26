import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { capturedFile, compilerFile, prepareArtifacts } from '../src/artifacts.js';
import { writeGenerated, writePreparedGenerated } from '../src/managed-output.js';
import type { GeneratedFile } from '../src/types.js';

async function snapshot(directory: string, prefix = ''): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) for (const [path, content] of await snapshot(join(directory, entry.name), `${name}/`)) files.set(path, content);
    else files.set(name, await readFile(join(directory, entry.name)));
  }
  return files;
}

test('captured model source evidence remains byte exact during TypeScript publication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sgd-artifact-evidence-'));
  try {
    const evidence = 'captured bytes are not generated code\r\n  evidence must stay unchanged\r\n';
    const prepared = await prepareArtifacts([
      compilerFile({ path: 'owner.ts', content: 'export const generated = true;\n' }),
      capturedFile({ path: 'evidence/original.tla', content: evidence }),
    ]);
    assert.equal(prepared.files.find(file => file.path === 'evidence/original.tla')?.content, evidence);
    await writePreparedGenerated({ out: directory, prepared });
    assert.equal(await readFile(join(directory, 'evidence/original.tla'), 'utf8'), evidence);
    await writePreparedGenerated({ out: directory, prepared, check: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('prepared artifacts copy and freeze draft records and stable receipt fields', async () => {
  const draft: GeneratedFile = { path: 'receipt.json', content: '{"one":1}\n', stableJsonKeys: ['one'] };
  const prepared = await prepareArtifacts([compilerFile(draft)]);
  draft.content = 'edited after preparation';
  draft.stableJsonKeys?.push('two');
  const file = prepared.files.find(candidate => candidate.path === draft.path);
  assert.ok(file);
  assert.equal(file.content, '{"one":1}\n');
  assert.deepEqual(file.stableJsonKeys, ['one']);
  assert.ok(Object.isFrozen(prepared.files));
  assert.ok(Object.isFrozen(file));
  assert.ok(Object.isFrozen(file.stableJsonKeys));
  assert.equal(Reflect.set(file, 'content', 'edited prepared file'), false);
});

test('runtime callers cannot forge readiness through a reflected constructor or plain value', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sgd-artifact-forge-'));
  const out = join(directory, 'uncreated');
  try {
    const prepared = await prepareArtifacts([compilerFile({ path: 'checked.txt', content: 'checked' })]);
    const constructor = Object.getPrototypeOf(prepared).constructor;
    const forged: unknown = Reflect.construct(constructor, [{ files: [{ path: 'owner.ts', content: 'unprepared output' }] }]);
    for (const value of [null, {}, forged]) {
      // Reflection models an untyped JavaScript caller at the exported publisher boundary.
      await assert.rejects(async () => {
        await Reflect.apply(writePreparedGenerated, undefined, [{ out, prepared: value }]);
      }, /TLC103: publication requires prepared artifacts/);
      await assert.rejects(readdir(out), { code: 'ENOENT' });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('publication reads checked bytes from private storage when the public files getter changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sgd-artifact-getter-'));
  const prepared = await prepareArtifacts([compilerFile({ path: 'owner.ts', content: 'export const generated = true;\n' })]);
  const canonical = prepared.files.find(file => file.path === 'owner.ts')?.content;
  assert.ok(canonical);
  const prototype = Object.getPrototypeOf(prepared);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'files');
  assert.ok(descriptor);
  try {
    Object.defineProperty(prototype, 'files', { ...descriptor, get: () => [{ path: 'owner.ts', content: 'forged raw source' }] });
    assert.equal(prepared.files[0]?.content, 'forged raw source');
    await writePreparedGenerated({ out: directory, prepared });
    assert.equal(await readFile(join(directory, 'owner.ts'), 'utf8'), canonical);
    const before = await snapshot(directory);
    await writePreparedGenerated({ out: directory, prepared, check: true });
    assert.deepEqual(await snapshot(directory), before);
  } finally {
    Object.defineProperty(prototype, 'files', descriptor);
    await rm(directory, { recursive: true, force: true });
  }
});

test('freshness refuses a semantically equivalent TypeScript source edit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sgd-artifact-stale-'));
  try {
    const raw = 'export const answer = 42;\n';
    const edited = 'export const answer=42;\n';
    const prepared = await prepareArtifacts([compilerFile({ path: 'owner.ts', content: raw })]);
    const canonical = prepared.files.find(file => file.path === 'owner.ts')?.content;
    assert.ok(canonical);
    assert.equal(canonical, raw);
    await writePreparedGenerated({ out: directory, prepared });
    await writeFile(join(directory, 'owner.ts'), edited);
    const before = await snapshot(directory);
    await assert.rejects(writePreparedGenerated({ out: directory, prepared, check: true }), /TLC104: stale generated file owner.ts/);
    assert.deepEqual(await snapshot(directory), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
