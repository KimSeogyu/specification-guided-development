import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { generateSymbolicTypeScript } from '../src/backends/symbolic-typescript.js';
import { symbolicModel, type SymbolicExpression, type SymbolicGuard } from '../src/symbolic-types.js';
import { inspectSymbolicOrbits, stepSymbolic } from '../src/symbolic-semantics.js';

const execute = promisify(execFile);
const compiler = resolve('node_modules/typescript/bin/tsc');
const state = (variable: string): SymbolicExpression => ({ kind: 'state', variable });
const scalar = (value: string): SymbolicExpression => ({ kind: 'literal', value: { kind: 'string', value } });
const input: SymbolicExpression = { kind: 'input' };
const eq = (left: SymbolicExpression, right: SymbolicExpression): SymbolicGuard => ({ kind: 'equal', left, right });
const model = symbolicModel({
  version: 1, kind: 'symbolic-owned', name: 'DataPolicy', checkDeadlock: true, variables: ['phase', 'rejected', 'stored'],
  input: { parameter: 'v', domain: 'Values', next: 'Next' },
  initial: { phase: { kind: 'string', value: 'absent' }, rejected: { kind: 'string', value: 'none' }, stored: { kind: 'string', value: 'none' } },
  branches: [
    { action: 'Insert', guard: eq(state('phase'), scalar('absent')), updates: { phase: scalar('present'), rejected: scalar('none'), stored: input }, source: null },
    { action: 'Same', guard: { kind: 'and', terms: [{ kind: 'not', term: eq(state('phase'), scalar('absent')) }, eq(input, state('stored'))] }, updates: { phase: state('phase'), rejected: state('rejected'), stored: state('stored') }, source: null },
    { action: 'Clash', guard: { kind: 'and', terms: [{ kind: 'not', term: eq(state('phase'), scalar('absent')) }, { kind: 'not-equal', left: input, right: state('stored') }] }, updates: { phase: scalar('conflict'), rejected: input, stored: state('stored') }, source: null },
  ], invariants: [], actionProperties: [],
});

async function withGenerated(work: (root: string) => Promise<void>, className = 'FactMachine'): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'sgd-symbolic-ts-'));
  try {
    for (const file of generateSymbolicTypeScript({ model, className })) {
      const path = join(root, file.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.content);
    }
    await execute(process.execPath, [compiler, '-p', join(root, 'tsconfig.json')], { timeout: 30_000 });
    await work(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function run(root: string, source: string): Promise<void> {
  const path = join(root, 'run.mjs');
  await writeFile(path, `import assert from 'node:assert/strict';\nimport {createFactMachine,isFactMachine} from './dist/machine.js';\n${source}`);
  await execute(process.execPath, [path], { timeout: 20_000 });
}

test('native TypeScript symbolic owner selects actions from real input and preserves assignment origins', async () => {
  await withGenerated(root => run(root, `
const machine = createFactMachine();
const actions=[]; for(const value of ['A','B','C','A']) { const result=machine.send(value); assert.equal(result.ok,true);actions.push(result.action); }
assert.deepEqual(actions,['Insert','Clash','Clash','Same']);
assert.deepEqual(machine.read().values.stored,{kind:'data',domain:'Values',value:'A'});
assert.deepEqual(machine.read().values.rejected,{kind:'data',domain:'Values',value:'C'});
assert.equal(machine.read().revision,'4');
const next = machine.send('D'); assert.equal(next.ok,true);
assert.deepEqual(next.updates.stored,{kind:'state',variable:'stored'});
assert.deepEqual(next.updates.rejected,{kind:'input'});
assert.deepEqual(next.before.values.rejected,{kind:'data',domain:'Values',value:'C'});
const sentinel=createFactMachine(); assert.equal(sentinel.send('none').action,'Insert');
assert.deepEqual(sentinel.read().values.stored,{kind:'data',domain:'Values',value:'none'});
assert.deepEqual(sentinel.read().values.rejected,{kind:'string',value:'none'});
assert.equal(sentinel.send('none').action,'Same');
const named=createFactMachine(); assert.equal(named.send('Same').action,'Insert');
assert.equal(named.send('Same').action,'Same');
for(const value of ['', '한글 😀', 'a\\u0000b', 'X'.repeat(40000)]) { const m=createFactMachine(); m.send(value); assert.equal(m.read().values.stored.value,value); }
`));
});

test('native TypeScript runtime casts, reflection, aliases and snapshots cannot change symbolic authority', async () => {
  await withGenerated(root => run(root, `
const machine=createFactMachine(); const before=machine.read();
assert.equal(isFactMachine(machine),true); assert.equal(isFactMachine({...machine}),false);assert.equal(isFactMachine(new Proxy(machine,{})),false);
assert.equal(Reflect.set(machine,'send',()=>({ok:true})),false);
assert.equal(Reflect.set(machine,'state',{}),false);
assert.equal(Reflect.set(before.values.stored,'value','forged'),false);
assert.equal(Reflect.set(before.values,'stored',{kind:'data',domain:'Values',value:'forged'}),false);
const alias=machine;assert.equal(alias.send('real').action,'Insert');assert.equal(before.values.stored.value,'none');
const saved=machine.read(); for(const invalid of [42,null,{},'\\ud800']) { assert.equal(machine.send(invalid).reason,'invalid-input'); assert.deepEqual(machine.read(),saved); }
`));
});

test('native TypeScript rejects writes, restore, forged construction and caller-selected action APIs', async () => {
  await withGenerated(async root => {
    const path = join(root, 'attempt.ts');
    await writeFile(path, `import {createFactMachine} from './machine.js';\nconst machine=createFactMachine();\nmachine.state={};\nmachine.read().values.stored={kind:'string',value:'forged'};\nmachine.send('Clash','payload');\nmachine.restore({});\ncreateFactMachine('forged');\n`);
    const config = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8'));
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ ...config, include: ['*.ts'] }));
    await assert.rejects(execute(process.execPath, [compiler, '-p', join(root, 'tsconfig.json')]), error => {
      if (!(error instanceof Error) || !('stdout' in error) || typeof error.stdout !== 'string') return false;
      assert.match(error.stdout, /attempt.ts/); assert.match(error.stdout, /TS2339/); assert.match(error.stdout, /TS2540/); assert.match(error.stdout, /TS2554/); return true;
    });
  });
});

test('every symbolic orbit and existing-or-fresh input decision matches native TypeScript', async () => {
  const proof = inspectSymbolicOrbits(model);
  const paths = new Map<number, string[]>([[0, []]]);
  for (let index = 0; index < proof.states.length; index++) for (const edge of proof.edges.filter(edge => edge.from === index)) {
    if (!paths.has(edge.to)) paths.set(edge.to, [...(paths.get(index) ?? []), edge.input]);
  }
  // Native runs use representative values mapped through the actual current register equalities.
  await withGenerated(root => run(root, `
const model=${JSON.stringify(model)}; const proof=${JSON.stringify(proof)};
const paths=${JSON.stringify([...paths])};
function normalize(values){ const names=new Map(); return Object.fromEntries(model.variables.map(key=>{const v=values[key];if(v.kind!=='data')return[key,v];if(!names.has(v.value))names.set(v.value,'a'+names.size);return[key,{...v,value:names.get(v.value)}];}));}
for(const [index,path] of paths){
 const machine=createFactMachine();
 function actualInput(atom){const values=machine.read().values;const names=new Map();for(const key of model.variables){const v=values[key];if(v.kind==='data'&&!names.has(v.value))names.set(v.value,'a'+names.size);}return [...names].find(([,name])=>name===atom)?.[0] ?? 'fresh'+machine.read().revision;}
 for(const atom of path)machine.send(actualInput(atom));
 assert.deepEqual(normalize(machine.read().values),proof.states[index]);
 const atoms=[...new Set(Object.values(proof.states[index]).filter(v=>v.kind==='data').map(v=>v.value))];
 for(const atom of [...atoms,'a'+atoms.length]){
  const replay=createFactMachine();for(const previous of path){const old=machine; const vals=replay.read().values;const map=new Map();for(const key of model.variables){const v=vals[key];if(v.kind==='data'&&!map.has(v.value))map.set(v.value,'a'+map.size);}replay.send([...map].find(([,name])=>name===previous)?.[0]??'fresh'+replay.read().revision);}
  const vals=replay.read().values;const map=new Map();for(const key of model.variables){const v=vals[key];if(v.kind==='data'&&!map.has(v.value))map.set(v.value,'a'+map.size);}const value=[...map].find(([,name])=>name===atom)?.[0]??'fresh'+replay.read().revision;
  const result=replay.send(value);const edge=proof.edges.find(e=>e.from===index&&e.input===atom);
  assert.equal(result.ok,!!edge);if(edge){assert.equal(result.action,edge.action);assert.deepEqual(normalize(result.after.values),proof.states[edge.to]);}
 }
}
`));
  assert.equal(stepSymbolic(model, model.initial, 'outside-finite-fixture').kind, 'accepted');
});

test('generated names do not shadow utility or platform types', async () => {
  for (const className of ['Record', 'Readonly', 'Map']) await withGenerated(async () => {}, className);
});
