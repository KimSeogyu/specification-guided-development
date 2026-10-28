import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { generateDomainRust } from '../src/backends/domain-rust.js';
import { checkRustDomainArtifact } from '../src/rust-domain-artifact.js';
import type { ExactFiniteAutomaton } from '../src/finite-types.js';

const edges = [
  { from: 's0', event: 'Prepare', to: 's1' },
  { from: 's1', event: 'Start', to: 's2' },
  { from: 's2', event: 'Succeeded', to: 's3' },
  { from: 's2', event: 'Failed', to: 's4' },
  { from: 's3', event: 'Reset', to: 's1' },
  { from: 's4', event: 'Reset', to: 's1' },
];
const graph: ExactFiniteAutomaton = {
  version: 1, kind: 'exact-finite', name: 'Delivery',
  variables: [{ name: 'phase', kind: 'string' }],
  nodes: ['Unready', 'Ready', 'Pending', 'Done', 'Failed'].map((phase, i) => ({
    id: `s${i}`, values: { phase: { kind: 'string', value: phase } },
  })),
  initial: ['s0'], actions: [...new Set(edges.map(edge => edge.event))], edges,
  source: { dotSha256: 'a'.repeat(64), stateCount: 5, edgeCount: edges.length },
};
const domain = { operations: [{ name: 'publish', port: 'writer', start: 'Start', success: 'Succeeded', failure: 'Failed' }] };

test('Rust domain emits a crate that preserves operation outcomes and cancellation state', { timeout: 60_000 }, t => {
  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (cargo.error && 'code' in cargo.error && cargo.error.code === 'ENOENT') { t.skip('cargo is not installed'); return; }
  assert.ifError(cargo.error);
  assert.equal(cargo.status, 0, cargo.stderr);
  const root = mkdtempSync(join(tmpdir(), 'sgd-rust-domain-'));
  let cleanupSafe = true;
  t.after(() => {
    if (cleanupSafe) rmSync(root, { recursive: true, force: true });
    else t.diagnostic(`Preserved ${root}: cargo process completion is uncertain`);
  });
  const files = generateDomainRust({ automaton: graph, domain, className: 'Delivery' });
  for (const file of files) {
    const destination = join(root, file.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, file.content);
  }
  const manifest = files.find(file => file.path === 'Cargo.toml')?.content;
  assert.ok(manifest);
  const packageName = /^name = "([^"]+)"$/m.exec(manifest)?.[1];
  assert.ok(packageName);
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'tests', 'domain.rs'), `
use ${packageName.replaceAll('-', '_')}::*;
use std::{future::{Future, pending, ready}, pin::Pin, sync::{Arc, atomic::{AtomicUsize, Ordering}}, task::{Context, Poll, Wake, Waker}};
struct TestPorts { calls: Arc<AtomicUsize>, waits: bool, fails: bool }
impl Ports for TestPorts {
    type Port0Input = u8; type Port0Output = u8; type Port0Error = &'static str;
    fn writer(&self, input: u8) -> impl Future<Output = Result<u8, &'static str>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let result = if self.fails { Err("actual error") } else { Ok(input) };
        if self.waits { Box::pin(pending()) as Pin<Box<dyn Future<Output = Result<u8, &'static str>>>> }
        else { Box::pin(ready(result)) }
    }
}
struct W;
impl Wake for W { fn wake(self: Arc<Self>) {} }
fn poll<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
    let waker = Waker::from(Arc::new(W));
    future.poll(&mut Context::from_waker(&waker))
}
fn phase(domain: &DeliveryDomain<TestPorts>) -> Value {
    domain.read().values.iter().find(|(name, _)| *name == "phase").unwrap().1
}
#[test]
fn actual_result_and_public_events() {
    let calls = Arc::new(AtomicUsize::new(0));
    let mut owner = DeliveryDomain::new(TestPorts { calls: calls.clone(), waits: false, fails: false });
    assert!(matches!(poll(Box::pin(owner.publish(9)).as_mut()), Poll::Ready(OperationResult::Refused(TransitionError::Disabled))));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(PublicEvent::from_model_name("Start").is_none());
    assert!(PublicEvent::from_model_name("Succeeded").is_none());
    owner.send(PublicEvent::from_model_name("Prepare").unwrap()).unwrap();
    assert!(matches!(poll(Box::pin(owner.publish(9)).as_mut()), Poll::Ready(OperationResult::Completed { outcome: Ok(9), .. })));
    assert_eq!(phase(&owner), Value::String("Done"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    owner.send(PublicEvent::from_model_name("Reset").unwrap()).unwrap();
    assert_eq!(phase(&owner), Value::String("Ready"));
}
#[test]
fn failure_keeps_original_error_and_selects_failure_transition() {
    let mut owner = DeliveryDomain::new(TestPorts { calls: Arc::new(AtomicUsize::new(0)), waits: false, fails: true });
    owner.send(PublicEvent::from_model_name("Prepare").unwrap()).unwrap();
    assert!(matches!(poll(Box::pin(owner.publish(9)).as_mut()), Poll::Ready(OperationResult::Completed { outcome: Err("actual error"), .. })));
    assert_eq!(phase(&owner), Value::String("Failed"));
}
#[test]
fn dropping_pending_operation_retains_pending_owner_state() {
    let calls = Arc::new(AtomicUsize::new(0));
    let mut owner = DeliveryDomain::new(TestPorts { calls: calls.clone(), waits: true, fails: false });
    owner.send(PublicEvent::from_model_name("Prepare").unwrap()).unwrap();
    let mut future = Box::pin(owner.publish(9));
    assert!(poll(future.as_mut()).is_pending());
    drop(future);
    assert_eq!(phase(&owner), Value::String("Pending"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(owner.send(PublicEvent::from_model_name("Prepare").unwrap()), Err(TransitionError::Disabled));
}
#[derive(Debug)]
struct Payload(String);
struct SyncWriter<F>(Option<F>);
impl<F: FnOnce(&Payload, u8) -> Result<usize, String>> SyncPorts for SyncWriter<F> {
    type Payload = Payload; type Port0Input = u8; type Port0Output = usize; type Port0Error = String;
    fn writer(&mut self, payload: &Payload, input: u8) -> Result<usize, String> {
        self.0.take().expect("writer called only once")(payload, input)
    }
}
#[test]
fn synchronous_owner_retains_payload_on_success_failure_and_refusal() {
    let calls = Arc::new(AtomicUsize::new(0));
    let called = calls.clone();
    let payload = Payload(String::from("refused"));
    let original = payload.0.as_ptr();
    let mut refused = DeliverySyncDomain::new(SyncWriter(Some(move |p: &Payload, _: u8| {
        called.fetch_add(1, Ordering::SeqCst); Ok(p.0.len())
    })), payload);
    let result = refused.publish(9);
    assert_eq!(refused.payload().0.as_ptr(), original);
    assert!(matches!(result.status(), OperationResult::Refused(TransitionError::Disabled)));
    assert_eq!(result.snapshot().values[0].1, Value::String("Unready"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let (payload, _, snapshot) = refused.into_parts();
    assert_eq!(snapshot.values[0].1, Value::String("Unready"));
    assert_eq!(payload.0, "refused");

    let payload = Payload(String::from("success"));
    let original = payload.0.as_ptr();
    let mut success = DeliverySyncDomain::new(SyncWriter(Some(|p: &Payload, _: u8| Ok(p.0.len()))), payload);
    success.send(PublicEvent::from_model_name("Prepare").unwrap()).unwrap();
    let result = success.publish(9);
    assert_eq!(success.payload().0.as_ptr(), original);
    assert!(matches!(result.status(), OperationResult::Completed { outcome: Ok(7), .. }));
    assert_eq!(result.snapshot().values[0].1, Value::String("Done"));
    let (payload, _, snapshot) = success.into_parts();
    assert_eq!(snapshot.values[0].1, Value::String("Done"));
    assert_eq!(payload.0, "success");

    let payload = Payload(String::from("failed"));
    let original = payload.0.as_ptr();
    let mut failed = DeliverySyncDomain::new(SyncWriter(Some(|_: &Payload, _: u8| Err(String::from("actual error")))), payload);
    failed.send(PublicEvent::from_model_name("Prepare").unwrap()).unwrap();
    let result = failed.publish(9);
    assert_eq!(failed.payload().0.as_ptr(), original);
    assert!(matches!(result.status(), OperationResult::Completed { outcome: Err(error), .. } if error == "actual error"));
    assert_eq!(result.snapshot().values[0].1, Value::String("Failed"));
    let (payload, _, snapshot) = failed.into_parts();
    assert_eq!(snapshot.values[0].1, Value::String("Failed"));
    assert_eq!(payload.0, "failed");
}
`);
  const run = spawnSync('cargo', ['test', '--offline', '--manifest-path', join(root, 'Cargo.toml')], {
    cwd: root, encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, CARGO_TARGET_DIR: join(root, 'target') },
  });
  if (run.error || run.signal) cleanupSafe = false;
  assert.ifError(run.error);
  assert.equal(run.signal, null, run.stderr);
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('Rust-only reserved operation and port identifiers are refused', () => {
  for (const [name, port] of [
    ['async', 'writer'], ['transition', 'writer'], ['into', 'writer'], ['try_into', 'writer'], ['payload', 'writer'], ['into_parts', 'writer'],
    ['publish', 'self'], ['publish', 'Port0Input'],
  ]) {
    assert.throws(() => generateDomainRust({ automaton: graph, className: 'Delivery', domain: {
      operations: [{ name, port, start: 'Start', success: 'Succeeded', failure: 'Failed' }],
    } }), /TLC208/);
  }
});

test('Rust generation refuses a mismatched rustfmt version', { skip: process.platform === 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'sgd-rustfmt-version-'));
  const oldPath = process.env.PATH;
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  });
  const rustc = join(root, 'rustc');
  const rustfmt = join(root, 'rustfmt');
  writeFileSync(rustc, '#!/bin/sh\nprintf "rustc 1.92.0 (ded5c06cf 2025-12-08)\\n"\n');
  writeFileSync(rustfmt, '#!/bin/sh\nprintf "rustfmt unexpected\\n"\n');
  chmodSync(rustc, 0o755);
  chmodSync(rustfmt, 0o755);
  process.env.PATH = `${root}:${oldPath ?? ''}`;
  assert.throws(() => generateDomainRust({ automaton: graph, domain, className: 'Delivery' }),
    /TLC208: Rust generation requires rustfmt 1\.8\.0-stable/);
});

test('cargo fmt preserves generated Rust bytes and verified artifact facts', { timeout: 60_000 }, t => {
  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (cargo.error && 'code' in cargo.error && cargo.error.code === 'ENOENT') { t.skip('cargo is not installed'); return; }
  assert.ifError(cargo.error);
  assert.equal(cargo.status, 0, cargo.stderr);
  const root = mkdtempSync(join(tmpdir(), 'sgd-rustfmt-'));
  let cleanupSafe = true;
  t.after(() => {
    if (cleanupSafe) rmSync(root, { recursive: true, force: true });
    else t.diagnostic(`Preserved ${root}: cargo fmt completion is uncertain`);
  });
  const resident: ExactFiniteAutomaton = {
    ...graph, variables: [...graph.variables, { name: 'resident', kind: 'boolean' }],
    nodes: graph.nodes.map(node => ({ ...node, values: { ...node.values, resident: { kind: 'boolean', value: true } } })),
  };
  for (const [kind, model, retainedVariable] of [
    ['standard', graph, undefined], ['resident', resident, 'resident'],
  ] as const) {
    const crate = join(root, kind);
    const input = { automaton: model, domain, className: 'Delivery',
      ...(retainedVariable === undefined ? {} : { retainedVariable }) };
    for (const file of generateDomainRust(input)) {
      const destination = join(crate, file.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, file.content);
    }
    const source = join(crate, 'src/lib.rs');
    const before = readFileSync(source, 'utf8');
    checkRustDomainArtifact({ ...input, source: before });
    const run = spawnSync('cargo', ['fmt', '--manifest-path', join(crate, 'Cargo.toml')], {
      cwd: crate, encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
    });
    if (run.error || run.signal) cleanupSafe = false;
    assert.ifError(run.error);
    assert.equal(run.signal, null, run.stderr);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const after = readFileSync(source, 'utf8');
    assert.equal(after, before, `${kind} rustfmt changed generated bytes`);
    checkRustDomainArtifact({ ...input, source: after });
    const check = spawnSync('cargo', ['fmt', '--manifest-path', join(crate, 'Cargo.toml'), '--', '--check'], {
      cwd: crate, encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
    });
    if (check.error || check.signal) cleanupSafe = false;
    assert.ifError(check.error);
    assert.equal(check.signal, null, check.stderr);
    assert.equal(check.status, 0, check.stdout + check.stderr);
  }
});

test('a resident-bound Rust domain retains payload from construction and hides the non-retaining owner', { timeout: 60_000 }, t => {
  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (cargo.error && 'code' in cargo.error && cargo.error.code === 'ENOENT') { t.skip('cargo is not installed'); return; }
  assert.ifError(cargo.error);
  assert.equal(cargo.status, 0, cargo.stderr);
  const root = mkdtempSync(join(tmpdir(), 'sgd-rust-resident-'));
  let cleanupSafe = true;
  t.after(() => {
    if (cleanupSafe) rmSync(root, { recursive: true, force: true });
    else t.diagnostic(`Preserved ${root}: cargo process completion is uncertain`);
  });
  const resident: ExactFiniteAutomaton = {
    ...graph, variables: [...graph.variables, { name: 'resident', kind: 'boolean' }],
    nodes: graph.nodes.map(node => ({ ...node, values: { ...node.values, resident: { kind: 'boolean', value: true } } })),
  };
  const files = generateDomainRust({ automaton: resident, domain, className: 'Delivery', retainedVariable: 'resident' });
  for (const file of files) {
    const destination = join(root, file.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, file.content);
  }
  const manifest = files.find(file => file.path === 'Cargo.toml')?.content;
  assert.ok(manifest);
  const packageName = /^name = "([^"]+)"$/m.exec(manifest)?.[1];
  assert.ok(packageName);
  const crateName = packageName.replaceAll('-', '_');
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'tests', 'resident.rs'), `
use ${crateName}::*;
struct Writer;
impl SyncPorts for Writer {
    type Payload = String; type Port0Input = (); type Port0Output = (); type Port0Error = &'static str;
    fn writer(&mut self, payload: &String, _: ()) -> Result<(), &'static str> {
        assert_eq!(payload, "original"); Err("report failed")
    }
}
#[test]
fn payload_is_owned_from_init_until_consuming_extraction() {
    assert_eq!(MODEL, "Delivery");
    assert_eq!(MODEL_REVISION, "${'a'.repeat(64)}");
    let mut owner = DeliverySyncDomain::new(Writer, String::from("original"));
    assert_eq!(owner.payload(), "original");
    assert_eq!(owner.read().values.iter().find(|(name,_)| *name == "resident").unwrap().1, Value::Boolean(true));
    owner.send(PublicEvent::from_model_name("Prepare").unwrap()).unwrap();
    let result = owner.publish(());
    assert!(matches!(result.status(), OperationResult::Completed { outcome: Err("report failed"), .. }));
    assert_eq!(owner.payload(), "original");
    assert_eq!(result.snapshot().values.iter().find(|(name,_)| *name == "resident").unwrap().1, Value::Boolean(true));
    let (payload, _, snapshot) = owner.into_parts();
    assert_eq!(payload, "original");
    assert_eq!(snapshot.values.iter().find(|(name,_)| *name == "phase").unwrap().1, Value::String("Failed"));
}
`);
  const env = { ...process.env, CARGO_TARGET_DIR: join(root, 'target'), RUSTFLAGS: '-Dwarnings', CARGO_ENCODED_RUSTFLAGS: '-Dwarnings' };
  const run = spawnSync('cargo', ['test', '--offline', '--manifest-path', join(root, 'Cargo.toml')], {
    cwd: root, encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024, env,
  });
  if (run.error || run.signal) cleanupSafe = false;
  assert.ifError(run.error);
  assert.equal(run.signal, null, run.stderr);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  mkdirSync(join(root, 'examples'));
  writeFileSync(join(root, 'examples', 'bypass.rs'), `use ${crateName}::DeliveryDomain;\nfn main() {}\n`);
  const bypass = spawnSync('cargo', ['check', '--offline', '--example', 'bypass', '--manifest-path', join(root, 'Cargo.toml')], {
    cwd: root, encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024, env,
  });
  if (bypass.error || bypass.signal) cleanupSafe = false;
  assert.ifError(bypass.error);
  assert.equal(bypass.signal, null, bypass.stderr);
  assert.notEqual(bypass.status, 0, 'the non-retaining async owner must not be publicly importable');
  assert.match(bypass.stderr, /private|unresolved import/);
});

test('Rust ports named like conversion traits call the injected port', { timeout: 60_000 }, t => {
  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (cargo.error && 'code' in cargo.error && cargo.error.code === 'ENOENT') { t.skip('cargo is not installed'); return; }
  assert.ifError(cargo.error);
  assert.equal(cargo.status, 0, cargo.stderr);
  const root = mkdtempSync(join(tmpdir(), 'sgd-rust-ports-'));
  let cleanupSafe = true;
  t.after(() => {
    if (cleanupSafe) rmSync(root, { recursive: true, force: true });
    else t.diagnostic(`Preserved ${root}: cargo process completion is uncertain`);
  });
  for (const port of ['into', 'try_into']) {
    const crate = join(root, port);
    const files = generateDomainRust({ automaton: graph, className: 'Delivery', domain: {
      operations: [{ name: 'publish', port, start: 'Start', success: 'Succeeded', failure: 'Failed' }],
    } });
    for (const file of files) {
      const destination = join(crate, file.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, file.content);
    }
    const manifest = files.find(file => file.path === 'Cargo.toml')?.content;
    assert.ok(manifest);
    const packageName = /^name = "([^"]+)"$/m.exec(manifest)?.[1];
    assert.ok(packageName);
    mkdirSync(join(crate, 'tests'));
    writeFileSync(join(crate, 'tests', 'port.rs'), `
use ${packageName.replaceAll('-', '_')}::*;
use std::{future::{Future, ready}, sync::{Arc, atomic::{AtomicUsize, Ordering}}, task::{Context, Poll, Wake, Waker}};
struct TestPorts(Arc<AtomicUsize>);
impl Ports for TestPorts {
    type Port0Input = u8; type Port0Output = u8; type Port0Error = ();
    fn ${port}(&self, input: u8) -> impl Future<Output = Result<u8, ()>> {
        self.0.fetch_add(1, Ordering::SeqCst);
        ready(Ok(input))
    }
}
struct W;
impl Wake for W { fn wake(self: Arc<Self>) {} }
#[test]
fn invokes_the_injected_port() {
    let calls = Arc::new(AtomicUsize::new(0));
    let mut owner = DeliveryDomain::new(TestPorts(calls.clone()));
    owner.send(PublicEvent::from_model_name("Prepare").unwrap()).unwrap();
    let waker = Waker::from(Arc::new(W));
    let mut future = Box::pin(owner.publish(9));
    assert!(matches!(future.as_mut().poll(&mut Context::from_waker(&waker)),
        Poll::Ready(OperationResult::Completed { outcome: Ok(9), .. })));
    drop(future);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(owner.read().values.iter().find(|(name, _)| *name == "phase").unwrap().1, Value::String("Done"));
}
`);
    const run = spawnSync('cargo', ['test', '--offline', '--manifest-path', join(crate, 'Cargo.toml')], {
      cwd: crate, encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, CARGO_TARGET_DIR: join(crate, 'target') },
    });
    if (run.error || run.signal) cleanupSafe = false;
    assert.ifError(run.error);
    assert.equal(run.signal, null, run.stderr);
    assert.equal(run.status, 0, run.stdout + run.stderr);
  }
});
