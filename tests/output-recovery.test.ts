import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { watch } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { writeGenerated } from '../src/managed-output.js';
import type { GeneratedFile } from '../src/types.js';

const recoverySupported = process.platform === 'linux' || process.platform === 'darwin';
const oldFiles = [
  { path: 'm-kept.txt', content: 'previous owned file\n' },
  { path: 'z-obsolete.txt', content: 'previous obsolete file\n' },
];
const desired = [
  { path: 'a-new.txt', content: 'newly generated output\n' },
  { path: 'm-kept.txt', content: 'updated owned file\n' },
  ...Array.from({ length: 128 }, (_, index) => ({ path: `n-new-${index}.txt`, content: `new output ${index}\n` })),
];

async function crashAfterPublication(t: TestContext, initial: GeneratedFile[], checkLive = false) {
  const fixture = await mkdtemp(join(tmpdir(), 'sgd-output-recovery-'));
  t.after(async () => { await rm(fixture, { recursive: true, force: true }); });
  const out = join(fixture, 'output');
  await mkdir(out);
  if (initial.length) await writeGenerated({ out, files: initial });
  const helper = join(fixture, 'writer.mjs');
  const config = join(fixture, 'config.json');
  await writeFile(config, JSON.stringify({ out, files: desired }));
  await writeFile(helper, `import {readFile} from 'node:fs/promises';\nimport {writeGenerated} from ${JSON.stringify(pathToFileURL(resolve('src/managed-output.ts')).href)};\nawait writeGenerated(JSON.parse(await readFile(process.argv[2],'utf8')));\n`);
  let child: ChildProcess | undefined;
  let stderr = '';
  let stopped = false;
  let publicationObserved: (() => void) | undefined;
  const published = new Promise<void>(resolveObserved => { publicationObserved = resolveObserved; });
  const observer = watch(out, (event, filename) => {
    if (event === 'rename' && filename?.toString() === 'a-new.txt' && child && !stopped) {
      stopped = true;
      child.kill('SIGSTOP');
      publicationObserved?.();
    }
  });
  child = spawn(process.execPath, ['--import', 'tsx', helper, config], { cwd: resolve('.'), stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.on('data', bytes => { stderr += String(bytes); });
  const terminal = once(child, 'close');
  const watchdog = setTimeout(() => { child?.kill('SIGKILL'); }, 15_000);
  try {
    await Promise.race([
      published,
      terminal.then(([code, signal]) => { throw new Error(`writer terminated before observed publication: ${code}/${signal}: ${stderr}`); }),
    ]);
    // A real filesystem observer and OS signals select the cut; the filesystem APIs are not mocked.
    if (checkLive) {
      await assert.rejects(writeGenerated({ out, files: desired }), /locked by a live generator/);
    }
    child.kill('SIGKILL');
    const [code, signal] = await terminal;
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL', stderr);
    await access(join(out, '.sgd-transaction.json'));
    assert.equal(await readFile(join(out, 'a-new.txt'), 'utf8'), desired[0]?.content);
  } finally {
    clearTimeout(watchdog);
    observer.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await terminal;
    }
  }
  return { fixture, out };
}

async function outputSnapshot(out: string) {
  const entries = await readdir(out, { withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.isFile()) files[entry.name] = (await readFile(join(out, entry.name))).toString('base64');
  }
  return files;
}

test('a real terminated first publication recovers automatically, rejects the live owner, and repeats successfully', { skip: !recoverySupported }, async t => {
  const { out } = await crashAfterPublication(t, [], true);
  await assert.rejects(access(join(out, '.sgd-generated.json')));
  await writeGenerated({ out, files: desired });
  await writeGenerated({ out, files: desired });
  await writeGenerated({ out, files: desired, check: true });
  for (const file of desired) assert.equal(await readFile(join(out, file.path), 'utf8'), file.content);
  assert.deepEqual(JSON.parse(await readFile(join(out, '.sgd-generated.json'), 'utf8')), { version: 1, files: desired.map(file => file.path).sort() });
  await assert.rejects(access(join(out, '.sgd-output.lock')));
  await assert.rejects(access(join(out, '.sgd-transaction.json')));
});

test('a real interrupted upgrade is not repaired by --check and then recovers additions, replacements, and removals', { skip: !recoverySupported }, async t => {
  const { out } = await crashAfterPublication(t, oldFiles);
  await writeFile(join(out, 'user-notes.txt'), 'keep unrelated notes');
  await mkdir(join(out, 'user-directory'));
  await writeFile(join(out, 'user-directory', 'important.txt'), 'keep unrelated child');
  const before = await outputSnapshot(out);
  const lockBefore = await readdir(join(out, '.sgd-output.lock'));
  await assert.rejects(writeGenerated({ out, files: desired, check: true }), /TLC104: incomplete.*Check mode does not recover/);
  assert.deepEqual(await outputSnapshot(out), before);
  assert.deepEqual(await readdir(join(out, '.sgd-output.lock')), lockBefore);
  await writeGenerated({ out, files: desired });
  await writeGenerated({ out, files: desired, check: true });
  await assert.rejects(access(join(out, 'z-obsolete.txt')));
  assert.equal(await readFile(join(out, 'm-kept.txt'), 'utf8'), 'updated owned file\n');
  assert.equal(await readFile(join(out, 'user-notes.txt'), 'utf8'), 'keep unrelated notes');
  assert.equal(await readFile(join(out, 'user-directory', 'important.txt'), 'utf8'), 'keep unrelated child');
});

test('recovery preserves an edited newly published file and can retry after the recorded bytes are restored', { skip: !recoverySupported }, async t => {
  const { out } = await crashAfterPublication(t, oldFiles);
  await writeFile(join(out, 'a-new.txt'), 'user edited this generated file');
  const before = await outputSnapshot(out);
  await assert.rejects(writeGenerated({ out, files: desired }), /conflicts with edited file a-new.txt.*preserved/);
  assert.deepEqual(await outputSnapshot(out), before);
  await writeFile(join(out, 'a-new.txt'), 'newly generated output\n');
  // The prior call closed its lease; a retry in this same still-live process is permitted.
  await writeGenerated({ out, files: desired });
  await writeGenerated({ out, files: desired, check: true });
});

test('recovery preflights a late removal conflict without rewriting any earlier output', { skip: !recoverySupported }, async t => {
  const { out } = await crashAfterPublication(t, oldFiles);
  await writeFile(join(out, 'z-obsolete.txt'), 'user changed the obsolete file after the crash');
  const before = await outputSnapshot(out);
  await assert.rejects(writeGenerated({ out, files: desired }), /conflicts with edited file z-obsolete.txt/);
  assert.deepEqual(await outputSnapshot(out), before);
  assert.equal((await readFile(join(out, 'm-kept.txt'))).toString('base64'), before['m-kept.txt']);
});

test('recovery can finish an interrupted generation before publishing a different requested output set', { skip: !recoverySupported }, async t => {
  const { out } = await crashAfterPublication(t, oldFiles);
  await writeFile(join(out, 'user-notes.txt'), 'unrelated content');
  const replacement = [{ path: 'replacement.txt', content: 'new model generation' }];
  await writeGenerated({ out, files: replacement });
  await writeGenerated({ out, files: replacement, check: true });
  assert.deepEqual((await readdir(out)).sort(), ['.sgd-generated.json', 'replacement.txt', 'user-notes.txt']);
  assert.equal(await readFile(join(out, 'user-notes.txt'), 'utf8'), 'unrelated content');
});

test('recovery refuses a replacement symlink and preserves the protected external file', { skip: !recoverySupported }, async t => {
  const { fixture, out } = await crashAfterPublication(t, oldFiles);
  const protectedFile = join(fixture, 'protected.txt');
  await writeFile(protectedFile, 'do not touch');
  await rm(join(out, 'a-new.txt'));
  await symlink(protectedFile, join(out, 'a-new.txt'));
  const inventoryBefore = await readFile(join(out, '.sgd-generated.json'), 'utf8');
  await assert.rejects(writeGenerated({ out, files: desired }), /symbolic link/);
  assert.equal(await readFile(protectedFile, 'utf8'), 'do not touch');
  assert.equal(await readFile(join(out, '.sgd-generated.json'), 'utf8'), inventoryBefore);
});

test('concurrent recovery contenders preserve one live lease and publish one complete generation', { skip: !recoverySupported }, async t => {
  const { out } = await crashAfterPublication(t, oldFiles);
  const results = await Promise.allSettled([
    writeGenerated({ out, files: desired }),
    writeGenerated({ out, files: desired }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.match(String(rejected.reason), /locked/);
  await writeGenerated({ out, files: desired, check: true });
});

test('a stale lock from a different boot cannot authorize recovery', { skip: !recoverySupported }, async t => {
  const { out } = await crashAfterPublication(t, oldFiles);
  const ownerPath = join(out, '.sgd-output.lock', 'owner.json');
  const owner = z.object({ identity: z.object({ boot: z.string() }).passthrough() }).passthrough().parse(JSON.parse(await readFile(ownerPath, 'utf8')));
  owner.identity.boot = 'a-different-boot-cannot-prove-inactivity';
  await writeFile(ownerPath, JSON.stringify(owner));
  const before = await outputSnapshot(out);
  await assert.rejects(writeGenerated({ out, files: desired }), /boot.*cannot be verified/);
  assert.deepEqual(await outputSnapshot(out), before);
});

test('an unrelated file added inside a dead lock is preserved instead of recursively cleaned', { skip: !recoverySupported }, async t => {
  const { out } = await crashAfterPublication(t, oldFiles);
  const notes = join(out, '.sgd-output.lock', 'my-notes.txt');
  await writeFile(notes, 'preserve even a misplaced user note');
  const before = await outputSnapshot(out);
  await assert.rejects(writeGenerated({ out, files: desired }), /unrelated entry my-notes.txt.*preserved/);
  assert.equal(await readFile(notes, 'utf8'), 'preserve even a misplaced user note');
  assert.deepEqual(await outputSnapshot(out), before);
});

test('empty locks and unverifiable owner identities fail closed without changing user files', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'sgd-output-unverifiable-'));
  t.after(async () => { await rm(fixture, { recursive: true, force: true }); });
  const out = join(fixture, 'empty-lock');
  await mkdir(out);
  await writeFile(join(out, '.sgd-output.lock'), '');
  await writeFile(join(out, 'user.txt'), 'keep');
  await assert.rejects(writeGenerated({ out, files: [] }), /unverifiable lock/);
  assert.equal(await readFile(join(out, 'user.txt'), 'utf8'), 'keep');
  const unknown = join(fixture, 'unknown');
  await mkdir(join(unknown, '.sgd-output.lock'), { recursive: true });
  await writeFile(join(unknown, '.sgd-output.lock', 'owner.json'), JSON.stringify({ kind: 'unverifiable', id: '9954edf9-a448-4ce4-bdf4-77615a039bfe', pid: process.pid }));
  await assert.rejects(writeGenerated({ out: unknown, files: [] }), /identity cannot be verified/);
  assert.deepEqual(await readdir(unknown), ['.sgd-output.lock']);
});

test('ordinary generation retains output ownership, volatile checks, and symlink refusal', async t => {
  const out = await mkdtemp(join(tmpdir(), 'sgd-output-ordinary-'));
  t.after(async () => { await rm(out, { recursive: true, force: true }); });
  const files = [{ path: 'owned.txt', content: 'value' }, { path: 'receipt.json', content: '{"stable":1,"time":1}', volatile: true, stableJsonKeys: ['stable'] }];
  await writeGenerated({ out, files });
  await writeFile(join(out, 'user.txt'), 'keep');
  await assert.rejects(writeGenerated({ out, files: [{ path: 'user.txt', content: 'overwrite' }] }), /unowned/);
  await writeFile(join(out, 'receipt.json'), '{"stable":1,"time":2}');
  await writeGenerated({ out, files, check: true });
  await writeFile(join(out, 'receipt.json'), '{"stable":2,"time":2}');
  await assert.rejects(writeGenerated({ out, files, check: true }), /TLC104: stale receipt field stable/);
  if (process.platform !== 'win32') {
    await rm(join(out, 'owned.txt'));
    await symlink(join(out, 'user.txt'), join(out, 'owned.txt'));
    await assert.rejects(writeGenerated({ out, files }), /symbolic link/);
    assert.equal(await readFile(join(out, 'user.txt'), 'utf8'), 'keep');
  }
});

test('POSIX backslashes remain literal path characters and cannot hide a parent symlink', { skip: process.platform === 'win32' }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'sgd-output-literal-backslash-'));
  t.after(async () => { await rm(fixture, { recursive: true, force: true }); });
  const out = join(fixture, 'output');
  const external = join(fixture, 'external');
  await mkdir(external);
  await writeFile(join(external, 'protected.txt'), 'preserve external content');
  const files = [{ path: 'literal\\directory/owned.txt', content: 'valid POSIX path' }];
  await writeGenerated({ out, files });
  await writeGenerated({ out, files, check: true });
  assert.equal(await readFile(join(out, 'literal\\directory', 'owned.txt'), 'utf8'), 'valid POSIX path');
  await symlink(external, join(out, 'link\\literal'));
  await assert.rejects(writeGenerated({ out, files: [...files, { path: 'link\\literal/new.txt', content: 'outside output' }] }), /symbolic link/);
  await assert.rejects(access(join(external, 'new.txt')));
  assert.equal(await readFile(join(external, 'protected.txt'), 'utf8'), 'preserve external content');
  await writeGenerated({ out, files, check: true });
});

test('generation and lock release need write permission only in the existing output, not its parent', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'sgd-output-parent-permission-'));
  const parent = join(fixture, 'read-only-parent');
  const out = join(parent, 'writable-output');
  await mkdir(out, { recursive: true });
  await chmod(parent, 0o555);
  t.after(async () => {
    await chmod(parent, 0o755);
    await rm(fixture, { recursive: true, force: true });
  });
  const files = [{ path: 'owned.txt', content: 'generated content' }];
  await writeGenerated({ out, files });
  await writeGenerated({ out, files, check: true });
  assert.equal(await readFile(join(out, 'owned.txt'), 'utf8'), 'generated content');
  assert.deepEqual((await readdir(out)).sort(), ['.sgd-generated.json', 'owned.txt']);
});
