import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { generateSymbolicRust } from '../src/backends/symbolic-rust.js';
import { generateSymbolicTypeScript } from '../src/backends/symbolic-typescript.js';
import type { FiniteValue } from '../src/finite-types.js';
import { stepSymbolic, type SymbolicState } from '../src/symbolic-semantics.js';
import {
  symbolicFiniteValueKey, symbolicInputDefinitions, symbolicModel,
  type SymbolicExpression, type SymbolicGuard, type SymbolicInput, type SymbolicModelV3,
} from '../src/symbolic-types.js';

const execute = promisify(execFile);
const compiler = resolve('node_modules/typescript/bin/tsc');
const runtime = resolve('.runtime/mixed-input-backends-tests');
const authorityName = 'MixedAuthority';
const state = (variable: string): SymbolicExpression => ({ kind: 'state', variable });
const input = (parameter: string): SymbolicExpression => ({ kind: 'input', parameter });
const literal = (value: FiniteValue): SymbolicExpression => ({ kind: 'literal', value });
const text = (value: string): FiniteValue => ({ kind: 'string', value });
const equal = (left: SymbolicExpression, right: SymbolicExpression): SymbolicGuard => ({ kind: 'equal', left, right });
const ordered = (values: FiniteValue[]) => [...values].sort((left, right) => symbolicFiniteValueKey(left) < symbolicFiniteValueKey(right) ? -1 : 1);
const commands = ordered(['capture', 'disabled', 'same spelling', 'swap', '줄\n😀\u0000', '\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069'].map(text));
const integerChoices = ordered(['-900719925474099312345678901234567890', '0', '900719925474099312345678901234567890'].map(value => ({ kind: 'integer', value })));
const booleanChoices: FiniteValue[] = [{ kind: 'boolean', value: false }, { kind: 'boolean', value: true }];

function stringProtocol(): SymbolicModelV3 {
  const variables = ['stored', 'previous', 'command', 'provenance'];
  const unchanged = Object.fromEntries(variables.map(variable => [variable, state(variable)]));
  return symbolicModel({
    version: 3, kind: 'symbolic-owned', name: 'MixedStringProtocol', checkDeadlock: true, variables,
    inputs: [
      { kind: 'opaque', parameter: 'identity', domain: 'Identities' },
      { kind: 'finite', parameter: 'command', domain: 'Commands', values: commands },
      { kind: 'opaque', parameter: 'receipt', domain: 'Receipts' },
    ], next: 'Next',
    initial: { stored: text('none'), previous: text('none'), command: text('capture'), provenance: text('none') },
    branches: commands.filter(value => value.value !== 'disabled').map((value, index) => ({
      action: `Apply${index}`,
      guard: { kind: 'and', terms: [equal(input('command'), literal(value)),
        { kind: 'member', value: input('command'), elements: commands },
        { kind: 'in-domain', value: input('identity'), domain: 'Identities' },
        { kind: 'not-equal', left: input('identity'), right: input('command') },
        { kind: 'not-equal', left: input('identity'), right: input('receipt') },
      ] },
      updates: { ...unchanged, stored: value.value === 'swap' ? state('previous') : input('identity'), previous: state('stored'), command: input('command'), provenance: input('receipt') },
      source: null,
    })), invariants: [], actionProperties: [],
  });
}

function scalarProtocol(): SymbolicModelV3 {
  return symbolicModel({
    version: 3, kind: 'symbolic-owned', name: 'MixedExactScalars', checkDeadlock: true,
    variables: ['stored', 'amount', 'previousAmount', 'flag'],
    inputs: [
      { kind: 'opaque', parameter: 'identity', domain: 'Identities' },
      { kind: 'finite', parameter: 'amount', domain: 'Amounts', values: integerChoices },
      { kind: 'finite', parameter: 'flag', domain: 'Flags', values: booleanChoices },
    ], next: 'Next',
    initial: { stored: text('none'), amount: { kind: 'integer', value: '0' }, previousAmount: { kind: 'integer', value: '0' }, flag: { kind: 'boolean', value: false } },
    branches: booleanChoices.map((value, index) => ({ action: `Capture${index}`, guard: equal(input('flag'), literal(value)),
      updates: { stored: input('identity'), amount: input('amount'), previousAmount: state('amount'), flag: input('flag') }, source: null })),
    invariants: [], actionProperties: [],
  });
}

type Tuple = (string | FiniteValue)[];
type Sequence = Tuple[];
type Native = { root: string; typescript: string; rust: string; consumer: string; target: string };
async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, content);
}
function finiteRustChoice(index: number, choice = 0): string { return `${authorityName}Input${index}::Choice${choice}`; }
function firstArguments(model: SymbolicModelV3): string[] {
  return model.inputs.map((item, index) => item.kind === 'opaque' ? '"identity"' : finiteRustChoice(index));
}
async function cargo(native: Native, args: string[], directory = native.consumer) {
  return execute('cargo', [...args, '--offline', '--quiet', '--manifest-path', join(directory, 'Cargo.toml'), '--target-dir', native.target], { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
}
async function withNatives(model: SymbolicModelV3, work: (native: Native) => Promise<void>): Promise<void> {
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(join(runtime, 'suite-'));
  const native = { root, typescript: join(root, 'typescript'), rust: join(root, 'rust'), consumer: join(root, 'consumer'), target: join(root, 'target') };
  try {
    const rust = generateSymbolicRust({ model, className: authorityName });
    for (const file of generateSymbolicTypeScript({ model, className: authorityName })) await put(join(native.typescript, file.path), file.content);
    for (const file of rust) await put(join(native.rust, file.path), file.content);
    await execute(process.execPath, [compiler, '-p', join(native.typescript, 'tsconfig.json')], { timeout: 30_000 });
    const manifest = rust.find(file => file.path === 'Cargo.toml'); assert.ok(manifest);
    const packageName = /^name = "([a-z0-9-]+)"$/m.exec(manifest.content)?.[1]; assert.ok(packageName);
    await put(join(native.consumer, 'Cargo.toml'), `[package]\nname = "mixed-consumer"\nversion = "0.1.0"\nedition = "2021"\n\n[workspace]\n\n[dependencies]\nauthority = { package = "${packageName}", path = "../rust" }\nserde_json = "=1.0.154"\n`);
    const enumImports = model.inputs.flatMap((item, index) => item.kind === 'finite' ? [`${authorityName}Input${index}`] : []);
    await put(join(native.consumer, 'choices.json'), JSON.stringify(model.inputs.map(item => item.kind === 'finite' ? item.values : [])));
    const argumentsFor = (tuple: string) => model.inputs.map((item, index) => item.kind === 'opaque' ? `${tuple}[${index}].as_str().expect("opaque string")`
      : `match choices[${index}].iter().position(|value| value == &${tuple}[${index}]) { ${item.values.map((_value, choice) => `Some(${choice}) => ${finiteRustChoice(index, choice)}`).join(', ')}, _ => panic!("invalid test fixture") }`).join(', ');
    await put(join(native.consumer, 'src/main.rs'), `#![forbid(unsafe_code)]
use authority::{MixedAuthority, ${enumImports.join(', ')}};
fn main() {
    let request = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/request.json")).unwrap();
    let sequences: Vec<Vec<Vec<serde_json::Value>>> = serde_json::from_str(&request).unwrap();
    let choices = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/choices.json")).unwrap();
    let choices: Vec<Vec<serde_json::Value>> = serde_json::from_str(&choices).unwrap();
    let mut traces = Vec::new();
    for sequence in sequences {
        let mut owner = MixedAuthority::new();
        let initial = owner.read();
        let mut detached = initial.clone(); detached.values.clear(); assert_eq!(owner.read(), initial);
        { let pending = owner.prepare(${firstArguments(model).join(', ')}); drop(pending); }
        assert_eq!(owner.read(), initial);
        let mut trace = Vec::new();
        for tuple in sequence {
            let (ok, mut receipt) = match owner.send(${argumentsFor('tuple')}) {
                Ok(value) => (true, serde_json::to_value(value).unwrap()),
                Err(value) => (false, serde_json::to_value(value).unwrap()),
            };
            receipt.as_object_mut().unwrap().insert("ok".into(), serde_json::json!(ok)); trace.push(receipt);
        }
        traces.push(trace);
    }
    println!("{}", serde_json::to_string(&traces).unwrap());
}
`);
    await work(native);
  } finally { await rm(root, { recursive: true, force: true }); }
}
function expected(model: SymbolicModelV3, sequence: Sequence): unknown[] {
  let values: SymbolicState = model.initial; let revision = 0n;
  const snapshot = () => ({ model: model.name, modelRevision: model.source.semanticSha256, revision: revision.toString(), values });
  return sequence.map(tuple => {
    const frame: SymbolicInput = Object.fromEntries(model.inputs.map((item, index) => {
      const value = tuple[index]; assert.notEqual(value, undefined); return [item.parameter, value];
    }));
    const before = snapshot(); const result = stepSymbolic(model, values, frame);
    if (result.kind !== 'accepted') return { ok: false, reason: result.kind, state: before };
    values = result.state; revision++;
    return { ok: true, action: result.action, before, after: snapshot(), updates: result.updates };
  });
}
async function compareTraces(model: SymbolicModelV3, native: Native, sequences: Sequence[]): Promise<void> {
  await put(join(native.consumer, 'request.json'), JSON.stringify(sequences));
  await put(join(native.typescript, 'traces.mjs'), `import { createMixedAuthority } from './dist/machine.js';
const sequences = ${JSON.stringify(sequences)};
const traces = sequences.map(sequence => { const owner=createMixedAuthority(); return sequence.map(tuple => owner.send(...tuple.map(value => typeof value==='string' ? value : value.kind==='integer' ? BigInt(value.value) : value.value))); });
process.stdout.write(JSON.stringify(traces));\n`);
  const ts = await execute(process.execPath, [join(native.typescript, 'traces.mjs')], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
  const rs = await cargo(native, ['run', '--bin', 'mixed-consumer']);
  const oracle = sequences.map(sequence => expected(model, sequence));
  assert.deepEqual(JSON.parse(ts.stdout), oracle); assert.deepEqual(JSON.parse(rs.stdout), oracle);
  await cargo(native, ['test'], native.rust);
  await execute('cargo', ['clippy', '--offline', '--quiet', '--all-targets', '--manifest-path', join(native.rust, 'Cargo.toml'), '--target-dir', native.target, '--', '-D', 'warnings'], { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
}
function allTuples(model: SymbolicModelV3): Tuple[] {
  let tuples: Tuple[] = [[]];
  for (const definition of symbolicInputDefinitions(model)) {
    const choices = definition.kind === 'finite' ? definition.values : ['same spelling', '줄\n😀\u0000', 'none'];
    tuples = tuples.flatMap(tuple => choices.map(value => [...tuple, value]));
  }
  return tuples;
}
async function rejectRust(native: Native, name: string, source: string, code: string): Promise<void> {
  await put(join(native.consumer, 'src/bin', `${name}.rs`), `#![forbid(unsafe_code)]\nuse authority::*;\nfn main() { ${source} }\n`);
  await assert.rejects(cargo(native, ['check', '--bin', name]), error => {
    if (!(error instanceof Error) || !('stderr' in error) || typeof error.stderr !== 'string') return false;
    assert.match(error.stderr, new RegExp(`error\\[${code}\\]`)); assert.match(error.stderr, new RegExp(`src/bin/${name}\\.rs`)); return true;
  });
}

test('mixed finite string choices preserve tagged identities, complete updates, Unicode and old-state copies in both native owners', async () => {
  const model = stringProtocol();
  await withNatives(model, async native => {
    const tuples = allTuples(model);
    const swap = text('swap');
    await compareTraces(model, native, tuples.map(tuple => [tuple, ['first', text('capture'), 'first'], ['second', text('capture'), 'second'], ['third', swap, 'third']]));
    const source = await readFile(join(native.typescript, 'machine.ts'), 'utf8');
    assert.ok(source.includes(`input_1: ${commands.map(value => { assert.equal(value.kind, 'string'); return JSON.stringify(value.value); }).join(' | ')}`));
    const rustReadme = await readFile(join(native.rust, 'README.md'), 'utf8');
    const mappings = [...rustReadme.matchAll(/`Choice([0-9]+)` = `([^`]+)`/g)];
    assert.deepEqual(mappings.map((mapping, index) => { assert.equal(mapping[1], String(index)); return JSON.parse(mapping[2] ?? 'null'); }), commands);
    await put(join(native.typescript, 'boundary.mjs'), `import assert from 'node:assert/strict';
import {createMixedAuthority,isMixedAuthority} from './dist/machine.js';
const owner=createMixedAuthority(); const saved=owner.read();
let touches=0; const hostile={toString(){touches++;throw new Error('coercion');},[Symbol.toPrimitive](){touches++;throw new Error('coercion');}};
for(const tuple of [['A','unknown','r'],['A',new String('capture'),'r'],['A',hostile,'r'],['A',0,'r'],['A',null,'r'],['A',true,'r'],['\\ud800','capture','r'],['A','capture','\\udfff'],['A','capture'],['A','capture','r','surplus']]) {assert.equal(owner.send(...tuple).reason,'invalid-input');assert.deepEqual(owner.read(),saved);}
assert.equal(touches,0);assert.equal(isMixedAuthority({...owner}),false); assert.equal(Reflect.set(owner,'values',{}),false); assert.equal(Reflect.set(saved.values.stored,'value','forged'),false);
const pending=owner.prepare('same spelling','same spelling','same spelling');assert.equal(pending.ok,true);assert.deepEqual(owner.read(),saved);
const invalid=owner.prepare('A','outside','r');assert.equal(invalid.reason,'invalid-input'); assert.equal(pending.commit().ok,true);assert.equal(pending.commit().reason,'consumed-preparation');
const a=owner.prepare('A','capture','r1');const b=owner.prepare('B','capture','r2');assert.equal(a.ok,true);assert.equal(b.ok,true);assert.equal(b.commit().ok,true);const stable=owner.read();assert.equal(a.commit().reason,'stale-preparation');assert.deepEqual(owner.read(),stable);assert.equal(a.commit().reason,'consumed-preparation');
assert.equal(owner.restore,undefined);assert.equal(owner.clone,undefined);
`);
    await execute(process.execPath, [join(native.typescript, 'boundary.mjs')], { timeout: 20_000 });
    await put(join(native.typescript, 'attempt.ts'), `import {createMixedAuthority} from './machine.js';
const owner=createMixedAuthority();
owner.send('A','invalid','r');
owner.send('A',true,'r');
owner.send('A',1n,'r');
owner.restore({});
owner.read().values.stored={kind:'string',value:'forged'};
createMixedAuthority('raw');
`);
    await put(join(native.typescript, 'attempt-config.json'), JSON.stringify({ extends: './tsconfig.json', compilerOptions: { noEmit: true }, include: ['machine.ts', 'attempt.ts'] }));
    await assert.rejects(execute(process.execPath, [compiler, '-p', join(native.typescript, 'attempt-config.json')]), error => {
      if (!(error instanceof Error) || !('stdout' in error) || typeof error.stdout !== 'string') return false;
      assert.match(error.stdout, /TS2345/); assert.match(error.stdout, /TS2339/); assert.match(error.stdout, /TS2540/); assert.match(error.stdout, /TS2554/); return true;
    });
    const args = firstArguments(model).join(', ');
    await rejectRust(native, 'raw_string', `let mut o=MixedAuthority::new();o.send("A","capture","r").unwrap();`, 'E0308');
    await rejectRust(native, 'forged_choice', `let mut o=MixedAuthority::new();o.send("A",MixedAuthorityInput1::Choice99,"r").unwrap();`, 'E0599');
    await rejectRust(native, 'forged_owner', `let _o=MixedAuthority { values: std::collections::BTreeMap::new(), revision: 0 };`, 'E0451');
    await rejectRust(native, 'clone_owner', `let o=MixedAuthority::new();let _copy=o.clone();`, 'E0599');
    await rejectRust(native, 'replay', `let mut o=MixedAuthority::new();let token=o.prepare(${args}).unwrap();token.commit();token.commit();`, 'E0382');
    await rejectRust(native, 'overlap', `let mut o=MixedAuthority::new();let token=o.prepare(${args}).unwrap();let second=o.prepare(${args});drop(second);token.commit();`, 'E0499');
  });
});

test('mixed bigint and Boolean choices map every finite variant exactly and reject cross-input enum types', async () => {
  const model = scalarProtocol();
  await withNatives(model, async native => {
    const tuples = allTuples(model);
    await compareTraces(model, native, tuples.flatMap(first => tuples.map(second => [first, second])));
    const source = await readFile(join(native.typescript, 'machine.ts'), 'utf8');
    assert.match(source, /input_1: -900719925474099312345678901234567890n \| 0n \| 900719925474099312345678901234567890n/);
    assert.match(source, /input_2: false \| true/);
    await put(join(native.typescript, 'boundary.mjs'), `import assert from 'node:assert/strict';import {createMixedAuthority} from './dist/machine.js';const o=createMixedAuthority();const before=o.read();
for(const tuple of [['A',0,true],['A','0',true],['A',1n,true],['A',0n,1],['A',0n,'true'],['A',Object(0n),true],['A',0n,new Boolean(true)]]){assert.equal(o.send(...tuple).reason,'invalid-input');assert.deepEqual(o.read(),before);}
`);
    await execute(process.execPath, [join(native.typescript, 'boundary.mjs')], { timeout: 20_000 });
    await rejectRust(native, 'wrong_enum', `let mut o=MixedAuthority::new();o.send("A",MixedAuthorityInput1::Choice0,MixedAuthorityInput1::Choice0).unwrap();`, 'E0308');
    await rejectRust(native, 'raw_integer', `let mut o=MixedAuthority::new();o.send("A",0,MixedAuthorityInput2::Choice0).unwrap();`, 'E0308');
  });
});

test('a finite first parameter retains the full 64-choice boundary in a two-input native owner', async () => {
  const values = ordered(Array.from({ length: 64 }, (_unused, index) => text(`choice-${index.toString().padStart(2, '0')}`)));
  const model = symbolicModel({
    version: 3, kind: 'symbolic-owned', name: 'MixedFullVocabulary', checkDeadlock: true, variables: ['stored', 'choice'],
    inputs: [
      { kind: 'finite', parameter: 'choice', domain: 'Choices', values },
      { kind: 'opaque', parameter: 'identity', domain: 'Identities' },
    ], next: 'Next', initial: { stored: text('none'), choice: text('choice-00') },
    branches: [{ action: 'Capture', guard: { kind: 'or', terms: [
      { kind: 'member', value: input('choice'), elements: values.slice(0, 32) },
      { kind: 'member', value: input('choice'), elements: values.slice(32) },
    ] },
      updates: { stored: input('identity'), choice: input('choice') }, source: null }], invariants: [], actionProperties: [],
  });
  await withNatives(model, native => compareTraces(model, native, [values.map(value => [value, 'same spelling'])]));
});
