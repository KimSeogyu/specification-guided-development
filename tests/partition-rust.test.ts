import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { generatePartitionRust } from '../src/backends/partition-rust.js';
import { generateRowRust } from '../src/backends/row-rust.js';
import { generateSymbolicRust } from '../src/backends/symbolic-rust.js';
import { FiniteGraphSchema } from '../src/finite-types.js';
import type { PartitionPlan } from '../src/partition-types.js';
import { formatGeneratedRust } from '../src/rust-format.js';
import { symbolicModel, type SymbolicExpression, type SymbolicGuard } from '../src/symbolic-types.js';

const execute = promisify(execFile);
const runtime = resolve('.runtime/partition-rust-tests');
const target = join(runtime, 'target');
const state = (variable: string): SymbolicExpression => ({ kind: 'state', variable });
const scalar = (value: string): SymbolicExpression => ({ kind: 'literal', value: { kind: 'string', value } });
const parameter = (name: string): SymbolicExpression => ({ kind: 'input', parameter: name });
const equal = (left: SymbolicExpression, right: SymbolicExpression): SymbolicGuard => ({ kind: 'equal', left, right });
const unequal = (left: SymbolicExpression, right: SymbolicExpression): SymbolicGuard => ({ kind: 'not-equal', left, right });
const variables = ['phase', 'stored', 'storedProvenance', 'rejected', 'rejectedProvenance'];
const retained = Object.fromEntries(variables.map(name => [name, state(name)]));
const occupied = unequal(state('phase'), scalar('absent'));
const model = symbolicModel({
  version: 2, kind: 'symbolic-owned', name: 'PartitionRow', checkDeadlock: true, variables,
  inputs: [{ parameter: 'v', domain: 'Values' }, { parameter: 'p', domain: 'Receipts' }], next: 'Next',
  initial: Object.fromEntries(variables.map(name => [name, { kind: 'string', value: name === 'phase' ? 'absent' : 'none' }])),
  branches: [
    { action: 'Insert', guard: equal(state('phase'), scalar('absent')), updates: { ...retained, phase: scalar('present'), stored: parameter('v'), storedProvenance: parameter('p') }, source: null },
    { action: 'Same', guard: { kind: 'or', terms: [
      { kind: 'and', terms: [equal(state('phase'), scalar('present')), equal(parameter('v'), state('stored'))] },
      { kind: 'and', terms: [equal(state('phase'), scalar('conflict')), equal(parameter('v'), state('stored'))] },
    ] }, updates: retained, source: null },
    { action: 'Clash', guard: { kind: 'and', terms: [occupied, unequal(parameter('v'), state('stored'))] }, updates: { ...retained, phase: scalar('conflict'), rejected: parameter('v'), rejectedProvenance: parameter('p') }, source: null },
  ], invariants: [], actionProperties: [],
});
const combinations = [[false, false], [true, false], [false, true], [true, true]];
const nodes = combinations.flatMap(([inserted, conflict], index) => {
  const values = { hasInserted: { kind: 'boolean', value: inserted }, hasConflict: { kind: 'boolean', value: conflict } };
  return [
    { id: `s${index}`, values: { phase: { kind: 'string', value: 'Open' }, ...values } },
    { id: `s${index + 4}`, values: { phase: { kind: 'string', value: conflict ? 'ReadyRefused' : inserted ? 'ReadyWrite' : 'ReadyNoop' }, ...values } },
    { id: `s${index + 8}`, values: { phase: { kind: 'string', value: 'Consumed' }, ...values } },
  ];
});
const edges = combinations.flatMap(([inserted, conflict], index) => [
  { from: `s${index}`, event: 'Insert', to: `s${conflict ? 3 : 1}` },
  { from: `s${index}`, event: 'Same', to: `s${index}` },
  { from: `s${index}`, event: 'Clash', to: `s${inserted ? 3 : 2}` },
  { from: `s${index}`, event: conflict ? 'CloseRefused' : inserted ? 'CloseWrite' : 'CloseNoop', to: `s${index + 4}` },
  { from: `s${index + 4}`, event: conflict ? 'ConsumeRefused' : inserted ? 'ConsumeWrite' : 'ConsumeNoop', to: `s${index + 8}` },
]);
const control = FiniteGraphSchema.parse({
  version: 1, kind: 'exact-finite', name: 'PartitionControl',
  variables: [{ name: 'phase', kind: 'string' }, { name: 'hasInserted', kind: 'boolean' }, { name: 'hasConflict', kind: 'boolean' }],
  nodes, initial: ['s0'], actions: ['Insert', 'Same', 'Clash', 'CloseWrite', 'CloseNoop', 'CloseRefused', 'ConsumeWrite', 'ConsumeNoop', 'ConsumeRefused'], edges,
  source: { dotSha256: 'a'.repeat(64), stateCount: nodes.length, edgeCount: edges.length },
});
const factNames = ['Fact', 'BookFact', 'TripleFact'];
const plan: PartitionPlan = {
  version: 1, kind: 'closed-partition-fold', runtimeProfile: 'unbound-partition-v1',
  contract: { version: 1, calendar: 'utc-micros-nonnegative-day-v1', families: factNames.map((name, index) => ({ name, key: ['key', 'secondary', 'third'].slice(0, index + 1), symbol: 'symbol', time: 'time', datasets: [`family-${['one', 'two', 'three'][index]}`] })) },
  row: {
    model,
    binding: {
      version: 1, profile: 'rust-whole-row-v1', source: { manifest: 'Cargo.toml', module: 'crate::facts', facts: factNames.map(name => ({ name, rustPath: `crate::facts::${name}`, metadata: ['received'] })) },
      model: { payloadInput: 'v', provenanceInput: 'p', pairs: [{ name: 'stored', payload: 'stored', provenance: 'storedProvenance' }, { name: 'rejected', payload: 'rejected', provenance: 'rejectedProvenance' }] },
    },
    plan: {
      version: 1, profile: 'rust-whole-row-v1', crateName: 'partition-consumer', sources: [{ path: 'src/main.rs', sha256: 'a'.repeat(64) }],
      facts: factNames.map(name => ({ name, rustPath: `crate::facts::${name}`, fields: [
        { name: 'symbol', rustType: 'Symbol', codec: { kind: 'string', getters: ['as_str'] }, payload: true, provenance: false },
        { name: 'key', rustType: 'Scalar', codec: { kind: 'i64', getters: ['ticks'] }, payload: true, provenance: false },
        ...['secondary', 'third', 'time', 'value'].map(field => ({ name: field, rustType: 'i64', codec: { kind: 'i64', getters: [] }, payload: true, provenance: false })),
        { name: 'schema', rustType: 'u32', codec: { kind: 'u32', getters: [] }, payload: true, provenance: true, classes: [[1, 2]] },
        { name: 'received', rustType: 'i64', codec: { kind: 'i64', getters: [] }, payload: false, provenance: true },
      ] })),
    },
  },
  control,
};
const facts = `pub mod facts {
#[derive(Clone, Debug, Eq, PartialEq)] pub struct Symbol(pub String);
impl Symbol { pub fn as_str(&self) -> &str { &self.0 } }
#[derive(Clone, Copy, Debug, Eq, PartialEq)] pub struct Scalar(pub i64);
impl Scalar { pub fn ticks(self) -> i64 { self.0 } }
${factNames.map(name => `#[derive(Clone, Debug)] pub struct ${name} { pub symbol: Symbol, pub key: Scalar, pub secondary: i64, pub third: i64, pub time: i64, pub value: i64, pub schema: u32, pub received: i64 }
impl PartialEq for ${name} { fn eq(&self, other: &Self) -> bool { self.symbol == other.symbol && self.key == other.key && self.secondary == other.secondary && self.third == other.third && self.time == other.time && self.value == other.value && (self.schema == other.schema || matches!((self.schema, other.schema), (1, 2) | (2, 1))) } }
impl Eq for ${name} {}`).join('\n')}
}`;
async function put(path: string, content: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }

test('Rust closed fold preserves complete rows, stutter observations, signed key order, and checked grouping', async () => {
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(join(runtime, 'suite-'));
  const rust = join(root, 'rust'); const consumer = join(root, 'consumer');
  try {
    const generated = await formatGeneratedRust(generatePartitionRust({ plan, className: 'PartitionAuthority', rustCrateMode: 'standalone' }));
    for (const file of generated.files) await put(join(rust, file.path), file.content);
    const manifest = await readFile(join(rust, 'Cargo.toml'), 'utf8');
    const packageName = /^name = "([a-z0-9-]+)"$/m.exec(manifest)?.[1]; assert.ok(packageName);
    await put(join(consumer, 'Cargo.toml'), `[package]\nname = "partition-consumer"\nversion = "0.1.0"\nedition = "2021"\n[workspace]\n[dependencies]\nsgd_fact_authority = { package = "${packageName}", path = "../rust" }\n`);
    const prelude = `#![forbid(unsafe_code)]\n${facts}\n#[path = "../../rust/adapter.rs"] mod adapter;\nuse adapter::{fold_partition, UnboundPartitionReport};\nuse facts::{Fact, BookFact, TripleFact, Scalar, Symbol};\nfn fact(key: i64, value: i64, received: i64) -> Fact { Fact { symbol: Symbol("한글😀".into()), key: Scalar(key), secondary: 0, third: 0, time: 86_400_000_000, value, schema: 1, received } }\n`;
    await put(join(consumer, 'src/main.rs'), `${prelude}
fn main() {}
#[cfg(test)] mod tests {
use super::*;
#[test] fn empty_is_noop_and_ungrouped() {
 let closed = fold_partition::<Fact>(vec![], vec![]).unwrap();
 assert_eq!(closed.counts().inserted(), 0); assert!(closed.group().is_none());
 let report = closed.into_report().unwrap(); assert!(report.group().is_none());
 assert!(matches!(report, UnboundPartitionReport::Noop { rows, .. } if rows.is_empty()));
}
#[test] fn no_insert_preserves_original_duplicates_and_metadata() {
 let original = vec![fact(4, 10, 1), fact(4, 20, 2), fact(-4, 1, 3)];
 let same = Fact { schema: 2, received: 999, ..original[1].clone() };
 let report = fold_partition(original.clone(), vec![same]).unwrap().into_report().unwrap();
 assert_eq!(report.counts().inserted(), 0); assert_eq!(report.counts().unchanged(), 1);
 assert_eq!(report.group().unwrap().symbol(), "한글😀"); assert_eq!(report.group().unwrap().day_index(), 1);
 match report { UnboundPartitionReport::Noop { rows, .. } => assert_eq!(rows.iter().map(|row| (row.key.0, row.value, row.schema, row.received)).collect::<Vec<_>>(), vec![(4,10,1,1),(4,20,1,2),(-4,1,1,3)]), _ => panic!("expected noop") }
}
#[test] fn write_is_sorted_by_signed_keys_and_materializes_last_baseline() {
 let original = vec![fact(8, 10, 1), fact(8, 20, 2)];
 let report = fold_partition(original, vec![fact(i64::MAX, 1, 3), fact(-1, 2, 4), fact(i64::MIN, 3, 5), fact(0, 4, 6)]).unwrap().into_report().unwrap();
 assert_eq!(report.counts().inserted(), 4);
 match report { UnboundPartitionReport::Write { rows, .. } => { assert_eq!(rows.iter().map(|row| row.key.0).collect::<Vec<_>>(), vec![i64::MIN,-1,0,8,i64::MAX]); assert_eq!(rows[3].received,2); assert_eq!(rows[3].value,20); }, _ => panic!("expected write") }
}
#[test] fn all_conflicts_survive_stutters_and_provisional_keys_roll_back() {
 let original = vec![fact(4, 10, 1), fact(4, 20, 2)];
 let rejected = fact(4, 999, 3); let same = Fact { schema: 2, received: 4, ..original[1].clone() };
 let closed = fold_partition(original.clone(), vec![fact(-100, 1, 0), rejected.clone(), rejected, same]).unwrap();
 assert_eq!(closed.counts().inserted(),0); assert_eq!(closed.counts().unchanged(),1);
 let report = closed.into_report().unwrap();
 assert_eq!(report.counts().inserted(),0); assert_eq!(report.counts().unchanged(),1);
 match report { UnboundPartitionReport::Refused { original: rows, conflicts, .. } => { assert_eq!(rows.iter().map(|r| r.received).collect::<Vec<_>>(),vec![1,2]); assert_eq!(conflicts.len(),2); for conflict in &conflicts { assert_eq!(conflict.stored().received,2); assert_eq!(conflict.rejected().received,3); } let (stored,rejected)=conflicts.into_iter().next().unwrap().into_rows(); assert_eq!((stored.value,rejected.value),(20,999)); }, _ => panic!("expected refusal") }
}
#[test] fn complete_group_preflight_rejects_baseline_incoming_and_calendar_mismatch() {
 let first = fact(0, 1, 1);
 for changed in [Fact { symbol: Symbol("other".into()), ..first.clone() }, Fact { time: 86_400_000_000-1, ..first.clone() }, Fact { time: -1, ..first.clone() }] {
  assert!(fold_partition(vec![first.clone(), changed.clone()], vec![]).is_err());
  assert!(fold_partition(vec![first.clone()], vec![changed.clone()]).is_err());
  assert!(fold_partition(vec![], vec![first.clone(),changed]).is_err());
 }
 let high = Fact { time: i64::MAX, ..first.clone() }; let closed = fold_partition(vec![],vec![high]).unwrap(); assert_eq!(closed.group().unwrap().day_index(),i64::MAX/86_400_000_000);
 let boundary = Fact { time: 0, ..first }; assert_eq!(fold_partition(vec![],vec![boundary]).unwrap().group().unwrap().day_index(),0);
}
#[test] fn two_and_three_component_keys_keep_signed_native_tuple_order() {
 let book = |key, secondary| BookFact { symbol:Symbol("x".into()),key:Scalar(key),secondary,third:0,time:0,value:0,schema:1,received:0 };
 match fold_partition(vec![],vec![book(0,i64::MAX),book(-1,0),book(0,i64::MIN)]).unwrap().into_report().unwrap() { UnboundPartitionReport::Write { rows, .. } => assert_eq!(rows.iter().map(|r|(r.key.0,r.secondary)).collect::<Vec<_>>(),vec![(-1,0),(0,i64::MIN),(0,i64::MAX)]), _=>panic!("write") }
 let triple = |third| TripleFact { symbol:Symbol("x".into()),key:Scalar(0),secondary:0,third,time:0,value:0,schema:1,received:0 };
 match fold_partition(vec![],vec![triple(i64::MAX),triple(i64::MIN),triple(0)]).unwrap().into_report().unwrap() { UnboundPartitionReport::Write { rows,.. } => assert_eq!(rows.iter().map(|r|r.third).collect::<Vec<_>>(),vec![i64::MIN,0,i64::MAX]), _=>panic!("write") }
}
}
`);
    await execute('cargo', ['fetch', '--quiet', '--manifest-path', join(consumer, 'Cargo.toml')], { timeout: 180_000 });
    await execute('cargo', ['test', '--offline', '--quiet', '--manifest-path', join(consumer, 'Cargo.toml'), '--target-dir', target], { timeout: 180_000 });
    await execute('cargo', ['test', '--offline', '--quiet', '--manifest-path', join(rust, 'Cargo.toml'), '--target-dir', target], { timeout: 180_000 });
    await execute('cargo', ['clippy', '--offline', '--quiet', '--tests', '--manifest-path', join(consumer, 'Cargo.toml'), '--target-dir', target, '--', '-D', 'warnings'], { timeout: 180_000 });
    await execute('cargo', ['clippy', '--offline', '--quiet', '--tests', '--manifest-path', join(rust, 'Cargo.toml'), '--target-dir', target, '--', '-D', 'warnings'], { timeout: 180_000 });
    for (const [body, expected] of [
      ['let _ = adapter::FactOwner::<Fact>::new();', 'E0603'],
      ['let _ = adapter::WriteEffect::Same;', 'E0603'],
      ['let _ = fold_partition::<String>(vec![],vec![]);', 'E0277'],
      ['let mut closed=fold_partition::<Fact>(vec![],vec![]).unwrap(); closed.original=vec![];', 'E0616'],
      ['let closed=fold_partition::<Fact>(vec![],vec![]).unwrap(); let _=closed.into_report(); let _=closed.into_report();', 'E0382'],
      ['let closed=fold_partition::<Fact>(vec![],vec![]).unwrap(); let mut counts=closed.counts(); counts.inserted=1;', 'E0616'],
      ['let closed=fold_partition::<Fact>(vec![],vec![]).unwrap(); closed.observe("Same");', 'E0599'],
      ['let _=adapter::ClosedPartition::<Fact>::restore();', 'E0599'],
    ]) {
      await put(join(consumer, 'src/main.rs'), `${prelude}\nfn main() { ${body} }\n`);
      await assert.rejects(execute('cargo', ['check', '--offline', '--quiet', '--message-format=json', '--manifest-path', join(consumer, 'Cargo.toml'), '--target-dir', target], { timeout: 180_000 }), (error: unknown) => {
        assert.ok(error instanceof Error && 'stdout' in error && typeof error.stdout === 'string');
        const errors = error.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(message => message.reason === 'compiler-message' && message.message.level === 'error');
        assert.ok(errors.some(message => message.message.code?.code === expected), error.stdout); return true;
      });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('private row composition preserves support files and hides low-level entry points', () => {
  const input = { ...plan.row, className: 'FactAuthority', rustCrateMode: 'standalone' } satisfies Parameters<typeof generateRowRust>[0];
  const ordinary = generateRowRust(input);
  const privateRows = generateRowRust({ ...input, internalVisibility: 'private' });
  const support = (path: string) => path !== 'adapter.rs' && path !== 'src/lib.rs';
  assert.deepEqual(ordinary.filter(file => support(file.path)), privateRows.filter(file => support(file.path)));
  const adapter = ordinary.find(file => file.path === 'adapter.rs'); assert.ok(adapter);
  const nested = privateRows.find(file => file.path === 'adapter.rs'); assert.ok(nested);
  assert.match(adapter.content, /pub\(crate\) struct FactOwner/); assert.doesNotMatch(nested.content, /pub\(crate\) struct FactOwner/);
});

test('minimal composed Rust guard conditions preserve empty conjunction and disjunction semantics', async () => {
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(join(runtime, 'truth-'));
  try {
    const truth = symbolicModel({
      version: 2, kind: 'symbolic-owned', name: 'EmptyGuardTruth', checkDeadlock: true, variables: ['flag', 'seenA', 'seenB'], inputs: [{ parameter: 'a', domain: 'As' }, { parameter: 'b', domain: 'Bs' }], next: 'Next',
      initial: { flag: { kind: 'boolean', value: false }, seenA: { kind: 'string', value: 'none' }, seenB: { kind: 'string', value: 'none' } },
      branches: [
        { action: 'Always', guard: { kind: 'and', terms: [] }, updates: { flag: { kind: 'literal', value: { kind: 'boolean', value: true } }, seenA: parameter('a'), seenB: parameter('b') }, source: null },
        { action: 'Never', guard: { kind: 'or', terms: [] }, updates: { flag: { kind: 'literal', value: { kind: 'boolean', value: false } }, seenA: state('seenA'), seenB: state('seenB') }, source: null },
      ], invariants: [], actionProperties: [],
    });
    const generated = await formatGeneratedRust(generateSymbolicRust({ model: truth, className: 'TruthAuthority', minimalGuardConditions: true }));
    for (const file of generated.files) await put(join(root, file.path), file.content);
    const manifest = await readFile(join(root, 'Cargo.toml'), 'utf8'); const packageName = /^name = "([a-z0-9-]+)"$/m.exec(manifest)?.[1]; assert.ok(packageName);
    await put(join(root, 'tests/truth.rs'), `use ${packageName.replaceAll('-', '_')}::{TruthAuthority, SymbolicValue};\n#[test] fn native_empty_guard_truth() { let mut authority=TruthAuthority::new(); for _ in 0..3 { let receipt=authority.send("a","b").unwrap(); assert_eq!(receipt.action,"Always"); assert_eq!(receipt.after.values.get("flag"),Some(&SymbolicValue::Boolean { value:true })); } }\n`);
    await execute('cargo', ['test', '--offline', '--quiet', '--manifest-path', join(root, 'Cargo.toml'), '--target-dir', target], { timeout: 180_000 });
    await execute('cargo', ['clippy', '--offline', '--quiet', '--tests', '--manifest-path', join(root, 'Cargo.toml'), '--target-dir', target, '--', '-D', 'warnings'], { timeout: 180_000 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
