#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'Usage: node scripts/demo-retained.mjs --jar PATH [--out NEW_DIRECTORY]\nTLA2TOOLS_JAR can supply --jar. Build the SDK first with npm run build. No tools or JAR are downloaded.';
const report = {
  schema: 'sgd-retained-demo-v1', status: 'running', startedAt: new Date().toISOString(),
  scope: { kind: 'synthetic-structural-custody-demo', originalApplicationReplay: false,
    guarantee: 'one synchronous invocation retains the actual payload on ordinary returns',
    excluded: ['crash durability', 'deep immutability', 'cross-call retry authority', 'application-wide coverage', 'enclosing-model refinement', 'installed-agent workflow'] },
  stages: [], observations: {}, negativeControls: {}, cleanup: { status: 'not-started' },
};
let output;
let stage = 'setup';
let currentChild;
let interrupted;
let childrenTerminal = true;
let logNumber = 0;
const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const inside = (parent, path) => { const part = relative(parent, path); return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)); };
const options = {};

function parse(args) {
  if (args.length === 1 && args[0] === '--help') return null;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--jar', '--out'].includes(key) || Object.hasOwn(options, key)) throw new Error(`Unknown or repeated option: ${key}\n${usage}`);
    {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Supply a value for ${key}\n${usage}`);
      options[key] = value;
    }
  }
  const jar = options['--jar'] ?? process.env.TLA2TOOLS_JAR;
  if (!jar) throw new Error(`Supply --jar or TLA2TOOLS_JAR.\n${usage}`);
  return { jar: resolve(jar), out: options['--out'] };
}

async function save() {
  if (!output) return;
  await writeFile(join(output, '.report-next.json'), JSON.stringify(report, null, 2) + '\n');
  await rename(join(output, '.report-next.json'), join(output, 'report.json'));
}

function groupAlive(pid) {
  if (process.platform === 'win32') return false;
  try { process.kill(-pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function stop(child, signal) {
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) { if (error.code !== 'ESRCH') childrenTerminal = false; }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = signal;
  if (currentChild) {
    const child = currentChild;
    stop(child, 'SIGTERM');
    const timer = setTimeout(() => { if (currentChild === child) stop(child, 'SIGKILL'); }, 2000);
    timer.unref();
  }
});

async function command(name, program, args, cwd, expectedExit = 0) {
  if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
  const prefix = `${String(++logNumber).padStart(2, '0')}-${name}`;
  const stdoutPath = join(output, 'logs', `${prefix}.stdout.log`);
  const stderrPath = join(output, 'logs', `${prefix}.stderr.log`);
  const entry = { name, program, arguments: args, cwd, expectedExit, status: 'running',
    stdout: relative(output, stdoutPath), stderr: relative(output, stderrPath) };
  report.stages.push(entry);
  await save();
  const stdout = await open(stdoutPath, 'wx');
  const stderr = await open(stderrPath, 'wx');
  let timedOut = false;
  let force;
  let child;
  try {
    child = spawn(program, args, { cwd, detached: process.platform !== 'win32',
      env: { ...process.env }, stdio: ['ignore', stdout.fd, stderr.fd] });
    currentChild = child;
    const timer = setTimeout(() => { timedOut = true; stop(child, 'SIGTERM'); force = setTimeout(() => stop(child, 'SIGKILL'), 2000); }, 240_000);
    const result = await new Promise(done => {
      let error;
      child.once('error', value => { error = value; });
      child.once('close', (code, signal) => done({ code, signal, error }));
    });
    clearTimeout(timer);
    if (force) clearTimeout(force);
    currentChild = undefined;
    if (child.pid && groupAlive(child.pid)) {
      stop(child, 'SIGTERM');
      for (let i = 0; i < 20 && groupAlive(child.pid); i++) await pause(50);
      if (groupAlive(child.pid)) stop(child, 'SIGKILL');
      for (let i = 0; i < 20 && groupAlive(child.pid); i++) await pause(50);
      if (groupAlive(child.pid)) childrenTerminal = false;
    }
    if (process.platform === 'win32' && (timedOut || interrupted)) childrenTerminal = false;
    entry.exitCode = result.code;
    entry.signal = result.signal;
    entry.status = !timedOut && !interrupted && !result.error && result.code === expectedExit && childrenTerminal ? 'passed' : 'failed';
    if (result.error) entry.error = result.error.message;
    if (timedOut) entry.error = 'Command timed out';
    await save();
    if (entry.status !== 'passed') throw new Error(`${name} failed${entry.error ? `: ${entry.error}` : ` (exit ${result.code})`}. Logs: ${stderrPath}`);
  } finally {
    await stdout.close();
    await stderr.close();
  }
  return await readFile(stdoutPath, 'utf8');
}

function traces(stdout) {
  const lines = stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 2, 'a native consumer must report both outcomes');
  return lines.map(line => JSON.parse(line));
}
function expected(ready) {
  return ['ok', 'err'].map(mode => ({ mode, calls: ready ? 1 : 0, payloadSame: true,
    rows: ['earlier-complete', 'technical-prefix'], execution: 'original execution error', ledger: 'terminal uncertain',
    observed: ready ? mode : 'refused', observedValue: ready ? mode === 'ok' ? 'reported' : 'report write failed' : 'disabled',
    phase: ready ? mode === 'ok' ? 'Succeeded' : 'Failed' : 'Ready', resident: true, revision: ready ? '2' : '0' }));
}
function assertPreserved(observed, ready) {
  assert.deepEqual(observed, expected(ready), 'actual payload and original facts must survive every ordinary return');
}
async function bytes(path) {
  const info = await lstat(path);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of await readdir(path)) total += await bytes(join(path, name));
  return total;
}
async function cleanup() {
  if (report.cleanup.status === 'removed') return;
  const disposable = join(output, '.disposable');
  if (!childrenTerminal || currentChild) { report.cleanup = { status: 'retained', reason: 'child termination not established' }; return; }
  try {
    const logicalBytes = await bytes(disposable);
    await rm(disposable, { recursive: true });
    report.cleanup = { status: 'removed', logicalBytes, path: '.disposable' };
  } catch (error) {
    if (error.code === 'ENOENT') report.cleanup = { status: 'nothing-to-remove', logicalBytes: 0 };
    else throw error;
  }
}

async function main() {
  const parsed = parse(process.argv.slice(2));
  if (parsed === null) { process.stdout.write(usage + '\n'); return; }
  for (const name of ['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH', 'TLA_LIBRARY', 'TLA-Library']) {
    if (process.env[name]) throw new Error(`TLC202: unset ${name} before the demo; inherited JVM or TLA+ overrides are unsupported`);
  }
  const jar = await realpath(parsed.jar);
  if (!(await lstat(jar)).isFile()) throw new Error('JAR must be a regular file');
  const cli = join(repository, 'dist/cli.js');
  try { await readFile(cli); } catch { throw new Error('SDK build is missing. Run npm run build before this demo.'); }
  const compiler = join(repository, 'node_modules/typescript/bin/tsc');
  const tsPackage = JSON.parse(await readFile(join(repository, 'node_modules/typescript/package.json'), 'utf8'));
  assert.equal(tsPackage.version, '7.0.2', 'this demo requires exact TypeScript 7.0.2');
  const repoPhysical = await realpath(repository);
  const runtime = join(repoPhysical, '.runtime');
  if (parsed.out) {
    const requested = resolve(parsed.out);
    if (inside(repository, requested) && !inside(join(repository, '.runtime'), requested)) throw new Error('Output inside the repository must be under .runtime; source, dependencies and dist are protected.');
    const parent = await realpath(dirname(requested));
    const physical = join(parent, basename(requested));
    if (inside(repoPhysical, physical) && !inside(runtime, physical)) throw new Error('Output inside the repository must be under .runtime; source, dependencies and dist are protected.');
    if (physical === runtime) throw new Error('Choose a new child directory under .runtime.');
    await mkdir(physical); // Exclusive claim: an existing file, directory, or symlink fails.
    output = physical;
  } else {
    await mkdir(runtime, { recursive: true });
    const physicalRuntime = await realpath(runtime);
    if (physicalRuntime !== runtime) throw new Error('Repository .runtime must not be a symlink');
    output = await mkdtemp(join(runtime, 'demo-retained-'));
  }
  report.paths = { output, source: 'source', logs: 'logs', readyView: 'ready/view/index.html', notReadyView: 'not-ready/view/index.html' };
  await mkdir(join(output, 'logs'));
  await save();
  process.stdout.write(`Evidence: ${output}\n`);
  report.tools = {
    node: process.version, typescript: tsPackage.version,
  };
  await command('java-version', 'java', ['-version'], output);
  await cp(join(repository, 'examples/retained-operation'), join(output, 'source'), { recursive: true });
  const source = join(output, 'source');
  const originalTS = await readFile(join(source, 'consumers/typescript.ts'));
  await writeFile(join(output, 'package.json'), '{"type":"module"}\n');
  for (const [name, ready] of [['ready', true], ['not-ready', false]]) {
    stage = name;
    process.stdout.write(`[${name}] Verify model, generate TypeScript, and run the unchanged consumer.\n`);
    const scenario = join(output, name);
    const model = join(scenario, 'model');
    const generated = join(scenario, 'generated');
    const consumer = join(scenario, 'consumer');
    const disposable = join(output, '.disposable', name);
    await mkdir(model, { recursive: true });
    await mkdir(consumer, { recursive: true });
    await mkdir(disposable, { recursive: true });
    for (const file of ['ReportCustody.tla', 'ReportCustody.cfg', 'NotReady.cfg']) await cp(join(source, file), join(model, file));
    const project = JSON.parse(await readFile(join(source, 'project.json'), 'utf8'));
    if (!ready) project.config = 'NotReady.cfg';
    await writeFile(join(model, 'project.json'), JSON.stringify(project, null, 2) + '\n');
    await command(`${name}-build`, process.execPath, [cli, 'build', '--project', join(model, 'project.json'), '--jar', jar, '--out', generated], output);
    await command(`${name}-view`, process.execPath, [cli, 'visualize', '--ir', join(generated, 'automaton.json'), '--out', join(scenario, 'view')], output);
    await writeFile(join(consumer, 'main.ts'), originalTS);
    assert.deepEqual(await readFile(join(consumer, 'main.ts')), originalTS);
    await writeFile(join(scenario, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, types: [], rootDir: '.', outDir: join(disposable, 'typescript'),
    }, files: ['consumer/main.ts'] }, null, 2));
    await command(`${name}-typescript-build`, process.execPath, [compiler, '-p', join(scenario, 'tsconfig.json')], scenario);
    const ts = traces(await command(`${name}-typescript-run`, process.execPath, [join(disposable, 'typescript/consumer/main.js')], scenario));
    assertPreserved(ts, ready);
    report.observations[name] = { typescript: ts, consumersUnchanged: true };
    await save();
    process.stdout.write(`[${name}] ${ready ? 'Success and report failure retain payload and original facts; callback runs once.' : 'Changed model refuses both attempts; callback runs zero times; payload remains.'}\n`);
    if (ready) {
      stage = 'negative-controls';
      const negative = join(consumer, 'error-only.mjs');
      await writeFile(negative, `
function errorOnly(payload, writer) { return writer(payload); }
for (const mode of ['ok', 'err']) {
  const payload = { rows: ['earlier-complete', 'technical-prefix'], execution: 'original execution error', ledger: 'terminal uncertain' };
  let calls = 0;
  const result = errorOnly(payload, evidence => {
    calls++;
    if (evidence !== payload) throw new Error('unexpected payload substitution');
    return mode === 'ok' ? { ok: true, value: 'reported' } : { ok: false, error: 'report write failed' };
  });
  const retained = Reflect.get(result, 'payload');
  console.log(JSON.stringify({ mode, calls, payloadSame: retained === payload,
    rows: retained?.rows ?? null, execution: retained?.execution ?? null, ledger: retained?.ledger ?? null,
    observed: result.ok ? 'ok' : 'err', observedValue: result.ok ? result.value : result.error,
    phase: result.ok ? 'Succeeded' : 'Failed', resident: true, revision: '2' }));
}
`);
      const loss = traces(await command('negative-error-only-run', process.execPath, [negative], scenario));
      assert.ok(loss.every(row => row.payloadSame === false && row.rows === null && row.execution === null && row.ledger === null), 'the error-only result must omit evidence');
      assert.throws(() => assertPreserved(loss, true), assert.AssertionError);
      report.negativeControls.errorOnly = { kind: 'executed-synthetic-loss-class', oracle: 'same-payload-and-original-facts', status: 'rejected-as-expected', observations: loss,
        scope: 'returned result loses access to payload; no garbage-collection or destruction claim' };
      process.stdout.write('[negative-controls] Executed error-only result fails the same preservation oracle.\n');
      await save();
    }
  }
  if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
  report.status = 'passed';
  report.completedAt = new Date().toISOString();
  await cleanup();
  if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
  await save();
  if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
  process.stdout.write(`PASS — report: ${join(output, 'report.json')}\nPele: ${join(output, report.paths.readyView)}\nChanged model: ${join(output, report.paths.notReadyView)}\n`);
}
main().catch(async error => {
  report.status = 'failed';
  report.failure = { stage, message: error instanceof Error ? error.message : String(error) };
  report.completedAt = new Date().toISOString();
  let persisted = false;
  let persistenceFailure;
  if (output) {
    try { await cleanup(); } catch (cleanupError) { report.cleanup = { status: 'failed', message: String(cleanupError) }; }
    try { await save(); persisted = true; } catch (saveError) { persistenceFailure = String(saveError); }
  }
  process.stderr.write(`FAIL [${stage}]: ${report.failure.message}\n`);
  if (persisted) process.stderr.write(`Failure report retained: ${join(output, 'report.json')}\n`);
  else if (output) process.stderr.write(`Could not persist the final failure report: ${persistenceFailure}. Inspect partial evidence in ${output}.\n`);
  process.exitCode = 1;
});
