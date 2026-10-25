import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const jar = process.env.TLA2TOOLS_JAR;
const script = resolve('scripts/demo-retained.mjs');
function invoke(args: string[], env = process.env, runner = script) {
  const result = spawnSync(process.execPath, [runner, ...args], {
    encoding: 'utf8', timeout: 600_000, env,
  });
  assert.equal(result.error, undefined, `${result.error}\n${result.stderr}`);
  return result;
}

test('retained demo rejects missing setup and unsupported CLI options before creating output', () => {
  const env = { ...process.env };
  delete env.TLA2TOOLS_JAR;
  const missing = invoke([], env);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Supply --jar or TLA2TOOLS_JAR/);
  const unknown = invoke(['--unknown']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown or repeated option/);
  assert.equal(invoke(['--help']).status, 0);
});

test('retained demo rejects inherited JVM and TLA overrides before setup probes or output creation', async t => {
  const runtime = resolve('.runtime/retained-demo-setup-tests');
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(join(runtime, 'suite-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const names = ['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH', 'TLA_LIBRARY', 'TLA-Library'];
  const base: NodeJS.ProcessEnv = { ...process.env, PATH: '' };
  for (const name of names) delete base[name];
  const sentinel = 'PRIVATE-SENTINEL-MUST-NOT-BE-PRINTED-OR-EXECUTED';
  for (const name of names) {
    const out = join(root, 'must-not-exist');
    const result = invoke(['--jar', join(root, 'missing.jar'), '--out', out], { ...base, [name]: sentinel });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`TLC202: unset ${name}`));
    assert.equal(result.stderr.includes(sentinel), false);
    assert.equal(result.stdout, '');
    assert.deepEqual(await readdir(root), [], 'rejection must precede output and every tool probe');
  }
});

test('public retained demo executes source-to-native preservation, loss control and unchanged-consumer model change', { skip: !jar, timeout: 660_000 }, async t => {
  assert.ok(jar);
  const runtime = resolve('.runtime/retained-demo-cli-tests');
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(join(runtime, 'suite-'));
  // Keep unexpected failure evidence for review. Successful verification removes only this test's fixtures.
  let passed = false;
  t.after(async () => {
    if (!passed) { t.diagnostic(`Unexpected failure evidence retained: ${root}`); return; }
    const measured = spawnSync('du', ['-sk', root], { encoding: 'utf8' });
    const removedKiB = measured.status === 0 ? Number(measured.stdout.split(/\s/)[0]) : null;
    await rm(root, { recursive: true, force: true });
    t.diagnostic(`Removed verified demo test fixtures: ${removedKiB === null ? 'size unavailable' : `${removedKiB} KiB`}`);
  });
  // Compile current src into this test's private SDK. Never consume or mutate global dist.
  const sdk = join(root, 'sdk');
  await mkdir(join(sdk, 'scripts'), { recursive: true });
  await cp(script, join(sdk, 'scripts/demo-retained.mjs'));
  await cp(resolve('examples/retained-operation'), join(sdk, 'examples/retained-operation'), { recursive: true });
  await cp(resolve('package.json'), join(sdk, 'package.json'));
  await symlink(await realpath(resolve('node_modules')), join(sdk, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const compiled = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', resolve('tsconfig.json'), '--outDir', join(sdk, 'dist')], {
    encoding: 'utf8', timeout: 180_000,
  });
  await writeFile(join(root, 'sdk-build.stdout.log'), compiled.stdout ?? '');
  await writeFile(join(root, 'sdk-build.stderr.log'), compiled.stderr ?? '');
  assert.equal(compiled.error, undefined, `${compiled.error}\n${compiled.stderr}`);
  assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
  const run = (args: string[]) => invoke(args, process.env, join(sdk, 'scripts/demo-retained.mjs'));
  const out = join(root, 'demo');
  const result = run(['--jar', jar, '--out', out, '--offline']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\nEvidence: ${out}`);
  assert.match(result.stdout, /Success and report failure retain payload/);
  assert.match(result.stdout, /callback runs zero times/);
  const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
  assert.equal(report.schema, 'sgd-retained-demo-v1');
  assert.equal(report.status, 'passed');
  assert.equal(report.scope.originalApplicationReplay, false);
  assert.equal(report.tools.typescript, '7.0.2');
  assert.equal(report.cleanup.status, 'removed');
  assert.ok(report.cleanup.logicalBytes > 0);
  for (const name of ['ready', 'not-ready']) {
    const observed = report.observations[name];
    assert.deepEqual(observed.typescript, observed.rust);
    assert.equal(observed.consumersUnchanged, true);
    assert.ok(observed.rust.every((row: { calls: number; payloadSame: boolean }) => row.calls === (name === 'ready' ? 1 : 0) && row.payloadSame));
    assert.ok((await readFile(join(out, name, 'view/index.html'), 'utf8')).includes('<html'));
    assert.ok((await readdir(join(out, name, 'generated'))).includes('verification.json'));
  }
  for (const name of ['errorOnly', 'payload-move', 'payload-mutation']) assert.equal(report.negativeControls[name].status, 'rejected-as-expected');
  const before = await readFile(join(out, 'report.json'));
  const reuse = run(['--jar', jar, '--out', out, '--offline']);
  assert.equal(reuse.status, 1);
  assert.match(reuse.stderr, /EEXIST/);
  assert.deepEqual(await readFile(join(out, 'report.json')), before);
  const sourceOutput = join(sdk, 'examples/retained-operation/demo-must-not-exist');
  const overlap = run(['--jar', jar, '--out', sourceOutput, '--offline']);
  assert.equal(overlap.status, 1);
  assert.match(overlap.stderr, /source, dependencies and dist are protected/);
  const dotted = run(['--jar', jar, '--out', join(sdk, '..demo-must-not-exist'), '--offline']);
  assert.equal(dotted.status, 1);
  assert.match(dotted.stderr, /source, dependencies and dist are protected/);
  const existing = join(root, 'existing');
  await mkdir(existing);
  await writeFile(join(existing, 'marker'), 'untouched');
  assert.equal(run(['--jar', jar, '--out', existing]).status, 1);
  assert.equal(await readFile(join(existing, 'marker'), 'utf8'), 'untouched');
  // An invalid JAR passes path admission but fails the actual controlled build.
  // Observe the promised failed report and full command logs before removing this expected fixture.
  const wrongJar = join(root, 'wrong.jar');
  await writeFile(wrongJar, 'not the pinned TLC binary');
  const failedOut = join(root, 'failed-demo');
  const failed = run(['--jar', wrongJar, '--out', failedOut, '--offline']);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /FAIL \[ready\]/);
  assert.match(failed.stderr, /Failure report retained:/);
  const failureReport = JSON.parse(await readFile(join(failedOut, 'report.json'), 'utf8'));
  assert.equal(failureReport.status, 'failed');
  assert.equal(failureReport.failure.stage, 'ready');
  const failedStage = failureReport.stages.find((entry: { name: string }) => entry.name === 'ready-build');
  assert.equal(failedStage.status, 'failed');
  assert.notEqual(failedStage.exitCode, 0);
  assert.match(await readFile(join(failedOut, failedStage.stderr), 'utf8'), /TLC202|JAR|jar|pinned/);
  assert.equal(failureReport.cleanup.status, 'removed');
  assert.equal((await readdir(failedOut)).includes('.disposable'), false);
  assert.equal(await readFile(join(failedOut, 'ready/model/ReportCustody.tla'), 'utf8'), await readFile(join(failedOut, 'source/ReportCustody.tla'), 'utf8'));
  t.diagnostic(`Demo removed private build targets: ${report.cleanup.logicalBytes} logical bytes. Invalid-JAR stage failure retained its report and logs until verified.`);
  passed = true;
});
