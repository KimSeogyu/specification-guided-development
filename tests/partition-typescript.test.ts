import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { generatePartitionTypeScript } from '../src/backends/partition-typescript.js';
import type { PartitionPlan } from '../src/partition-types.js';
import { partitionPlan } from './partition-fixtures.js';

const execute = promisify(execFile);
const runtime = resolve('.runtime/partition-ts-tests');
async function put(path: string, content: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }
async function fixture(plan = partitionPlan()) {
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(join(runtime, 'suite-'));
  try {
    for (const file of generatePartitionTypeScript({ plan, className: 'PartitionAuthority', rustCrateMode: 'standalone' })) await put(join(root, file.path), file.content);
    await execute(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json')], { timeout: 30_000 });
    const module = await import(pathToFileURL(join(root, 'dist/machine.js')).href);
    return { root, module };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
function raw(overrides: Record<string, unknown> = {}) { return { symbol: '한글😀\0', key: 5n, time: 0n, value: 10n, schema: 1, received: 1n, ...overrides }; }

test('TypeScript closed fold preserves whole rows, baseline duplicates, signed keys, all conflicts and Same stutters', async () => {
  const { root, module } = await fixture();
  try {
    const row = (overrides: Record<string, unknown> = {}) => module.createFactRow(raw(overrides));
    const consume = (result: ReturnType<typeof module.foldFact>) => { assert.equal(result.ok, true); const consumed = result.value.intoReport(); assert.equal(consumed.ok, true); return consumed.value; };
    const empty = consume(module.foldFact({ baseline: [], incoming: [] }));
    assert.equal(empty.kind, 'Noop'); assert.deepEqual(empty.rows, []); assert.equal(empty.group, null); assert.deepEqual(empty.counts, { inserted: 0n, unchanged: 0n });
    const first = row(); const last = row({ value: 20n, received: 2n });
    const noop = consume(module.foldFact({ baseline: [first, last], incoming: [] }));
    assert.equal(noop.kind, 'Noop'); assert.deepEqual(noop.rows, [first, last]);
    const same = consume(module.foldFact({ baseline: [first], incoming: [row({ schema: 2, received: 99n })] }));
    assert.equal(same.kind, 'Noop'); assert.equal(same.rows[0], first); assert.equal(same.rows[0].schema, 1); assert.equal(same.rows[0].received, 1n); assert.deepEqual(same.counts, { inserted: 0n, unchanged: 1n });
    const write = consume(module.foldFact({ baseline: [first, last], incoming: [row({ key: 9223372036854775807n }), row({ key: -9223372036854775808n }), row({ key: 0n }), row({ value: 20n, schema: 2, received: 90n })] }));
    assert.equal(write.kind, 'Write'); assert.deepEqual(write.rows.map((entry: ReturnType<typeof module.createFactRow>) => entry.key), [-9223372036854775808n, 0n, 5n, 9223372036854775807n]);
    assert.equal(write.rows[2], last); assert.deepEqual(write.counts, { inserted: 3n, unchanged: 1n }); assert.deepEqual(write.group, { symbol: '한글😀\0', dayIndex: 0n });
    const rejected = row({ value: 11n, received: 2n }); const another = row({ value: 12n, received: 3n });
    const refused = consume(module.foldFact({ baseline: [first], incoming: [row({ key: -1n }), rejected, rejected, row({ schema: 2, received: 99n }), another] }));
    assert.equal(refused.kind, 'Refused'); assert.deepEqual(refused.original, [first]); assert.deepEqual(refused.counts, { inserted: 0n, unchanged: 1n });
    assert.deepEqual(refused.conflicts, [{ stored: first, rejected }, { stored: first, rejected }, { stored: first, rejected: another }]);
    for (const value of [write, write.rows, write.counts, write.group, refused, refused.original, refused.conflicts, ...refused.conflicts]) assert.ok(Object.isFrozen(value));
    assert.throws(() => { write.counts.inserted = 9n; }, TypeError);
    assert.throws(() => { refused.conflicts.push({ stored: first, rejected }); }, TypeError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('TypeScript snapshots dense authenticated input before trial and refuses forged arrays, rows, groups and calendars', async () => {
  const original = partitionPlan(); const fact = original.row.plan.facts[0]; const source = original.row.binding.source.facts[0]; const family = original.contract.families[0];
  assert.ok(fact && source && family);
  const two: PartitionPlan = { ...original, row: { ...original.row, plan: { ...original.row.plan, facts: [fact, { ...fact, name: 'OtherFact', rustPath: 'crate::facts::OtherFact' }] }, binding: { ...original.row.binding, source: { ...original.row.binding.source, facts: [source, { ...source, name: 'OtherFact', rustPath: 'crate::facts::OtherFact' }] } } }, contract: { ...original.contract, families: [family, { ...family, name: 'OtherFact', datasets: ['other-fact'] }] } };
  const { root, module } = await fixture(two);
  const other = await fixture();
  try {
    const token = module.createFactRow(raw());
    const baseline = [token]; const incoming: unknown[] = [];
    const pending = module.foldFact({ baseline, incoming }); assert.equal(pending.ok, true);
    baseline.length = 0; incoming.push(module.createFactRow(raw({ value: 99n })));
    const report = pending.value.intoReport(); assert.equal(report.ok, true); assert.deepEqual(report.value.rows, [token]);
    const failures = [raw(), { ...token }, {}, null, 'Same', new Proxy(token, {}), module.createOtherFactRow(raw()), other.module.createFactRow(raw())];
    for (const value of failures) assert.deepEqual(module.foldFact({ baseline: [], incoming: [value] }), { ok: false, reason: 'invalid-row' });
    let invoked = false;
    const accessor = [token]; Object.defineProperty(accessor, '0', { get() { invoked = true; return token; } });
    const extra = [token]; Object.defineProperty(extra, 'extra', { value: 1 });
    const symbol = [token]; Object.defineProperty(symbol, Symbol('extra'), { value: 1 });
    const hole = new Array(1);
    for (const value of [accessor, extra, symbol, hole, { 0: token, length: 1 }, null]) assert.deepEqual(module.foldFact({ baseline: [], incoming: value }), { ok: false, reason: 'invalid-batch' });
    const batchAccessor = { incoming: [] }; Object.defineProperty(batchAccessor, 'baseline', { get() { invoked = true; return []; } });
    assert.deepEqual(module.foldFact(batchAccessor), { ok: false, reason: 'invalid-batch' }); assert.equal(invoked, false);
    assert.deepEqual(module.foldFact({ baseline: [], incoming: [], extra: 1 }), { ok: false, reason: 'invalid-batch' });
    for (const changed of [{ symbol: 'other' }, { time: 86_400_000_000n }]) assert.deepEqual(module.foldFact({ baseline: [token], incoming: [module.createFactRow(raw(changed))] }), { ok: false, reason: 'wrong-group' });
    assert.deepEqual(module.foldFact({ baseline: [], incoming: [module.createFactRow(raw({ time: -1n }))] }), { ok: false, reason: 'invalid-calendar' });
    const extreme = module.foldFact({ baseline: [], incoming: [module.createFactRow(raw({ time: 9223372036854775807n }))] }); assert.equal(extreme.ok, true); assert.equal(extreme.value.group.dayIndex, 9223372036854775807n / 86_400_000_000n);
    assert.deepEqual(module.foldFact({ baseline: [], incoming: [token] }).value.intoReport().value.rows, [token]);
  } finally { await rm(root, { recursive: true, force: true }); await rm(other.root, { recursive: true, force: true }); }
});

test('closed handle authentication and TypeScript declarations exclude observation, controller and raw-row bypasses', async () => {
  const { root, module } = await fixture();
  try {
    assert.equal('createFactOwner' in module, false); assert.equal('createPartitionAuthorityControl' in module, false);
    const pending = module.foldFact({ baseline: [], incoming: [module.createFactRow(raw())] }); assert.equal(pending.ok, true);
    const closed = pending.value; assert.ok(Object.isFrozen(closed));
    for (const fake of [{ ...closed }, {}, null, new Proxy(closed, {})]) assert.deepEqual(closed.intoReport.call(fake), { ok: false, reason: 'invalid-closed' });
    assert.equal(closed.intoReport().ok, true); assert.deepEqual(closed.intoReport(), { ok: false, reason: 'already-consumed' });
    await put(join(root, 'consumer.ts'), `import { createFactRow, foldFact, createFactOwner, type FactRow, type FactClosedPartition } from './machine.js';
const row = createFactRow({symbol:'x',key:0n,time:0n,value:1n,schema:1,received:0n});
row.value = 2n;
const forged: FactRow = {symbol:'x',key:0n,time:0n,value:1n,schema:1,received:0n};
const batch = foldFact({baseline:[],incoming:[row]});
if (batch.ok) {
 batch.value.counts.inserted = 1n;
 batch.value.send('Same');
 batch.value.restore({});
}
const fake: FactClosedPartition = {counts:{inserted:0n,unchanged:0n},group:null,intoReport(){throw new Error();}};
`);
    const config = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8')); config.include.push('consumer.ts'); await put(join(root, 'tsconfig.json'), JSON.stringify(config));
    await assert.rejects(execute(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json')], { timeout: 30_000 }), (error: unknown) => {
      assert.ok(error instanceof Error && 'stdout' in error && typeof error.stdout === 'string');
      for (const [line, code] of [[1, 2724], [3, 2540], [4, 2741], [7, 2540], [8, 2339], [9, 2339], [11, 2741]]) assert.match(error.stdout, new RegExp(`consumer\\.ts\\(${line},[0-9]+\\): error TS${code}`));
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('two and three raw i64 tuple keys use signed lexicographic order rather than identity string order', async () => {
  for (const key of [['key', 'value'], ['key', 'value', 'time']]) {
    const plan = partitionPlan(); const family = plan.contract.families[0]; assert.ok(family);
    const { root, module } = await fixture({ ...plan, contract: { ...plan.contract, families: [{ ...family, key }] } });
    try {
      const entries = [raw({ key: 1n, value: -1n }), raw({ key: -1n, value: 9223372036854775807n }), raw({ key: -1n, value: -9223372036854775808n }), raw({ key: 0n, value: 0n })].map(value => module.createFactRow(value));
      const folded = module.foldFact({ baseline: [], incoming: entries }); assert.equal(folded.ok, true);
      const consumed = folded.value.intoReport(); assert.equal(consumed.ok, true); assert.equal(consumed.value.kind, 'Write');
      assert.deepEqual(consumed.value.rows.map((row: ReturnType<typeof module.createFactRow>) => [row.key, row.value]), [[-1n, -9223372036854775808n], [-1n, 9223372036854775807n], [0n, 0n], [1n, -1n]]);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
