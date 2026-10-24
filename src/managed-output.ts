import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readlink, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { GeneratedFile } from './types.js';
import { checkGeneratedOutput } from './output-check.js';
import { compilerFile, prepareArtifacts, preparedFiles, type PreparedArtifacts } from './artifacts.js';

const execute = promisify(execFile);
const inventoryName = '.sgd-generated.json';
const lockName = '.sgd-output.lock';
const journalName = '.sgd-transaction.json';
const retiredPrefix = '.sgd-retired-lock-';
const Inventory = z.object({ version: z.literal(1), files: z.array(z.string().min(1)) }).strict();
const Identity = z.object({
  platform: z.enum(['linux', 'darwin']), host: z.string().min(1),
  boot: z.string().min(1), namespace: z.string().min(1),
}).strict();
const Owner = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('verified'), id: z.string().uuid(), pid: z.number().int().positive(), identity: Identity, start: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('unverifiable'), id: z.string().uuid(), pid: z.number().int().positive() }).strict(),
]);
const Bytes = z.string().refine(value => Buffer.from(value, 'base64').toString('base64') === value, 'Non-canonical base64');
const Journal = z.object({
  version: z.literal(1), owner: z.string().uuid(), root: z.string(),
  inventory: z.object({ before: Bytes.nullable(), after: Bytes }).strict(),
  files: z.array(z.object({ path: z.string().min(1), before: Bytes.nullable(), after: Bytes.nullable() }).strict()),
}).strict();
const RetiredFile = z.object({ path: z.string().regex(/^(?:next\/)*(?:owner\.json|owner\.tmp|closed|closed\.tmp|journal|retirement|file-\d+)$/), bytes: Bytes }).strict();
const Retirement = z.object({
  version: z.literal(1), owner: z.string().uuid(), root: z.string(),
  files: z.array(RetiredFile), directories: z.array(z.string().regex(/^(?:next(?:\/next)*)?$/)),
}).strict();
type LeaseOwner = z.infer<typeof Owner>;
type ProcessIdentity = z.infer<typeof Identity>;
type Transaction = z.infer<typeof Journal>;
type RetiredLock = z.infer<typeof Retirement>;
interface Lease { directory: string; owner: LeaseOwner; ancestors: string[] }

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
function codeIs(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
function fail(message: string): never { throw new Error(`TLC103: ${message}`); }
function incomplete(): never {
  throw new Error('TLC104: incomplete generated-output transaction. Check mode does not recover outputs; rerun generation without --check after resolving the reported owner or file conflict.');
}

// Boot identities deliberately do not recover across machines, boots, or PID namespaces.
async function processIdentity(): Promise<ProcessIdentity | null> {
  try {
    if (process.platform === 'linux') {
      const [boot, namespace] = await Promise.all([
        readFile('/proc/sys/kernel/random/boot_id', 'utf8'), readlink('/proc/self/ns/pid'),
      ]);
      return Identity.parse({ platform: 'linux', host: hostname(), boot: boot.trim(), namespace });
    }
    if (process.platform === 'darwin') {
      const result = await execute('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { timeout: 2_000, maxBuffer: 4_096 });
      return Identity.parse({ platform: 'darwin', host: hostname(), boot: result.stdout.trim(), namespace: 'global' });
    }
  } catch { /* Unavailable identity must not become evidence that another owner is dead. */ }
  return null;
}

async function processStart(pid: number, identity: ProcessIdentity): Promise<string | null> {
  if (identity.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
      if (!start || !/^\d+$/.test(start)) throw new Error('Unrecognized process start identity');
      return start;
    } catch (error) { if (missing(error)) return null; throw error; }
  }
  try {
    const result = await execute('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      timeout: 2_000, maxBuffer: 4_096, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
    const start = result.stdout.trim();
    if (!start) throw new Error('Empty process start identity');
    return start;
  } catch (error) {
    try { process.kill(pid, 0); } catch (probe) { if (codeIs(probe, 'ESRCH')) return null; }
    throw error;
  }
}

async function newOwner(identity: ProcessIdentity | null): Promise<LeaseOwner> {
  const basic = { id: randomUUID(), pid: process.pid };
  if (identity) {
    try {
      const start = await processStart(process.pid, identity);
      if (start) return { kind: 'verified', ...basic, identity, start };
    } catch { /* Writes remain available when process identity cannot be obtained. */ }
  }
  return { kind: 'unverifiable', ...basic };
}

async function flushFile(path: string, bytes: Uint8Array | string): Promise<void> {
  const file = await open(path, 'wx');
  try { await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
}

async function flushDirectory(path: string): Promise<void> {
  // Windows does not support opening a directory this way. No power-loss claim depends on it.
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try { await directory.sync(); }
  catch (error) { if (!codeIs(error, 'EINVAL') && !codeIs(error, 'ENOTSUP')) throw error; }
  finally { await directory.close(); }
}

async function writeOwner(directory: string, owner: LeaseOwner): Promise<void> {
  await flushFile(join(directory, 'owner.tmp'), JSON.stringify(owner));
  await rename(join(directory, 'owner.tmp'), join(directory, 'owner.json'));
  await flushDirectory(directory);
}

async function readOwner(directory: string): Promise<LeaseOwner> {
  await inspectLeaseDirectory(directory);
  try {
    const ownerPath = join(directory, 'owner.json');
    const stat = await lstat(ownerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('output lock has unverifiable owner metadata. Inspect the lock before manual recovery; it will not be expired by age.');
    return Owner.parse(JSON.parse(await readFile(ownerPath, 'utf8')));
  } catch (error) {
    fail('output directory is locked by an unverifiable owner. Legacy empty locks and incomplete owner metadata require manual inspection; no generated file was adopted or removed.');
  }
}

async function inspectLeaseDirectory(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'next') {
      if (!entry.isDirectory() || entry.isSymbolicLink()) fail('output lock has an invalid takeover path');
    } else if (['owner.json', 'owner.tmp', 'closed', 'closed.tmp', 'journal', 'retirement'].includes(entry.name) || /^file-\d+$/.test(entry.name)) {
      if (!entry.isFile() || entry.isSymbolicLink()) fail('output lock contains an invalid staged file; it was preserved');
    } else {
      fail(`output lock contains unrelated entry ${entry.name}; it was preserved. Inspect the lock before manual recovery.`);
    }
  }
}

async function ownerInactive(directory: string, owner: LeaseOwner, identity: ProcessIdentity | null): Promise<boolean> {
  try {
    const closed = join(directory, 'closed');
    const stat = await lstat(closed);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('output lock has invalid release metadata');
    if (await readFile(closed, 'utf8') !== owner.id) fail('output lock has invalid release metadata');
    return true;
  } catch (error) { if (!missing(error)) throw error; }
  if (owner.kind !== 'verified' || !identity || JSON.stringify(owner.identity) !== JSON.stringify(identity)) {
    fail('output directory is locked by an owner whose host, boot, process namespace, or identity cannot be verified. Inspect it manually; lock age is not proof of inactivity.');
  }
  try {
    const start = await processStart(owner.pid, identity);
    return start === null || start !== owner.start;
  } catch {
    fail('output directory is locked and its process identity cannot be checked. Inspect it manually; the owner was not assumed dead.');
  }
}

async function acquire(root: string, check: boolean, owner: LeaseOwner, identity: ProcessIdentity | null): Promise<Lease> {
  const lockPath = join(root, lockName);
  try {
    await mkdir(lockPath);
    await writeOwner(lockPath, owner);
    return { directory: lockPath, owner, ancestors: [] };
  } catch (error) {
    if (!codeIs(error, 'EEXIST')) throw error;
  }
  let directory = lockPath;
  const ancestors: string[] = [];
  for (;;) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('output directory is locked by an unverifiable legacy lock. Inspect the lock before manual recovery.');
    const previous = await readOwner(directory);
    ancestors.push(previous.id);
    const next = join(directory, 'next');
    try {
      const nextStat = await lstat(next);
      if (!nextStat.isDirectory() || nextStat.isSymbolicLink()) fail('output lock has an invalid takeover path');
      directory = next;
      continue;
    } catch (error) { if (!missing(error)) throw error; }
    if (!await ownerInactive(directory, previous, identity)) {
      fail('output directory is locked by a live generator. Use a separate output directory for concurrent builds.');
    }
    if (check) incomplete();
    try {
      await mkdir(next);
      await writeOwner(next, owner);
      return { directory: next, owner, ancestors };
    } catch (error) {
      if (!codeIs(error, 'EEXIST')) throw error;
      directory = next;
    }
  }
}

async function release(root: string, lease: Lease, pending: boolean): Promise<void> {
  if (pending) {
    // No output I/O follows this marker. A later caller can retry the journal even in this process.
    await closeLease(lease);
    return;
  }
  const retirement = join(root, `${retiredPrefix}${lease.owner.id}`);
  const marker = `${retirement}.json`;
  let moved = false;
  try {
    for (const path of [retirement, marker]) {
      try { await lstat(path); }
      catch (error) { if (missing(error)) continue; throw error; }
      fail('refusing to overwrite an existing lock retirement path');
    }
    const record = await snapshotLock(root, lease);
    const temporary = join(lease.directory, 'retirement');
    await flushFile(temporary, JSON.stringify(record));
    await rename(temporary, marker);
    await flushDirectory(root);
    await rename(join(root, lockName), retirement);
    moved = true;
    await cleanupRetirement(root, marker, record);
  } catch (error) {
    if (!moved) await closeLease(lease);
    throw error;
  }
}

async function closeLease(lease: Lease): Promise<void> {
  await flushFile(join(lease.directory, 'closed.tmp'), lease.owner.id);
  await rename(join(lease.directory, 'closed.tmp'), join(lease.directory, 'closed'));
  await flushDirectory(lease.directory);
}

async function snapshotLock(root: string, lease: Lease): Promise<RetiredLock> {
  const base = join(root, lockName);
  const record: RetiredLock = { version: 1, owner: lease.owner.id, root, files: [], directories: [] };
  let directory = base;
  for (;;) {
    await inspectLeaseDirectory(directory);
    record.directories.push(relative(base, directory).split('\\').join('/'));
    let next = false;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'next') { next = true; continue; }
      const path = join(directory, entry.name);
      record.files.push({ path: relative(base, path).split('\\').join('/'), bytes: (await readFile(path)).toString('base64') });
    }
    if (!next) return record;
    directory = join(directory, 'next');
  }
}

async function cleanupRetirement(root: string, marker: string, record: RetiredLock): Promise<void> {
  if (record.root !== root || marker !== join(root, `${retiredPrefix}${record.owner}.json`)) fail('invalid retired output-lock ownership; its files were preserved');
  const base = join(root, `${retiredPrefix}${record.owner}`);
  if (new Set(record.files.map(file => file.path)).size !== record.files.length
    || new Set(record.directories).size !== record.directories.length || !record.directories.includes('')) {
    fail('invalid retired output-lock inventory; its files were preserved');
  }
  // The marker is published before the directory is moved. Missing paths also cover interrupted cleanup.
  for (const directory of record.directories) {
    const path = join(base, directory);
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('retired output lock contains an edited directory; it was preserved');
      for (const entry of await readdir(path)) {
        const child = directory ? `${directory}/${entry}` : entry;
        if (!record.directories.includes(child) && !record.files.some(file => file.path === child)) {
          fail(`retired output lock contains unrelated entry ${child}; it was preserved`);
        }
      }
    } catch (error) { if (!missing(error)) throw error; }
  }
  for (const file of record.files) {
    const path = join(base, file.path);
    const bytes = await currentBytes(root, path);
    if (bytes !== null && bytes !== file.bytes) fail(`retired output lock contains edited file ${file.path}; it was preserved`);
  }
  for (const file of record.files) await rm(join(base, file.path), { force: true });
  for (const directory of [...record.directories].sort((a, b) => b.length - a.length)) {
    try { await rmdir(join(base, directory)); }
    catch (error) { if (!missing(error)) throw error; }
  }
  await rm(marker, { force: true });
}

async function cleanupRetired(root: string, check: boolean): Promise<void> {
  const entries = await readdir(root);
  const retired = entries.filter(name => name.startsWith(retiredPrefix));
  if (retired.length && check) incomplete();
  for (const name of retired.filter(name => name.endsWith('.json'))) {
    const path = join(root, name);
    const bytes = await currentBytes(root, path);
    if (bytes === null) continue;
    let record: RetiredLock;
    try { record = Retirement.parse(JSON.parse(Buffer.from(bytes, 'base64').toString('utf8'))); }
    catch { fail('retired output-lock marker is invalid; its files were preserved'); }
    await cleanupRetirement(root, path, record);
  }
  if ((await readdir(root)).some(name => name.startsWith(retiredPrefix))) {
    fail('retired output lock has no matching cleanup marker; it was preserved for manual inspection');
  }
}

function outputPath(root: string, name: string): string {
  const path = resolve(root, name);
  const rel = relative(root, path);
  const first = rel.split(/[\\/]/)[0];
  if (!name || !rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    || isAbsolute(rel) || first === inventoryName || first === lockName || first === journalName || first?.startsWith(retiredPrefix)) {
    fail('invalid output path');
  }
  return path;
}

async function rejectSymlinks(root: string, path: string): Promise<void> {
  const components = relative(root, path).split(sep);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) fail('generated output cannot traverse a symbolic link');
    } catch (error) { if (missing(error)) return; throw error; }
  }
}

async function currentBytes(root: string, path: string): Promise<string | null> {
  await rejectSymlinks(root, path);
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) fail(`generated output is not a regular file: ${relative(root, path)}`);
    return (await readFile(path)).toString('base64');
  } catch (error) { if (missing(error)) return null; throw error; }
}

function inventory(bytes: string | null): string[] {
  if (bytes === null) return [];
  return Inventory.parse(JSON.parse(Buffer.from(bytes, 'base64').toString('utf8'))).files;
}

function validatePaths(root: string, names: string[]): void {
  const paths = names.map(name => outputPath(root, name));
  if (new Set(paths).size !== paths.length) fail('duplicate output file');
  paths.sort();
  for (const [index, path] of paths.entries()) {
    const next = paths[index + 1];
    if (next?.startsWith(`${path}${process.platform === 'win32' ? '\\' : '/'}`)) {
      fail('output paths cannot contain both a file and its descendant');
    }
  }
}

function validateJournal(root: string, lease: Lease, transaction: Transaction): void {
  if (transaction.root !== root || ![lease.owner.id, ...lease.ancestors].includes(transaction.owner)) {
    fail('incomplete output transaction has no matching lock owner. Preserve its files and inspect the journal manually.');
  }
  let before: string[];
  let after: string[];
  try {
    before = inventory(transaction.inventory.before);
    after = inventory(transaction.inventory.after);
  } catch { fail('incomplete output transaction contains an invalid inventory; its files were preserved'); }
  validatePaths(root, before);
  validatePaths(root, after);
  validatePaths(root, transaction.files.map(file => file.path));
  const union = [...new Set([...before, ...after])].sort();
  if (JSON.stringify(union) !== JSON.stringify(transaction.files.map(file => file.path).sort())) fail('invalid output transaction inventory');
  for (const file of transaction.files) {
    if ((!before.includes(file.path) && file.before !== null) || (after.includes(file.path) === (file.after === null))) {
      fail('invalid output transaction ownership');
    }
  }
}

async function matchesRecorded(root: string, path: string, before: string | null, after: string | null): Promise<string | null> {
  const current = await currentBytes(root, path);
  if (current !== before && current !== after) {
    fail(`incomplete output transaction conflicts with edited file ${relative(root, path)}. The file was preserved; restore the recorded version or choose a new output directory.`);
  }
  return current;
}

async function publish(root: string, lease: Lease, path: string, before: string | null, after: string | null, index: number): Promise<void> {
  if (await matchesRecorded(root, path, before, after) === after) return;
  if (after === null) { await rm(path); return; }
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(lease.directory, `file-${index}`);
  await flushFile(temporary, Buffer.from(after, 'base64'));
  // Recheck after staging; cooperative writers are serialized by the lease.
  await matchesRecorded(root, path, before, after);
  await rename(temporary, path);
}

async function replay(root: string, lease: Lease, transaction: Transaction): Promise<void> {
  validateJournal(root, lease, transaction);
  for (const file of transaction.files) await matchesRecorded(root, outputPath(root, file.path), file.before, file.after);
  await matchesRecorded(root, join(root, inventoryName), transaction.inventory.before, transaction.inventory.after);
  for (const [index, file] of transaction.files.entries()) await publish(root, lease, outputPath(root, file.path), file.before, file.after, index);
  await publish(root, lease, join(root, inventoryName), transaction.inventory.before, transaction.inventory.after, transaction.files.length);
  await flushDirectory(root);
  await rm(join(root, journalName));
  await flushDirectory(root);
}

async function pendingJournal(root: string): Promise<Transaction | null> {
  const bytes = await currentBytes(root, join(root, journalName));
  if (bytes === null) return null;
  try { return Journal.parse(JSON.parse(Buffer.from(bytes, 'base64').toString('utf8'))); }
  catch { fail('incomplete output transaction journal is invalid. Preserve its files and inspect it manually.'); }
}

async function manage(root: string, lease: Lease, files: readonly GeneratedFile[], check: boolean): Promise<void> {
  await cleanupRetired(root, check);
  const pending = await pendingJournal(root);
  if (pending) {
    if (check) incomplete();
    await replay(root, lease, pending);
  }
  const wanted = files.map(file => file.path).sort();
  validatePaths(root, wanted);
  for (const name of wanted) await rejectSymlinks(root, outputPath(root, name));
  const beforeInventory = await currentBytes(root, join(root, inventoryName));
  const previous = inventory(beforeInventory);
  validatePaths(root, previous);
  for (const name of previous) await rejectSymlinks(root, outputPath(root, name));
  if (beforeInventory === null && (await readdir(root)).some(name => name !== lockName)) {
    fail('output directory has no generated-file inventory. Use an empty directory.');
  }
  if (check) {
    const checked = [];
    for (const file of files) {
      const bytes = await currentBytes(root, outputPath(root, file.path));
      checked.push({ file, current: bytes === null ? null : Buffer.from(bytes, 'base64') });
    }
    checkGeneratedOutput({ previous, files: checked });
    return;
  }
  const changes: Transaction['files'] = [];
  const names = [...new Set([...previous, ...wanted])].sort();
  validatePaths(root, names);
  for (const name of names) {
    const before = await currentBytes(root, outputPath(root, name));
    if (!previous.includes(name) && before !== null) fail(`refusing to overwrite unowned output file ${name}`);
    const generated = files.find(file => file.path === name);
    changes.push({ path: name, before, after: generated ? Buffer.from(generated.content).toString('base64') : null });
  }
  const transaction: Transaction = {
    version: 1, owner: lease.owner.id, root, files: changes,
    inventory: { before: beforeInventory, after: Buffer.from(JSON.stringify({ version: 1, files: wanted }, null, 2) + '\n').toString('base64') },
  };
  const temporary = join(lease.directory, 'journal');
  await flushFile(temporary, JSON.stringify(transaction));
  await rename(temporary, join(root, journalName));
  await flushDirectory(root);
  await replay(root, lease, transaction);
}

/** Per-file atomic publication with journaled recovery after a verifiably inactive writer. */
export async function writeGenerated(input: { out: string; files: GeneratedFile[]; check?: boolean }): Promise<void> {
  const prepared = await prepareArtifacts(input.files.map(compilerFile));
  await writePreparedGenerated({ out: input.out, prepared, ...(input.check === undefined ? {} : { check: input.check }) });
}

/** Publish only immutable artifacts whose syntax normalization has completed. */
export async function writePreparedGenerated(input: { out: string; prepared: PreparedArtifacts; check?: boolean }): Promise<void> {
  const files = preparedFiles(input.prepared);
  await mkdir(input.out, { recursive: true });
  const root = await realpath(input.out);
  const identity = await processIdentity();
  const owner = await newOwner(identity);
  const lease = await acquire(root, input.check === true, owner, identity);
  try { await manage(root, lease, files, input.check === true); }
  finally {
    let pending = true;
    try { await lstat(join(root, journalName)); }
    catch (error) { if (missing(error)) pending = false; else throw error; }
    await release(root, lease, pending);
  }
}
