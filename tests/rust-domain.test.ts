import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { generateDomainRust } from '../src/backends/domain-rust.js';
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
    ['async', 'writer'], ['transition', 'writer'], ['into', 'writer'], ['try_into', 'writer'],
    ['publish', 'self'], ['publish', 'Port0Input'],
  ]) {
    assert.throws(() => generateDomainRust({ automaton: graph, className: 'Delivery', domain: {
      operations: [{ name, port, start: 'Start', success: 'Succeeded', failure: 'Failed' }],
    } }), /TLC208/);
  }
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
