#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const fixture = join(repository, 'tests/fixtures/rust-codec-recipe');
const limits = Object.freeze({ files: 4096, fileBytes: 16 * 1024 * 1024, totalBytes: 128 * 1024 * 1024 });
const collector = 'crates/collector/src/';
const leaves = ['funding_codec.rs', 'sgd_wire.rs'];
const columns = [
  ['symbol', 'symbol', 'string'], ['raw_calc_time_us', 'raw_calc_time', 'i64'],
  ['funding_time_us', 'funding_time', 'i64'], ['interval_hours', 'interval_hours', 'i64'],
  ['rate_ticks', 'rate', 'i64'], ['event_ts_us', 'event_ts', 'i64'],
  ['available_ts_us', 'available_ts', 'i64'], ['received_ts_us', 'received_ts', 'i64'],
  ['schema_version', 'schema_version', 'u32'],
];
let phase = 'arguments';

class ProbeError extends Error {}

function requireCondition(condition, message) {
  if (!condition) throw new ProbeError(message);
}

function decode(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function paths(bytes) {
  requireCondition(bytes.length === 0 || bytes.at(-1) === 0, 'Git returned an incomplete path inventory');
  return bytes.length === 0 ? [] : decode(bytes).slice(0, -1).split('\0');
}

function safePath(root, path) {
  requireCondition(path.length > 0 && !/[\\:\x00-\x1f\x7f]/.test(path) && !isAbsolute(path), 'Tracked path is not an ordinary portable relative path');
  requireCondition(path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'), 'Tracked path can escape the source copy');
  const destination = resolve(root, path);
  const child = relative(root, destination);
  requireCondition(child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child), 'Tracked path can escape the source copy');
  return destination;
}

async function git(root, ...arguments_) {
  const result = await execute('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root, ...arguments_], {
    encoding: 'buffer', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return result.stdout;
}

async function gitState(root) {
  const tracked = await git(root, 'ls-files', '-z', '--cached', '--full-name');
  const staged = await git(root, 'ls-files', '-z', '--stage', '--full-name');
  const names = paths(tracked);
  requireCondition(names.length > 0 && names.length <= limits.files && new Set(names).size === names.length, 'Tracked inventory is empty, unmerged, duplicated, or exceeds its bound');
  const entries = paths(staged);
  requireCondition(entries.length === names.length, 'Tracked index inventory changed or is unmerged');
  for (let index = 0; index < entries.length; index++) {
    const entry = /^(100644|100755) [a-f0-9]+ 0\t(.+)$/u.exec(entries[index]);
    requireCondition(entry !== null && entry[2] === names[index], 'The tracked index contains a symlink, gitlink, unmerged entry, or unsupported file mode');
    safePath(root, names[index]);
  }
  return { tracked, staged, names };
}

function sameGitState(before, after) {
  requireCondition(before.tracked.equals(after.tracked) && before.staged.equals(after.staged), 'Tracked Git list or index changed during the probe');
}

async function readOrdinary(root, path) {
  const target = safePath(root, path);
  const parts = path.split('/');
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    const info = await lstat(parent);
    requireCondition(info.isDirectory() && !info.isSymbolicLink(), 'A tracked source parent is not an ordinary directory');
  }
  const before = await lstat(target);
  requireCondition(before.isFile() && !before.isSymbolicLink() && Number.isSafeInteger(before.size) && before.size <= limits.fileBytes, 'A tracked source is not a bounded ordinary file');
  requireCondition(await realpath(target) === target, 'A tracked source resolves through a symlink');
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    requireCondition(opened.isFile() && before.dev === opened.dev && before.ino === opened.ino && before.size === opened.size && before.mtimeMs === opened.mtimeMs && before.ctimeMs === opened.ctimeMs, 'A tracked source changed while opening it');
    const bounded = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bounded.length) {
      const { bytesRead } = await handle.read(bounded, length, bounded.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const bytes = bounded.subarray(0, length);
    const after = await handle.stat();
    requireCondition(bytes.length <= limits.fileBytes && after.size === bytes.length && opened.size === after.size && opened.mtimeMs === after.mtimeMs && opened.ctimeMs === after.ctimeMs, 'A tracked source changed while reading it');
    const current = await lstat(target);
    requireCondition(current.isFile() && !current.isSymbolicLink() && after.dev === current.dev && after.ino === current.ino && after.size === current.size && after.mtimeMs === current.mtimeMs && after.ctimeMs === current.ctimeMs, 'A tracked source changed after reading it');
    return { bytes, executable: (before.mode & 0o111) !== 0 };
  } finally {
    await handle.close();
  }
}

async function requireAbsent(path) {
  try { await lstat(path); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new ProbeError('The temporary codec fixture conflicts with an existing application path');
}

async function noLeafConflicts(root) {
  for (const name of leaves) {
    await requireAbsent(safePath(root, `${collector}${name}`));
    await requireAbsent(safePath(root, `${collector}${name.slice(0, -3)}`));
  }
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function copyTracked(root, destination, state) {
  const captured = new Map();
  let totalBytes = 0;
  for (const path of state.names) {
    const { bytes, executable } = await readOrdinary(root, path);
    totalBytes += bytes.length;
    requireCondition(totalBytes <= limits.totalBytes, 'Tracked source copy exceeds its total byte bound');
    const target = safePath(destination, path);
    await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: 'wx', mode: executable ? 0o700 : 0o600 });
    captured.set(path, { bytes: bytes.length, sha256: digest(bytes) });
  }
  return { captured, totalBytes };
}

async function originalUnchanged(requested, root, before, captured) {
  requireCondition(await realpath(requested) === root, 'The original application root changed during the probe');
  sameGitState(before, await gitState(root));
  await noLeafConflicts(root);
  for (const [path, baseline] of captured) {
    const { bytes } = await readOrdinary(root, path);
    requireCondition(bytes.length === baseline.bytes && digest(bytes) === baseline.sha256, 'Original tracked working-tree bytes changed during the probe');
  }
  sameGitState(before, await gitState(root));
}

function checkedReport(report) {
  assert.equal(report.profile, 'rust-codec-recipe-v1');
  assert.equal(report.scope, 'selected-codec-and-native-constructor-closure');
  assert.equal(report.storageAuthority, false);
  assert.equal(report.discovery.scope, 'discovered-targets-only');
  assert.equal(report.row.name, 'FundingFact');
  assert.equal(report.row.rustPath, 'crate::vision::FundingFact');
  assert.deepEqual(report.columns.map(column => [column.column, column.field, column.scalar]), columns);
  assert.deepEqual(report.row.fields.map(field => [field.name, field.codec.kind, field.payload, field.provenance]), columns.map(([, field, scalar]) => [field, scalar, field !== 'received_ts', field === 'received_ts']));
  assert.ok(report.sources.some(source => source.path === `${collector}vision/rows.rs`));
  for (const name of leaves) assert.ok(report.sources.some(source => source.path === `${collector}${name}`));
  assert.equal(report.entrypoints.encode.file, `${collector}funding_codec.rs`);
  assert.equal(report.entrypoints.decode.file, `${collector}funding_codec.rs`);
  assert.equal(report.wire.file, `${collector}sgd_wire.rs`);
}

function codecDiagnostic(error) {
  if (!(error instanceof Error)) return undefined;
  for (const line of error.message.split('\n')) {
    const start = line.indexOf('{');
    if (start < 0) continue;
    try {
      const value = JSON.parse(line.slice(start));
      if (value?.ruleId === 'TLC309' && value.profile === 'rust-codec-recipe-v1' && value.storageAuthority === false && value.file === `${collector}funding_codec.rs` && Number.isSafeInteger(value.line) && value.line > 0 && Number.isSafeInteger(value.column) && value.column > 0) {
        return { ruleId: value.ruleId, file: value.file, line: value.line, column: value.column };
      }
    } catch { /* The public API prefixes the native JSON diagnostic with context. */ }
  }
  return undefined;
}

async function rejectedWithSource(invoke) {
  let diagnostic;
  await assert.rejects(invoke, error => {
    diagnostic = codecDiagnostic(error);
    return diagnostic !== undefined;
  });
  return diagnostic;
}

async function verify() {
  requireCondition(process.argv.length === 4 && process.argv[2] === '--application' && process.argv[3].length > 0, 'Usage: node scripts/verify-codec-recipe.mjs --application PATH');
  const requested = resolve(process.argv[3]);
  const root = await realpath(requested);
  requireCondition((await lstat(root)).isDirectory(), 'The application root must be an ordinary Git working-tree directory');
  const top = decode(await git(root, 'rev-parse', '--show-toplevel')).trimEnd();
  requireCondition(await realpath(top) === root, 'The application must be the Git working-tree root');
  phase = 'capture tracked application sources';
  const before = await gitState(root);
  await noLeafConflicts(root);
  const directory = await mkdtemp(join(tmpdir(), 'sgd-actual-codec-'));
  let evidence;
  try {
    await chmod(directory, 0o700);
    const application = join(directory, 'application');
    await mkdir(application, { mode: 0o700 });
    const { captured, totalBytes } = await copyTracked(root, application, before);
    await originalUnchanged(requested, root, before, captured);
    phase = 'add temporary Funding codec leaves';
    const binding = JSON.parse(decode((await readOrdinary(fixture, 'codec-binding.json')).bytes));
    let addedBytes = 0;
    for (const name of leaves) {
      const { bytes } = await readOrdinary(join(fixture, 'parangsae'), `${collector}${name}`);
      await writeFile(safePath(application, `${collector}${name}`), bytes, { flag: 'wx', mode: 0o600 });
      addedBytes += bytes.length;
    }
    const library = safePath(application, `${collector}lib.rs`);
    const originalLibrary = decode(await readFile(library));
    requireCondition(!/\bmod\s+(?:r#)?(?:funding_codec|sgd_wire)\b/u.test(originalLibrary), 'The collector library already declares a selected codec fixture module');
    const declarations = '\nmod funding_codec;\nmod sgd_wire;\n';
    await writeFile(library, originalLibrary + declarations);
    addedBytes += Buffer.byteLength(declarations);
    phase = 'analyze and recheck the copied application';
    const { analyzeCodecRecipe, recheckCodecRecipe } = await import(new URL('../dist/codec-recipe.js', import.meta.url));
    const report = await analyzeCodecRecipe({ application, binding });
    checkedReport(report);
    await recheckCodecRecipe({ report });
    await originalUnchanged(requested, root, before, captured);
    phase = 'reject a same-scalar encoder field substitution';
    const codecPath = safePath(application, `${collector}funding_codec.rs`);
    const codec = decode(await readFile(codecPath));
    const from = 'raw_calc_time_us: row.raw_calc_time.micros(),';
    const to = 'raw_calc_time_us: row.funding_time.micros(),';
    requireCondition(codec.split(from).length === 2, 'The fixture does not contain exactly one expected encoder expression');
    const mutationLine = codec.slice(0, codec.indexOf(from)).split('\n').length;
    await writeFile(codecPath, codec.replace(from, to));
    const mutation = await rejectedWithSource(() => analyzeCodecRecipe({ application, binding }));
    assert.equal(mutation.line, report.entrypoints.encode.line);
    const staleReport = await rejectedWithSource(() => recheckCodecRecipe({ report }));
    assert.deepEqual(staleReport, mutation);
    phase = 'restore and recheck original recipe evidence';
    await writeFile(codecPath, codec);
    await recheckCodecRecipe({ report });
    await originalUnchanged(requested, root, before, captured);
    evidence = {
      version: 1, probe: 'actual-parangsae-funding-codec-source-copy', passed: true,
      source: {
        kind: 'tracked-current-working-tree-bytes', commitTree: false, atomicSnapshot: false,
        untrackedFilesCopied: false, existingTrackedGeneratedModules: 'preserved',
        originalTrackedListIndexAndBytesRechecked: true, porcelainStatus: 'not-invoked', originalApplicationWrites: false, applicationBuilt: false,
        copiedFiles: before.names.length, copiedBytes: totalBytes, temporaryAddedBytes: addedBytes, limits,
      },
      report: {
        profile: report.profile, scope: report.scope, storageAuthority: report.storageAuthority,
        discoveryScope: report.discovery.scope, nativeRow: report.row.name, nativeFields: report.row.fields.length,
        columns: report.columns.map(column => ({ column: column.column, field: column.field, scalar: column.scalar })),
        encode: report.entrypoints.encode, decode: report.entrypoints.decode, wire: report.wire,
        capturedSources: report.sources.length,
      },
      checks: { initialRecheck: 'passed', changedEncoderExpressionLine: mutationLine, sameScalarSubstitution: mutation, originalReportAfterSubstitution: staleReport, restoredRecheck: 'passed' },
      limitsOfEvidence: ['source-copy-only', 'working-tree-not-commit-tree', 'discovery-is-not-all-target-effect-admission', 'no-Parquet-or-resource-ownership-authority'],
    };
  } finally {
    phase = evidence ? 'remove private source copy' : phase;
    await rm(directory, { recursive: true, force: true });
  }
  return { ...evidence, cleanup: 'private-source-copy-removed' };
}

try {
  console.log(JSON.stringify(await verify(), null, 2));
} catch (error) {
  console.error(JSON.stringify({ version: 1, probe: 'actual-parangsae-funding-codec-source-copy', passed: false, phase, message: (error instanceof Error ? error.message : String(error)).slice(0, 4000) }));
  process.exitCode = 1;
}
