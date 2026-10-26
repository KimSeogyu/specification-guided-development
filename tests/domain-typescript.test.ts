import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { generateDomainTypeScript } from '../src/backends/domain-typescript.js';
import { DomainBindingSchema, type DomainBinding } from '../src/domain-types.js';
import { validateDomainBinding } from '../src/domain-validation.js';
import type { ExactFiniteAutomaton } from '../src/finite-types.js';

const domain: DomainBinding = {
  operations: [
    { name: 'publish', port: 'write', start: 'BeginWrite', success: 'Written', failure: 'WriteFailed' },
    { name: 'overwrite', port: 'write', start: 'BeginOverwrite', success: 'Overwritten', failure: 'OverwriteFailed' },
    { name: 'refresh', port: 'fetch', start: 'BeginFetch', success: 'Fetched', failure: 'FetchFailed' },
  ],
};

function graph(ready = false): ExactFiniteAutomaton {
  const phases = ['Unready', 'Ready', 'Writing', 'Written', 'Failed', 'Fetching', 'Fetched', 'FetchFailed', 'Overwriting'];
  const edges = [
    { from: 's0', event: 'Prepare', to: 's1' },
    { from: 's1', event: 'Disarm', to: 's0' },
    { from: 's1', event: 'BeginWrite', to: 's2' },
    { from: 's2', event: 'Written', to: 's3' },
    { from: 's2', event: 'WriteFailed', to: 's4' },
    { from: 's1', event: 'BeginOverwrite', to: 's8' },
    { from: 's3', event: 'BeginOverwrite', to: 's8' },
    { from: 's8', event: 'Overwritten', to: 's3' },
    { from: 's8', event: 'OverwriteFailed', to: 's4' },
    { from: 's1', event: 'BeginFetch', to: 's5' },
    { from: 's5', event: 'Fetched', to: 's6' },
    { from: 's5', event: 'FetchFailed', to: 's7' },
    ...['s3', 's4', 's6', 's7'].map(from => ({ from, event: 'Reset', to: 's1' })),
  ];
  return {
    version: 1, kind: 'exact-finite', name: 'Delivery',
    variables: [{ name: 'phase', kind: 'string' }],
    nodes: phases.map((phase, index) => ({
      id: `s${index}`, values: { phase: { kind: 'string', value: phase } },
    })),
    initial: [ready ? 's1' : 's0'],
    actions: [...new Set(edges.map(edge => edge.event))],
    edges,
    source: { dotSha256: 'a'.repeat(64), stateCount: phases.length, edgeCount: edges.length },
  };
}

function recount(value: ExactFiniteAutomaton): ExactFiniteAutomaton {
  return { ...value, source: { ...value.source, stateCount: value.nodes.length, edgeCount: value.edges.length } };
}

function fixture(t: TestContext, automaton = graph()) {
  const root = mkdtempSync(join(tmpdir(), 'sgd-domain-ts-'));
  let cleanupSafe = true;
  t.after(() => {
    if (cleanupSafe) rmSync(root, { recursive: true, force: true });
    else t.diagnostic(`Preserved domain fixture because process completion is uncertain: ${root}`);
  });
  const files = generateDomainTypeScript({ automaton, className: 'Delivery', domain });
  for (const file of files) {
    const destination = join(root, file.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, file.content);
  }
  const execute = (args: string[]) => {
    const result = spawnSync(process.execPath, args, {
      cwd: root, encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error) { cleanupSafe = false; throw result.error; }
    assert.equal(result.signal, null, result.stderr);
    return result;
  };
  const compile = (consumer?: string) => {
    if (consumer === undefined) return execute([resolve('node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json')]);
    writeFileSync(join(root, 'consumer.ts'), consumer);
    writeFileSync(join(root, 'consumer-tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
        noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, types: [],
        declaration: true, noEmitOnError: true, outDir: 'consumer-dist',
      },
      include: ['consumer.ts', 'domain.ts', 'internal/machine.ts'],
    }));
    return execute([resolve('node_modules/typescript/bin/tsc'), '-p', join(root, 'consumer-tsconfig.json')]);
  };
  const run = (body: string) => {
    const built = compile();
    assert.equal(built.status, 0, built.stdout + built.stderr);
    writeFileSync(join(root, 'run.mjs'), [
      "import assert from 'node:assert/strict';",
      "import {createDeliveryDomain, isDeliveryDomain} from './dist/domain.js';",
      body,
    ].join('\n'));
    const observed = execute([join(root, 'run.mjs')]);
    assert.equal(observed.status, 0, observed.stdout + observed.stderr);
  };
  return { root, compile, run };
}

test('domain admission and actual fulfillment or rejection choose model outcomes without caller completion events', t => {
  fixture(t).run(`
let writes = 0;
let reads = 0;
let behavior = 'fulfilled';
const fulfilled = {kind:'failure', explanation:'a fulfilled value is opaque, not an outcome selector'};
const originalError = Object.freeze({cause:'native port rejection'});
const owner = createDeliveryDomain({
  fetch: input => { reads++; return 'fetched:' + input; },
  write: input => {
    writes++;
    if (behavior === 'rejected') return Promise.reject(originalError);
    if (behavior === 'throws-undefined') throw undefined;
    if (behavior === 'rejects-undefined') return Promise.reject(undefined);
    if (behavior === 'fulfills-undefined') return undefined;
    return Promise.resolve(fulfilled);
  },
});
const initial = owner.read();
const disabled = await owner.publish({id:'first'});
assert.equal(disabled.kind, 'refused');
assert.equal(disabled.reason, 'disabled');
assert.equal(writes, 0);
assert.deepEqual(owner.read(), initial);
assert.equal(owner.send('Prepare').ok, true);
const success = await owner.publish({id:'first'});
assert.equal(success.kind, 'success');
assert.equal(success.value, fulfilled);
assert.equal(success.start.event, 'BeginWrite');
assert.equal(success.completion.event, 'Written');
assert.equal(owner.read().values.phase.value, 'Written');
assert.equal(owner.read().revision, '3');
assert.equal(writes, 1);

for (const mode of ['rejected', 'throws-undefined', 'rejects-undefined', 'fulfills-undefined']) {
  assert.equal(owner.send('Reset').ok, true);
  behavior = mode;
  const result = await owner.publish({id:mode});
  assert.notEqual(result.kind, 'completion-rejected');
  if (mode === 'fulfills-undefined') {
    assert.equal(result.kind, 'success');
    assert.equal(Object.hasOwn(result, 'value'), true);
    assert.equal(result.value, undefined);
    assert.equal(result.completion.event, 'Written');
  } else {
    assert.equal(result.kind, 'failure');
    assert.equal(Object.hasOwn(result, 'error'), true);
    assert.equal(result.error, mode === 'rejected' ? originalError : undefined);
    assert.equal(result.completion.event, 'WriteFailed');
    assert.equal(owner.read().values.phase.value, 'Failed');
  }
}
assert.equal(writes, 5);
assert.equal(owner.send('Reset').ok, true);
const refreshed = await owner.refresh(17);
assert.equal(refreshed.kind, 'success');
assert.equal(refreshed.value, 'fetched:17');
assert.equal(refreshed.completion.event, 'Fetched');
assert.equal(reads, 1);
`);
});

test('pending state prevents synchronous reentrancy, concurrent operations and public completion spoofing', t => {
  fixture(t, graph(true)).run(`
let calls = 0;
let reads = 0;
let release;
let reentered;
let publicAttempt;
const owner = createDeliveryDomain({
  fetch: () => { reads++; return 'unused'; },
  write: input => {
    calls++;
    assert.equal(owner.read().values.phase.value, 'Writing');
    reentered = owner.overwrite(input);
    publicAttempt = owner.send('Written');
    return new Promise(resolve => { release = resolve; });
  },
});
const first = owner.publish({id:'actual'});
assert.equal(calls, 1);
assert.equal(owner.read().revision, '1');
const pending = owner.read();
assert.equal((await reentered).kind, 'refused');
assert.equal((await owner.publish({id:'duplicate'})).kind, 'refused');
assert.equal((await owner.refresh(3)).kind, 'refused');
assert.equal(owner.send('Reset').ok, false);
assert.equal(publicAttempt.ok, false);
assert.equal(publicAttempt.reason, 'unknown-event');
for (const action of ['BeginWrite', 'Written', 'WriteFailed', 'BeginOverwrite', 'Overwritten', 'OverwriteFailed', 'BeginFetch', 'Fetched', 'FetchFailed']) {
  const rejected = owner.send(action);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'unknown-event');
}
assert.deepEqual(owner.read(), pending);
assert.equal(calls, 1);
assert.equal(reads, 0);
const value = {receipt:'one'};
release(value);
const result = await first;
assert.equal(result.kind, 'success');
assert.equal(result.value, value);
assert.equal(result.completion.event, 'Written');
assert.equal(owner.read().revision, '2');
assert.equal(owner.read().values.phase.value, 'Written');
assert.equal(calls, 1);
`);
});

test('domain facades and snapshots are immutable and copies or proxies do not authenticate', t => {
  fixture(t, graph(true)).run(`
const owner = createDeliveryDomain({fetch: input => input, write: input => input});
assert.equal(isDeliveryDomain(owner), true);
assert.equal(isDeliveryDomain({...owner}), false);
assert.equal(isDeliveryDomain(new Proxy(owner, {})), false);
assert.equal(isDeliveryDomain(null), false);
assert.equal(isDeliveryDomain({read:owner.read,send:owner.send,publish:owner.publish}), false);
const snapshot = owner.read();
assert.equal(Object.isFrozen(owner), true);
assert.equal(Object.isFrozen(owner.publish), true);
assert.equal(Object.isFrozen(snapshot), true);
assert.equal(Object.isFrozen(snapshot.values), true);
assert.equal(Object.isFrozen(snapshot.values.phase), true);
assert.equal(Reflect.set(snapshot, 'revision', '999'), false);
assert.equal(Reflect.set(snapshot.values.phase, 'value', 'Written'), false);
assert.equal(Reflect.set(owner, 'send', () => ({ok:true})), false);
assert.equal(Reflect.set(owner, 'machine', {send:()=>({ok:true})}), false);
assert.equal('machine' in owner, false);
assert.equal(owner.read().values.phase.value, 'Ready');
const result = await owner.publish('retained value');
assert.equal(result.kind, 'success');
assert.equal(Object.isFrozen(result), true);
assert.equal(Object.isFrozen(result.start), true);
assert.equal(Object.isFrozen(result.completion), true);
assert.equal(snapshot.values.phase.value, 'Ready');
assert.equal(owner.read().values.phase.value, 'Written');
`);
});

test('dependency injection captures own data functions once and never invokes port getters', t => {
  fixture(t, graph(true)).run(`
let originalCalls = 0;
let replacementCalls = 0;
let getterCalls = 0;
let receiver;
const ports = {
  fetch: value => value,
  write: function (input) { receiver = this; originalCalls++; return input; },
};
const owner = createDeliveryDomain(ports);
ports.write = () => { replacementCalls++; throw new Error('late replacement'); };
Object.defineProperty(ports, 'write', {get(){getterCalls++; throw new Error('late getter');}});
assert.equal((await owner.publish('original')).kind, 'success');
assert.equal(receiver, undefined);
const overwritten = await owner.overwrite('second');
assert.equal(overwritten.kind, 'success');
assert.equal(overwritten.value, 'second');
assert.equal(overwritten.completion.event, 'Overwritten');
assert.equal(originalCalls, 2);
assert.equal(replacementCalls, 0);
assert.equal(getterCalls, 0);

const accessor = {fetch: value => value, get write(){getterCalls++; return value => value;}};
assert.throws(() => createDeliveryDomain(accessor), /TLC208.*own.*data property/);
assert.equal(getterCalls, 0);
const inherited = Object.create({write: value => value});
inherited.fetch = value => value;
assert.throws(() => createDeliveryDomain(inherited), /TLC208.*own.*data property/);
for (const write of [undefined, 3, 'function', {}, null]) {
  assert.throws(() => createDeliveryDomain({fetch: value => value, write}), /TLC208/);
}
for (const value of [undefined, null, [], 5]) assert.throws(() => createDeliveryDomain(value), /TLC208/);
`);
});

test('shared and independent ports keep their inferred input and awaited output types', t => {
  const built = fixture(t, graph(true)).compile(`
import {createDeliveryDomain} from './domain.js';
const owner = createDeliveryDomain({
  fetch: (id: number) => Promise.resolve('entry:' + id),
  write: (input: {body: string}) => ({receipt: input.body.length}),
});
const published = await owner.publish({body:'one'});
if (published.kind === 'success') {
  const receipt: number = published.value.receipt;
  void receipt;
}
const overwritten = await owner.overwrite({body:'two'});
if (overwritten.kind === 'success') {
  const receipt: number = overwritten.value.receipt;
  void receipt;
}
const fetched = await owner.refresh(3);
if (fetched.kind === 'success') {
  const entry: string = fetched.value;
  void entry;
}
owner.send('Reset');
`);
  assert.equal(built.status, 0, built.stdout + built.stderr);
});

test('native TypeScript rejects wrong port inputs, private events and facade mutation', t => {
  const built = fixture(t, graph(true)).compile(`
import {createDeliveryDomain} from './domain.js';
const owner = createDeliveryDomain({
  fetch: (id: number) => String(id),
  write: (input: {body: string}) => ({receipt: input.body.length}),
});
owner.publish(3);
owner.overwrite({body:17});
owner.refresh('wrong');
owner.send('Written');
owner.send('BeginWrite');
owner.publish = async () => ({kind:'failure',error:'fake'});
owner.read().revision = '9';
const result = await owner.publish({body:'valid'});
if (result.kind === 'success') {
  const wrong: string = result.value.receipt;
}
`);
  assert.notEqual(built.status, 0);
  for (const marker of ['TS2345', 'TS2322', 'TS2540']) {
    assert.ok(built.stdout.includes(marker), built.stdout + built.stderr);
  }
  for (const line of [7, 8, 9, 10, 11, 12, 13, 16]) {
    assert.ok(built.stdout.includes(`consumer.ts(${line},`), built.stdout);
  }
});

test('operations reserve two revisions before calling a port and complete at the final revision', t => {
  const max = 18_446_744_073_709_551_615n;
  for (const [revision, rejects] of [[max - 2n, false], [max - 1n, true], [max, true]] satisfies [bigint, boolean][]) {
    const f = fixture(t, graph(true));
    const machine = join(f.root, 'internal/machine.ts');
    const original = readFileSync(machine, 'utf8');
    assert.equal(original.split('let revision = 0n;').length, 2, 'the controlled boundary fixture must alter one private revision initializer');
    writeFileSync(machine, original.replace('let revision = 0n;', `let revision = ${revision}n;`));
    f.run(`
let calls = 0;
const owner = createDeliveryDomain({fetch: value => value, write: () => {calls++; throw undefined;}});
const before = owner.read();
const result = await owner.publish('one');
${rejects ? `
assert.equal(result.kind, 'refused');
assert.equal(result.reason, 'revision-exhausted');
assert.equal(calls, 0);
assert.deepEqual(owner.read(), before);
` : `
assert.equal(result.kind, 'failure');
assert.equal(Object.hasOwn(result, 'error'), true);
assert.equal(result.error, undefined);
assert.equal(result.start.after.revision, '${max - 1n}');
assert.equal(result.completion.after.revision, '${max}');
assert.equal(owner.read().values.phase.value, 'Failed');
assert.equal(calls, 1);
`}
`);
  }
});

test('domain validation refuses orphaned or ambiguous asynchronous protocols', () => {
  const valid = graph();
  validateDomainBinding({ automaton: valid, domain });
  const modified = (change: (value: ExactFiniteAutomaton) => void): ExactFiniteAutomaton => {
    const value = structuredClone(valid);
    change(value);
    return recount(value);
  };
  const invalid: ExactFiniteAutomaton[] = [
    modified(value => { value.edges = value.edges.filter(edge => edge.event !== 'WriteFailed'); }),
    modified(value => { value.edges.push({from:'s2',event:'Reset',to:'s1'}); }),
    modified(value => { value.edges.push({from:'s1',event:'Written',to:'s3'}); }),
    modified(value => { value.edges.push({from:'s1',event:'Reset',to:'s2'}); }),
    modified(value => { value.initial = ['s2']; }),
    modified(value => {
      const success = value.edges.find(edge => edge.event === 'Written');
      assert.ok(success);
      success.to = 's5';
    }),
  ];
  for (const automaton of invalid) {
    assert.throws(() => validateDomainBinding({ automaton, domain }), /TLC208/);
    assert.throws(() => generateDomainTypeScript({ automaton, className:'Delivery', domain }), /TLC208/);
  }
  for (const malformed of [
    { operations: [{...domain.operations[0], success:'WriteFailed'}] },
    { operations: [{...domain.operations[0], name:'send'}] },
    { operations: [{...domain.operations[0], name:'__proto__'}] },
    { operations: [{...domain.operations[0], failure:'NotAModelAction'}] },
    { operations: [domain.operations[0], domain.operations[0]] },
  ]) {
    const parsed = DomainBindingSchema.safeParse(malformed);
    if (!parsed.success) continue;
    assert.throws(() => validateDomainBinding({ automaton:valid, domain:parsed.data }), /TLC208/);
  }
});
