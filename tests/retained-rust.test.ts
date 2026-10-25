import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateRetainedRust } from '../src/backends/retained-rust.js';
import { generateOwnedRust } from '../src/backends/owned-rust.js';
import { FiniteGraphSchema } from '../src/finite-types.js';
import type { RetainedOperationInput } from '../src/retained-operation.js';

function input(disabled = false): RetainedOperationInput {
  const phases = disabled ? ['Waiting', 'Ready', 'Writing', 'Succeeded', 'Failed'] : ['Ready', 'Writing', 'Succeeded', 'Failed'];
  const offset = disabled ? 1 : 0;
  const edges = [
    ...(disabled ? [{ from: 's0', event: 'Prepare', to: 's1' }] : []),
    { from: `s${offset}`, event: 'Begin', to: `s${offset + 1}` },
    { from: `s${offset + 1}`, event: 'Success', to: `s${offset + 2}` },
    { from: `s${offset + 1}`, event: 'Failure', to: `s${offset + 3}` },
  ];
  return {
    className: 'ReportMachine',
    operation: { kind: 'retained-operation', start: 'Begin', success: 'Success', failure: 'Failure', retainedVariable: 'resident' },
    automaton: FiniteGraphSchema.parse({
      version: 1, kind: 'exact-finite', name: 'RetainedReport',
      variables: [{ name: 'phase', kind: 'string' }, { name: 'resident', kind: 'boolean' }],
      nodes: phases.map((phase, index) => ({ id: `s${index}`, values: {
        phase: { kind: 'string', value: phase }, resident: { kind: 'boolean', value: true },
      } })),
      initial: ['s0'], actions: ['Begin', 'Success', 'Failure', ...(disabled ? ['Prepare'] : [])], edges,
      source: { dotSha256: 'a'.repeat(64), stateCount: phases.length, edgeCount: edges.length },
    }),
  };
}

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

const consumerSource = `use authority::{finalize, FinalizationStatus, FiniteValue};
use std::cell::Cell;
#[derive(Debug)]
struct Evidence { rows: Vec<Box<String>>, execution: &'static str, ledger: &'static str }
fn main() {
    for stage in ["open", "write", "sync"] {
        let calls = Cell::new(0);
        let payload = Evidence { rows: vec![Box::new("earlier-complete".into()), Box::new("technical-prefix".into())], execution: "original execution error", ledger: "terminal uncertain" };
        let pointer = &*payload.rows[0] as *const String;
        let result = finalize(payload, |evidence| {
            calls.set(calls.get() + 1);
            assert_eq!(evidence.rows.len(), 2);
            Err::<(), _>(stage)
        });
        assert_eq!(calls.get(), 1);
        assert_eq!(&*result.payload().rows[0] as *const String, pointer);
        assert_eq!(result.payload().execution, "original execution error");
        assert_eq!(result.payload().ledger, "terminal uncertain");
        assert!(matches!(result.status(), FinalizationStatus::Completed(Err(error)) if *error == stage));
        assert_eq!(result.snapshot().revision, "2");
        assert_eq!(result.snapshot().values["phase"], FiniteValue::String("Failed".into()));
        let (payload, status, snapshot) = result.into_parts();
        assert_eq!(payload.rows[1].as_str(), "technical-prefix");
        assert!(matches!(status, FinalizationStatus::Completed(Err(error)) if error == stage));
        assert_eq!(snapshot.values["resident"], FiniteValue::Boolean(true));
    }
    let result = finalize(vec![String::from("original")], |rows| Ok::<_, String>(rows.len()));
    assert_eq!(result.payload()[0], "original");
    assert!(matches!(result.status(), FinalizationStatus::Completed(Ok(1))));
    assert_eq!(result.snapshot().values["phase"], FiniteValue::String("Succeeded".into()));
    let path = std::env::args().nth(1).unwrap();
    let result = finalize(String::from("real retained evidence"), |_| std::fs::OpenOptions::new().write(true).open(path));
    assert!(matches!(result.status(), FinalizationStatus::Completed(Err(_))));
    assert_eq!(result.payload(), "real retained evidence");
}
`;

test('public finite Rust generation remains the default surface', () => {
  const source = input();
  assert.deepEqual(generateOwnedRust(source), generateOwnedRust(source, 'public'));
  const embedded = generateOwnedRust(source, 'embedded').find(file => file.path === 'src/lib.rs');
  assert.ok(embedded);
  assert.doesNotMatch(embedded.content, /pub fn model_name/);
  assert.match(embedded.content, /#\[cfg\(test\)\]\npub const ALL_EVENTS/);
});

test('Rust retained operation preserves actual payload, follows observed outcomes, and rejects ownership bypasses', { timeout: 240_000 }, async () => {
  const runtime = resolve('.runtime/retained-rust-tests');
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(join(runtime, 'suite-'));
  const authority = join(directory, 'authority');
  const consumer = join(directory, 'consumer');
  const target = join(directory, 'target');
  const cargo = (args: string[], directory = consumer, compilerArgs: string[] = []) => {
    const result = spawnSync('cargo', [...args, '--jobs', '1', '--offline', '--quiet', '--manifest-path', join(directory, 'Cargo.toml'), '--target-dir', target, ...compilerArgs], {
      encoding: 'utf8', timeout: 180_000, env: { ...process.env, CARGO_BUILD_JOBS: '1' },
    });
    assert.equal(result.error, undefined, `${result.error}\n${result.stderr}`);
    return result;
  };
  const generate = async (disabled = false) => {
    for (const file of generateRetainedRust(input(disabled))) await put(join(authority, file.path), file.content);
  };
  try {
    await generate();
    const manifest = await readFile(join(authority, 'Cargo.toml'), 'utf8');
    const packageName = /^name = "([a-z0-9-]+)"$/m.exec(manifest)?.[1];
    assert.ok(packageName);
    await put(join(consumer, 'Cargo.toml'), `[package]\nname = "retained-operation-consumer"\nversion = "0.1.0"\nedition = "2021"\n[workspace]\n[dependencies]\nauthority = { package = "${packageName}", path = "../authority" }\n`);
    await put(join(consumer, 'src/main.rs'), consumerSource);
    const built = cargo(['build']);
    assert.equal(built.status, 0, built.stderr);
    const observed = spawnSync(join(target, 'debug', 'retained-operation-consumer'), [directory], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(observed.status, 0, observed.stderr);
    const linted = cargo(['clippy', '--all-targets'], authority, ['--', '-D', 'warnings']);
    assert.equal(linted.status, 0, linted.stderr);

    const invalid = [
      { name: 'move_payload', code: 'E0507', source: 'fn main() { let _ = authority::finalize(vec![1], |rows| { let _moved = *rows; Ok::<(), ()>(()) }); }' },
      { name: 'mutate_payload', code: 'E0596', source: 'fn main() { let _ = authority::finalize(vec![1], |rows| { rows.clear(); Ok::<(), ()>(()) }); }' },
      { name: 'private_state', code: 'E0616', source: 'fn main() { let mut value = authority::finalize(vec![1], |_| Ok::<(), ()>(())); value.payload.clear(); }' },
      { name: 'raw_machine', code: 'E0603', source: 'fn main() { let _ = authority::machine::ReportMachine::new(); }' },
      { name: 'error_only', code: 'E0308', source: 'fn finalization() -> authority::Finalized<Vec<i32>, (), String> { Err("report failed".to_owned()) } fn main() {}' },
    ];
    for (const rejected of invalid) {
      const source = join(consumer, 'src/bin', `${rejected.name}.rs`);
      await put(source, rejected.source);
      const check = cargo(['check', '--bin', rejected.name]);
      assert.equal(check.status, 101, `${rejected.name}: ${check.stderr}`);
      assert.match(check.stderr, new RegExp(`error\\[${rejected.code}\\]`));
      await rm(source);
    }

    await generate(true);
    await put(join(consumer, 'src/main.rs'), `use authority::{finalize, FinalizationStatus};\nfn main() { let result = finalize(vec!["unchanged"], |_| -> Result<(), ()> { panic!("refused callback ran") }); assert_eq!(result.payload(), &vec!["unchanged"]); assert!(matches!(result.status(), FinalizationStatus::Refused(_))); assert_eq!(result.snapshot().revision, "0"); }\n`);
    const refused = cargo(['run']);
    assert.equal(refused.status, 0, refused.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
