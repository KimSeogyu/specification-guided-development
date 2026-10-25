import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { generateRetainedTypeScript } from '../src/backends/retained-typescript.js';
import type { ExactFiniteAutomaton } from '../src/finite-types.js';
import type { RetainedOperationInput } from '../src/retained-operation.js';

const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
const graph: ExactFiniteAutomaton = {
  version: 1, kind: 'exact-finite', name: 'ReportCustody',
  variables: [{ name: 'phase', kind: 'string' }, { name: 'retained', kind: 'boolean' }],
  nodes: ['Ready', 'Writing', 'Written', 'Failed'].map((phase, i) => ({ id: `s${i}`, values: {
    phase: { kind: 'string', value: phase }, retained: { kind: 'boolean', value: true },
  } })),
  initial: ['s0'], actions: ['Start', 'Success', 'Failure'],
  edges: [{ from: 's0', event: 'Start', to: 's1' }, { from: 's1', event: 'Success', to: 's2' }, { from: 's1', event: 'Failure', to: 's3' }],
  source: { dotSha256: 'a'.repeat(64), stateCount: 4, edgeCount: 3 },
};
const operation: RetainedOperationInput['operation'] = {
  kind: 'retained-operation', start: 'Start', success: 'Success', failure: 'Failure', retainedVariable: 'retained',
};

function fixture(t: TestContext, automaton = graph) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sgd-retained-ts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = generateRetainedTypeScript({ automaton, className: 'Report', operation });
  for (const file of files) {
    const destination = path.join(root, file.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.content);
  }
  const compile = (source?: string) => {
    if (source !== undefined) {
      fs.writeFileSync(path.join(root, 'app.ts'), source);
      const config = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
      config.include.push('app.ts');
      fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(config));
    }
    const result = spawnSync(process.execPath, [compiler, '-p', path.join(root, 'tsconfig.json')], { cwd: root, encoding: 'utf8' });
    if (result.error) throw result.error;
    return result;
  };
  const run = (source: string) => {
    const compiled = compile();
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    fs.writeFileSync(path.join(root, 'run.mjs'), `import assert from 'node:assert/strict';\nimport {finalize, isFinalized} from './dist/operation.js';\n${source}`);
    const result = spawnSync(process.execPath, [path.join(root, 'run.mjs')], { cwd: root, encoding: 'utf8' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  return { compile, run, files };
}

test('retained TypeScript finalization preserves real payload and separates writer outcomes', t => {
  fixture(t).run(`
for (const ok of [true, false]) {
  const payload = { units: [{metrics: 42, raw: [1, 2]}], executionError: new Error('execution'), ledger: 'uncertain' };
  const output = {name: ok ? 'report path' : 'sync failure'};
  let calls = 0;
  const result = finalize(payload, borrowed => {
    calls++;
    assert.equal(borrowed, payload);
    return ok ? {ok:true,value:output} : {ok:false,error:output};
  });
  assert.equal(calls, 1);
  assert.equal(result.payload(), payload);
  assert.equal(result.payload().executionError, payload.executionError);
  assert.equal(result.status().kind, 'completed');
  const observed = result.status().observation;
  assert.equal(observed.kind, 'returned');
  assert.equal(observed.outcome.ok, ok);
  assert.equal(observed.outcome[ok ? 'value' : 'error'], output);
  assert.equal(result.snapshot().values.phase.value, ok ? 'Written' : 'Failed');
  assert.equal(result.snapshot().revision, '2');
  assert.equal(result.snapshot().values.retained.value, true);
  assert.equal(isFinalized(result), true);
  assert.equal(isFinalized({...result}), false);
  assert.equal(isFinalized(new Proxy(result, {})), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.status()), true);
  assert.equal(Object.isFrozen(observed), true);
  assert.equal(Object.isFrozen(observed.outcome), true);
  assert.equal(Reflect.set(result, 'payload', () => null), false);
  assert.equal(Reflect.set(observed.outcome, 'ok', !ok), false);
  assert.equal('send' in result, false);
}
`);
});

test('retained TypeScript catches callback faults and refuses malformed or async result shapes', t => {
  fixture(t).run(`
const payload = {raw: ['original']};
const fault = new Error('writer threw');
const thrown = finalize(payload, () => { throw fault; });
assert.equal(thrown.payload(), payload);
assert.equal(thrown.status().observation.kind, 'threw');
assert.equal(thrown.status().observation.error, fault);
assert.equal(thrown.snapshot().values.phase.value, 'Failed');
let getterCalls = 0;
const getter = {get ok() { getterCalls++; throw fault; }, value: 3};
const valueGetter = {ok:true, get value() { getterCalls++; throw fault; }};
for (const invalid of [null, undefined, 4, {}, {ok:true}, {ok:1,value:3}, {ok:false,value:3}, {ok:true,value:3,then(){}}, [], Promise.resolve(3), getter, valueGetter]) {
  let calls = 0;
  const result = finalize(payload, () => {calls++; return invalid;});
  assert.equal(calls, 1);
  assert.equal(result.payload(), payload);
  assert.equal(result.status().observation.kind, 'invalid-result');
  assert.equal(result.status().observation.returned, invalid);
  assert.equal(result.snapshot().values.phase.value, 'Failed');
}
assert.equal(getterCalls, 0);
const proxy = new Proxy({}, { getOwnPropertyDescriptor() {throw fault;} });
const trapped = finalize(payload, () => proxy);
assert.equal(trapped.payload(), payload);
assert.equal(trapped.status().observation.kind, 'threw');
assert.equal(trapped.status().observation.error, fault);
`);
});

test('model admission change prevents writer invocation and returns the same payload', t => {
  const denied: ExactFiniteAutomaton = {
    ...graph,
    nodes: [...graph.nodes, { id: 's4', values: { phase: { kind: 'string', value: 'Unprepared' }, retained: { kind: 'boolean', value: true } } }],
    initial: ['s4'], actions: [...graph.actions, 'Prepare'],
    edges: [...graph.edges, { from: 's4', event: 'Prepare', to: 's0' }],
    source: { ...graph.source, stateCount: 5, edgeCount: 4 },
  };
  fixture(t, denied).run(`
const payload = {raw: [7]};
const result = finalize(payload, () => { throw new Error('must not run'); });
assert.equal(result.payload(), payload);
assert.equal(result.status().kind, 'refused');
assert.equal(result.status().rejection.reason, 'disabled');
assert.equal(result.snapshot().revision, '0');
assert.equal(result.snapshot().values.phase.value, 'Unprepared');
`);
});

test('TypeScript compiler rejects replacing payload, spoofing status, event dispatch and async writers', t => {
  const f = fixture(t);
  const build = f.compile(`
import {finalize} from './operation.js';
const result = finalize({raw: 7}, payload => {
  payload.raw = 8;
  return {ok:true,value:'saved'};
});
result.payload = () => ({raw:9});
result.payload().raw = 10;
result.send('Success');
result.status().kind = 'completed';
finalize({raw:1}, async () => ({ok:true,value:'saved'}));
`);
  assert.notEqual(build.status, 0);
  for (const token of ['raw', 'payload', 'send', 'kind', 'Promise']) assert.ok(build.stdout.includes(token), build.stdout);
});

test('retained generator rejects missing completion and payload-loss models', () => {
  const missing: ExactFiniteAutomaton = { ...graph,
    edges: [{ from: 's0', event: 'Start', to: 's1' }, { from: 's1', event: 'Success', to: 's2' }, { from: 's2', event: 'Failure', to: 's3' }],
  };
  assert.throws(() => generateRetainedTypeScript({automaton:missing,className:'Report',operation}), /TLC207.*both observed/);
  const losing: ExactFiniteAutomaton = { ...graph, nodes: graph.nodes.map(node => node.id === 's3'
    ? {...node,values:{...node.values,retained:{kind:'boolean',value:false}}} : node) };
  assert.throws(() => generateRetainedTypeScript({automaton:losing,className:'Report',operation}), /TLC207.*stay true/);
});
