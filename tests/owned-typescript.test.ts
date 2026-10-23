import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { generateOwnedTypeScript } from '../src/backends/owned-typescript.js';
import type { ExactFiniteAutomaton } from '../src/finite-types.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const compiler = path.join(projectDirectory, 'node_modules/typescript/bin/tsc');
const graph: ExactFiniteAutomaton = {
  version: 1, kind: 'exact-finite', name: 'GuardedOrder',
  variables: [{ name: 'phase', kind: 'string' }, { name: 'approved', kind: 'boolean' }, { name: 'quantity', kind: 'integer' }],
  nodes: [
    { id: 's0', values: { phase: { kind: 'string', value: 'New' }, approved: { kind: 'boolean', value: false }, quantity: { kind: 'integer', value: '9007199254740993' } } },
    { id: 's1', values: { phase: { kind: 'string', value: 'New' }, approved: { kind: 'boolean', value: true }, quantity: { kind: 'integer', value: '9007199254740993' } } },
    { id: 's2', values: { phase: { kind: 'string', value: 'Submitted' }, approved: { kind: 'boolean', value: true }, quantity: { kind: 'integer', value: '9007199254740994' } } },
    { id: 's3', values: { phase: { kind: 'string', value: 'Cancelled' }, approved: { kind: 'boolean', value: false }, quantity: { kind: 'integer', value: '-123456789012345678901234567890' } } },
  ],
  initial: ['s0'], actions: ['Approve', 'Submit', 'Cancel', 'Reset', 'Stay'],
  edges: [
    { from: 's0', event: 'Approve', to: 's1' }, { from: 's0', event: 'Stay', to: 's0' },
    { from: 's1', event: 'Submit', to: 's2' }, { from: 's1', event: 'Reset', to: 's0' },
    { from: 's2', event: 'Cancel', to: 's3' }, { from: 's3', event: 'Reset', to: 's0' },
  ],
  source: { dotSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', stateCount: 4, edgeCount: 6 },
};

function fixture(t: TestContext, automaton = graph, className = 'Order') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sgd-owned-ts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = generateOwnedTypeScript({ automaton, className });
  for (const file of files) {
    const destination = path.join(root, file.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.content);
  }
  const compile = (source?: string) => {
    if (source !== undefined) {
      fs.writeFileSync(path.join(root, 'app.ts'), source);
      const config = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
      config.include = ['machine.ts', 'app.ts'];
      fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(config));
    }
    const result = spawnSync(process.execPath, [compiler, '-p', path.join(root, 'tsconfig.json')], { cwd: root, encoding: 'utf8' });
    if (result.error) throw result.error;
    return result;
  };
  const run = (source: string) => {
    fs.writeFileSync(path.join(root, 'run.mjs'), `import assert from 'node:assert/strict';\nimport { create${className}, is${className} } from './dist/machine.js';\n${source}`);
    const result = spawnSync(process.execPath, [path.join(root, 'run.mjs')], { cwd: root, encoding: 'utf8' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  return { root, files, compile, run };
}

function requireBuild(f: ReturnType<typeof fixture>) {
  const build = f.compile();
  assert.equal(build.status, 0, build.stdout + build.stderr);
}

test('owned TypeScript preserves guards, exact values, revisions and rejected dispatch state', t => {
  const f = fixture(t);
  requireBuild(f);
  f.run(`
const machine = createOrder();
const initial = machine.read();
assert.equal(initial.model, 'GuardedOrder');
assert.equal(initial.modelRevision, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
assert.equal(initial.revision, '0');
assert.deepEqual(initial.values.quantity, {kind:'integer',value:'9007199254740993'});
assert.deepEqual(machine.send('Submit'), {ok:false,reason:'disabled',state:initial});
assert.deepEqual(machine.read(), initial);
assert.deepEqual(machine.send('NotAnAction'), {ok:false,reason:'unknown-event',state:initial});
for (const event of [undefined, null, {}, 5, Symbol('Approve')]) {
  assert.deepEqual(machine.send(event), {ok:false,reason:'unknown-event',state:initial});
}
const approved = machine.send('Approve');
assert.equal(approved.ok, true);
assert.equal(approved.event, 'Approve');
assert.deepEqual(approved.before, initial);
assert.equal(approved.after.values.phase.value, 'New');
assert.equal(approved.after.values.approved.value, true);
assert.equal(approved.after.revision, '1');
const submitted = machine.send('Submit');
assert.equal(submitted.ok, true);
assert.equal(submitted.after.nodeId, 's2');
assert.equal(submitted.after.revision, '2');
assert.deepEqual(submitted.after.values.quantity, {kind:'integer',value:'9007199254740994'});
assert.equal(machine.send('Cancel').after.values.quantity.value, '-123456789012345678901234567890');
assert.equal(initial.values.approved.value, false);
`);
});

test('casts, reflection, snapshots, aliases and method replacement cannot mutate the owned state', t => {
  const f = fixture(t);
  requireBuild(f);
  f.run(`
const machine = createOrder();
const initial = machine.read();
assert.equal(Object.isFrozen(machine), true);
assert.equal(Object.isFrozen(machine.read), true);
assert.equal(Object.isFrozen(machine.send), true);
assert.equal(Object.isFrozen(initial), true);
assert.equal(Object.isFrozen(initial.values), true);
for (const value of Object.values(initial.values)) assert.equal(Object.isFrozen(value), true);
assert.notEqual(initial, machine.read());
assert.notEqual(initial.values, machine.read().values);
assert.notEqual(initial.values.approved, machine.read().values.approved);
for (const [target, key, value] of [
  [machine, 'nodeId', 's1'], [machine, 'revision', 100n], [machine, 'send', () => ({ok:true})],
  [machine, 'read', () => ({nodeId:'s1'})], [initial, 'nodeId', 's1'], [initial, 'revision', '100'],
  [initial.values, 'approved', {kind:'boolean',value:true}], [initial.values.approved, 'value', true],
]) {
  assert.equal(Reflect.set(target, key, value), false);
  assert.equal(Reflect.defineProperty(target, key, {value}), false);
}
assert.equal(Reflect.setPrototypeOf(machine, {nodeId:'s1'}), false);
assert.throws(() => { machine.state = 'Submitted'; }, TypeError);
assert.throws(() => { initial.values.approved.value = true; }, TypeError);
assert.deepEqual(machine.read(), initial);
assert.equal(machine.send('Submit').ok, false);
const alias = machine;
const detached = machine.send;
assert.equal(detached.call({nodeId:'s1'}, 'Submit').ok, false);
assert.equal(alias.send('Approve').ok, true);
assert.equal(detached('Submit').ok, true);
assert.equal(machine.read().revision, '2');
assert.equal(isOrder(machine), true);
for (const fake of [null, undefined, 1, 'Order', {}, {...machine}, Object.create(machine), new Proxy(machine,{})]) {
  assert.equal(isOrder(fake), false);
}
const second = createOrder();
assert.equal(isOrder(second), true);
assert.equal(second.read().revision, '0');
assert.equal(second.send('Submit').ok, false);
`);
});

test('native TypeScript 7 rejects direct state writes, snapshot edits, missing APIs and invalid events', t => {
  const f = fixture(t);
  const build = f.compile(`
import {createOrder, type Order} from './machine.js';
const machine = createOrder();
machine.nodeId = 's1';
machine.revision = '50';
machine.send = () => ({ok: false, reason: 'disabled', state: machine.read()});
machine.read().values.approved.value = true;
machine.read().nodeId = 's1';
machine.restore(machine.read());
machine.send('Missing');
new Order();
`);
  assert.notEqual(build.status, 0);
  for (const token of ['nodeId', 'revision', 'send', 'value', 'restore', 'Missing', 'Order']) assert.ok(build.stdout.includes(token), build.stdout);
  assert.equal(fs.existsSync(path.join(f.root, 'dist/machine.js')), false, 'noEmitOnError prevents emission');
});

test('every reachable concrete node/action decision matches the exact graph without transition annotations', t => {
  const f = fixture(t);
  requireBuild(f);
  f.run(`
const graph = ${JSON.stringify(graph)};
const paths = new Map([[graph.initial[0], []]]);
const pending = [graph.initial[0]];
for (let index = 0; index < pending.length; index++) {
  const current = pending[index];
  for (const edge of graph.edges.filter(edge => edge.from === current)) {
    if (!paths.has(edge.to)) {
      paths.set(edge.to, [...paths.get(current), edge.event]);
      pending.push(edge.to);
    }
  }
}
assert.equal(paths.size, graph.nodes.length);
for (const [id, path] of paths) {
  for (const event of graph.actions) {
    const machine = createOrder();
    for (const step of path) assert.equal(machine.send(step).ok, true);
    const before = machine.read();
    assert.equal(before.nodeId, id);
    assert.deepEqual(before.values, graph.nodes.find(node => node.id === id).values);
    const edge = graph.edges.find(edge => edge.from === id && edge.event === event);
    const result = machine.send(event);
    if (edge) {
      assert.equal(result.ok, true, id + ' / ' + event);
      assert.equal(result.after.nodeId, edge.to);
      assert.equal(result.after.revision, String(BigInt(before.revision) + 1n));
      assert.deepEqual(result.after.values, graph.nodes.find(node => node.id === edge.to).values);
      assert.deepEqual(result.before, before);
    } else {
      assert.deepEqual(result, {ok:false,reason:'disabled',state:before});
      assert.deepEqual(machine.read(), before);
    }
  }
}
`);
});

test('generation rejects nondeterministic successors and multiple initial states', () => {
  assert.throws(() => generateOwnedTypeScript({ automaton: { ...graph, initial: ['s0', 's1'] }, className: 'Order' }), /TLC204.*one initial/);
  assert.throws(() => generateOwnedTypeScript({ automaton: { ...graph, edges: [...graph.edges, { from: 's0', event: 'Approve', to: 's2' }], source: { ...graph.source, edgeCount: graph.edges.length + 1 } }, className: 'Order' }), /TLC204.*ambiguous/);
  assert.throws(() => generateOwnedTypeScript({ automaton: graph, className: 'Order;process' }), /TLC204.*className/);
});

test('generation is deterministic under node, action, edge, variable and valuation reordering', () => {
  const canonical = generateOwnedTypeScript({ automaton: graph, className: 'Order' });
  const reordered: ExactFiniteAutomaton = {
    ...graph, variables: [...graph.variables].reverse(), nodes: [...graph.nodes].reverse().map(node => ({ ...node, values: Object.fromEntries(Object.entries(node.values).reverse()) })),
    actions: [...graph.actions].reverse(), edges: [...graph.edges].reverse(),
  };
  assert.deepEqual(generateOwnedTypeScript({ automaton: reordered, className: 'Order' }), canonical);
  const manifest = canonical.find(file => file.path === 'package.json');
  assert.ok(manifest);
  assert.equal(JSON.parse(manifest.content).devDependencies.typescript, '7.0.2');
});

test('special action names remain data and generated identifiers do not shadow native types', t => {
  const tricky: ExactFiniteAutomaton = {
    version: 1, kind: 'exact-finite', name: 'Names', variables: [{name:'phase',kind:'string'}],
    nodes: [{id:'s0',values:{phase:{kind:'string',value:'data'}}}],
    initial:['s0'], actions:['__proto__'], edges:[{from:'s0',event:'__proto__',to:'s0'}],
    source:{dotSha256:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',stateCount:1,edgeCount:1},
  };
  const f = fixture(t, tricky, 'Map');
  requireBuild(f);
  f.run(`
const machine = createMap();
assert.equal(isMap(machine), true);
assert.deepEqual(machine.read().values.phase, {kind:'string',value:'data'});
assert.equal(machine.send('__proto__').ok, true);
`);
});

test('private overflow harness refuses an enabled transition before changing node or revision', t => {
  const f = fixture(t);
  const source = fs.readFileSync(path.join(f.root, 'machine.ts'), 'utf8');
  // Seed only this temporary module to reach the u64 boundary without exposing a restore API.
  assert.equal(source.split('let revision = 0n;').length, 2);
  fs.writeFileSync(path.join(f.root, 'machine.ts'), source.replace('let revision = 0n;', 'let revision = 18446744073709551615n;'));
  requireBuild(f);
  f.run(`
const machine = createOrder();
const before = machine.read();
assert.equal(before.revision, '18446744073709551615');
const denied = machine.send('Approve');
assert.deepEqual(denied, {ok:false,reason:'revision-exhausted',state:before});
assert.equal(Object.isFrozen(denied), true);
assert.deepEqual(machine.read(), before);
assert.equal(machine.send('Missing').reason, 'unknown-event');
assert.equal(machine.send('Submit').reason, 'disabled');
assert.deepEqual(machine.read(), before);
`);
});
