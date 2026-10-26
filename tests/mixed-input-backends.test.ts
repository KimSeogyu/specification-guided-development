import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
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
type Native = { root: string; typescript: string };
async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, content);
}
async function withNatives(model: SymbolicModelV3, work: (native: Native) => Promise<void>): Promise<void> {
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(join(runtime, 'suite-'));
  const native = { root, typescript: join(root, 'typescript') };
  try {
    for (const file of generateSymbolicTypeScript({ model, className: authorityName })) await put(join(native.typescript, file.path), file.content);
    await execute(process.execPath, [compiler, '-p', join(native.typescript, 'tsconfig.json')], { timeout: 30_000 });
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
  await put(join(native.typescript, 'traces.mjs'), `import { createMixedAuthority } from './dist/machine.js';
const sequences = ${JSON.stringify(sequences)};
const traces = sequences.map(sequence => { const owner=createMixedAuthority(); return sequence.map(tuple => owner.send(...tuple.map(value => typeof value==='string' ? value : value.kind==='integer' ? BigInt(value.value) : value.value))); });
process.stdout.write(JSON.stringify(traces));\n`);
  const ts = await execute(process.execPath, [join(native.typescript, 'traces.mjs')], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
  const oracle = sequences.map(sequence => expected(model, sequence));
  assert.deepEqual(JSON.parse(ts.stdout), oracle);

}
function allTuples(model: SymbolicModelV3): Tuple[] {
  let tuples: Tuple[] = [[]];
  for (const definition of symbolicInputDefinitions(model)) {
    const choices = definition.kind === 'finite' ? definition.values : ['same spelling', '줄\n😀\u0000', 'none'];
    tuples = tuples.flatMap(tuple => choices.map(value => [...tuple, value]));
  }
  return tuples;
}
test('mixed finite string choices preserve tagged identities, complete updates, Unicode and old-state copies in the TypeScript owner', async () => {
  const model = stringProtocol();
  await withNatives(model, async native => {
    const tuples = allTuples(model);
    const swap = text('swap');
    await compareTraces(model, native, tuples.map(tuple => [tuple, ['first', text('capture'), 'first'], ['second', text('capture'), 'second'], ['third', swap, 'third']]));
    const source = await readFile(join(native.typescript, 'machine.ts'), 'utf8');
    assert.ok(source.includes(`input_1: ${commands.map(value => { assert.equal(value.kind, 'string'); return JSON.stringify(value.value); }).join(' | ')}`));
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
  });
});

test('mixed bigint and Boolean choices map every finite variant exactly and reject invalid TypeScript inputs', async () => {
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
