#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'Usage: node scripts/demo-retained.mjs --jar PATH [--out NEW_DIRECTORY] [--offline]\nTLA2TOOLS_JAR can supply --jar. Build the SDK first with npm run build. No tools or JAR are downloaded.';
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
    if (!['--jar', '--out', '--offline'].includes(key) || Object.hasOwn(options, key)) throw new Error(`Unknown or repeated option: ${key}\n${usage}`);
    if (key === '--offline') options[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Supply a value for ${key}\n${usage}`);
      options[key] = value;
    }
  }
  const jar = options['--jar'] ?? process.env.TLA2TOOLS_JAR;
  if (!jar) throw new Error(`Supply --jar or TLA2TOOLS_JAR.\n${usage}`);
  return { jar: resolve(jar), offline: options['--offline'] === true, out: options['--out'] };
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
      env: { ...process.env, CARGO_BUILD_JOBS: '1' }, stdio: ['ignore', stdout.fd, stderr.fd] });
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
  report.offline = parsed.offline;
  await mkdir(join(output, 'logs'));
  await save();
  process.stdout.write(`Evidence: ${output}\n`);
  report.tools = {
    node: process.version, typescript: tsPackage.version,
    cargo: (await command('cargo-version', 'cargo', ['--version'], output)).trim(),
    rustfmt: (await command('rustfmt-version', 'rustfmt', ['--version'], output)).trim(),
  };
  await command('java-version', 'java', ['-version'], output);
  await cp(join(repository, 'examples/retained-operation'), join(output, 'source'), { recursive: true });
  const source = join(output, 'source');
  const originalTS = await readFile(join(source, 'consumers/typescript.ts'));
  const originalRust = await readFile(join(source, 'consumers/rust.rs'));
  await writeFile(join(output, 'package.json'), '{"type":"module"}\n');
  let lock;
  for (const [name, ready] of [['ready', true], ['not-ready', false]]) {
    stage = name;
    process.stdout.write(`[${name}] Verify model, generate both languages, and run unchanged consumers.\n`);
    const scenario = join(output, name);
    const model = join(scenario, 'model');
    const generated = join(scenario, 'generated');
    const consumer = join(scenario, 'consumer');
    const disposable = join(output, '.disposable', name);
    await mkdir(model, { recursive: true });
    await mkdir(join(consumer, 'src'), { recursive: true });
    await mkdir(disposable, { recursive: true });
    for (const file of ['ReportCustody.tla', 'ReportCustody.cfg', 'NotReady.cfg']) await cp(join(source, file), join(model, file));
    const project = JSON.parse(await readFile(join(source, 'project.json'), 'utf8'));
    if (!ready) project.config = 'NotReady.cfg';
    await writeFile(join(model, 'project.json'), JSON.stringify(project, null, 2) + '\n');
    await command(`${name}-build`, process.execPath, [cli, 'build', '--project', join(model, 'project.json'), '--jar', jar, '--out', generated], output);
    await command(`${name}-view`, process.execPath, [cli, 'visualize', '--ir', join(generated, 'automaton.json'), '--out', join(scenario, 'view')], output);
    await writeFile(join(consumer, 'main.ts'), originalTS);
    await writeFile(join(consumer, 'src/main.rs'), originalRust);
    assert.deepEqual(await readFile(join(consumer, 'main.ts')), originalTS);
    assert.deepEqual(await readFile(join(consumer, 'src/main.rs')), originalRust);
    await writeFile(join(scenario, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, types: [], rootDir: '.', outDir: join(disposable, 'typescript'),
    }, files: ['consumer/main.ts'] }, null, 2));
    await command(`${name}-typescript-build`, process.execPath, [compiler, '-p', join(scenario, 'tsconfig.json')], scenario);
    const ts = traces(await command(`${name}-typescript-run`, process.execPath, [join(disposable, 'typescript/consumer/main.js')], scenario));
    const packageName = /^name = "([a-z0-9-]+)"$/m.exec(await readFile(join(generated, 'rust/Cargo.toml'), 'utf8'))?.[1];
    if (!packageName) throw new Error('Generated Rust package name is missing');
    await writeFile(join(consumer, 'Cargo.toml'), `[package]\nname = "retained-demo-consumer"\nversion = "0.1.0"\nedition = "2021"\n[workspace]\n[dependencies]\nauthority = { package = "${packageName}", path = "../generated/rust" }\nserde_json = "=1.0.154"\n`);
    const cargo = ['--jobs', '1', ...(parsed.offline ? ['--offline'] : []), '--manifest-path', join(consumer, 'Cargo.toml'), '--target-dir', join(disposable, 'cargo')];
    if (lock) await writeFile(join(consumer, 'Cargo.lock'), lock);
    await command(`${name}-rust-build`, 'cargo', ['build', '--quiet', ...(lock ? ['--locked'] : []), ...cargo], scenario);
    if (!lock) lock = await readFile(join(consumer, 'Cargo.lock'));
    const binary = join(disposable, 'cargo/debug', `retained-demo-consumer${process.platform === 'win32' ? '.exe' : ''}`);
    const rust = traces(await command(`${name}-rust-run`, binary, [], scenario));
    assertPreserved(ts, ready);
    assertPreserved(rust, ready);
    assert.deepEqual(ts, rust);
    report.observations[name] = { typescript: ts, rust, consumersUnchanged: true };
    await save();
    process.stdout.write(`[${name}] ${ready ? 'Success and report failure retain payload and original facts; callback runs once.' : 'Changed model refuses both attempts; callback runs zero times; payload remains.'}\n`);
    if (ready) {
      stage = 'negative-controls';
      await mkdir(join(consumer, 'src/bin'));
      await cp(join(source, 'consumers/error-only.rs'), join(consumer, 'src/bin/error-only.rs'));
      await command('negative-error-only-build', 'cargo', ['build', '--quiet', '--locked', '--bin', 'error-only', ...cargo], scenario);
      const loss = traces(await command('negative-error-only-run', join(disposable, 'cargo/debug', `error-only${process.platform === 'win32' ? '.exe' : ''}`), [], scenario));
      const witnessLog = report.stages.at(-1).stderr;
      const witnesses = (await readFile(join(output, witnessLog), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
      assert.deepEqual(witnesses, ['ok', 'err'].map(mode => ({ event: 'payload-drop', mode, before: 0, after: 1 })), 'both ordinary legacy returns must actually destroy their owned evidence');
      assert.ok(loss.every(row => row.payloadSame === false && row.rows === null && row.execution === null && row.ledger === null), 'negative must run the intended error-only boundary');
      assert.throws(() => assertPreserved(loss, true), assert.AssertionError);
      report.negativeControls.errorOnly = { kind: 'compiled-synthetic-loss-class', oracle: 'same-payload-and-original-facts', status: 'rejected-as-expected', observations: loss, lifetimeWitnesses: witnesses };
      for (const [fixture, code] of [['payload-move', 'E0507'], ['payload-mutation', 'E0596']]) {
        await cp(join(source, `consumers/${fixture}.rs`), join(consumer, `src/bin/${fixture}.rs`));
        const raw = await command(`negative-${fixture}`, 'cargo', ['check', '--quiet', '--locked', '--bin', fixture, '--message-format=json', ...cargo], scenario, 101);
        const diagnostics = raw.trim().split(/\r?\n/).map(line => JSON.parse(line)).filter(value => value.reason === 'compiler-message' && value.message.level === 'error');
        assert.ok(diagnostics.some(value => value.message.code?.code === code && value.message.spans.some(span => span.is_primary && span.file_name.endsWith(`${fixture}.rs`))), `expected native ownership error ${code}`);
        report.negativeControls[fixture] = { kind: 'native-compile-refusal', code, status: 'rejected-as-expected' };
      }
      process.stdout.write('[negative-controls] Executed error-only result fails the same preservation oracle; Rust rejects payload move and mutation.\n');
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
