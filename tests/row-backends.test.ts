import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { generateRowRust } from '../src/backends/row-rust.js';
import { encodeRowIdentity, generateRowTypeScript } from '../src/backends/row-typescript.js';
import { type RowBinding, type RowBindingPlan } from '../src/row-binding-types.js';
import { symbolicModel, type SymbolicExpression, type SymbolicGuard } from '../src/symbolic-types.js';

const execute = promisify(execFile);
const runtime = resolve('.runtime/row-backend-tests');
const target = join(runtime, 'target');
const state = (variable: string): SymbolicExpression => ({ kind: 'state', variable });
const scalar = (value: string): SymbolicExpression => ({ kind: 'literal', value: { kind: 'string', value } });
const input = (parameter: string): SymbolicExpression => ({ kind: 'input', parameter });
const equal = (left: SymbolicExpression, right: SymbolicExpression): SymbolicGuard => ({ kind: 'equal', left, right });
const notEqual = (left: SymbolicExpression, right: SymbolicExpression): SymbolicGuard => ({ kind: 'not-equal', left, right });
const and = (...terms: SymbolicGuard[]): SymbolicGuard => ({ kind: 'and', terms });
const variables = ['phase', 'stored', 'storedProvenance', 'rejected', 'rejectedProvenance'];
const unchanged = Object.fromEntries(variables.map(variable => [variable, state(variable)]));
const occupied = notEqual(state('phase'), scalar('absent'));
function model(clearOnSame = false, mixed = false) {
  return symbolicModel({
    version: 2, kind: 'symbolic-owned', name: 'WholeFact', checkDeadlock: true, variables,
    inputs: [{ parameter: 'v', domain: 'Values' }, { parameter: 'p', domain: 'Receipts' }], next: 'Next',
    initial: Object.fromEntries(variables.map(variable => [variable, { kind: 'string', value: variable === 'phase' ? 'absent' : 'none' }])),
    branches: [
      { action: 'Insert', guard: equal(state('phase'), scalar('absent')), updates: { ...unchanged, phase: scalar('present'), stored: input('v'), storedProvenance: input('p') }, source: null },
      { action: 'Same', guard: and(occupied, equal(input('v'), state('stored'))), updates: clearOnSame ? { ...unchanged, rejected: scalar('none'), rejectedProvenance: scalar('none'), phase: scalar('present') } : unchanged, source: null },
      { action: 'Clash', guard: and(occupied, notEqual(input('v'), state('stored'))), updates: { ...unchanged, phase: scalar('conflict'), rejected: input('v'), rejectedProvenance: mixed ? state('storedProvenance') : input('p') }, source: null },
    ], invariants: [], actionProperties: [],
  });
}
const binding: RowBinding = {
  version: 1, profile: 'rust-whole-row-v1', source: { manifest: 'Cargo.toml', module: 'crate::facts', facts: [{ name: 'Fact', rustPath: 'crate::facts::Fact', metadata: ['received'] }] },
  model: { payloadInput: 'v', provenanceInput: 'p', pairs: [{ name: 'stored', payload: 'stored', provenance: 'storedProvenance' }, { name: 'rejected', payload: 'rejected', provenance: 'rejectedProvenance' }] },
};
const plan: RowBindingPlan = {
  version: 1, profile: 'rust-whole-row-v1', crateName: 'row-consumer', sources: [{ path: 'src/facts.rs', sha256: 'a'.repeat(64) }],
  facts: [{ name: 'Fact', rustPath: 'crate::facts::Fact', fields: [
    { name: 'symbol', rustType: 'String', codec: { kind: 'string', getters: [] }, payload: true, provenance: false },
    { name: 'value', rustType: 'i64', codec: { kind: 'i64', getters: [] }, payload: true, provenance: false },
    { name: 'schema', rustType: 'u32', codec: { kind: 'u32', getters: [] }, payload: true, provenance: true, classes: [[2, 1]] },
    { name: 'received', rustType: 'i64', codec: { kind: 'i64', getters: [] }, payload: false, provenance: true },
    { name: 'verified', rustType: 'bool', codec: { kind: 'bool', getters: [] }, payload: true, provenance: false },
    { name: 'domain', rustType: 'Domain', codec: { kind: 'enum', getters: [], rustPath: 'crate::facts::Domain', variants: ['Spot', 'Futures'] }, payload: true, provenance: false },
  ] }],
};
const rustFacts = `pub mod facts {
#[derive(Clone, Debug, Eq, PartialEq)] pub enum Domain { Spot, Futures }
#[derive(Clone, Debug)] pub struct Fact { pub symbol: String, pub value: i64, pub schema: u32, pub received: i64, pub verified: bool, pub domain: Domain }
impl PartialEq for Fact { fn eq(&self, other: &Self) -> bool { self.symbol == other.symbol && self.value == other.value && (self.schema == other.schema || matches!((self.schema, other.schema), (1, 2) | (2, 1))) && self.verified == other.verified && self.domain == other.domain } }
impl Eq for Fact {}
}`;
async function put(path: string, content: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }
function row(overrides: Record<string, unknown> = {}) { return { symbol: '한글😀\u0000', value: -9223372036854775808n, schema: 1, received: 1n, verified: true, domain: 'Spot', ...overrides }; }

async function fixture(program = model()) {
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(join(runtime, 'suite-'));
  const ts = join(root, 'typescript'); const rust = join(root, 'rust'); const consumer = join(root, 'consumer');
  try {
  for (const file of generateRowTypeScript({ model: program, className: 'FactAuthority', plan, binding })) await put(join(ts, file.path), file.content);
  for (const file of generateRowRust({ model: program, className: 'FactAuthority', plan, binding, rustCrateMode: 'standalone' })) await put(join(rust, file.path), file.content);
  await execute(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', join(ts, 'tsconfig.json')], { timeout: 30_000 });
  const manifest = await readFile(join(rust, 'Cargo.toml'), 'utf8'); const packageName = /^name = "([a-z0-9-]+)"$/m.exec(manifest)?.[1]; assert.ok(packageName);
  await put(join(consumer, 'Cargo.toml'), `[package]\nname = "row-consumer"\nversion = "0.1.0"\nedition = "2021"\n[workspace]\n[dependencies]\nsgd_fact_authority = { package = "${packageName}", path = "../rust" }\nserde_json = "=1.0.154"\n`);
  await put(join(consumer, 'src/main.rs'), `#![forbid(unsafe_code)]
${rustFacts}
#[path = "../../rust/adapter.rs"] mod adapter;
use adapter::FactOwner;
use facts::{Fact, Domain};
fn observed(row: Option<&Fact>) -> serde_json::Value { match row { None => serde_json::Value::Null, Some(row) => serde_json::json!({ "symbol": row.symbol, "value": row.value.to_string(), "schema": row.schema, "received": row.received.to_string(), "verified": row.verified, "domain": match row.domain { Domain::Spot => "Spot", Domain::Futures => "Futures" } }) } }
fn main() {
 if ${program.branches.some(branch => branch.action === 'Clash' && branch.updates.rejectedProvenance?.kind === 'input') && !program.branches.some(branch => branch.action === 'Same' && branch.guard.kind === 'boolean' && !branch.guard.value)} { for a in [0, 1, 2, 3, u32::MAX] {
   for b in [0, 1, 2, 3, u32::MAX] {
     let first = Fact { symbol: "law".into(), value: 1, schema: a, received: 1, verified: false, domain: Domain::Futures };
     let second = Fact { schema: b, received: 2, ..first.clone() };
     let equal = first == second;
     let mut law_owner = FactOwner::<Fact>::new();
     assert_eq!(law_owner.write(first).unwrap(), adapter::WriteEffect::Insert);
     assert_eq!(law_owner.write(second).unwrap(), if equal { adapter::WriteEffect::Same } else { adapter::WriteEffect::Clash });
     assert_eq!(law_owner.stored().unwrap().received, 1);
     assert_eq!(law_owner.stored().unwrap().schema, a);
   }
 } }
 let mut owner = FactOwner::<Fact>::new();
 let mut trace = Vec::new();
 for (value, schema, received) in [(i64::MIN, 1, 1), (42, 2, 2), (43, 2, 3), (i64::MIN, 2, 4), (i64::MIN, 3, 5)] {
   let result = owner.write(Fact { symbol: "한글😀\\0".into(), value, schema, received, verified: true, domain: Domain::Spot });
   let effect = result.map(|effect| format!("{effect:?}")).unwrap_or_else(|_| "rejected".to_owned());
   trace.push(serde_json::json!({ "effect": effect, "stored": observed(owner.stored()), "rejected": observed(owner.rejected()), "state": owner.read() }));
 }
 println!("{}", serde_json::to_string(&trace).unwrap());
}`);
  await execute('cargo', ['fetch', '--manifest-path', join(consumer, 'Cargo.toml'), '--quiet'], { timeout: 180_000 });
  return { root, ts, rust, consumer };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

function tsTrace(module: { createFactOwner(): { write(row: unknown): unknown; read(): unknown }; createFactRow(value: unknown): unknown }) {
  const owner = module.createFactOwner();
  return [row(), row({ value: 42n, schema: 2, received: 2n }), row({ value: 43n, schema: 2, received: 3n }), row({ schema: 2, received: 4n }), row({ schema: 3, received: 5n })].map(value => {
    const result = owner.write(module.createFactRow(value));
    assert.ok(typeof result === 'object' && result !== null && 'effect' in result);
    const observation = owner.read();
    assert.ok(typeof observation === 'object' && observation !== null);
    return JSON.parse(JSON.stringify({ effect: result.effect, ...observation }, (_name, item: unknown) => typeof item === 'bigint' ? item.toString() : item));
  });
}

test('whole-row Rust and TypeScript preserve original metadata, select native equality classes, and produce identical byte identities', async () => {
  const native = await fixture();
  try {
    const module = await import(pathToFileURL(join(native.ts, 'dist/machine.js')).href);
    const typescript = tsTrace(module);
    const result = await execute('cargo', ['run', '--offline', '--quiet', '--manifest-path', join(native.consumer, 'Cargo.toml'), '--target-dir', target], { timeout: 180_000 });
    const rust = JSON.parse(result.stdout);
    assert.deepEqual(typescript, rust);
    assert.deepEqual(typescript.map(entry => entry.effect), ['Insert', 'Clash', 'Clash', 'Same', 'Clash']);
    assert.equal(typescript[3].stored.schema, 1); assert.equal(typescript[3].stored.received, '1'); assert.equal(typescript[3].rejected.received, '3');
    const fact = plan.facts[0]; assert.ok(fact);
    assert.equal(typescript[0].state.values.stored.value, encodeRowIdentity({ fact, flavor: 'payload', values: row() }));
    assert.equal(typescript[0].state.values.storedProvenance.value, encodeRowIdentity({ fact, flavor: 'provenance', values: row() }));
    // The source equality excludes receipt but gives schemas 1 and 2 one payload class only.
    assert.equal(encodeRowIdentity({ fact, flavor: 'payload', values: row() }), encodeRowIdentity({ fact, flavor: 'payload', values: row({ schema: 2, received: 999n }) }));
    assert.notEqual(encodeRowIdentity({ fact, flavor: 'provenance', values: row() }), encodeRowIdentity({ fact, flavor: 'provenance', values: row({ schema: 2 }) }));
    for (const changed of [{ schema: 3 }, { value: 0n }, { verified: false }, { domain: 'Futures' }, { symbol: 'other' }]) assert.notEqual(encodeRowIdentity({ fact, flavor: 'payload', values: row() }), encodeRowIdentity({ fact, flavor: 'payload', values: row(changed) }));
  } finally { await rm(native.root, { recursive: true, force: true }); }
});

test('TypeScript admits only authenticated complete immutable row tokens', async () => {
  const native = await fixture();
  try {
    const module = await import(pathToFileURL(join(native.ts, 'dist/machine.js')).href);
    const owner = module.createFactOwner(); const original = row(); const token = module.createFactRow(original);
    original.received = 1000n;
    assert.ok(Object.isFrozen(token)); assert.throws(() => { token.received = 999n; }, TypeError);
    assert.equal(owner.write(token).effect, 'Insert'); const before = owner.read();
    for (const forged of [original, { ...token }, {}, null, 'Same']) assert.equal(owner.write(forged).reason, 'invalid-row');
    assert.deepEqual(owner.read(), before); assert.equal(owner.read().stored.received, 1n);
    for (const invalid of [row({ extra: true }), row({ value: 1 }), row({ value: 9223372036854775808n }), row({ schema: -1 }), row({ schema: 1.1 }), row({ symbol: '\ud800' }), row({ domain: 'Unknown' })]) assert.throws(() => module.createFactRow(invalid), /ROW303/);
    const accessor = { ...row() }; Object.defineProperty(accessor, 'received', { get() { throw new Error('must not invoke getter'); }, enumerable: true });
    assert.throws(() => module.createFactRow(accessor), /ROW303.*accessors/);
  } finally { await rm(native.root, { recursive: true, force: true }); }
});

test('mixed row origins fail the binding gate before native code is emitted', () => {
  assert.throws(() => generateRowRust({ model: model(false, true), className: 'FactAuthority', plan, binding, rustCrateMode: 'standalone' }), /TLC305.*mixes/);
  assert.throws(() => generateRowTypeScript({ model: model(false, true), className: 'FactAuthority', plan, binding }), /TLC305.*mixes/);
});

test('disabled whole-row preparations preserve all retained rows and revisions in both languages', async () => {
  const { source: _source, ...program } = model();
  const disabled = symbolicModel({ ...program, checkDeadlock: false, branches: program.branches.map(branch => branch.action === 'Same' ? { ...branch, guard: { kind: 'boolean', value: false } satisfies SymbolicGuard } : branch) });
  const native = await fixture(disabled);
  try {
    const module = await import(pathToFileURL(join(native.ts, 'dist/machine.js')).href);
    const owner = module.createFactOwner(); assert.equal(owner.write(module.createFactRow(row())).effect, 'Insert'); const before = owner.read();
    assert.equal(owner.write(module.createFactRow(row({ schema: 2, received: 2n }))).reason, 'disabled'); assert.deepEqual(owner.read(), before);
    const rust = await execute('cargo', ['run', '--offline', '--quiet', '--manifest-path', join(native.consumer, 'Cargo.toml'), '--target-dir', target], { timeout: 180_000 });
    const trace = JSON.parse(rust.stdout); assert.equal(trace[3].effect, 'rejected'); assert.deepEqual(trace[3].state, trace[2].state); assert.deepEqual(trace[3].stored, trace[2].stored); assert.deepEqual(trace[3].rejected, trace[2].rejected);
  } finally { await rm(native.root, { recursive: true, force: true }); }
});

test('a model requirement change regenerates the complete row behavior in both languages', async () => {
  const native = await fixture(model(true));
  try {
    const module = await import(pathToFileURL(join(native.ts, 'dist/machine.js')).href);
    const typescript = tsTrace(module);
    const rust = await execute('cargo', ['run', '--offline', '--quiet', '--manifest-path', join(native.consumer, 'Cargo.toml'), '--target-dir', target], { timeout: 180_000 });
    assert.deepEqual(typescript, JSON.parse(rust.stdout)); assert.equal(typescript[3].rejected, null); assert.equal(typescript[3].state.values.phase.value, 'present');
  } finally { await rm(native.root, { recursive: true, force: true }); }
});

test('Rust rejects open Eq wrappers, raw row mutation and unclassified added fields', async () => {
  const native = await fixture();
  try {
    const original = await readFile(join(native.consumer, 'src/main.rs'), 'utf8');
    for (const [body, expected] of [
      ['let _ = FactOwner::<String>::new();', 'E0277'],
      ['let mut owner = FactOwner::<Fact>::new(); owner.stored = None;', 'E0616'],
      ['let _ = FactOwner::<Fact>::restore();', 'E0599'],
      ['let mut owner = FactOwner::<Fact>::new(); owner.same();', 'E0599'],
    ]) {
      await put(join(native.consumer, 'src/main.rs'), original.replace(/fn main\(\) \{[\s\S]*$/, `fn main() { ${body} }`));
      await assert.rejects(execute('cargo', ['check', '--offline', '--quiet', '--message-format=json', '--manifest-path', join(native.consumer, 'Cargo.toml'), '--target-dir', target], { timeout: 180_000 }), (error: unknown) => {
        assert.ok(error instanceof Error && 'stdout' in error && typeof error.stdout === 'string');
        const errors = error.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(message => message.reason === 'compiler-message' && message.message.level === 'error');
        assert.ok(errors.some(message => message.message.code?.code === expected)); return true;
      });
    }
    await put(join(native.consumer, 'src/main.rs'), original.replace('pub received: i64,', 'pub received: i64, pub added: i64,').replace('received, verified:', 'received, added: 0, verified:'));
    await assert.rejects(execute('cargo', ['check', '--offline', '--quiet', '--message-format=json', '--manifest-path', join(native.consumer, 'Cargo.toml'), '--target-dir', target], { timeout: 180_000 }), (error: unknown) => { assert.ok(error instanceof Error && 'stdout' in error && typeof error.stdout === 'string'); assert.match(error.stdout, /E0027/); return true; });
  } finally { await rm(native.root, { recursive: true, force: true }); }
});

test('per-type token authentication and native TypeScript readonly boundaries reject bypasses', async () => {
  await mkdir(runtime, { recursive: true }); const root = await mkdtemp(join(runtime, 'suite-'));
  try {
    const fact = plan.facts[0]; assert.ok(fact);
    const twoFacts = { ...plan, facts: [fact, { ...fact, name: 'OtherFact', rustPath: 'crate::facts::OtherFact' }] };
    for (const file of generateRowTypeScript({ model: model(), className: 'FactAuthority', plan: twoFacts, binding: { ...binding, source: { ...binding.source, facts: [...binding.source.facts, { name: 'OtherFact', rustPath: 'crate::facts::OtherFact', metadata: ['received'] }] } } })) await put(join(root, file.path), file.content);
    await execute(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json')], { timeout: 30_000 });
    const module = await import(pathToFileURL(join(root, 'dist/machine.js')).href);
    const owner = module.createFactOwner(); const before = owner.read();
    assert.equal(owner.write(module.createOtherFactRow(row())).reason, 'invalid-row'); assert.deepEqual(owner.read(), before);
    const other = module.createOtherFactOwner(); assert.equal(other.write(module.createFactRow(row())).reason, 'invalid-row');
    await put(join(root, 'consumer.ts'), `import { createFactOwner, createFactRow, type FactRow } from './machine.js';
const owner = createFactOwner();
const row = createFactRow({symbol:'x',value:1n,schema:1,received:1n,verified:true,domain:'Spot'});
row.received = 2n;
owner.stored = row;
owner.same(row);
owner.restore({});
const forged: FactRow = {symbol:'x',value:1n,schema:1,received:1n,verified:true,domain:'Spot'};
owner.write(forged);
`);
    const config = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8')); config.include.push('consumer.ts'); await put(join(root, 'tsconfig.json'), JSON.stringify(config));
    await assert.rejects(execute(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json')], { timeout: 30_000 }), (error: unknown) => {
      assert.ok(error instanceof Error && 'stdout' in error && typeof error.stdout === 'string');
      for (const [line, code] of [[4, 2540], [5, 2339], [6, 2339], [7, 2339], [8, 2741]]) assert.match(error.stdout, new RegExp(`consumer\\.ts\\(${line},[0-9]+\\): error TS${code}`));
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('identity encoding remains exact at numeric and framing boundaries', () => {
  const fact = plan.facts[0]; assert.ok(fact);
  const identities = new Set<string>();
  for (const value of [-9223372036854775808n, -1n, 0n, 1n, 9223372036854775807n]) {
    const encoded = encodeRowIdentity({ fact, flavor: 'payload', values: row({ value }) });
    assert.ok(!identities.has(encoded)); identities.add(encoded);
  }
  for (const symbol of ['', ':;', '1:ff;', '\0', '가😀']) {
    const encoded = encodeRowIdentity({ fact, flavor: 'payload', values: row({ symbol }) }); assert.ok(!identities.has(encoded)); identities.add(encoded);
  }
  for (const invalid of [{ received: -9223372036854775809n }, { schema: 4294967296 }, { symbol: '\udfff' }, { domain: 'Missing' }, { extra: 1 }]) assert.throws(() => encodeRowIdentity({ fact, flavor: 'payload', values: row(invalid) }), /ROW303/);
});


test('the removed outcome classifier cannot silently relabel source actions', () => {
  for (const outcomes of [
    { Insert: 'Inserted', Same: 'Unchanged', Clash: 'Conflict' },
    { Insert: 'Inserted', Same: 'Conflict', Clash: 'Unchanged' },
  ]) {
    const legacy = { ...binding, model: { ...binding.model, outcomes } };
    assert.throws(() => generateRowRust({ model: model(), className: 'FactAuthority', plan, binding: legacy, rustCrateMode: 'standalone' }), /TLC305.*binding/);
    assert.throws(() => generateRowTypeScript({ model: model(), className: 'FactAuthority', plan, binding: legacy }), /TLC305.*binding/);
  }
});

test('source action renames remain visible and require native caller adaptation', async () => {
  const { source: _source, ...program } = model();
  const renamed = symbolicModel({ ...program, branches: program.branches.map(branch => ({ ...branch, action: branch.action === 'Insert' ? 'Capture' : branch.action === 'Same' ? 'Retain' : 'Reject' })) });
  const native = await fixture(renamed);
  try {
    const module = await import(pathToFileURL(join(native.ts, 'dist/machine.js')).href);
    const trace = tsTrace(module);
    assert.deepEqual(trace.map(entry => entry.effect), ['Capture', 'Reject', 'Reject', 'Retain', 'Reject']);
    await assert.rejects(execute('cargo', ['check', '--offline', '--quiet', '--message-format=json', '--manifest-path', join(native.consumer, 'Cargo.toml'), '--target-dir', target], { timeout: 180_000 }), (error: unknown) => {
      assert.ok(error instanceof Error && 'stdout' in error && typeof error.stdout === 'string');
      const errors = error.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(message => message.reason === 'compiler-message' && message.message.level === 'error');
      assert.ok(errors.length >= 3); assert.ok(errors.every(message => message.message.code?.code === 'E0599'));
      return true;
    });
    const path = join(native.consumer, 'src/main.rs');
    const source = await readFile(path, 'utf8');
    await put(path, source.replaceAll('WriteEffect::Insert', 'WriteEffect::Capture').replaceAll('WriteEffect::Same', 'WriteEffect::Retain').replaceAll('WriteEffect::Clash', 'WriteEffect::Reject'));
    const result = await execute('cargo', ['run', '--offline', '--quiet', '--manifest-path', join(native.consumer, 'Cargo.toml'), '--target-dir', target], { timeout: 180_000 });
    assert.deepEqual(JSON.parse(result.stdout), trace);
  } finally { await rm(native.root, { recursive: true, force: true }); }
});
