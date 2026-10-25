import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildProjectReport } from '../src/compiler.js';

const jar = process.env.TLA2TOOLS_JAR;
const typescriptConsumer = `import { finalize } from '../out/typescript/operation.js';
for (const mode of ['ok', 'err']) {
  const payload = { rows: ['earlier-complete', 'technical-prefix'], execution: 'original execution error', ledger: 'terminal uncertain' };
  let calls = 0;
  const result = finalize(payload, evidence => {
    calls++;
    if (evidence !== payload) throw new Error('callback received a replacement payload');
    return mode === 'ok' ? { ok: true, value: 'reported' } : { ok: false, error: 'report write failed' };
  });
  const status = result.status();
  let observed: string;
  let observedValue: string;
  if (status.kind === 'refused') { observed = 'refused'; observedValue = 'disabled'; }
  else if (status.kind === 'completed' && status.observation.kind === 'returned') {
    const outcome = status.observation.outcome;
    observed = outcome.ok ? 'ok' : 'err';
    observedValue = outcome.ok ? outcome.value : outcome.error;
  } else throw new Error('unexpected generated result');
  const state = result.snapshot();
  const actual = result.payload();
  console.log(JSON.stringify({ mode, calls, payloadSame: actual === payload,
    rows: actual.rows, execution: actual.execution, ledger: actual.ledger,
    observed, observedValue, phase: state.values.phase.value,
    resident: state.values.resident.value, revision: state.revision }));
}
`;
const rustConsumer = `use authority::{finalize, FinalizationStatus, FiniteValue};
use serde_json::json;
struct Evidence { rows: Vec<String>, execution: &'static str, ledger: &'static str }
fn main() {
    for mode in ["ok", "err"] {
        let payload = Evidence { rows: vec!["earlier-complete".into(), "technical-prefix".into()], execution: "original execution error", ledger: "terminal uncertain" };
        let original = payload.rows.as_ptr();
        let mut calls = 0;
        let result = finalize(payload, |evidence| {
            calls += 1;
            assert_eq!(evidence.rows.as_ptr(), original);
            if mode == "ok" { Ok("reported") } else { Err("report write failed") }
        });
        let (observed, observed_value) = match result.status() {
            FinalizationStatus::Refused(_) => ("refused", "disabled"),
            FinalizationStatus::Completed(Ok(value)) => ("ok", *value),
            FinalizationStatus::Completed(Err(error)) => ("err", *error),
            FinalizationStatus::TransitionRejected { .. } => panic!("unexpected completion rejection"),
        };
        let actual = result.payload();
        let state = result.snapshot();
        let phase = match &state.values["phase"] { FiniteValue::String(value) => value, _ => panic!("phase type") };
        let resident = match state.values["resident"] { FiniteValue::Boolean(value) => value, _ => panic!("resident type") };
        println!("{}", json!({ "mode": mode, "calls": calls, "payloadSame": actual.rows.as_ptr() == original,
            "rows": actual.rows, "execution": actual.execution, "ledger": actual.ledger,
            "observed": observed, "observedValue": observed_value, "phase": phase,
            "resident": resident, "revision": state.revision }));
    }
}
`;

function command(program: string, args: string[], cwd: string): string {
  const result = spawnSync(program, args, {
    cwd, encoding: 'utf8', timeout: 240_000,
    env: { ...process.env, CARGO_BUILD_JOBS: '1' },
  });
  assert.equal(result.error, undefined, `${result.error}\n${result.stderr}`);
  assert.equal(result.status, 0, `${program} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function trace(stdout: string): unknown[] {
  return stdout.trim().split(/\r?\n/).map(line => JSON.parse(line) as unknown);
}

function expected(ready: boolean): unknown[] {
  return ['ok', 'err'].map(mode => ({
    mode, calls: ready ? 1 : 0, payloadSame: true,
    rows: ['earlier-complete', 'technical-prefix'], execution: 'original execution error', ledger: 'terminal uncertain',
    observed: ready ? mode : 'refused',
    observedValue: ready ? mode === 'ok' ? 'reported' : 'report write failed' : 'disabled',
    phase: ready ? mode === 'ok' ? 'Succeeded' : 'Failed' : 'Ready',
    resident: true, revision: ready ? '2' : '0',
  }));
}

test('controlled TLA builds drive the same actual TypeScript and Rust retained-operation consumers', { skip: !jar, timeout: 600_000 }, async t => {
  assert.ok(jar);
  const runtime = resolve('.runtime/retained-e2e-tests');
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(join(runtime, 'suite-'));
  t.after(async () => {
    const measured = spawnSync('du', ['-sk', root], { encoding: 'utf8' });
    const removedKiB = measured.status === 0 ? Number(measured.stdout.split(/\s/)[0]) : null;
    await rm(root, { recursive: true, force: true });
    t.diagnostic(`Removed owned TLC/native fixture and Cargo target: ${removedKiB === null ? 'size unavailable' : `${removedKiB} KiB`}`);
  });
  const model = join(root, 'model');
  await cp(resolve('examples/retained-operation'), model, { recursive: true });
  const project = join(model, 'project.json');
  const out = join(root, 'out');
  const consumer = join(root, 'consumer');
  await mkdir(join(consumer, 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(consumer, 'main.ts'), typescriptConsumer);
  await writeFile(join(consumer, 'src/main.rs'), rustConsumer);
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, types: [], rootDir: '.', outDir: 'ts-build' },
    files: ['consumer/main.ts'],
  }));
  const compiler = resolve('node_modules/typescript/bin/tsc');
  const target = join(root, 'target');

  const runConsumers = (): unknown[] => {
    command('node', [compiler, '-p', join(root, 'tsconfig.json')], root);
    const ts = trace(command('node', [join(root, 'ts-build/consumer/main.js')], root));
    command('cargo', ['build', '--jobs', '1', '--offline', '--quiet', '--manifest-path', join(consumer, 'Cargo.toml'), '--target-dir', target], root);
    const rust = trace(command(join(target, 'debug/retained-e2e-consumer'), [], root));
    assert.deepEqual(ts, rust, 'independent native runtimes must report the same modeled observations');
    return ts;
  };

  const built = await buildProjectReport({ project, out, jar });
  assert.ok(built.summary.verification.checks.some(check => check.kind === 'retained-operation'));
  const manifest = await readFile(join(out, 'rust/Cargo.toml'), 'utf8');
  const packageName = /^name = "([a-z0-9-]+)"$/m.exec(manifest)?.[1];
  assert.ok(packageName);
  await writeFile(join(consumer, 'Cargo.toml'), `[package]\nname = "retained-e2e-consumer"\nversion = "0.1.0"\nedition = "2021"\n[workspace]\n[dependencies]\nauthority = { package = "${packageName}", path = "../out/rust" }\nserde_json = "=1.0.154"\n`);
  assert.deepEqual(runConsumers(), expected(true));

  const projectValue = JSON.parse(await readFile(project, 'utf8'));
  await writeFile(project, JSON.stringify({ ...projectValue, config: 'NotReady.cfg' }));
  await buildProjectReport({ project, out, jar });
  assert.equal(await readFile(join(consumer, 'main.ts'), 'utf8'), typescriptConsumer);
  assert.equal(await readFile(join(consumer, 'src/main.rs'), 'utf8'), rustConsumer);
  assert.deepEqual(runConsumers(), expected(false));
});
