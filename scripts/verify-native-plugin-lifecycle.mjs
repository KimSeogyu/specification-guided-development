#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startGitHttpServer } from './native-plugin-lifecycle/git-http.mjs';
import { verifyNativeMcp } from './native-plugin-lifecycle/codex-mcp.mjs';

const pluginName = 'specification-guided-development';
const commandTimeout = 55_000;
const outputLimit = 8 * 1024 * 1024;
const packageLimits = { files: 10_000, logicalBytes: 256 * 1024 * 1024 };
const phaseNames = ['preflight', 'publish-a', 'install-a', 'discover-a', 'publish-b', 'refresh-and-update', 'discover-b'];
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

class TrialFailure extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'TrialFailure';
    this.code = code;
    this.details = details;
  }
}

function requireThat(condition, code, message, details) {
  if (!condition) throw new TrialFailure(code, message, details);
}

export function parseArguments(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return null;
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    requireThat(['--host', '--from', '--to', '--out'].includes(key) && argv[index + 1] && !Object.hasOwn(options, key.slice(2)), 'ARGUMENTS', 'Use --host codex|claude-code --from COMPLETE_PLUGIN_DIR_A --to COMPLETE_PLUGIN_DIR_B --out NEW_EVIDENCE_DIR.');
    options[key.slice(2)] = argv[index + 1];
  }
  requireThat(['codex', 'claude-code'].includes(options.host) && options.from && options.to && options.out, 'ARGUMENTS', 'All four options are required. The evidence directory must not exist; its parent must exist.');
  return options;
}

function environmentFor(host, scratch) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:GIT_|ANTHROPIC|OPENAI|CLAUDE_CODE_OAUTH|CODEX_API_KEY|AWS_|AZURE_|GOOGLE_APPLICATION_CREDENTIALS)/i.test(key) || /(?:^|_)(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|TOKEN)$/i.test(key) || ['PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT'].includes(key)) delete env[key];
  }
  if (host === 'codex') env.CODEX_HOME = path.join(scratch, 'native-home');
  else {
    env.CLAUDE_CONFIG_DIR = path.join(scratch, 'native-home');
    env.CLAUDE_CODE_PLUGIN_CACHE_DIR = path.join(scratch, 'native-home', 'plugins');
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = path.join(scratch, 'empty-git-config');
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'credential.helper';
  env.GIT_CONFIG_VALUE_0 = '';
  env.NO_PROXY = [env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
  env.no_proxy = [env.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
  env.COPYFILE_DISABLE = '1';
  requireThat(env.HOME === process.env.HOME, 'HOME_CHANGED', 'The verifier must preserve ordinary HOME.');
  return env;
}

export function redactor(replacements) {
  return value => {
    let text = String(value);
    for (const [actual, replacement] of [...replacements].filter(([actual]) => actual).sort((a, b) => b[0].length - a[0].length)) text = text.split(actual).join(replacement);
    return text
      .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+/g, '[redacted-token]')
      .replace(/("(?:authorization|api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|token)"\s*:\s*)(?:"(?:\\.|[^"\\])*"|[^,}\r\n]+)/gi, '$1"[redacted]"')
      .replace(/(\bauthorization\s*[:=]\s*)[^\r\n]+/gi, '$1[redacted]')
      .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
      .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[redacted]')
      .replace(/(?:[A-Za-z]:[\\/]|\/)(?:Users|home|private|tmp|var|Volumes|System|opt|Applications|usr|etc)[^\s"'<>]*/g, '{machine-path}');
  };
}

function sanitize(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => sanitize(item, redact));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(?:authorization|api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|token)$/i.test(key) ? '[redacted]' : sanitize(item, redact)]));
  return value;
}

const failureSummary = error => ({ code: error?.code ?? 'UNEXPECTED', message: error?.message ?? String(error), ...(error?.details === undefined ? {} : { details: error.details }) });

/** Record finalization separately, and never replace an operation failure with a cleanup failure. */
export async function finalizeOperation({ operation, cleanup, observe }) {
  let result;
  try { result = { status: 'succeeded', value: await operation() }; }
  catch (error) { result = { status: 'failed', error }; }
  let finalized;
  try { await cleanup(); finalized = { status: 'succeeded' }; }
  catch (error) { finalized = { status: 'failed', error }; }
  let observation;
  try { await observe({ operation: result, cleanup: finalized }); observation = { status: 'succeeded' }; }
  catch (error) { observation = { status: 'failed', error }; }
  if (result.status === 'failed') throw result.error;
  if (finalized.status === 'failed') throw finalized.error;
  if (observation.status === 'failed') throw observation.error;
  return result.value;
}

function processAction(record, signal, outcome, code) {
  record.actions ??= [];
  const last = record.actions.at(-1);
  if (signal === 0 && !code && last?.signal === 0 && last.outcome === outcome && !last.code) { last.repetitions = (last.repetitions ?? 1) + 1; return; }
  record.actions.push({ signal, outcome, ...(code ? { code } : {}) });
  if (record.actions.length > 24) record.actions.shift();
}

function processSignal(record, signal) {
  try {
    process.kill(-record.child.pid, signal);
    processAction(record, signal, signal === 0 ? 'present' : 'sent');
    return true;
  } catch (error) {
    processAction(record, signal, error.code === 'ESRCH' ? 'absent' : 'error', error.code);
    if (error.code === 'ESRCH') return false;
    throw new TrialFailure(error.code ?? 'PROCESS_SIGNAL', `The verifier could not ${signal === 0 ? 'inspect' : 'signal'} its owned process group.`, { ownedPid: record.child.pid, signal, code: error.code });
  }
}

function processEvidence(record) {
  return { ownedPid: record.child.pid ?? null, childClosed: record.childClosed === true, exitCode: record.child.exitCode, signalCode: record.child.signalCode, stopped: record.stopped === true, stopAttempts: record.stopAttempts ?? 0, actions: structuredClone(record.actions ?? []) };
}

function alive(record) {
  if (record.stopped) return false;
  if (!record.child.pid) return false;
  if (process.platform === 'win32') return record.child.exitCode === null && record.child.signalCode === null;
  return processSignal(record, 0);
}

async function performStop(record) {
  record.stopAttempts = (record.stopAttempts ?? 0) + 1;
  const running = alive(record);
  if (process.platform === 'win32') {
    if (running) await new Promise(resolve => {
      const killer = spawn('taskkill', ['/pid', String(record.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => { killer.kill(); resolve(); }, 5_000);
      killer.once('error', () => { clearTimeout(timer); resolve(); });
      killer.once('close', () => { clearTimeout(timer); resolve(); });
    });
  } else if (running) {
    processSignal(record, 'SIGTERM');
    for (let attempt = 0; attempt < 20 && alive(record); attempt += 1) await sleep(50);
    if (alive(record)) {
      processSignal(record, 'SIGKILL');
      for (let attempt = 0; attempt < 20 && alive(record); attempt += 1) await sleep(50);
    }
  }
  requireThat(!alive(record), 'PROCESS_LIVE', 'The owned process group did not stop.');
  if (!record.childClosed) {
    let timer;
    const closed = await Promise.race([record.closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 2_000); })]);
    clearTimeout(timer);
    requireThat(closed, 'PROCESS_CHILD_NOT_CLOSED', 'The owned child did not close after its process group disappeared.');
  }
  record.stopped = true;
}

function stop(record) {
  if (!record || record.stopped) return Promise.resolve();
  if (record.stopAttempt) return record.stopAttempt;
  const attempt = performStop(record).finally(() => { if (record.stopAttempt === attempt) record.stopAttempt = undefined; });
  record.stopAttempt = attempt;
  return attempt;
}

function requestStop(record) {
  void stop(record).catch(error => { record.stopError = error; });
}

function startProcess(state, command, args, cwd = state.app) {
  requireThat(!state.interrupted, 'INTERRUPTED', 'The trial was interrupted.');
  const child = spawn(command, args, { cwd, env: state.env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const record = { child, command, args };
  state.processes.add(record);
  child.stdin.on('error', error => { record.stdinError = error.code; });
  child.stdout.on('error', error => { record.streamError = error.code; requestStop(record); });
  child.stderr.on('error', error => { record.streamError = error.code; requestStop(record); });
  record.closed = new Promise(resolve => {
    child.once('error', error => { record.error = error; });
    child.once('close', (code, signal) => { record.childClosed = true; resolve({ exitCode: code, signal, error: record.error?.code }); });
  });
  return record;
}

async function run(state, label, command, args, { cwd = state.app, allowFailure = false, timeout = commandTimeout } = {}) {
  const record = startProcess(state, command, args, cwd);
  let stdout = '';
  let stderr = '';
  let tooLarge = false;
  let timedOut = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  record.child.stdout.on('data', chunk => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= outputLimit) stdout += chunk.toString('utf8');
    else { tooLarge = true; requestStop(record); }
  });
  record.child.stderr.on('data', chunk => {
    stderrBytes += chunk.length;
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8_192);
  });
  record.child.stdin.end();
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => { timedOut = true; requestStop(record); resolve({ exitCode: null, signal: null, error: 'COMMAND_TIMEOUT' }); }, timeout);
  });
  const result = await Promise.race([record.closed, deadline]);
  clearTimeout(timer);
  const evidence = { label, command, args, ...result, ...(record.streamError ? { streamError: record.streamError } : {}), timedOut, outputLimitExceeded: tooLarge, stdoutBytes, stderrBytes };
  if (stderr.trim()) evidence.stderr = state.redact(stderr.trim()).slice(-4_096);
  if ((result.exitCode !== 0 || timedOut || tooLarge || result.error) && stdout.trim()) evidence.stdoutDiagnostic = state.redact(stdout.trim()).slice(-4_096);
  return finalizeOperation({
    operation: async () => {
      if (!allowFailure) requireThat(result.exitCode === 0 && !timedOut && !tooLarge && !result.error && !record.streamError, 'COMMAND_FAILED', `${label} did not complete successfully.`, evidence);
      return { ...result, timedOut, tooLarge, stdout, stderr, evidence };
    },
    cleanup: async () => { await stop(record); },
    observe: ({ operation, cleanup }) => {
      evidence.process = processEvidence(record);
      if (operation.status === 'failed') evidence.operationFailure = { code: operation.error?.code ?? 'UNEXPECTED', message: operation.error?.message ?? String(operation.error) };
      if (cleanup.status === 'failed') evidence.cleanupFailure = failureSummary(cleanup.error);
      state.receipt.commands.push(evidence);
    },
  });
}

function lastJson(result, label) {
  try { return JSON.parse(result.stdout.trim()); } catch {}
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  try { return JSON.parse(lines.at(-1)); }
  catch { throw new TrialFailure('NATIVE_JSON', `${label} did not return JSON.`, { stdoutTail: result.stdout.slice(-4_096) }); }
}

const select = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));

async function nativeMutation(state, label, args) {
  const result = await run(state, label, state.executable, args);
  const value = lastJson(result, label);
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'NATIVE_JSON', `${label} returned an unexpected JSON root.`);
  if (state.host === 'claude-code') requireThat(value.outcome === 'ok', 'NATIVE_OUTCOME', `${label} did not report outcome ok.`, select(value, ['command', 'outcome', 'code', 'message', 'error']));
  if (Object.hasOwn(value, 'errors')) requireThat(Array.isArray(value.errors) && value.errors.length === 0, 'NATIVE_ERRORS', `${label} reported native errors.`, { errors: value.errors });
  return value;
}

async function inventory(root) {
  const files = [];
  let logicalSize = 0;
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name);
      const entry = await lstat(file);
      requireThat(!entry.isSymbolicLink(), 'PACKAGE_SYMLINK', 'Plugin payloads and installed caches must not contain symlinks.', { file });
      if (entry.isDirectory()) await visit(file);
      else {
        requireThat(entry.isFile(), 'PACKAGE_FILE_KIND', 'Plugin payloads must contain only regular files and directories.', { file });
        logicalSize += entry.size;
        requireThat(files.length < packageLimits.files && logicalSize <= packageLimits.logicalBytes, 'PACKAGE_LIMIT', 'The public lifecycle input profile permits at most 10,000 files and 256 MiB of logical payload bytes.');
        const digest = createHash('sha256');
        for await (const chunk of createReadStream(file)) digest.update(chunk);
        files.push({ path: path.relative(root, file).split(path.sep).join('/'), size: entry.size, sha256: digest.digest('hex') });
      }
    }
  }
  await visit(root);
  return files;
}

function digestInventory(files) {
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

async function artifact(root, host) {
  const directory = await realpath(root);
  requireThat((await lstat(directory)).isDirectory(), 'ARTIFACT_DIRECTORY', 'Each artifact must be an extracted complete plugin directory.');
  const manifestPath = host === 'codex' ? 'plugin.json' : '.claude-plugin/plugin.json';
  const manifest = await json(path.join(directory, manifestPath));
  const runtime = await json(path.join(directory, 'runtime/package.json'));
  const platform = await json(path.join(directory, 'runtime/runtime-platform.json'));
  requireThat(manifest.name === pluginName && typeof manifest.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version), 'ARTIFACT_MANIFEST', 'The native manifest must identify SGD and a concrete version.');
  requireThat(runtime.version === manifest.version && runtime.type === 'module', 'ARTIFACT_RUNTIME_VERSION', 'The native manifest and complete runtime package must declare the same version.');
  requireThat(platform.version === 1 && platform.platform === process.platform && platform.arch === process.arch, 'ARTIFACT_PLATFORM', 'Both artifacts must contain runtime-platform v1 metadata for this machine.', { expected: `${process.platform}-${process.arch}`, actual: platform });
  const files = await inventory(directory);
  for (const required of [manifestPath, 'scripts/run.mjs', 'skills/specification-guided-development/SKILL.md', 'runtime/package.json', 'runtime/runtime-platform.json', 'runtime/dist/cli.js', 'runtime/dist/mcp.js']) requireThat(files.some(file => file.path === required), 'ARTIFACT_INCOMPLETE', 'A required prepared plugin component is missing.', { required });
  requireThat(files.some(file => file.path.startsWith('runtime/node_modules/')), 'ARTIFACT_INCOMPLETE', 'The extracted plugin must include its runtime dependencies.');
  const mcpFile = host === 'codex' ? 'mcp.json' : '.mcp.json';
  const mcp = await json(path.join(directory, mcpFile));
  requireThat(mcp.mcpServers?.sgd?.command === 'node' && Array.isArray(mcp.mcpServers.sgd.args) && mcp.mcpServers.sgd.args.includes('mcp'), 'ARTIFACT_MCP', 'The host-native manifest must declare the packaged SGD stdio server.');
  const duplicate = path.join(directory, '.codex-plugin/plugin.json');
  if (host === 'codex') {
    try {
      const duplicateManifest = await json(duplicate);
      requireThat(duplicateManifest.name === manifest.name && duplicateManifest.version === manifest.version, 'ARTIFACT_DUPLICATE_MANIFEST', 'Plugin manifests disagree.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { directory, manifestPath, version: manifest.version, files, receipt: { version: manifest.version, platform: platform.platform, arch: platform.arch, fileCount: files.length, logicalBytes: files.reduce((sum, file) => sum + file.size, 0), inventorySha256: digestInventory(files), skillSha256: files.find(file => file.path === 'skills/specification-guided-development/SKILL.md').sha256, runtimeSha256: digestInventory(files.filter(file => file.path.startsWith('runtime/'))) } };
}

async function differences(from, to) {
  const previous = new Map(from.files.map(file => [file.path, file]));
  const next = new Map(to.files.map(file => [file.path, file]));
  const changed = [...new Set([...previous.keys(), ...next.keys()])].filter(file => previous.get(file)?.sha256 !== next.get(file)?.sha256).sort();
  const executable = changed.filter(file => /^(?:runtime\/dist\/.*\.(?:js|mjs|cjs)|scripts\/.*\.(?:js|mjs|cjs)|skills\/.*\.md)$/.test(file));
  let substantiveRuntimeDifference = false;
  for (const file of executable.filter(file => file.startsWith('runtime/dist/'))) {
    if (!previous.has(file) || !next.has(file)) { substantiveRuntimeDifference = true; break; }
    const a = (await readFile(path.join(from.directory, file), 'utf8')).split(from.version).join('{artifact-version}');
    const b = (await readFile(path.join(to.directory, file), 'utf8')).split(to.version).join('{artifact-version}');
    if (a !== b) { substantiveRuntimeDifference = true; break; }
  }
  requireThat(substantiveRuntimeDifference, 'ARTIFACT_METADATA_ONLY', 'A version-only or marker-only replacement does not establish a genuine runtime upgrade. Executable runtime code must differ after version strings are normalized.');
  return { changedFileCount: changed.length, changedExecutableOrSkillFileCount: executable.length, changedRuntimeBeyondVersionStrings: true, changedComponents: executable.slice(0, 16) };
}

async function git(state, label, args, cwd = state.publisher) {
  return run(state, label, 'git', ['-c', `core.hooksPath=${path.join(state.scratch, 'empty-hooks')}`, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd });
}

async function disableAutomaticMaintenance(state, bare) {
  const target = bare ? ['--git-dir', state.bare] : [];
  for (const [key, value] of [['gc.auto', '0'], ['maintenance.auto', 'false'], ['receive.autogc', 'false']]) await git(state, `Disable owned ${bare ? 'bare' : 'publisher'} ${key}`, [...target, 'config', key, value], bare ? state.scratch : state.publisher);
  if (bare) await git(state, 'Keep the served Git repository read-only over HTTP', [...target, 'config', 'http.receivepack', 'false'], state.scratch);
}

async function publish(state, artifactInput, initial) {
  if (!initial) await rename(state.hiddenPublisher, state.publisher);
  const packageRelative = `plugins/${state.host}`;
  const packageDirectory = path.join(state.publisher, packageRelative);
  if (!initial) await rm(packageDirectory, { recursive: true });
  await cp(artifactInput.directory, packageDirectory, { recursive: true, dereference: false });
  requireThat(JSON.stringify(await inventory(packageDirectory)) === JSON.stringify(artifactInput.files), 'PUBLISH_BYTES', 'The complete publishing copy must match the immutable preflight artifact.');
  const catalogueRelative = state.host === 'codex' ? '.agents/plugins/marketplace.json' : '.claude-plugin/marketplace.json';
  const catalogue = state.host === 'codex'
    ? { name: state.marketplace, plugins: [{ name: pluginName, source: { source: 'local', path: `./${packageRelative}` }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools', interface: { displayName: 'Specification Guided Development' } }] }
    : { name: state.marketplace, owner: { name: 'SGD lifecycle verification' }, plugins: [{ name: pluginName, source: `./${packageRelative}`, version: artifactInput.version, description: 'Complete SGD plugin release for a native cached upgrade trial.' }] };
  await mkdir(path.dirname(path.join(state.publisher, catalogueRelative)), { recursive: true });
  await writeFile(path.join(state.publisher, catalogueRelative), `${JSON.stringify(catalogue, null, 2)}\n`);
  if (initial) {
    await git(state, 'Initialize owned publisher', ['init', '--initial-branch=lifecycle', '--template', path.join(state.scratch, 'empty-hooks')]);
    await disableAutomaticMaintenance(state, false);
    await git(state, 'Set owned publisher author', ['config', 'user.name', 'SGD Lifecycle Verifier']);
    await git(state, 'Set owned publisher email', ['config', 'user.email', 'sgd-lifecycle@example.invalid']);
    await git(state, 'Disable owned publisher signing', ['config', 'commit.gpgsign', 'false']);
  }
  await git(state, `Stage complete release ${artifactInput.version}`, ['add', '--force', '--', catalogueRelative, packageRelative]);
  const staged = await git(state, `Inspect staged release ${artifactInput.version}`, initial ? ['diff', '--cached', '--stat'] : ['diff', '--cached', '--stat', 'HEAD']);
  requireThat(staged.stdout.trim(), 'PUBLISH_EMPTY', 'The publisher must contain an actual version change.');
  await git(state, `Commit release ${artifactInput.version}`, ['commit', '-m', `Publish SGD ${state.host} ${artifactInput.version}`]);
  if (initial) {
    await git(state, 'Create independent served bare repository', ['clone', '--bare', '--no-hardlinks', state.publisher, state.bare], state.scratch);
    await disableAutomaticMaintenance(state, true);
  }
  else await git(state, 'Advance the same lifecycle ref', ['push', state.bare, 'HEAD:refs/heads/lifecycle']);
  // Publish one stable pack inventory before any native client reads info/packs.
  await git(state, 'Synchronously pack the served object store', ['--git-dir', state.bare, 'repack', '-a', '-d'], state.scratch);
  await git(state, 'Refresh dumb HTTP Git metadata', ['--git-dir', state.bare, 'update-server-info', '--force'], state.scratch);
  await rename(state.publisher, state.hiddenPublisher);
  return { version: artifactInput.version, ref: 'lifecycle', completePayloadCommitted: true, publishingWorkingTreeHidden: true, nativeCatalogue: catalogueRelative, automaticMaintenanceDisabledInOwnedPublisherAndBare: true, synchronousPackPublication: true };
}

async function serveBare(state) {
  const serving = await startGitHttpServer({ httpRoot: state.httpRoot, bare: state.bare, env: state.env });
  state.server = serving.server;
  state.closeGitHttp = serving.close;
  state.origin = serving.origin;
  state.redactions.push([state.origin, '{loopback-origin}']);
  state.httpCounters = serving.counters;
  state.httpSnapshot = serving.snapshot;
  return `${state.origin}/marketplace.git`;
}

async function servedRepositorySnapshot(state, label) {
  await git(state, `${label}: verify complete bare object connectivity`, ['--git-dir', state.bare, 'fsck', '--full', '--strict'], state.scratch);
  const count = await git(state, `${label}: inspect served object inventory`, ['--git-dir', state.bare, 'count-objects', '-v'], state.scratch);
  const counts = Object.fromEntries(count.stdout.trim().split(/\r?\n/).map(line => line.split(': ')).map(([key, value]) => [key, Number(value)]));
  requireThat(counts.garbage === 0, 'GIT_PUBLICATION_GARBAGE', 'The served repository must not contain interrupted background pack output.');
  const packs = (await readdir(path.join(state.bare, 'objects/pack'))).filter(name => /^pack-[0-9a-f]{40}\.pack$/.test(name)).sort();
  const advertised = (await readFile(path.join(state.bare, 'objects/info/packs'), 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => {
    requireThat(/^P pack-[0-9a-f]{40}\.pack$/.test(line), 'GIT_PACK_ADVERTISEMENT', 'The Git pack metadata contains unsupported entries.');
    return line.slice(2);
  }).sort();
  requireThat(JSON.stringify(advertised) === JSON.stringify(packs), 'GIT_PACK_ADVERTISEMENT', 'The advertised and physical served Git pack inventories must match.');
  const head = (await git(state, `${label}: read published lifecycle ref`, ['--git-dir', state.bare, 'rev-parse', 'refs/heads/lifecycle'], state.scratch)).stdout.trim();
  return { head, looseObjects: counts.count, packedObjects: counts['in-pack'], packCount: counts.packs, packFiles: packs, advertisedPackFiles: advertised, bareFsckPassed: true };
}

async function proveHttpPublication(state, expected) {
  const before = await servedRepositorySnapshot(state, `Release ${expected.version} before independent clone`);
  const modes = [];
  for (const mode of ['full', 'shallow']) {
    const clone = path.join(state.scratch, `transport-clone-${expected.version}-${mode}`);
    const depth = mode === 'shallow' ? ['--depth', '1'] : [];
    await git(state, `Independently ${mode}-clone release ${expected.version} over Git HTTP`, ['clone', ...depth, '--branch', 'lifecycle', '--single-branch', state.gitUrl, clone], state.scratch);
    await git(state, `Verify release ${expected.version} ${mode} clone connectivity`, ['-C', clone, 'fsck', '--full', '--strict'], state.scratch);
    const actualHead = (await git(state, `Read independently ${mode}-cloned ${expected.version} ref`, ['-C', clone, 'rev-parse', 'HEAD'], state.scratch)).stdout.trim();
    requireThat(actualHead === before.head, 'GIT_HTTP_REF', 'The independent HTTP clone must resolve the actual published lifecycle ref.');
    const actual = await inventory(path.join(clone, 'plugins', state.host));
    requireThat(JSON.stringify(actual) === JSON.stringify(expected.files), 'GIT_HTTP_PAYLOAD', 'The complete independently cloned plugin payload must match the requested artifact.');
    modes.push({ mode, cloneFsckPassed: true, completePayloadMatchesArtifact: true });
  }
  const after = await servedRepositorySnapshot(state, `Release ${expected.version} after independent clone`);
  requireThat(JSON.stringify(before) === JSON.stringify(after), 'GIT_PUBLICATION_CHANGED', 'The served object and pack inventory changed while a read-only clone was running.');
  return { version: expected.version, transport: 'git-smart-http-backend', cloneModes: modes, freshGitHttpClonePassed: true, cloneFsckPassed: true, completeClonedPayloadMatchesArtifact: true, servedRepositoryStableDuringClone: true, servedRepository: after, http: state.httpSnapshot() };
}

function nativeHttpDelta(state, before) {
  const after = state.httpSnapshot();
  return Object.fromEntries(['requests', 'objectRequests', 'objectPayloadRequests', 'bytesSent'].map(key => [key, after[key] - before[key]]));
}

async function cacheEvidence(state, selected, expected) {
  requireThat(typeof selected.installPath === 'string' && path.isAbsolute(selected.installPath), 'CACHE_PATH', 'Native discovery must identify an absolute installed cache path.');
  const nativeCache = await realpath(path.join(state.scratch, 'native-home/plugins/cache'));
  const installed = await realpath(selected.installPath);
  requireThat(inside(nativeCache, installed) && installed !== nativeCache, 'CACHE_PATH', 'Native discovery must use the isolated copied plugin cache.', { installedPath: selected.installPath });
  requireThat(!selected.readFromFolder, 'IN_PLACE_LOADING', 'The Git marketplace trial must not load a publisher directory in place.');
  const manifest = await json(path.join(installed, expected.manifestPath));
  const runtime = await json(path.join(installed, 'runtime/package.json'));
  const platform = await json(path.join(installed, 'runtime/runtime-platform.json'));
  requireThat(manifest.version === expected.version && runtime.version === expected.version, 'CACHED_UPGRADE_NOT_APPLIED', 'The physical installed manifest or runtime has the wrong version.', { expectedVersion: expected.version, manifestVersion: manifest.version, runtimeVersion: runtime.version });
  requireThat(platform.version === 1 && platform.platform === process.platform && platform.arch === process.arch, 'CACHE_PLATFORM', 'The installed runtime platform must match this machine.');
  const actual = await inventory(installed);
  requireThat(JSON.stringify(actual) === JSON.stringify(expected.files), 'CACHE_BYTES', 'The full installed plugin payload differs from the complete requested artifact.', { expectedVersion: expected.version, expectedInventorySha256: digestInventory(expected.files), actualInventorySha256: digestInventory(actual) });
  const skillRelative = 'skills/specification-guided-development/SKILL.md';
  for (const relative of [skillRelative, 'runtime/dist/cli.js']) {
    const original = await stat(path.join(expected.directory, relative));
    const cached = await stat(path.join(installed, relative));
    requireThat(original.dev !== cached.dev || original.ino !== cached.ino, 'CACHE_SHARED_FILE', 'The cached skill and runtime must be physical files independent from the artifact inputs.', { relative });
  }
  const runtimeVersion = await run(state, `Run cached ${expected.version} CLI version only`, process.execPath, [path.join(installed, 'scripts/run.mjs'), '--version'], { cwd: state.app });
  requireThat(runtimeVersion.stdout.trim() === expected.version, 'CACHE_EXECUTED_VERSION', 'The cached launcher did not execute the matching runtime version.', { expectedVersion: expected.version, actualVersion: runtimeVersion.stdout.trim() });
  return { installedPath: installed, skillPath: path.join(installed, skillRelative), version: expected.version, fullPayloadMatchesArtifact: true, independentSkillAndRuntimeFiles: true, noSymlinks: true, runtimeCliVersion: runtimeVersion.stdout.trim(), inventorySha256: digestInventory(actual) };
}

async function codexRpc(state, expected, selected, verifyMcp = false) {
  const record = startProcess(state, 'codex', ['--strict-config', 'app-server', '--stdio']);
  let nextId = 0;
  let stderr = '';
  let protocolFailure;
  let outputBytes = 0;
  const pending = new Map();
  const methods = [];
  const calls = [];
  const lines = createInterface({ input: record.child.stdout });
  function failTransport(error) {
    protocolFailure ??= error;
    for (const item of pending.values()) { clearTimeout(item.timer); item.diagnostic.status = 'transport-error'; item.reject(protocolFailure); }
    pending.clear();
    requestStop(record);
  }
  record.child.stdin.on('error', error => failTransport(new TrialFailure('CODEX_RPC_STREAM', 'The owned RPC input stream failed.', { code: error.code })));
  lines.on('error', error => failTransport(new TrialFailure('CODEX_RPC_STREAM', 'The owned RPC output stream failed.', { code: error.code })));
  record.child.stdout.on('data', chunk => { outputBytes += chunk.length; if (outputBytes > outputLimit) failTransport(new TrialFailure('CODEX_RPC_OUTPUT_LIMIT', 'The discovery output exceeded the bounded protocol buffer.')); });
  record.child.stderr.on('data', chunk => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4_096); });
  lines.on('line', line => {
    if (protocolFailure) return;
    try {
      requireThat(line.length <= outputLimit, 'CODEX_RPC_OUTPUT_LIMIT', 'A discovery reply exceeded the bounded protocol buffer.');
      const message = JSON.parse(line);
      requireThat(message && typeof message === 'object' && !Array.isArray(message), 'CODEX_RPC_JSON', 'Every RPC message must be a JSON object.');
      if (Object.hasOwn(message, 'id') && Object.hasOwn(message, 'method')) {
        // Reject host requests even when their request ID matches a pending client ID.
        record.child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'The lifecycle trial accepts no server requests.' } })}\n`);
        if (verifyMcp) failTransport(new TrialFailure('CODEX_UNEXPECTED_SERVER_REQUEST', 'The bounded MCP phase does not authorize server requests, approvals, elicitation, or authentication.', { method: message.method }));
      } else if (Object.hasOwn(message, 'id') && pending.has(message.id)) {
        const item = pending.get(message.id);
        clearTimeout(item.timer);
        pending.delete(message.id);
        if (message.error) { item.diagnostic.status = 'rpc-error'; item.diagnostic.error = select(message.error, ['code', 'message']); item.reject(new TrialFailure('CODEX_RPC', `${item.method} failed.`, { error: message.error })); }
        else { item.diagnostic.status = 'succeeded'; item.resolve(message.result); }
      }
    } catch (error) { failTransport(error instanceof TrialFailure ? error : new TrialFailure('CODEX_RPC_JSON', 'The owned discovery process returned malformed JSON.')); }
  });
  void record.closed.then(result => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.diagnostic.status = 'process-exit'; item.reject(new TrialFailure('CODEX_RPC_EXIT', 'The owned discovery process exited before its reply.', result)); }
    pending.clear();
  });
  function request(method, params, timeout = 45_000) {
    requireThat(!state.interrupted, 'INTERRUPTED', 'The trial was interrupted.');
    if (protocolFailure) throw protocolFailure;
    methods.push(method);
    const id = nextId++;
    const diagnostic = { method, status: 'pending' };
    calls.push(diagnostic);
    if (calls.length > 32) calls.shift();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); diagnostic.status = 'timed-out'; reject(new TrialFailure('CODEX_RPC_TIMEOUT', `${method} did not reply within ${Math.ceil(timeout / 1_000)} seconds.`)); requestStop(record); }, timeout);
      pending.set(id, { resolve, reject, timer, method, diagnostic });
      try { record.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); }
      catch (error) { failTransport(new TrialFailure('CODEX_RPC_STREAM', 'Writing the owned RPC request failed.', { code: error.code })); }
    });
  }
  return finalizeOperation({ operation: async () => {
    await request('initialize', { clientInfo: { name: 'sgd_native_plugin_lifecycle', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    record.child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const listing = await request('plugin/list', { cwds: [state.app], forceRefetch: false, marketplaceKinds: ['local'] });
    requireThat(Array.isArray(listing.marketplaces) && Array.isArray(listing.marketplaceLoadErrors) && listing.marketplaceLoadErrors.length === 0, 'CODEX_MARKETPLACE', 'Fresh Codex discovery returned marketplace errors.', { errors: listing.marketplaceLoadErrors });
    const markets = listing.marketplaces.filter(market => market.name === state.marketplace);
    requireThat(markets.length === 1 && typeof markets[0].path === 'string', 'CODEX_MARKETPLACE', 'Fresh Codex discovery must find the single Git marketplace.');
    requireThat(inside(path.join(state.scratch, 'native-home'), await realpath(markets[0].path)), 'CODEX_MARKETPLACE_PATH', 'The Git catalogue must come from isolated native storage.');
    const summaries = markets[0].plugins.filter(plugin => plugin.id === state.pluginId);
    requireThat(summaries.length === 1, 'CODEX_PLUGIN', 'Fresh Codex discovery must identify the installed plugin.');
    const detail = (await request('plugin/read', { marketplacePath: markets[0].path, pluginName })).plugin;
    const summary = detail?.summary;
    for (const item of [summary, summaries[0]]) requireThat(item?.id === state.pluginId && item.installed === true && item.enabled === true && item.localVersion === expected.version, 'CACHED_UPGRADE_NOT_APPLIED', 'Fresh Codex discovery did not identify the requested installed/enabled version.', { expectedVersion: expected.version, observed: item ? select(item, ['id', 'installed', 'enabled', 'localVersion']) : null });
    requireThat(Array.isArray(detail.mcpServers) && detail.mcpServers.includes('sgd') && Array.isArray(detail.skills) && detail.skills.length > 0, 'CODEX_COMPONENTS', 'Fresh Codex manifest discovery must recognize the SGD skill and MCP declaration.');
    const skillResult = await request('skills/list', { cwds: [state.app], forceReload: true });
    requireThat(Array.isArray(skillResult.data), 'CODEX_SKILLS', 'Fresh Codex skill discovery returned an unexpected root.');
    const matching = skillResult.data.flatMap(entry => Array.isArray(entry.skills) ? entry.skills : []).filter(skill => skill.pluginId === state.pluginId && (skill.name === pluginName || skill.name === `${pluginName}:${pluginName}`));
    requireThat(matching.length === 1 && matching[0].enabled === true, 'CODEX_SKILL_LINK', 'The native-discovered enabled skill must have the exact installed plugin identity.');
    const discoveredSkillPath = await realpath(matching[0].path);
    const installedPath = path.resolve(path.dirname(discoveredSkillPath), '../..');
    for (const candidate of [selected.installedPath, selected.installPath, state.nativeInstallPath].filter(value => typeof value === 'string')) requireThat(await realpath(candidate) === installedPath, 'CODEX_CACHE_PATH_DISAGREEMENT', 'Native installer and discovered skill cache paths disagree.');
    const cached = await cacheEvidence(state, { installPath: installedPath }, expected);
    requireThat(await realpath(matching[0].path) === await realpath(cached.skillPath), 'CODEX_SKILL_PATH', 'The discovered skill must be the physical installed cached skill.');
    const mcp = verifyMcp ? await verifyNativeMcp({ request, state, expectedVersion: expected.version }) : undefined;
    if (protocolFailure) throw protocolFailure;
    return { freshProcess: true, methods, summary: select(summary, ['id', 'installed', 'enabled', 'localVersion']), mcpDeclarationRecognized: true, nativeDiscoveredSkill: select(matching[0], ['name', 'enabled', 'path', 'pluginId']), cache: cached, unrelatedSkillInventoriesRetained: false, ...(mcp ? { mcp } : {}) };
  }, cleanup: async () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.diagnostic.status = 'cancelled-during-finalization'; }
    pending.clear();
    lines.close();
    await stop(record);
  }, observe: ({ operation, cleanup }) => {
    state.receipt.commands.push({
      label: `Fresh Codex ${expected.version} ${verifyMcp ? 'installed MCP transport' : 'discovery'} process`, command: 'codex', args: ['--strict-config', 'app-server', '--stdio'],
      methods, issuedRequests: nextId, rpcCalls: structuredClone(calls), lastRequest: calls.at(-1) ? structuredClone(calls.at(-1)) : null,
      operationStatus: operation.status, process: processEvidence(record), stopped: record.stopped === true,
      ...(operation.status === 'failed' ? { operationFailure: failureSummary(operation.error) } : {}),
      ...(cleanup.status === 'failed' ? { cleanupFailure: failureSummary(cleanup.error) } : {}),
      ...(protocolFailure ? { protocolFailure: failureSummary(protocolFailure) } : {}),
      ...(verifyMcp && operation.status === 'succeeded' ? { mcp: operation.value.mcp } : {}),
      ...(stderr.trim() ? { stderr: state.redact(stderr.trim()) } : {}),
    });
  } });
}

async function discover(state, expected) {
  const listed = lastJson(await run(state, `Fresh ${state.host} ${expected.version} installed inventory`, state.executable, state.host === 'codex' ? ['plugin', 'list', '--marketplace', state.marketplace, '--json'] : ['plugin', 'list', '--json']), 'Native installed inventory');
  const rows = state.host === 'codex' ? listed.installed : listed;
  requireThat(Array.isArray(rows), 'NATIVE_LIST', 'The native installed inventory has an unexpected root.');
  const selectedRows = rows.filter(row => (state.host === 'codex' ? row.pluginId : row.id) === state.pluginId);
  requireThat(selectedRows.length === 1, 'NATIVE_INSTALLED_ID', 'Exactly one installed record must match the isolated plugin identity.');
  const selected = selectedRows[0];
  requireThat(selected.version === expected.version && selected.enabled === true, 'CACHED_UPGRADE_NOT_APPLIED', 'The native installed inventory did not report the requested enabled version.', { expectedVersion: expected.version, observed: select(selected, ['id', 'pluginId', 'version', 'enabled']) });
  if (state.host === 'codex') requireThat(selected.installed === true, 'NATIVE_INSTALLED_STATE', 'The selected Codex record must explicitly report installed true.');
  requireThat(!selected.errors || (Array.isArray(selected.errors) && selected.errors.length === 0), 'NATIVE_LIST_ERRORS', 'The selected installed plugin has discovery errors.');
  if (state.host === 'codex') return codexRpc(state, expected, selected);
  requireThat(selected.scope === 'local', 'CLAUDE_SCOPE', 'The Claude installation must remain scoped to the owned disposable project.');
  const details = await run(state, `Fresh Claude ${expected.version} component details`, 'claude', ['plugin', 'details', state.pluginId]);
  requireThat(details.stdout.includes(`${pluginName} ${expected.version}`) && details.stdout.includes(`Source: ${state.pluginId}`), 'CLAUDE_DETAILS', 'A fresh Claude process must report the exact installed plugin identity/version.');
  requireThat(/Skills\s*\(1\)\s+specification-guided-development\b/.test(details.stdout) && /MCP servers\s*\(1\)\s+sgd\b/.test(details.stdout), 'CLAUDE_COMPONENTS', 'A fresh Claude process must recognize the packaged SGD skill and MCP declaration.');
  const cached = await cacheEvidence(state, selected, expected);
  const registry = await json(path.join(state.scratch, 'native-home/plugins/known_marketplaces.json'));
  requireThat(registry[state.marketplace]?.source?.source === 'git', 'CLAUDE_GIT_SOURCE', 'The isolated Claude marketplace record must identify a Git source.');
  return { freshProcesses: true, installedRecord: select(selected, ['id', 'version', 'scope', 'enabled', 'installPath']), gitMarketplaceRecorded: true, loadingMode: 'git-marketplace-copied-cache', componentDetails: { sourcePluginId: state.pluginId, version: expected.version, skill: pluginName, mcpServer: 'sgd' }, skillPathFromInstalledManifest: cached.skillPath, cache: cached };
}

async function save(state) {
  await writeFile(path.join(state.output, 'result.json'), `${JSON.stringify(sanitize(state.receipt, state.redact), null, 2)}\n`, { mode: 0o600 });
}

async function phase(state, name, operation) {
  state.currentPhase = name;
  const entry = state.receipt.phases.find(entry => entry.name === name);
  try { entry.details = await operation(); entry.status = 'passed'; }
  catch (error) {
    entry.status = error.code === 'UNSUPPORTED_PLATFORM' ? 'unsupported' : 'failed';
    entry.failure = { code: error.code ?? 'UNEXPECTED', message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
    throw error;
  } finally { await save(state); }
}

async function logicalBytes(root) {
  let total = 0;
  for (const name of await readdir(root)) {
    const file = path.join(root, name);
    const entry = await lstat(file);
    if (entry.isDirectory()) total += await logicalBytes(file);
    else total += entry.size;
  }
  return total;
}

async function cleanup(state) {
  const cleanup = { stoppedOwnedProcessGroups: false, stoppedLoopbackServer: false, removedScratch: false, removedLogicalBytes: 0, removedAllocatedBytes: null };
  state.receipt.cleanup = cleanup;
  try {
    if (state.closeGitHttp) await state.closeGitHttp();
    else if (state.server) {
      state.server.closeAllConnections();
      await new Promise(resolve => state.server.close(resolve));
    }
    cleanup.stoppedLoopbackServer = true;
  } catch (error) { cleanup.serverStopFailure = failureSummary(error); }
  const records = [...state.processes];
  const stopped = await Promise.allSettled(records.map(record => stop(record)));
  const processFailures = stopped.flatMap((result, index) => result.status === 'rejected' ? [{ ...processEvidence(records[index]), failure: failureSummary(result.reason) }] : []);
  if (processFailures.length) cleanup.processStopFailures = processFailures;
  cleanup.stoppedOwnedProcessGroups = processFailures.length === 0 && records.every(record => record.stopped === true);
  if (state.scratch) {
    try {
      requireThat(cleanup.stoppedLoopbackServer, 'CLEANUP_SERVER_LIVE', 'Scratch was retained because the owned Git server did not finish stopping.');
      requireThat(cleanup.stoppedOwnedProcessGroups, 'CLEANUP_PROCESS_LIVE', 'Scratch was retained because owned process-group shutdown could not be proved.');
      if (process.platform !== 'win32') {
        const handles = await run(state, 'Check scratch open handles before removal', 'lsof', ['-nP', '+D', state.scratch], { allowFailure: true, timeout: 15_000, cwd: process.cwd() });
        requireThat(handles.exitCode === 1 && !handles.timedOut && !handles.tooLarge && !handles.error && handles.stdout.trim() === '' && handles.stderr.trim() === '', 'CLEANUP_HANDLES', 'Scratch was retained because open-handle absence was not established.');
        cleanup.noOpenScratchHandles = true;
      }
      cleanup.removedLogicalBytes = await logicalBytes(state.scratch);
      if (process.platform !== 'win32') {
        const du = await run(state, 'Measure owned scratch allocation', 'du', ['-sk', state.scratch], { allowFailure: true, timeout: 15_000, cwd: process.cwd() });
        if (du.exitCode === 0 && /^\d+\s/.test(du.stdout)) cleanup.removedAllocatedBytes = Number(du.stdout.trim().split(/\s+/)[0]) * 1024;
      }
      await rm(state.scratch, { recursive: true, force: false });
      cleanup.removedScratch = true;
    } catch (error) {
      cleanup.removedLogicalBytes = 0;
      cleanup.retainedScratchBasename = path.basename(state.scratch);
      cleanup.reason = error.message;
    }
  }
  const disk = process.platform === 'darwin' ? '/System/Volumes/Data' : '/';
  if (process.platform !== 'win32') {
    const df = await run(state, 'Read free space after cleanup', 'df', ['-h', disk], { allowFailure: true, timeout: 15_000, cwd: process.cwd() });
    cleanup.dfAfter = df.exitCode === 0 ? df.stdout.trim() : 'unavailable';
  }
  state.receipt.cleanup = cleanup;
  if (!cleanup.removedScratch) {
    state.receipt.status = 'failed';
    state.receipt.cleanupIncomplete = true;
    state.receipt.failure ??= { phase: 'cleanup', code: 'CLEANUP_INCOMPLETE', message: cleanup.reason ?? 'Owned resource shutdown was not proved.' };
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.log('Usage: node scripts/verify-native-plugin-lifecycle.mjs --host codex|claude-code --from COMPLETE_PLUGIN_DIR_A --to COMPLETE_PLUGIN_DIR_B --out NEW_EVIDENCE_DIR\nUses installed native CLIs, Git, Node core, and lsof/du/df on Unix. The evidence parent must exist. Installs only in disposable native roots. A and B must be genuine distinct complete prepared releases for this platform. Tests native installation, fresh discovery, and cached upgrade. Codex additionally starts one ephemeral read-only thread and verifies the upgraded installed MCP inspect tool with valid and missing owned inputs; Claude MCP remains not run. No inference, authentication, or account RPCs are requested. Startup egress and account-free operation are not established. Each command is bounded to 55 seconds; MCP startup polling is bounded to 30 seconds.');
    return 0;
  }
  const output = path.resolve(options.out);
  const fromPath = await realpath(options.from);
  const toPath = await realpath(options.to);
  const outputParent = await realpath(path.dirname(output));
  requireThat(!inside(fromPath, output) && !inside(toPath, output) && !inside(output, fromPath) && !inside(output, toPath), 'EVIDENCE_OVERLAP', 'The evidence directory must be independent from both artifact directories.');
  requireThat(outputParent === path.dirname(output), 'EVIDENCE_PARENT', 'Use a physical evidence-parent path without symlink components.');
  await mkdir(output, { mode: 0o700 });
  const state = { host: options.host, executable: options.host === 'codex' ? 'codex' : 'claude', output, processes: new Set(), redactions: [[fromPath, '{artifactA}'], [toPath, '{artifactB}'], [output, '{evidence}'], [process.cwd(), '{source}'], [process.env.HOME, '{home}'], [os.tmpdir(), '{temporary}']], receipt: { schema: 'sgd-native-plugin-lifecycle-v1', status: 'running', host: options.host, scope: 'native-git-cached-install-fresh-discovery-and-distinct-version-upgrade', startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, nodeVersion: process.version, phases: phaseNames.map(name => ({ name, status: 'not-run' })), commands: [], notRun: ['native MCP connection or tool invocation', 'thread/start', 'model inference or real agent skill workflow', 'auth/account/model RPC', 'desktop UI installation or restart', 'persistent Parangsae plugin deployment', 'rollback or remove/reinstall recovery'], limitations: ['Native startup egress is not measured or blocked; this is not an offline or account-free guarantee.', 'Ordinary HOME is retained. Separate native storage does not establish complete user-home read isolation.', 'Artifact authenticity and publication provenance are supplied by the caller; distinct matching versions and changed runtime distributions are checked here.', 'MCP manifest recognition and cached CLI version execution do not establish host-to-MCP-server operation or agent use.'] } };
  if (options.host === 'codex') state.receipt.phases.push({ name: 'mcp-b', status: 'not-run' });
  state.redact = redactor(state.redactions);
  let interrupt;
  try {
    state.scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sgd-native-lifecycle-')));
    state.redactions.push([state.scratch, '{trial}']);
    state.env = environmentFor(options.host, state.scratch);
    state.app = path.join(state.scratch, 'app');
    state.publisher = path.join(state.scratch, 'publisher');
    state.hiddenPublisher = path.join(state.scratch, 'publisher-hidden');
    state.httpRoot = path.join(state.scratch, 'http');
    state.bare = path.join(state.httpRoot, 'marketplace.git');
    state.marketplace = `sgd-lifecycle-${options.host}`;
    state.pluginId = `${pluginName}@${state.marketplace}`;
    await Promise.all([state.app, state.publisher, state.httpRoot, path.join(state.scratch, 'native-home'), path.join(state.scratch, 'empty-hooks')].map(directory => mkdir(directory)));
    await writeFile(path.join(state.scratch, 'empty-git-config'), '', { mode: 0o600 });
    interrupt = () => { state.interrupted = true; for (const record of state.processes) requestStop(record); state.server?.closeAllConnections(); };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    state.receipt.isolation = { ordinaryHomeUnchanged: state.env.HOME === process.env.HOME, nativeStorage: state.host === 'codex' ? { CODEX_HOME: state.env.CODEX_HOME } : { CLAUDE_CONFIG_DIR: state.env.CLAUDE_CONFIG_DIR, CLAUDE_CODE_PLUGIN_CACHE_DIR: state.env.CLAUDE_CODE_PLUGIN_CACHE_DIR }, copiedAuthenticationSettingsSkillsOrMemory: false, removedInheritedProviderCredentialEnvironment: true, manualMcpOrSkillOverrides: false, filesystemWriteAudit: 'Owned paths and child configuration overrides only; no complete filesystem-write trace.' };
    let from;
    let to;
    await phase(state, 'preflight', async () => {
      requireThat(process.platform !== 'win32', 'UNSUPPORTED_PLATFORM', 'This verifier currently requires Unix process groups and lsof. Native Windows lifecycle acceptance remains pending; no Windows installation ran.');
      [from, to] = await Promise.all([artifact(fromPath, options.host), artifact(toPath, options.host)]);
      requireThat(from.version !== to.version, 'ARTIFACT_SAME_VERSION', 'The native upgrade trial requires two genuinely distinct release versions.');
      const difference = await differences(from, to);
      const cli = await run(state, 'Read installed native CLI version', state.executable, ['--version']);
      state.receipt.nativeCliVersion = cli.stdout.trim();
      await run(state, 'Read installed Git version', 'git', ['--version']);
      return { from: from.receipt, to: to.receipt, difference, publicInputProfile: packageLimits };
    });
    await phase(state, 'publish-a', async () => {
      const published = await publish(state, from, true);
      state.gitUrl = await serveBare(state);
      const transportProof = await proveHttpPublication(state, from);
      return { ...published, source: state.gitUrl, loopbackEphemeralPort: true, independentBareGitRepository: true, transportProof };
    });
    await phase(state, 'install-a', async () => {
      const before = state.httpSnapshot();
      const addArgs = state.host === 'codex' ? ['plugin', 'marketplace', 'add', state.gitUrl, '--ref', 'lifecycle', '--json'] : ['plugin', 'marketplace', 'add', `${state.gitUrl}#lifecycle`, '--scope', 'local', '--json'];
      const market = await nativeMutation(state, 'Register owned Git marketplace', addArgs);
      const installed = await nativeMutation(state, `Install genuine ${from.version}`, state.host === 'codex' ? ['plugin', 'add', state.pluginId, '--json'] : ['plugin', 'install', state.pluginId, '--scope', 'local', '--json']);
      state.nativeInstallPath = typeof installed.installedPath === 'string' ? installed.installedPath : undefined;
      const transportDelta = nativeHttpDelta(state, before);
      requireThat(transportDelta.objectPayloadRequests > 0, 'GIT_TRANSPORT', 'The native installer itself must fetch actual Git object payloads from the owned loopback publisher.');
      return { marketplace: select(market, ['command', 'outcome', 'marketplaceName', 'marketplace', 'installedRoot', 'alreadyAdded', 'message']), nativeInstall: select(installed, ['command', 'outcome', 'pluginId', 'name', 'marketplaceName', 'version', 'installedPath', 'scope', 'message']), nativeTransportDelta: transportDelta, transport: state.httpSnapshot(), publisherWorkingTreeHidden: true };
    });
    await phase(state, 'discover-a', () => discover(state, from));
    await phase(state, 'publish-b', async () => ({ ...await publish(state, to, false), transportProof: await proveHttpPublication(state, to) }));
    await phase(state, 'refresh-and-update', async () => {
      const before = state.httpSnapshot();
      const refreshed = await nativeMutation(state, 'Refresh the same Git marketplace', state.host === 'codex' ? ['plugin', 'marketplace', 'upgrade', state.marketplace, '--json'] : ['plugin', 'marketplace', 'update', state.marketplace, '--json']);
      const updated = await nativeMutation(state, 'Request native installed-plugin update', state.host === 'codex' ? ['plugin', 'add', state.pluginId, '--json'] : ['plugin', 'update', state.pluginId, '--scope', 'local', '--json']);
      state.nativeInstallPath = typeof updated.installedPath === 'string' ? updated.installedPath : undefined;
      const transportDelta = nativeHttpDelta(state, before);
      requireThat(transportDelta.objectPayloadRequests > 0, 'GIT_TRANSPORT', 'The native marketplace refresh itself must fetch actual Git object payloads from the updated loopback publisher.');
      return { marketplace: select(refreshed, ['command', 'outcome', 'selectedMarketplaces', 'upgradedRoots', 'errors', 'message']), installedUpdate: select(updated, ['command', 'outcome', 'pluginId', 'name', 'marketplaceName', 'version', 'installedPath', 'scope', 'alreadyInstalled', 'message']), nativeTransportDelta: transportDelta, nativeUpdateInterface: state.host === 'codex' ? 'marketplace upgrade followed by plugin add; actual replacement is checked separately' : 'marketplace update followed by plugin update', removedOrReinstalledPlugin: false };
    });
    await phase(state, 'discover-b', () => discover(state, to));
    if (state.host === 'codex') await phase(state, 'mcp-b', async () => {
      const details = await codexRpc(state, to, {}, true);
      state.receipt.scope = 'native-git-cached-install-fresh-discovery-distinct-version-upgrade-and-installed-codex-mcp-transport';
      state.receipt.notRun = state.receipt.notRun.filter(item => item !== 'native MCP connection or tool invocation' && item !== 'thread/start');
      state.receipt.limitations = state.receipt.limitations.filter(item => item !== 'MCP manifest recognition and cached CLI version execution do not establish host-to-MCP-server operation or agent use.');
      state.receipt.limitations.push('The Codex MCP phase loads imported v1 diagnostic data. It does not establish controlled TLC evidence, executable authority, an agent skill workflow, or MCP subprocess filesystem isolation.');
      return details;
    });
    state.receipt.status = 'passed-bounded-native-cached-upgrade';
  } catch (error) {
    state.receipt.status = 'failed';
    state.receipt.failure = { phase: state.currentPhase ?? 'setup', code: error.code ?? 'UNEXPECTED', message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
  } finally {
    if (interrupt) { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
    try { await cleanup(state); }
    catch (error) {
      state.receipt.status = 'failed';
      const removedScratch = state.receipt.cleanup?.removedScratch === true;
      state.receipt.cleanup = { ...state.receipt.cleanup, removedScratch, reason: state.receipt.cleanup?.reason ?? error.message, finalizationFailure: failureSummary(error), ...(!removedScratch && state.scratch ? { retainedScratchBasename: path.basename(state.scratch) } : {}) };
      state.receipt.failure ??= { phase: 'cleanup', ...failureSummary(error) };
    }
    state.receipt.finishedAt = new Date().toISOString();
    if (state.httpCounters) state.receipt.loopbackGitTransport = state.httpSnapshot();
    await save(state);
  }
  const result = sanitize({ status: state.receipt.status, host: state.host, result: '{evidence}/result.json', failure: state.receipt.failure ?? null, cleanup: state.receipt.cleanup }, state.redact);
  console.log(JSON.stringify(result, null, 2));
  return state.receipt.status === 'passed-bounded-native-cached-upgrade' ? 0 : 1;
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  try { process.exitCode = await main(); }
  catch (error) {
    const redact = redactor([[process.cwd(), '{source}'], [process.env.HOME, '{home}'], [os.tmpdir(), '{temporary}']]);
    console.error(redact(`Native plugin lifecycle verification failed: ${error.code ?? 'UNEXPECTED'}: ${error.message}`));
    process.exitCode = 1;
  }
}
