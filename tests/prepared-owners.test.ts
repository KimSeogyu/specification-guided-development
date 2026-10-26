import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { generateSymbolicTypeScript } from '../src/backends/symbolic-typescript.js';
import type { FiniteValue } from '../src/finite-types.js';
import { symbolicInputs, symbolicModel, type SymbolicExpression, type SymbolicGuard, type SymbolicModel } from '../src/symbolic-types.js';

const execute = promisify(execFile);
const runtime = resolve('.runtime/prepared-owners-tests');
const compiler = resolve('node_modules/typescript/bin/tsc');
const state = (variable: string): SymbolicExpression => ({ kind: 'state', variable });
const scalar = (value: string): SymbolicExpression => ({ kind: 'literal', value: { kind: 'string', value } });
const eq = (left: SymbolicExpression, right: SymbolicExpression): SymbolicGuard => ({ kind: 'equal', left, right });
const not = (term: SymbolicGuard): SymbolicGuard => ({ kind: 'not', term });
const and = (...terms: SymbolicGuard[]): SymbolicGuard => ({ kind: 'and', terms });

function program(product: boolean, disableSame = false): SymbolicModel {
  const payload: SymbolicExpression = product ? { kind: 'input', parameter: 'v' } : { kind: 'input' };
  const provenance: SymbolicExpression = { kind: 'input', parameter: 'provenance' };
  const variables = product ? ['stored', 'rejected', 'storedProvenance', 'rejectedProvenance'] : ['stored', 'rejected'];
  const preserve = Object.fromEntries(variables.map(variable => [variable, state(variable)]));
  const initial = Object.fromEntries(variables.map(variable => [variable, { kind: 'string', value: 'none' } satisfies FiniteValue]));
  const occupied = not(eq(state('stored'), scalar('none')));
  const common = {
    kind: 'symbolic-owned', name: product ? 'PreparedEnvelope' : 'PreparedPayload', checkDeadlock: true, variables, initial,
    branches: [
      { action: 'Insert', guard: eq(state('stored'), scalar('none')), updates: { ...preserve, stored: payload, ...(product ? { storedProvenance: provenance } : {}) }, source: null },
      { action: 'Same', guard: disableSame ? { kind: 'boolean', value: false } : and(occupied, eq(state('stored'), payload)), updates: preserve, source: null },
      { action: 'Clash', guard: and(occupied, not(eq(state('stored'), payload))), updates: { ...preserve, rejected: payload, ...(product ? { rejectedProvenance: provenance } : {}) }, source: null },
    ], invariants: [], actionProperties: [],
  } satisfies Omit<ReturnType<typeof symbolicModel>, 'version' | 'input' | 'inputs' | 'next' | 'source'>;
  return product ? symbolicModel({ version: 2, ...common, inputs: [{ parameter: 'v', domain: 'Values' }, { parameter: 'provenance', domain: 'Receipts' }], next: 'Next' })
    : symbolicModel({ version: 1, ...common, input: { parameter: 'v', domain: 'Values', next: 'Next' } });
}

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, content);
}

type Native = { typescript: string; product: boolean };
async function withNative(model: SymbolicModel, work: (native: Native) => Promise<void>): Promise<void> {
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(join(runtime, 'suite-'));
  const typescript = join(root, 'typescript');
  try {
    for (const file of generateSymbolicTypeScript({ model, className: 'PreparedAuthority' })) await put(join(typescript, file.path), file.content);
    await execute(process.execPath, [compiler, '-p', join(typescript, 'tsconfig.json')], { timeout: 30_000 });
    await work({ typescript, product: symbolicInputs(model).length === 2 });
  } finally { await rm(root, { recursive: true, force: true }); }
}

function args(product: boolean, payload: string, provenance = 'r'): string {
  return [payload, ...(product ? [provenance] : [])].map(value => JSON.stringify(value)).join(', ');
}

async function runTypeScript(native: Native, source: string): Promise<void> {
  const path = join(native.typescript, 'run.mjs');
  await put(path, `import assert from 'node:assert/strict';\nimport {createPreparedAuthority} from './dist/machine.js';\n${source}`);
  await execute(process.execPath, [path], { timeout: 20_000 });
}

test('TypeScript preparation is immutable, owner-bound, single-use and rejects stale commits without state changes', async () => {
  for (const product of [false, true]) await withNative(program(product), async native => {
    await runTypeScript(native, `
const owner=createPreparedAuthority(); const initial=owner.read();
const dropped=owner.prepare(${args(product, 'dropped', 'drop-receipt')}); assert.equal(dropped.ok,true);
assert.equal(dropped.receipt.action,'Insert'); assert.equal(dropped.receipt.before.revision,'0');assert.equal(dropped.receipt.after.revision,'1');
assert.deepEqual(owner.read(),initial);
const prepared=owner.prepare(${args(product, 'A', 'p1')});assert.equal(prepared.ok,true);
assert.equal(Object.isFrozen(prepared),true);assert.equal(Object.isFrozen(prepared.commit),true);assert.equal(Object.isFrozen(prepared.receipt),true);
assert.equal(Reflect.set(prepared.receipt.after.values.stored,'value','forged'),false);
assert.equal(Reflect.set(prepared.receipt.updates.stored,'kind','state'),false);
assert.deepEqual(owner.read(),initial);
const first=prepared.commit();assert.equal(first.ok,true);assert.deepEqual(first,{ok:true,...prepared.receipt});
assert.equal(owner.read().revision,'1');assert.equal(owner.read().values.stored.value,'A');
const stable=owner.read();assert.equal(prepared.commit().reason,'consumed-preparation');assert.deepEqual(owner.read(),stable);
assert.equal(({...prepared}).commit().reason,'consumed-preparation');assert.deepEqual(owner.read(),stable);
const b=owner.prepare(${args(product, 'B', 'p2')});const c=owner.prepare(${args(product, 'C', 'p3')});assert.equal(b.ok&&c.ok,true);
assert.equal(b.commit().action,'Clash');const afterB=owner.read();
assert.equal(c.commit().reason,'stale-preparation');assert.deepEqual(owner.read(),afterB);
assert.equal(c.commit().reason,'consumed-preparation');assert.deepEqual(owner.read(),afterB);
assert.equal(dropped.commit().reason,'stale-preparation');assert.deepEqual(owner.read(),afterB);
const other=createPreparedAuthority();const otherInitial=other.read();const bound=owner.prepare(${args(product, 'C', 'p3')});assert.equal(bound.ok,true);
assert.equal(bound.commit.call(other).ok,true);assert.deepEqual(other.read(),otherInitial);assert.equal(owner.read().revision,'3');
assert.equal(owner.read().values.stored.value,'A');assert.equal(owner.read().values.rejected.value,'C');
${product ? "assert.equal(owner.read().values.storedProvenance.value,'p1');assert.equal(owner.read().values.rejectedProvenance.value,'p3');assert.deepEqual(bound.receipt.updates.rejectedProvenance,{kind:'input',parameter:'provenance'});" : "assert.deepEqual(bound.receipt.updates.rejected,{kind:'input'});"}
const saved=owner.read();const bad=owner.prepare(${args(product, '\ud800', 'p4')});assert.equal(bad.ok,false);assert.equal(bad.reason,'invalid-input');assert.deepEqual(owner.read(),saved);
let getters=0;const hostile={get value(){getters++;throw new Error('getter');},toString(){getters++;throw new Error('coercion');}};
assert.equal(owner.prepare(hostile${product ? ",'p4'" : ''}).reason,'invalid-input');assert.equal(getters,0);assert.deepEqual(owner.read(),saved);
const same=owner.prepare(${args(product, 'A', 'ignored')});assert.equal(same.ok,true);assert.equal(same.receipt.action,'Same');assert.deepEqual(owner.read(),saved);
assert.equal(same.commit().ok,true);assert.deepEqual(owner.read().values,saved.values);assert.equal(owner.read().revision,'4');
const pending=owner.prepare(${args(product, 'D', 'p4')});assert.equal(pending.ok,true);const values=owner.read().values;
assert.equal(owner.send(${args(product, 'A', 'same-receipt')}).action,'Same');assert.deepEqual(owner.read().values,values);assert.equal(owner.read().revision,'5');
const afterSelfLoop=owner.read();assert.equal(pending.commit().reason,'stale-preparation');assert.deepEqual(owner.read(),afterSelfLoop);
${product ? "for(const tuple of [[],['A'],['A','p','extra']]) { const error=owner.prepare(...tuple);assert.equal(error.reason,'invalid-input');assert.deepEqual(owner.read(),afterSelfLoop); }" : ''}
`);
  });
});

test('rejected preparations and a regenerated requirement leave the TypeScript owner unchanged', async () => {
  for (const product of [false, true]) await withNative(program(product, true), async native => {
    await runTypeScript(native, `
const owner=createPreparedAuthority();assert.equal(owner.send(${args(product, 'A', 'p1')}).ok,true);const stable=owner.read();
const prepared=owner.prepare(${args(product, 'A', 'p2')});assert.equal(prepared.ok,false);assert.equal(prepared.reason,'disabled');assert.deepEqual(owner.read(),stable);
assert.equal(owner.send(${args(product, 'A', 'p3')}).reason,'disabled');assert.deepEqual(owner.read(),stable);
`);
  });
});

test('TypeScript declarations reject preparation mutation and committing through another owner', async () => {
  await withNative(program(true), async native => {
    await put(join(native.typescript, 'attempt.ts'), `import {createPreparedAuthority} from './machine.js';
const owner=createPreparedAuthority();const other=createPreparedAuthority();const pending=owner.prepare('A','p1');
if(pending.ok) {
 pending.commit(other);
 pending.receipt.after.values.stored={kind:'string',value:'forged'};
 pending.receipt.updates.stored={kind:'input',parameter:'v'};
 pending.commit=()=>owner.send('B','p2');
 other.commit(pending);
}
`);
    const config = JSON.parse(await readFile(join(native.typescript, 'tsconfig.json'), 'utf8'));
    await put(join(native.typescript, 'tsconfig.json'), JSON.stringify({ ...config, include: ['*.ts'] }));
    await assert.rejects(execute(process.execPath, [compiler, '-p', join(native.typescript, 'tsconfig.json')]), error => {
      assert.ok(error instanceof Error && 'stdout' in error && typeof error.stdout === 'string');
      assert.match(error.stdout, /TS2554/); assert.match(error.stdout, /TS2540/); assert.match(error.stdout, /TS2542/); assert.match(error.stdout, /TS2339/); return true;
    });
  });
});
