import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { z } from 'zod';
import { generateSymbolicRust } from '../src/backends/symbolic-rust.js';
import { generateSymbolicTypeScript } from '../src/backends/symbolic-typescript.js';
import type { FiniteValue } from '../src/finite-types.js';
import { stepSymbolic, type SymbolicState } from '../src/symbolic-semantics.js';
import { symbolicInputs, symbolicModel, type SymbolicExpression, type SymbolicGuard, type SymbolicModel } from '../src/symbolic-types.js';

const execute = promisify(execFile);
const runtime = resolve('.runtime/product-input-backends-tests');
const target = join(runtime, 'target');
const compiler = resolve('node_modules/typescript/bin/tsc');
const state = (variable: string): SymbolicExpression => ({ kind: 'state', variable });
const scalar = (value: string): SymbolicExpression => ({ kind: 'literal', value: { kind: 'string', value } });
const input = (parameter: string): SymbolicExpression => ({ kind: 'input', parameter });
const equal = (left: SymbolicExpression, right: SymbolicExpression): SymbolicGuard => ({ kind: 'equal', left, right });
const notEqual = (left: SymbolicExpression, right: SymbolicExpression): SymbolicGuard => ({ kind: 'not-equal', left, right });
const and = (...terms: SymbolicGuard[]): SymbolicGuard => ({ kind: 'and', terms });
const variables = ['phase', 'original', 'originalReceipt', 'rejected', 'rejectedReceipt'];

function envelopeModel(clearOnSame = false): SymbolicModel {
  const preserve = Object.fromEntries(variables.map(variable => [variable, state(variable)]));
  const occupied = notEqual(state('phase'), scalar('absent'));
  return symbolicModel({
    version: 2, kind: 'symbolic-owned', name: 'FactEnvelope', checkDeadlock: true, variables,
    inputs: [{ parameter: 'v', domain: 'Values' }, { parameter: 'receipt', domain: 'Receipts' }], next: 'Next',
    initial: Object.fromEntries(variables.map(variable => [variable, { kind: 'string', value: variable === 'phase' ? 'absent' : 'none' } satisfies FiniteValue])),
    branches: [
      { action: 'Insert', guard: and(equal(state('phase'), scalar('absent')), notEqual(input('v'), input('receipt'))),
        updates: { ...preserve, phase: scalar('present'), original: input('v'), originalReceipt: input('receipt') }, source: null },
      { action: 'Same', guard: and(occupied, equal(input('v'), state('original'))),
        updates: clearOnSame ? { ...preserve, phase: scalar('present'), rejected: scalar('none'), rejectedReceipt: scalar('none') } : preserve, source: null },
      { action: 'Clash', guard: and(occupied, notEqual(input('v'), state('original'))),
        updates: { ...preserve, phase: scalar('conflict'), rejected: input('v'), rejectedReceipt: input('receipt') }, source: null },
    ],
    invariants: [],
    actionProperties: [{ kind: 'square-action', name: 'OriginalEnvelopeStable', predicate: { kind: 'implies', left: occupied,
      right: and(equal(state('original'), { kind: 'next-state', variable: 'original' }), equal(state('originalReceipt'), { kind: 'next-state', variable: 'originalReceipt' })) } }],
  });
}

function tripleModel(): SymbolicModel {
  return symbolicModel({
    version: 2, kind: 'symbolic-owned', name: 'ThreeInputs', checkDeadlock: true, variables: ['first', 'second', 'third'],
    inputs: [{ parameter: 'first', domain: 'Firsts' }, { parameter: 'second', domain: 'Seconds' }, { parameter: 'third', domain: 'Thirds' }], next: 'Next',
    initial: { first: { kind: 'string', value: 'none' }, second: { kind: 'string', value: 'none' }, third: { kind: 'string', value: 'none' } },
    branches: [{ action: 'Capture', guard: and(notEqual(input('first'), input('second')), notEqual(input('second'), input('third')), notEqual(input('first'), input('third'))),
      updates: { first: input('first'), second: input('second'), third: input('third') }, source: null }], invariants: [], actionProperties: [],
  });
}

type Sequence = string[][];
type Native = { typescript: string; rust: string; consumer: string };
type Snapshot = { model: string; modelRevision: string; revision: string; values: SymbolicState };
type TraceEntry =
  | { ok: true; action: string; before: Snapshot; after: Snapshot; updates: Readonly<Record<string, SymbolicExpression>> }
  | { ok: false; reason: string; state: Snapshot };
const CompilerEvent = z.object({ reason: z.string() }).passthrough();
const ErrorDiagnostic = z.object({ reason: z.literal('compiler-message'), message: z.object({
  level: z.string(), code: z.object({ code: z.string() }).passthrough().nullable(),
  spans: z.array(z.object({ file_name: z.string(), is_primary: z.boolean(), line_start: z.number() }).passthrough()),
}).passthrough() }).passthrough();

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, content);
}

async function withNatives(model: SymbolicModel, work: (native: Native) => Promise<void>): Promise<void> {
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(join(runtime, 'suite-'));
  const typescript = join(root, 'typescript');
  const rust = join(root, 'rust');
  const consumer = join(root, 'consumer');
  const parameters = symbolicInputs(model);
  try {
    for (const file of generateSymbolicTypeScript({ model, className: 'EnvelopeAuthority' })) await put(join(typescript, file.path), file.content);
    for (const file of generateSymbolicRust({ model, className: 'EnvelopeAuthority' })) await put(join(rust, file.path), file.content);
    await execute(process.execPath, [compiler, '-p', join(typescript, 'tsconfig.json')], { timeout: 30_000 });
    const manifest = await readFile(join(rust, 'Cargo.toml'), 'utf8');
    const packageName = /^name = "([a-z0-9-]+)"$/m.exec(manifest)?.[1];
    assert.ok(packageName);
    await put(join(consumer, 'Cargo.toml'), `[package]\nname = "product-consumer"\nversion = "0.1.0"\nedition = "2021"\n\n[workspace]\n\n[dependencies]\nauthority = { package = "${packageName}", path = "../rust" }\nserde_json = "=1.0.154"\n`);
    await put(join(consumer, 'src/main.rs'), `#![forbid(unsafe_code)]
use authority::EnvelopeAuthority;
fn main() {
    let request = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/request.json")).unwrap();
    let sequences: Vec<Vec<Vec<String>>> = serde_json::from_str(&request).unwrap();
    let mut traces = Vec::new();
    for sequence in sequences {
        let mut owner = EnvelopeAuthority::new();
        let original = owner.read();
        let mut detached = original.clone();
        detached.values.clear();
        detached.revision = "forged".into();
        assert_eq!(owner.read(), original);
        let mut trace = Vec::new();
        for mut input in sequence {
            assert_eq!(input.len(), ${parameters.length});
            let (ok, mut receipt) = match owner.send(${parameters.map((_parameter, index) => `&input[${index}]`).join(', ')}) {
                Ok(value) => (true, serde_json::to_value(value).unwrap()),
                Err(error) => (false, serde_json::to_value(error).unwrap()),
            };
            receipt.as_object_mut().unwrap().insert("ok".into(), serde_json::json!(ok));
            trace.push(receipt);
            let stable = owner.read();
            for value in &mut input { value.clear(); }
            let mut detached = owner.read();
            detached.values.clear();
            assert_eq!(owner.read(), stable);
        }
        traces.push(trace);
    }
    println!("{}", serde_json::to_string(&traces).unwrap());
}
`);
    await execute('cargo', ['fetch', '--quiet', '--manifest-path', join(consumer, 'Cargo.toml')], { timeout: 180_000 });
    await work({ typescript, rust, consumer });
  } finally { await rm(root, { recursive: true, force: true }); }
}

function expectedTrace(model: SymbolicModel, sequence: Sequence): TraceEntry[] {
  const parameters = symbolicInputs(model);
  let values: SymbolicState = model.initial;
  let revision = 0n;
  const snapshot = () => ({ model: model.name, modelRevision: model.source.semanticSha256, revision: revision.toString(), values });
  return sequence.map((tuple): TraceEntry => {
    assert.equal(tuple.length, parameters.length);
    const named = Object.fromEntries(parameters.map((parameter, index) => {
      const value = tuple[index]; assert.ok(typeof value === 'string'); return [parameter.parameter, value];
    }));
    const before = snapshot();
    const result = stepSymbolic(model, values, named);
    if (result.kind !== 'accepted') return { ok: false, reason: result.kind, state: before };
    values = result.state; revision += 1n;
    return { ok: true, action: result.action, before, after: snapshot(), updates: result.updates };
  });
}

async function nativeTraces(native: Native, sequences: Sequence[]) {
  await put(join(native.consumer, 'request.json'), JSON.stringify(sequences));
  const script = join(native.typescript, 'trace.mjs');
  await put(script, `import assert from 'node:assert/strict';
import {createEnvelopeAuthority} from './dist/machine.js';
const traces = ${JSON.stringify(sequences)}.map(sequence => {
 const owner = createEnvelopeAuthority();
 return sequence.map(input => { const result=owner.send(...input); const stable=owner.read(); for(let i=0;i<input.length;i++)input[i]='mutated'; assert.deepEqual(owner.read(),stable); return result; });
});
process.stdout.write(JSON.stringify(traces));`);
  const ts = await execute(process.execPath, [script], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
  const rs = await execute('cargo', ['run', '--offline', '--quiet', '--manifest-path', join(native.consumer, 'Cargo.toml'), '--target-dir', target], {
    timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
  });
  return { typescript: JSON.parse(ts.stdout), rust: JSON.parse(rs.stdout) };
}

test('two native inputs preserve payload equality and original/latest receipt provenance', async () => {
  const model = envelopeModel();
  const sequences = [
    [['A', 'p1'], ['B', 'p2'], ['C', 'p3'], ['A', 'p4']],
    [['same text', 'same text'], ['other', 'same text'], ['same text', 'different receipt']],
    [['none', 'none'], ['', '한글 😀'], ['a\u0000b', 'none']],
  ];
  await withNatives(model, async native => {
    const traces = await nativeTraces(native, sequences);
    const expected = sequences.map(sequence => expectedTrace(model, sequence));
    assert.deepEqual(traces.typescript, expected);
    assert.deepEqual(traces.rust, expected);
    const final = expected[0]?.at(-1);
    assert.ok(final?.ok && 'after' in final);
    assert.deepEqual(final.after.values.original, { kind: 'data', domain: 'Values', value: 'A' });
    assert.deepEqual(final.after.values.originalReceipt, { kind: 'data', domain: 'Receipts', value: 'p1' });
    assert.deepEqual(final.after.values.rejected, { kind: 'data', domain: 'Values', value: 'C' });
    assert.deepEqual(final.after.values.rejectedReceipt, { kind: 'data', domain: 'Receipts', value: 'p3' });
    assert.equal(final.after.revision, '4');
    const first = expected[0]?.[0]; const clash = expected[0]?.[2]; assert.ok(first?.ok && clash?.ok);
    assert.deepEqual(first.updates.original, { kind: 'input', parameter: 'v' });
    assert.deepEqual(first.updates.originalReceipt, { kind: 'input', parameter: 'receipt' });
    assert.deepEqual(clash.updates.rejectedReceipt, { kind: 'input', parameter: 'receipt' });
    assert.equal(expected[1]?.[0]?.ok, true, 'identical text in different domains cannot disable Insert');
    const overflow = await execute('cargo', ['test', '--offline', '--quiet', '--lib', '--manifest-path', join(native.rust, 'Cargo.toml'), '--target-dir', target], { timeout: 180_000 });
    assert.match(overflow.stdout, /1 passed/);
  });
});

test('TypeScript fixed-arity native boundary rejects hostile input without invoking user getters', async () => {
  await withNatives(envelopeModel(), async native => {
    const script = join(native.typescript, 'invalid.mjs');
    await put(script, `import assert from 'node:assert/strict';
import {createEnvelopeAuthority,isEnvelopeAuthority} from './dist/machine.js';
const owner=createEnvelopeAuthority(); owner.send('A','p1'); const stable=owner.read();
let getters=0; const hostile={get v(){getters++;throw new Error('user getter');},get receipt(){getters++;throw new Error('user getter');}};
for(const args of [[],['A'],['A','p2','extra'],[hostile,'p2'],['A',hostile],[42,'p2'],['A',null],['\\ud800','p2'],['A','\\udfff']]) {
 const result=owner.send(...args); assert.equal(result.ok,false);assert.equal(result.reason,'invalid-input');assert.deepEqual(owner.read(),stable);
}
assert.equal(getters,0);assert.equal(Object.isFrozen(owner.send),true);
assert.equal(isEnvelopeAuthority(owner),true);assert.equal(isEnvelopeAuthority({...owner}),false);
assert.equal(Reflect.set(owner,'send',()=>({ok:true})),false);
assert.equal(Reflect.set(stable.values.original,'value','forged'),false);
assert.equal(Reflect.set(stable.values,'originalReceipt',{}),false);
const receipt=owner.send('B','p2');assert.equal(receipt.ok,true);
assert.equal(Object.isFrozen(receipt.updates.rejectedReceipt),true);
assert.equal(Reflect.set(receipt.updates.rejectedReceipt,'parameter','v'),false);
const alias=owner;assert.equal(alias.send('C','p3').action,'Clash');
assert.deepEqual(owner.read().values.originalReceipt,{kind:'data',domain:'Receipts',value:'p1'});
assert.deepEqual(owner.read().values.rejectedReceipt,{kind:'data',domain:'Receipts',value:'p3'});
`);
    await execute(process.execPath, [script], { timeout: 20_000 });
    const attempted = join(native.typescript, 'attempt.ts');
    await put(attempted, `import {createEnvelopeAuthority} from './machine.js';
const owner=createEnvelopeAuthority();
owner.send('A');
owner.send('A','p1','Same');
owner.send({v:'A',receipt:'p1'},'p2');
owner.read().values.original={kind:'string',value:'forged'};
owner.state={};
owner.restore({});
`);
    const config = JSON.parse(await readFile(join(native.typescript, 'tsconfig.json'), 'utf8'));
    await put(join(native.typescript, 'tsconfig.json'), JSON.stringify({ ...config, include: ['*.ts'] }));
    await assert.rejects(execute(process.execPath, [compiler, '-p', join(native.typescript, 'tsconfig.json')]), error => {
      assert.ok(error instanceof Error && 'stdout' in error && typeof error.stdout === 'string');
      assert.match(error.stdout, /TS2554/); assert.match(error.stdout, /TS2345/); assert.match(error.stdout, /TS2540/); assert.match(error.stdout, /TS2339/);
      return true;
    });
  });
});

test('Rust fixed arity, private state and method surface reject source bypasses', async () => {
  await withNatives(envelopeModel(), async native => {
    for (const [name, body, code] of [
      ['missing', 'owner.send("A");', 'E0061'],
      ['surplus', 'owner.send("A", "p1", "Same");', 'E0061'],
      ['wrong-type', 'owner.send("A", 42);', 'E0308'],
      ['write-state', 'owner.values.clear();', 'E0616'],
      ['alias-write', 'let alias = &mut owner; alias.values.clear();', 'E0616'],
      ['restore', 'owner.restore("A", "p1");', 'E0599'],
      ['select-same', 'owner.same("A", "p1");', 'E0599'],
      ['copy-owner', 'let _ = owner.clone();', 'E0599'],
    ]) {
      assert.ok(name && body && code);
      const source = join(native.consumer, 'src/bin', `${name}.rs`);
      await put(source, `use authority::EnvelopeAuthority;\nfn main() { let mut owner=EnvelopeAuthority::new(); ${body} }\n`);
      await assert.rejects(execute('cargo', ['check', '--offline', '--quiet', '--bin', name, '--message-format=json', '--manifest-path', join(native.consumer, 'Cargo.toml'), '--target-dir', target], { timeout: 180_000 }), error => {
        assert.ok(error instanceof Error && 'stdout' in error && typeof error.stdout === 'string');
        const diagnostics = error.stdout.split(/\r?\n/).filter(Boolean).map(line => CompilerEvent.parse(JSON.parse(line))).filter(event => event.reason === 'compiler-message')
          .map(event => ErrorDiagnostic.parse(event).message).filter(message => message.level === 'error');
        assert.ok(diagnostics.length > 0);
        for (const diagnostic of diagnostics) {
          assert.equal(diagnostic.code?.code, code);
          assert.ok(diagnostic.spans.some(span => span.is_primary && resolve(native.consumer, span.file_name) === source && span.line_start === 2));
        }
        return true;
      });
    }
  });
});

test('three primitive inputs retain separate domains and parameter origins in both native backends', async () => {
  const model = tripleModel();
  const sequences = [[['same', 'same', 'same'], ['a', 'b', 'c'], ['none', '', '한글 😀']]];
  await withNatives(model, async native => {
    const traces = await nativeTraces(native, sequences);
    const expected = sequences.map(sequence => expectedTrace(model, sequence));
    assert.deepEqual(traces.typescript, expected); assert.deepEqual(traces.rust, expected);
    const first = expected[0]?.[0]; assert.ok(first?.ok && 'after' in first);
    assert.deepEqual(first.after.values, {
      first: { kind: 'data', domain: 'Firsts', value: 'same' },
      second: { kind: 'data', domain: 'Seconds', value: 'same' },
      third: { kind: 'data', domain: 'Thirds', value: 'same' },
    });
    assert.deepEqual(first.updates.third, { kind: 'input', parameter: 'third' });
  });
});

test('a provenance requirement change regenerates both native owners instead of reusing policy', async () => {
  const model = envelopeModel(true);
  assert.notEqual(model.source.semanticSha256, envelopeModel().source.semanticSha256);
  const sequences = [[['A', 'p1'], ['B', 'p2'], ['C', 'p3'], ['A', 'p4']]];
  await withNatives(model, async native => {
    const traces = await nativeTraces(native, sequences);
    const expected = sequences.map(sequence => expectedTrace(model, sequence));
    assert.deepEqual(traces.typescript, expected); assert.deepEqual(traces.rust, expected);
    const final = expected[0]?.at(-1); assert.ok(final?.ok && 'after' in final);
    assert.deepEqual(final.after.values.originalReceipt, { kind: 'data', domain: 'Receipts', value: 'p1' });
    assert.deepEqual(final.after.values.rejectedReceipt, { kind: 'string', value: 'none' });
    assert.deepEqual(final.updates.rejectedReceipt, { kind: 'literal', value: { kind: 'string', value: 'none' } });
  });
});
