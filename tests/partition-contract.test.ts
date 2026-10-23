import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { readPartitionContract } from '../src/partition-contract.js';
import { PartitionContractSchema, PartitionProjectSchema } from '../src/partition-types.js';

const jar = process.env.TLA2TOOLS_JAR ? resolve(process.env.TLA2TOOLS_JAR) : undefined;
const source = String.raw`---- MODULE Families ----
PartitionFamilies ==
 [version |-> 1, calendar |-> "utc-micros-nonnegative-day-v1",
  families |->
   [OtherFact |-> [key |-> <<"time", "value", "key">>, symbol |-> "symbol", time |-> "time", datasets |-> {"z-other", "a-other"}],
    Fact |-> [key |-> <<"key">>, symbol |-> "symbol", time |-> "time", datasets |-> {"fact"}]]]
====
`;
async function fixture(text = source) {
  assert.ok(jar);
  const directory = await mkdtemp(join(tmpdir(), 'sgd-partition-contract-test-'));
  const spec = join(directory, 'Families.tla'); await writeFile(spec, text);
  return { directory, spec, read: () => readPartitionContract({ spec, operator: 'PartitionFamilies', jar }) };
}

test('v6 declares only the unbound partition fold and exact source references', () => {
  const project = { version: 6, profile: 'partition-fold', name: 'Partition', application: '../application', targets: ['rust', 'typescript'], models: { row: { project: 'row.json' }, control: { project: 'control.json' }, families: { spec: 'Families.tla', operator: 'PartitionFamilies' } }, binding: { className: 'PartitionMachine' } };
  assert.equal(PartitionProjectSchema.parse(project).binding.rustCrateMode, 'standalone');
  for (const unsupported of [{ ...project, profile: 'partition-store' }, { ...project, outcomes: { Insert: 'Clash' } }, { ...project, binding: { ...project.binding, writer: 'userCallback' } }]) assert.equal(PartitionProjectSchema.safeParse(unsupported).success, false);
});

test('literal family contract preserves tuple order and normalizes set and family order after actual SANY/TLC', { skip: !jar }, async () => {
  const data = await fixture();
  try {
    const result = await data.read();
    assert.deepEqual(result.contract, { version: 1, calendar: 'utc-micros-nonnegative-day-v1', families: [
      { name: 'Fact', key: ['key'], symbol: 'symbol', time: 'time', datasets: ['fact'] },
      { name: 'OtherFact', key: ['time', 'value', 'key'], symbol: 'symbol', time: 'time', datasets: ['a-other', 'z-other'] },
    ] });
    assert.equal(result.evidence.moduleClosure.length, 2); assert.deepEqual(result.evidence.standardModules, []);
    await result.recheck();
    await writeFile(data.spec, await readFile(data.spec, 'utf8') + '\n');
    await assert.rejects(result.recheck(), /TLC306.*changed during verification/);
  } finally { await rm(data.directory, { recursive: true, force: true }); }
});

for (const [name, text] of [
  ['helper definitions', source.replace('PartitionFamilies ==', 'Helper == 1\nPartitionFamilies ==')],
  ['computed metadata fields', source.replace('version |-> 1', 'version |-> IF TRUE THEN 1 ELSE 1')],
  ['unknown root members', source.replace('version |-> 1', 'extra |-> "unknown", version |-> 1')],
  ['unknown family members', source.replace('key |-> <<"key">>', 'owner |-> "caller", key |-> <<"key">>')],
  ['unsupported calendar', source.replace('utc-micros-nonnegative-day-v1', 'local-time')],
  ['unsupported version', source.replace('version |-> 1', 'version |-> 2')],
  ['empty key tuple', source.replace('<<"key">>', '<<>>')],
  ['more than three key fields', source.replace('<<"key">>', '<<"a", "b", "c", "d">>')],
  ['duplicate key fields', source.replace('<<"key">>', '<<"key", "key">>')],
  ['duplicate dataset literals', source.replace('{"fact"}', '{"fact", "fact"}')],
  ['overlapping datasets across families', source.replace('{"fact"}', '{"a-other"}')],
  ['unsafe dataset components', source.replace('{"fact"}', '{"../fact"}')],
  ['standard module imports', source.replace('PartitionFamilies ==', 'EXTENDS Naturals\nPartitionFamilies ==')],
  ['local module imports', source.replace('PartitionFamilies ==', 'EXTENDS Unavailable\nPartitionFamilies ==')],
  ['extra variable declarations', source.replace('PartitionFamilies ==', 'VARIABLE hidden\nPartitionFamilies ==')],
  ['extra assumptions', source.replace('PartitionFamilies ==', 'ASSUME TRUE\nPartitionFamilies ==')],
  ['duplicate record members', source.replace('version |-> 1', 'version |-> 1, version |-> 1')],
] satisfies [string, string][]) {
  test(`actual literal metadata admission rejects ${name}`, { skip: !jar }, async () => {
    const data = await fixture(text);
    try { await assert.rejects(data.read(), /TLC(?:20[134]|306)/); }
    finally { await rm(data.directory, { recursive: true, force: true }); }
  });
}

test('metadata must remain an original regular file', { skip: !jar || process.platform === 'win32' }, async () => {
  const data = await fixture();
  try {
    const original = join(data.directory, 'Original.tla'); await writeFile(original, source);
    await rm(data.spec); await symlink(original, data.spec);
    await assert.rejects(data.read(), /TLC306.*regular original file/);
  } finally { await rm(data.directory, { recursive: true, force: true }); }
});

test('direct contract parsing rejects family and dataset duplication before backends run', () => {
  const family = { name: 'Fact', key: ['key'], symbol: 'symbol', time: 'time', datasets: ['fact'] };
  const contract = { version: 1, calendar: 'utc-micros-nonnegative-day-v1', families: [family] };
  assert.equal(PartitionContractSchema.safeParse(contract).success, true);
  for (const families of [[family, { ...family, datasets: ['other'] }], [family, { ...family, name: 'OtherFact' }], [{ ...family, key: ['key', 'key'] }]]) assert.equal(PartitionContractSchema.safeParse({ ...contract, families }).success, false);
});
