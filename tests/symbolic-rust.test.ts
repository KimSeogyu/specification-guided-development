import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { generateSymbolicRust } from '../src/backends/symbolic-rust.js';
import { symbolicModel, type SymbolicExpression, type SymbolicGuard, type SymbolicModel } from '../src/symbolic-types.js';
import { inspectSymbolicOrbits, stepSymbolic, type SymbolicState } from '../src/symbolic-semantics.js';

const runtime = resolve('.runtime/symbolic-rust-tests');
const target = join(runtime, 'target');
const hugeInteger = '987654321098765432109876543210987654321098765432109876543210';
const state = (variable: string): SymbolicExpression => ({ kind: 'state', variable });
const literal = (value: string): SymbolicExpression => ({ kind: 'literal', value: { kind: 'string', value } });
const input: SymbolicExpression = { kind: 'input' };
const inDomain = (value: SymbolicExpression): SymbolicGuard => ({ kind: 'in-domain', value, domain: 'Values' });
const equal = (left: SymbolicExpression, right: SymbolicExpression): SymbolicGuard => ({ kind: 'equal', left, right });
const updates = (result: string, overrides: Record<string, SymbolicExpression> = {}): Record<string, SymbolicExpression> => ({
  stored: state('stored'), rejected: state('rejected'), previous: state('previous'),
  result: literal(result), amount: state('amount'), ready: state('ready'), ...overrides,
});
const model = symbolicModel({
  version: 1, kind: 'symbolic-owned', name: 'OpaqueIdentity', checkDeadlock: false,
  variables: ['stored', 'rejected', 'previous', 'result', 'amount', 'ready'],
  input: { parameter: 'incoming', domain: 'Values', next: 'Receive' },
  initial: {
    stored: { kind: 'string', value: 'none' }, rejected: { kind: 'string', value: 'none' }, previous: { kind: 'string', value: 'none' },
    result: { kind: 'string', value: 'Idle' }, amount: { kind: 'integer', value: hugeInteger }, ready: { kind: 'boolean', value: false },
  },
  branches: [
    { action: 'First', guard: { kind: 'and', terms: [equal(state('stored'), literal('none')), inDomain(input),
      { kind: 'and', terms: [] }, { kind: 'not', term: { kind: 'or', terms: [] } },
      { kind: 'not', term: { kind: 'member', value: input, elements: [] } },
    ] },
      updates: updates('First', { stored: input, ready: { kind: 'literal', value: { kind: 'boolean', value: true } } }), source: null },
    { action: 'Same', guard: { kind: 'and', terms: [inDomain(state('stored')), equal(state('stored'), input)] }, updates: updates('Same'), source: null },
    { action: 'Clash', guard: { kind: 'and', terms: [
      inDomain(state('stored')), { kind: 'not-equal', left: state('stored'), right: input },
      { kind: 'or', terms: [{ kind: 'boolean', value: false }, { kind: 'boolean', value: true }] },
      { kind: 'not', term: { kind: 'boolean', value: false } },
      { kind: 'implies', left: { kind: 'boolean', value: true }, right: { kind: 'boolean', value: true } },
      { kind: 'equivalent', left: { kind: 'boolean', value: false }, right: { kind: 'boolean', value: false } },
      { kind: 'member', value: state('amount'), elements: [{ kind: 'integer', value: hugeInteger }] },
      { kind: 'member', value: state('ready'), elements: [{ kind: 'boolean', value: true }] },
    ] }, updates: updates('Clash', { rejected: input, previous: state('rejected') }), source: null },
  ],
  invariants: [{ name: 'StoredType', predicate: { kind: 'or', terms: [equal(state('stored'), literal('none')), inDomain(state('stored'))] } }],
  actionProperties: [{ kind: 'square-action', name: 'StoredNeverChangesAfterFirst', predicate: {
    kind: 'implies', left: inDomain(state('stored')), right: equal(state('stored'), { kind: 'next-state', variable: 'stored' }),
  } }],
});
let directory = '';
let authority = '';
let consumer = '';
let packageName = '';

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function cargo(args: string[], request?: unknown, cwd = consumer) {
  const result = spawnSync('cargo', [...args, '--offline', '--quiet', '--manifest-path', join(cwd, 'Cargo.toml'), '--target-dir', target], {
    encoding: 'utf8', timeout: 180_000, ...(request === undefined ? {} : { input: JSON.stringify(request) }),
  });
  assert.equal(result.error, undefined, `${result.error}\n${result.stderr}`);
  return result;
}

function trace(program: SymbolicModel, sequence: string[]) {
  let values: SymbolicState = program.initial;
  let revision = 0n;
  const snapshot = () => ({ model: program.name, modelRevision: program.source.semanticSha256, revision: revision.toString(), values });
  return sequence.map(value => {
    const before = snapshot();
    const result = stepSymbolic(program, values, value);
    if (result.kind !== 'accepted') return { ok: false, reason: result.kind, state: before };
    values = result.state;
    revision += 1n;
    return { ok: true, action: result.action, before, after: snapshot(), updates: result.updates };
  });
}

function runSequences(program: SymbolicModel, sequences: string[][]): void {
  const result = cargo(['run', '--bin', 'symbolic-consumer'], sequences);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), sequences.map(sequence => trace(program, sequence)));
}

const CargoEventSchema = z.object({ reason: z.string() }).passthrough();
const CompilerMessageSchema = z.object({ reason: z.literal('compiler-message'), message: z.object({
  level: z.string(), code: z.object({ code: z.string() }).passthrough().nullable(),
  spans: z.array(z.object({ file_name: z.string(), is_primary: z.boolean(), line_start: z.number().int().positive() }).passthrough()),
}).passthrough() }).passthrough();
type ErrorCode = 'E0616' | 'E0451' | 'E0599' | 'E0277' | 'E0614' | 'E0061';

async function compileFailure(name: string, body: string, expectedCode: ErrorCode): Promise<void> {
  const source = join(consumer, 'src/bin', `${name}.rs`);
  await put(source, `use authority::IdentityAuthority;\nfn main() { ${body} }\n`);
  const result = cargo(['check', '--bin', name, '--message-format=json']);
  assert.equal(result.status, 101, `${name} must fail compilation:\n${result.stderr}\n${result.stdout}`);
  const errors = result.stdout.split(/\r?\n/).filter(line => line.length > 0)
    .map(line => CargoEventSchema.parse(JSON.parse(line))).filter(event => event.reason === 'compiler-message')
    .map(event => CompilerMessageSchema.parse(event).message).filter(message => message.level === 'error');
  assert.ok(errors.length > 0, `${name} must report a source rejection:\n${result.stderr}`);
  for (const error of errors) {
    assert.equal(error.code?.code, expectedCode, `${name} must fail for the specified authority violation`);
    assert.ok(error.spans.some(span => span.is_primary && resolve(consumer, span.file_name) === source && span.line_start === 2), `${name} must identify its own rejected source expression`);
  }
}

before(async () => {
  await mkdir(runtime, { recursive: true });
  directory = await mkdtemp(join(runtime, 'suite-'));
  authority = join(directory, 'authority');
  consumer = join(directory, 'consumer');
  const files = generateSymbolicRust({ model, className: 'IdentityAuthority' });
  for (const file of files) await put(join(authority, file.path), file.content);
  const manifest = files.find(file => file.path === 'Cargo.toml');
  assert.ok(manifest);
  const matched = /^name = "([a-z0-9-]+)"$/m.exec(manifest.content);
  assert.ok(matched?.[1]);
  packageName = matched[1];
  await put(join(consumer, 'Cargo.toml'), `[package]
name = "symbolic-consumer"
version = "0.1.0"
edition = "2021"

[workspace]

[dependencies]
authority = { package = "${packageName}", path = "../authority" }
serde_json = "=1.0.154"
`);
  await put(join(consumer, 'src/main.rs'), `#![forbid(unsafe_code)]
use authority::{IdentityAuthority, SymbolicValue};
use std::io::Read;
fn main() {
    let mut copied_input = String::from("original-input");
    let mut input_owner = IdentityAuthority::new();
    input_owner.send(&copied_input).unwrap();
    copied_input.clear();
    copied_input.push_str("changed-after-send");
    assert_eq!(input_owner.read().values["stored"], SymbolicValue::Data { domain: "Values".into(), value: "original-input".into() });
    let mut request = String::new();
    std::io::stdin().read_to_string(&mut request).unwrap();
    let sequences: Vec<Vec<String>> = serde_json::from_str(&request).unwrap();
    let mut traces = Vec::new();
    for sequence in sequences {
        let mut owner = IdentityAuthority::new();
        let original = owner.read();
        let mut copied = owner.read();
        copied.values.clear();
        copied.revision = "1000".into();
        assert_eq!(owner.read(), original);
        let mut trace = Vec::new();
        for input in sequence {
            let (ok, mut result) = match owner.send(&input) {
                Ok(receipt) => (true, serde_json::to_value(receipt).unwrap()),
                Err(error) => (false, serde_json::to_value(error).unwrap()),
            };
            result.as_object_mut().unwrap().insert("ok".into(), serde_json::json!(ok));
            trace.push(result);
            let stable = owner.read();
            let mut copied = owner.read();
            if let Some(SymbolicValue::Data { value, .. }) = copied.values.get_mut("stored") { value.clear(); }
            assert_eq!(owner.read(), stable);
        }
        traces.push(trace);
    }
    println!("{}", serde_json::to_string(&traces).unwrap());
}
`);
  const fetched = spawnSync('cargo', ['fetch', '--quiet', '--manifest-path', join(consumer, 'Cargo.toml')], { encoding: 'utf8', timeout: 180_000 });
  assert.equal(fetched.error, undefined, `${fetched.error}\n${fetched.stderr}`);
  assert.equal(fetched.status, 0, `Fetch dependencies before offline source checks:\n${fetched.stderr}`);
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  // The parent task removes the owned target after complete verification.
});

test('Rust dispatch uses actual immutable data, sentinel tags and simultaneous old-state copies', () => {
  const sequences = [
    ['A', 'B', 'C', 'A'], ['none', 'other', 'none'], ['Same', 'Clash', 'Same'],
    ['', '\u0000', '한글 😀 " \\ \n', 'opaque-'.repeat(1000)],
  ];
  runSequences(model, sequences);
  const final = trace(model, ['A', 'B', 'C', 'A']).at(-1);
  assert.ok(final?.ok && 'after' in final);
  assert.deepEqual(final.after.values.stored, { kind: 'data', domain: 'Values', value: 'A' });
  assert.deepEqual(final.after.values.rejected, { kind: 'data', domain: 'Values', value: 'C' });
  assert.deepEqual(final.after.values.previous, { kind: 'data', domain: 'Values', value: 'B' });
  assert.deepEqual(final.after.values.amount, { kind: 'integer', value: hugeInteger });
  assert.match(packageName, /^sgd-symbolic-opaqueidentity-[a-f0-9]{12}$/);
});

test('native Rust replays every equality/copy orbit input against the interpreter', () => {
  const orbits = inspectSymbolicOrbits(model);
  const representatives = new Map<number, { path: string[]; state: SymbolicState }>([[0, { path: [], state: model.initial }]]);
  const sequences: string[][] = [];
  const canonical = (values: SymbolicState): SymbolicState => {
    const atoms = new Map<string, string>();
    return Object.fromEntries(model.variables.map(variable => {
      const value = values[variable];
      assert.ok(value);
      if (value.kind !== 'data') return [variable, value];
      let atom = atoms.get(value.value);
      if (atom === undefined) { atom = `a${atoms.size}`; atoms.set(value.value, atom); }
      return [variable, { ...value, value: atom }];
    }));
  };
  for (let index = 0; index < orbits.states.length; index++) {
    const representative = representatives.get(index);
    assert.ok(representative, `orbit ${index} needs an actual reachable representative`);
    assert.deepEqual(canonical(representative.state), orbits.states[index]);
    const atoms = [...new Set(model.variables.flatMap(variable => {
      const value = representative.state[variable];
      return value?.kind === 'data' ? [value.value] : [];
    }))];
    const actualInput = (abstract: string) => {
      const number = Number(abstract.slice(1));
      const existing = atoms[number];
      if (existing !== undefined) return existing;
      let fresh = `fresh-orbit-${index}-한글-${'x'.repeat(index)}`;
      while (atoms.includes(fresh)) fresh += '_';
      return fresh;
    };
    for (const edge of orbits.edges.filter(item => item.from === index)) {
      const value = actualInput(edge.input);
      const sequence = [...representative.path, value];
      sequences.push(sequence);
      const result = stepSymbolic(model, representative.state, value);
      assert.equal(result.kind, 'accepted');
      if (result.kind !== 'accepted') throw new Error('Expected orbit successor');
      assert.equal(result.action, edge.action);
      assert.deepEqual(canonical(result.state), orbits.states[edge.to]);
      if (!representatives.has(edge.to)) representatives.set(edge.to, { path: sequence, state: result.state });
    }
    for (const rejected of orbits.disabled.filter(item => item.state === index)) sequences.push([...representative.path, actualInput(rejected.input)]);
  }
  assert.equal(representatives.size, orbits.states.length);
  assert.equal(sequences.length, orbits.edges.length + orbits.disabled.length);
  runSequences(model, sequences);
});

test('Rust denies direct and aliased state writes, raw construction and owner copying', async () => {
  await compileFailure('write-state', 'let mut owner = IdentityAuthority::new(); owner.values.clear();', 'E0616');
  await compileFailure('write-revision', 'let mut owner = IdentityAuthority::new(); owner.revision = 1;', 'E0616');
  await compileFailure('alias-write', 'let mut owner = IdentityAuthority::new(); let alias = &mut owner; alias.values.clear();', 'E0616');
  await compileFailure('raw-construction', 'let _ = IdentityAuthority { values: Default::default(), revision: 0 };', 'E0451');
  await compileFailure('clone-owner', 'let owner = IdentityAuthority::new(); let _ = owner.clone();', 'E0599');
  await compileFailure('restore-owner', 'let _ = IdentityAuthority::restore("A");', 'E0599');
  await compileFailure('deserialize-owner', 'let _: IdentityAuthority = serde_json::from_str("{}").unwrap();', 'E0277');
  await compileFailure('deref-owner', 'let mut owner = IdentityAuthority::new(); let _ = &mut *owner;', 'E0614');
});

test('callers cannot select Same or Clash as the operation', async () => {
  await compileFailure('select-same', 'let mut owner = IdentityAuthority::new(); owner.same("A");', 'E0599');
  await compileFailure('select-clash', 'let mut owner = IdentityAuthority::new(); owner.clash("A");', 'E0599');
  await compileFailure('select-action', 'let mut owner = IdentityAuthority::new(); owner.send("Same", "A");', 'E0061');
});

test('symbolic crate rejects revision overflow without changing complete state', () => {
  const result = cargo(['test', '--lib'], undefined, authority);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 passed/);
});

test('generation validates semantics, references, invariants and overlapping actions before rendering', () => {
  assert.deepEqual(generateSymbolicRust({ model, className: 'IdentityAuthority' }), generateSymbolicRust({ model: structuredClone(model), className: 'IdentityAuthority' }));
  assert.throws(() => generateSymbolicRust({ model: { ...model, source: { semanticSha256: '0'.repeat(64) } }, className: 'IdentityAuthority' }), /TLC301/);
  const { source: _source, ...program } = model;
  const first = program.branches[0];
  assert.ok(first);
  const overlap = symbolicModel({ ...program, branches: [...program.branches, { ...first, action: 'Overlap' }] });
  assert.throws(() => generateSymbolicRust({ model: overlap, className: 'IdentityAuthority' }), /TLC302.*more than one/);
  const invalidInvariant = symbolicModel({ ...program, invariants: [{ name: 'Fails', predicate: { kind: 'boolean', value: false } }] });
  assert.throws(() => generateSymbolicRust({ model: invalidInvariant, className: 'IdentityAuthority' }), /TLC302.*Fails/);
  assert.throws(() => symbolicModel({ ...program, branches: [{ ...first, updates: { ...first.updates, stored: state('missing') } }] }), /TLC301/);
});

test('a changed requirement regenerates native behavior and disabled sends preserve state', async () => {
  const { source: _source, ...program } = model;
  const changed = symbolicModel({ ...program, branches: program.branches.map(branch => branch.action === 'Same' ? { ...branch, guard: { kind: 'boolean', value: false } } : branch) });
  try {
    for (const file of generateSymbolicRust({ model: changed, className: 'IdentityAuthority' })) await put(join(authority, file.path), file.content);
    runSequences(changed, [['A', 'A', 'B', 'A'], ['none', 'none']]);
    assert.notEqual(changed.source.semanticSha256, model.source.semanticSha256);
  } finally {
    for (const file of generateSymbolicRust({ model, className: 'IdentityAuthority' })) await put(join(authority, file.path), file.content);
  }
});
