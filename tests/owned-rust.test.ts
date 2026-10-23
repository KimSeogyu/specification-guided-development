import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateOwnedRust } from '../src/backends/owned-rust.js';
import { FiniteGraphSchema, type ExactFiniteAutomaton } from '../src/finite-types.js';

const runtime = resolve('.runtime/owned-rust-tests');
const target = join(runtime, 'target');
const exactInteger = '987654321098765432109876543210987654321098765432109876543210';
const modelRevision = 'a'.repeat(64);
const note = '한글 "quotes" \\\nline\u0000end';
const graph = FiniteGraphSchema.parse({
  version: 1, kind: 'exact-finite', name: 'GuardedOrders',
  variables: [{ name: 'phase', kind: 'string' }, { name: 'approved', kind: 'boolean' }, { name: 'amount', kind: 'integer' }, { name: 'note', kind: 'string' }],
  nodes: [
    { id: 's0', values: { phase: { kind: 'string', value: 'New' }, approved: { kind: 'boolean', value: false }, amount: { kind: 'integer', value: exactInteger }, note: { kind: 'string', value: note } } },
    { id: 's1', values: { phase: { kind: 'string', value: 'New' }, approved: { kind: 'boolean', value: true }, amount: { kind: 'integer', value: exactInteger }, note: { kind: 'string', value: note } } },
    { id: 's2', values: { phase: { kind: 'string', value: 'Submitted' }, approved: { kind: 'boolean', value: true }, amount: { kind: 'integer', value: exactInteger }, note: { kind: 'string', value: note } } },
  ],
  initial: ['s0'], actions: ['Approve', 'Submit', 'type', 'Action_74797065', 'Self', '__proto__', '한글 "\\'],
  edges: [{ from: 's0', event: 'Approve', to: 's1' }, { from: 's1', event: 'Submit', to: 's2' }],
  source: { dotSha256: modelRevision, stateCount: 3, edgeCount: 2 },
});
let directory = '';
let consumer = '';
let authority = '';
let packageName = '';

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function cargo(args: string[], cwd = consumer) {
  const result = spawnSync('cargo', [...args, '--offline', '--quiet', '--manifest-path', join(cwd, 'Cargo.toml'), '--target-dir', target], {
    encoding: 'utf8', timeout: 180_000,
  });
  assert.equal(result.error, undefined, `${result.error}\n${result.stderr}`);
  return result;
}

async function compileFailure(name: string, body: string, expected: RegExp): Promise<void> {
  await put(join(consumer, 'src/bin', `${name}.rs`), `use authority::{OrderAuthority, Event};\nfn main() { ${body} }\n`);
  const result = cargo(['check', '--bin', name]);
  assert.notEqual(result.status, 0, `${name} unexpectedly compiled`);
  assert.match(result.stderr, expected);
}

before(async () => {
  await mkdir(runtime, { recursive: true });
  directory = await mkdtemp(join(runtime, 'suite-'));
  authority = join(directory, 'authority');
  consumer = join(directory, 'consumer');
  const files = generateOwnedRust({ automaton: graph, className: 'OrderAuthority' });
  for (const file of files) await put(join(authority, file.path), file.content);
  const manifest = files.find(file => file.path === 'Cargo.toml');
  assert.ok(manifest);
  const matched = /^name = "([a-z0-9-]+)"$/m.exec(manifest.content);
  assert.ok(matched?.[1]);
  packageName = matched[1];
  await put(join(consumer, 'Cargo.toml'), `[package]
name = "owned-rust-consumer"
version = "0.1.0"
edition = "2021"

[workspace]

[dependencies]
authority = { package = "${packageName}", path = "../authority" }
serde_json = "=1.0.154"
`);
  await put(join(consumer, 'src/main.rs'), `use authority::{Event, FiniteValue, OrderAuthority, TransitionErrorReason, ALL_EVENTS};

fn main() {
    let mut owner = OrderAuthority::new();
    let initial = owner.read();
    assert_eq!(initial.node_id, "s0");
    assert_eq!(initial.revision, "0");
    assert_eq!(initial.values["approved"], FiniteValue::Boolean(false));
    assert_eq!(initial.values["amount"], FiniteValue::Integer("${exactInteger}".into()));
    assert_eq!(initial.values.len(), 4);
    let rejected = owner.send(Event::Submit).expect_err("guard must reject Submit");
    assert_eq!(rejected.reason, TransitionErrorReason::Disabled);
    assert_eq!(rejected.state, initial);
    assert_eq!(owner.read(), initial);

    let mut copied = owner.read();
    copied.values.insert("phase".into(), FiniteValue::String("Submitted".into()));
    copied.values.insert("approved".into(), FiniteValue::Boolean(true));
    copied.node_id = "s2";
    copied.revision = "100".into();
    assert_eq!(owner.read(), initial);
    let alias = &mut owner;
    assert_eq!(alias.send(Event::Submit).unwrap_err().state, initial);
    let approved = alias.send(Event::Approve).unwrap();
    assert_eq!(approved.before, initial);
    assert_eq!(approved.after.node_id, "s1");
    assert_eq!(approved.after.revision, "1");
    assert_eq!(approved.after.values["phase"], FiniteValue::String("New".into()));
    assert_eq!(approved.after.values["approved"], FiniteValue::Boolean(true));
    let submitted = alias.send(Event::Submit).unwrap();
    assert_eq!(submitted.after.node_id, "s2");
    assert_eq!(submitted.after.revision, "2");
    assert_eq!(submitted.event.model_name(), "Submit");
    let stable = alias.read();
    assert_eq!(alias.send(Event::Submit).unwrap_err().state, stable);
    assert_eq!(alias.read(), stable);

    for event in ALL_EVENTS {
        assert_eq!(Event::from_model_name(event.model_name()), Some(*event));
    }
    assert_eq!(Event::from_model_name("does not exist"), None);
    assert_ne!(Event::from_model_name("type"), Event::from_model_name("Action_74797065"));

    // Compare every reachable concrete node and action, including both New
    // valuations. This catches projected-phase checks that lose approved.
    for path in [vec![], vec![Event::Approve], vec![Event::Approve, Event::Submit]] {
        for event in ALL_EVENTS {
            let mut machine = OrderAuthority::new();
            for step in &path { machine.send(*step).unwrap(); }
            let before = machine.read();
            let expected = match (before.node_id, event.model_name()) {
                ("s0", "Approve") => Some("s1"),
                ("s1", "Submit") => Some("s2"),
                _ => None,
            };
            match (expected, machine.send(*event)) {
                (Some(node), Ok(receipt)) => {
                    assert_eq!(receipt.after.node_id, node);
                    assert_eq!(receipt.before, before);
                }
                (None, Err(error)) => {
                    assert_eq!(error.reason, TransitionErrorReason::Disabled);
                    assert_eq!(error.state, before);
                    assert_eq!(machine.read(), before);
                }
                _ => panic!("generated dispatch diverged from exact graph"),
            }
        }
    }
    println!("{}", serde_json::to_string(&submitted).unwrap());
    println!("{}", serde_json::to_string(&rejected).unwrap());
    println!("{}", serde_json::to_string(ALL_EVENTS).unwrap());
}
`);
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  // The root task removes this suite's target after the complete validation run.
});

test('generated separate Rust authority crate enforces full-node guards without declarations', () => {
  const result = cargo(['run', '--bin', 'owned-rust-consumer']);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 3);
  const receipt = JSON.parse(lines[0] ?? 'null');
  assert.deepEqual(receipt, {
    event: 'Submit',
    before: {
      model: 'GuardedOrders', modelRevision, nodeId: 's1', revision: '1',
      values: { phase: { kind: 'string', value: 'New' }, approved: { kind: 'boolean', value: true }, amount: { kind: 'integer', value: exactInteger }, note: { kind: 'string', value: note } },
    },
    after: {
      model: 'GuardedOrders', modelRevision, nodeId: 's2', revision: '2',
      values: { phase: { kind: 'string', value: 'Submitted' }, approved: { kind: 'boolean', value: true }, amount: { kind: 'integer', value: exactInteger }, note: { kind: 'string', value: note } },
    },
  });
  const error = JSON.parse(lines[1] ?? 'null');
  assert.equal(error.reason, 'disabled');
  assert.equal(error.state.nodeId, 's0');
  assert.equal(error.state.revision, '0');
  assert.deepEqual(JSON.parse(lines[2] ?? 'null'), [...graph.actions].sort());
  assert.match(packageName, /^sgd-owned-guardedorders-[a-f0-9]{12}$/);
});

test('Rust rejects field writes and raw construction across the crate boundary', async () => {
  await compileFailure('write-node', 'let mut owner = OrderAuthority::new(); owner.node = 2;', /field `node`.*private/);
  await compileFailure('write-revision', 'let mut owner = OrderAuthority::new(); owner.revision = 5;', /field `revision`.*private/);
  await compileFailure('raw-construction', 'let _ = OrderAuthority { node: 2, revision: 5 };', /fields `node` and `revision`.*private/);
  await compileFailure('alias-write', 'let mut owner = OrderAuthority::new(); let alias = &mut owner; alias.node = 2;', /field `node`.*private/);
});

test('Rust rejects Clone, arbitrary restore, deserialization and mutable state references', async () => {
  await compileFailure('clone-owner', 'let owner = OrderAuthority::new(); let _ = owner.clone();', /no method named `clone`/);
  await compileFailure('restore-owner', 'let _ = OrderAuthority::restore("s2", 0);', /no function or associated item named `restore`/);
  await compileFailure('deserialize-owner', 'let _: OrderAuthority = serde_json::from_str("{}").unwrap();', /Deserialize/);
  await compileFailure('deref-owner', 'let mut owner = OrderAuthority::new(); let _ = &mut *owner;', /cannot be dereferenced/);
});

test('generated crate checks revision overflow without state change', () => {
  const result = cargo(['test', '--lib'], authority);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 passed/);
});

test('generation is deterministic under input collection ordering and rejects invalid authority identities', () => {
  const reordered: ExactFiniteAutomaton = {
    ...graph, nodes: [...graph.nodes].reverse(), variables: [...graph.variables].reverse(), actions: [...graph.actions].reverse(), edges: [...graph.edges].reverse(),
  };
  assert.deepEqual(generateOwnedRust({ automaton: graph, className: 'OrderAuthority' }), generateOwnedRust({ automaton: reordered, className: 'OrderAuthority' }));
  for (const className of ['Self', 'Event', 'String', 'BTreeMap', 'Order_Authority', 'orderAuthority']) {
    assert.throws(() => generateOwnedRust({ automaton: graph, className }), /TLC204/);
  }
  assert.throws(() => generateOwnedRust({ automaton: { ...graph, initial: ['s0', 's1'] }, className: 'OrderAuthority' }), /TLC204/);
  assert.throws(() => generateOwnedRust({ automaton: { ...graph, edges: [...graph.edges, { from: 's0', event: 'Approve', to: 's2' }], source: { ...graph.source, edgeCount: 3 } }, className: 'OrderAuthority' }), /TLC204/);
  const invalidUnicode = { ...graph, name: '\ud800' };
  assert.throws(() => generateOwnedRust({ automaton: invalidUnicode, className: 'OrderAuthority' }), /TLC204.*Unicode/);
});

test('regenerating a changed concrete model changes the compiled consumer behavior', async () => {
  const changed: ExactFiniteAutomaton = {
    ...graph,
    edges: [...graph.edges, { from: 's0', event: 'Submit', to: 's2' }],
    source: { ...graph.source, dotSha256: 'b'.repeat(64), edgeCount: 3 },
  };
  try {
    for (const file of generateOwnedRust({ automaton: changed, className: 'OrderAuthority' })) await put(join(authority, file.path), file.content);
    await put(join(consumer, 'src/bin/changed-model.rs'), `use authority::{Event, OrderAuthority};
fn main() {
    let mut owner = OrderAuthority::new();
    let receipt = owner.send(Event::Submit).expect("the changed model permits immediate Submit");
    assert_eq!(receipt.before.node_id, "s0");
    assert_eq!(receipt.after.node_id, "s2");
    assert_eq!(receipt.after.revision, "1");
    assert_eq!(receipt.after.model_revision, "${'b'.repeat(64)}");
}
`);
    const result = cargo(['run', '--bin', 'changed-model']);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    for (const file of generateOwnedRust({ automaton: graph, className: 'OrderAuthority' })) await put(join(authority, file.path), file.content);
  }
});
