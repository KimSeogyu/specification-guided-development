import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { lowerSymbolicModel } from '../src/symbolic-lower.js';
import { parseSanyXml } from '../src/sany-xml.js';
import { runSymbolicTlc } from '../src/symbolic-tlc.js';
import { symbolicModel } from '../src/symbolic-types.js';
import { importSymbolicDot, SymbolicWitnessSchema, verifySymbolicWitness } from '../src/symbolic-witness.js';

const jar = process.env.TLA2TOOLS_JAR ? resolve(process.env.TLA2TOOLS_JAR) : undefined;
function graph(labels: string[], edges: [number, string, number][], initial = [0]): string {
  return 'strict digraph DiskGraph { subgraph cluster_graph {\n' + labels.map((label, index) =>
    `${index + 100} [label=${JSON.stringify(label)}${initial.includes(index) ? ',style=filled' : ''}];`).join('\n') + '\n' +
    edges.map(([from, action, to]) => `${from + 100} -> ${to + 100} [label=${JSON.stringify(action)}];`).join('\n') + '\n}}';
}

test('symbolic DOT preserves all valuations and distinguishes model atoms from scalar spellings', () => {
  const dot = graph([
    '/\\ phase = "v1"\n/\\ stored = "none"\n/\\ count = -9007199254740993\n/\\ flag = FALSE',
    '/\\ phase = "v1"\n/\\ stored = v1\n/\\ count = -9007199254740993\n/\\ flag = TRUE',
    '/\\ phase = "v1"\n/\\ stored = v2\n/\\ count = -9007199254740993\n/\\ flag = TRUE',
  ], [[0, 'Write', 1], [1, 'Write', 2], [2, 'Same', 2], [2, 'Same', 2]]);
  const witness = importSymbolicDot({ dot, name: 'Exact', domain: 'Values', atoms: ['v2', 'v1'] });
  assert.equal(witness.nodes.length, 3);
  assert.equal(witness.edges.length, 4);
  assert.equal(witness.source.edgeCount, 4);
  assert.deepEqual(witness.variables, ['count', 'flag', 'phase', 'stored']);
  assert.deepEqual(witness.atoms, ['v1', 'v2']);
  assert.ok(witness.nodes.some(node => node.values.stored?.kind === 'string' && node.values.stored.value === 'none'));
  assert.ok(witness.nodes.some(node => node.values.stored?.kind === 'data' && node.values.stored.domain === 'Values' && node.values.stored.value === 'v1'));
  assert.ok(witness.nodes.every(node => node.values.phase?.kind === 'string' && node.values.phase.value === 'v1'));
  assert.ok(witness.nodes.every(node => node.values.count?.value === '-9007199254740993'));
});

test('symbolic DOT rejects incomplete, duplicated, unreachable, compound, or unknown valuations', () => {
  const complete = '/\\ stored = "none"\n/\\ phase = "absent"';
  for (const dot of [
    graph([complete, '/\\ phase = "present"'], [[0, 'Write', 1]]),
    graph([complete, complete], [[0, 'Write', 1]]),
    graph([complete, '/\\ stored = v1\n/\\ phase = "present"'], []),
    graph(['/\\ stored = {v1}'], []),
    graph(['/\\ stored = unconfigured'], []),
    graph(['/\\ stored = v1\n/\\ stored = v2'], []),
    graph([complete], [[0, 'Write(v1)', 0]]),
  ]) assert.throws(() => importSymbolicDot({ dot, name: 'Bad', domain: 'Values', atoms: ['v1', 'v2'] }), /TLC20[5]|TLC303/);
  assert.throws(() => importSymbolicDot({ dot: graph([complete], []), name: 'Bad', domain: 'Values', atoms: ['v1', 'v1'] }), /TLC303/);
});

test('public witness JSON schema rejects corrupted inventories, references, atom typing, counts, and unreachable states', () => {
  const witness = importSymbolicDot({
    dot: graph(['/\\ phase = "absent"\n/\\ stored = "none"', '/\\ phase = "present"\n/\\ stored = v1'], [[0, 'Write', 1]]),
    name: 'JsonWitness', domain: 'Values', atoms: ['v1', 'v2'],
  });
  assert.deepEqual(SymbolicWitnessSchema.parse(JSON.parse(JSON.stringify(witness))), witness);
  const first = witness.nodes[0];
  const second = witness.nodes[1];
  const initial = witness.initial[0];
  assert.ok(first && second && initial);
  const corruptions: unknown[] = [
    { ...witness, nodes: [first, { ...second, id: first.id }] },
    { ...witness, initial: ['unknown'] },
    { ...witness, initial: [initial, initial] },
    { ...witness, variables: [...witness.variables, 'stored'] },
    { ...witness, nodes: [{ ...first, values: { phase: first.values.phase } }, second] },
    { ...witness, nodes: [{ ...first, values: { ...first.values, extra: { kind: 'boolean', value: false } } }, second] },
    { ...witness, nodes: [first, { ...second, values: { ...second.values, stored: { kind: 'data', domain: 'Other', value: 'v1' } } }] },
    { ...witness, nodes: [first, { ...second, values: { ...second.values, stored: { kind: 'data', domain: 'Values', value: 'unknown' } } }] },
    { ...witness, atoms: ['v1', 'v1'] },
    { ...witness, atoms: ['v1', 'TRUE'] },
    { ...witness, source: { ...witness.source, stateCount: 7 } },
    { ...witness, source: { ...witness.source, edgeCount: 7 } },
    { ...witness, nodes: [first, { ...second, values: Object.fromEntries(Object.entries(first.values).reverse()) }] },
    { ...witness, edges: [{ from: initial, event: 'Write', to: 'unknown' }] },
    { ...witness, edges: [], source: { ...witness.source, edgeCount: 0 } },
    { ...witness, omittedStatePolicy: true },
  ];
  for (const corruption of corruptions) assert.equal(SymbolicWitnessSchema.safeParse(corruption).success, false);
});

async function fixture(source: string, configuration: string): Promise<{ spec: string; config: string; dispose: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'sgd-witness-test-'));
  const spec = join(directory, 'ManifestWrite.tla');
  const config = join(directory, 'ManifestWrite.cfg');
  await writeFile(spec, source);
  await writeFile(config, configuration);
  return { spec, config, dispose: () => rm(directory, { recursive: true, force: true }) };
}

for (const count of [2, 3]) test(`real original-action oracle checks every ManifestWrite state/input with ${count} model atoms`, { skip: !jar }, async () => {
  assert.ok(jar);
  const source = await readFile(new URL('../examples/fact-merge/ManifestWrite.tla', import.meta.url), 'utf8');
  const originalConfig = await readFile(new URL('../examples/fact-merge/ManifestWrite.cfg', import.meta.url), 'utf8');
  const files = await fixture(source, originalConfig.replace('{v1, v2}', `{${Array.from({ length: count }, (_, index) => `v${index + 1}`).join(', ')}}`));
  try {
    const run = await runSymbolicTlc({ ...files, jar });
    const model = lowerSymbolicModel({ name: 'ManifestWrite', semantic: parseSanyXml(run.xml), config: run.config });
    const verified = await verifySymbolicWitness({ model, run, ...files, jar });
    assert.equal(verified.evidence.kind, 'tlc-finite-input-oracle');
    assert.equal(verified.evidence.scope, 'configured-reachable-state-input-product');
    assert.equal(verified.evidence.stateCount, 1 + count + count * (count - 1));
    assert.equal(verified.evidence.checkedCases, verified.witness.nodes.length * count);
    assert.equal(verified.evidence.acceptedCases, verified.evidence.checkedCases);
    assert.equal(verified.evidence.disabledCases, 0);
    assert.match(verified.oracleLog, /Model checking completed\. No error has been found\./);
    assert.ok(verified.oracleDot.includes('before'));
    assert.ok(verified.oracleDot.includes('after'));
    assert.equal(await readFile(files.spec, 'utf8'), source);
    if (count === 3) {
      const { source: _source, ...program } = model;
      const omittedAction = symbolicModel({ ...program, branches: model.branches.filter(branch => branch.action !== 'Same') });
      await assert.rejects(verifySymbolicWitness({ model: omittedAction, run, ...files, jar }), /TLC303.*omits an action/);
      const wrongEquality = symbolicModel({ ...program, branches: model.branches.map(branch => branch.action === 'Same'
        ? { ...branch, guard: { kind: 'boolean', value: false } } : branch) });
      await assert.rejects(verifySymbolicWitness({ model: wrongEquality, run, ...files, jar }), /TLC303.*disables an original enabled/);
      const wrongUpdate = symbolicModel({ ...program, branches: model.branches.map(branch => branch.action === 'Clash'
        ? { ...branch, updates: { ...branch.updates, stored: { kind: 'input' } } } : branch) });
      await assert.rejects(verifySymbolicWitness({ model: wrongUpdate, run, ...files, jar }), /TLC303.*complete successor differs/);
      const wrongRejectedUpdate = symbolicModel({ ...program, branches: model.branches.map(branch => branch.action === 'Clash'
        ? { ...branch, updates: { ...branch.updates, rejected: { kind: 'state', variable: 'stored' } } } : branch) });
      await assert.rejects(verifySymbolicWitness({ model: wrongRejectedUpdate, run, ...files, jar }), /TLC303.*complete successor differs/);
      const forgetThirdValue = symbolicModel({ ...program, branches: model.branches.flatMap(branch => branch.action !== 'Clash' ? [branch] : [
        { ...branch, guard: { kind: 'and', terms: [branch.guard, { kind: 'equal', left: { kind: 'state', variable: 'phase' }, right: { kind: 'literal', value: { kind: 'string', value: 'present' } } }] } },
        { ...branch, guard: { kind: 'and', terms: [branch.guard, { kind: 'equal', left: { kind: 'state', variable: 'phase' }, right: { kind: 'literal', value: { kind: 'string', value: 'conflict' } } }] },
          updates: { ...branch.updates, rejected: { kind: 'state', variable: 'rejected' } } },
      ]) });
      await assert.rejects(verifySymbolicWitness({ model: forgetThirdValue, run, ...files, jar }), /TLC303.*complete successor differs/);
    }
  } finally { await files.dispose(); }
});

const once = String.raw`---- MODULE ManifestWrite ----
CONSTANT Values
VARIABLE stored
SGDOracle0Input == "occupied name"
Init == stored = "none"
Write(v) == /\ stored = "none" /\ stored' = v
Hidden(v) == stored' = v
Next == \E v \in Values: Write(v)
Spec == Init /\ [][Next]_stored
====
`;
const onceConfig = 'SPECIFICATION Spec\nCONSTANT Values = {v1, v2}\nCHECK_DEADLOCK FALSE\n';

test('real oracle compares disabled inputs and deterministically avoids semantic identifier collisions', { skip: !jar }, async () => {
  assert.ok(jar);
  const files = await fixture(once, onceConfig);
  try {
    const run = await runSymbolicTlc({ ...files, jar });
    const model = lowerSymbolicModel({ name: 'Once', semantic: parseSanyXml(run.xml), config: run.config });
    const verified = await verifySymbolicWitness({ model, run, ...files, jar });
    assert.equal(verified.evidence.checkedCases, 6);
    assert.equal(verified.evidence.acceptedCases, 2);
    assert.equal(verified.evidence.disabledCases, 4);
    assert.match(verified.oracleDot, /SGDOracle1Input/);
    const { source: _source, ...program } = model;
    const alwaysEnabled = symbolicModel({ ...program, branches: model.branches.map(branch => ({ ...branch, guard: { kind: 'boolean', value: true } })) });
    await assert.rejects(verifySymbolicWitness({ model: alwaysEnabled, run, ...files, jar }), /TLC303.*complete successor differs/);
    const originalBranch = model.branches[0];
    assert.ok(originalBranch);
    const extraAction = symbolicModel({ ...program, branches: [...model.branches,
      { ...originalBranch, action: 'Hidden', guard: { kind: 'boolean', value: true } }] });
    await assert.rejects(verifySymbolicWitness({ model: extraAction, run, ...files, jar }), /TLC303.*outside the original configured Next relation/);
    await writeFile(files.spec, once + '\\* changed after completed base run\n');
    await assert.rejects(verifySymbolicWitness({ model, run, ...files, jar }), /TLC303.*differs from the completed base run/);
  } finally { await files.dispose(); }
});

test('real base verification rejects a safety defect before accepting any oracle evidence', { skip: !jar }, async () => {
  assert.ok(jar);
  const source = await readFile(new URL('../examples/fact-merge/ManifestWrite.tla', import.meta.url), 'utf8');
  const configuration = await readFile(new URL('../examples/fact-merge/ManifestWrite.cfg', import.meta.url), 'utf8');
  const files = await fixture(source.replace('/\\ UNCHANGED stored', "/\\ stored' = v"), configuration);
  try { await assert.rejects(runSymbolicTlc({ ...files, jar }), /TLC204/); }
  finally { await files.dispose(); }
});

test('real oracle rejects multiple original enabled actions for an exact state/input', { skip: !jar }, async () => {
  assert.ok(jar);
  const files = await fixture(once.replace('Next == \\E v \\in Values: Write(v)', 'Next == \\E v \\in Values: Write(v) \\/ Hidden(v)'), onceConfig);
  try {
    const run = await runSymbolicTlc({ ...files, jar });
    const model = lowerSymbolicModel({ name: 'Ambiguous', semantic: parseSanyXml(run.xml), config: run.config });
    await assert.rejects(verifySymbolicWitness({ model, run, ...files, jar }), /TLC303.*multiple enabled action\/results/);
  } finally { await files.dispose(); }
});
