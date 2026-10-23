import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { importFiniteDot } from '../src/finite-dot.js';
import { runControlledTlc } from '../src/finite-tlc.js';
import type { ExactFiniteAutomaton } from '../src/finite-types.js';
import { validatePartitionControl, validatePartitionControlSource, validatePartitionPlan } from '../src/partition-composition.js';
import type { PartitionPlan } from '../src/partition-types.js';
import { inspectSymbolicOrbits, stepSymbolic, type SymbolicState } from '../src/symbolic-semantics.js';
import { symbolicModel, type SymbolicExpression, type SymbolicModelV2 } from '../src/symbolic-types.js';
import { partitionControl, partitionPlan, partitionRowModel } from './partition-fixtures.js';

const jar = process.env.TLA2TOOLS_JAR ? resolve(process.env.TLA2TOOLS_JAR) : undefined;
const state = (variable: string): SymbolicExpression => ({ kind: 'state', variable });
const scalar = (value: string): SymbolicExpression => ({ kind: 'literal', value: { kind: 'string', value } });
const input = (parameter: string): SymbolicExpression => ({ kind: 'input', parameter });
function changedRow(change: (program: Omit<SymbolicModelV2, 'source'>) => void): SymbolicModelV2 {
  const { source: _source, ...program } = partitionRowModel();
  change(program);
  return symbolicModel(program);
}
function changedBranch(action: string, change: (branch: SymbolicModelV2['branches'][number]) => void): SymbolicModelV2 {
  return changedRow(program => { const branch = program.branches.find(candidate => candidate.action === action); assert.ok(branch); change(branch); });
}
function changeEdges(graph: ExactFiniteAutomaton, change: (edges: ExactFiniteAutomaton['edges']) => void): ExactFiniteAutomaton {
  change(graph.edges); graph.source.edgeCount = graph.edges.length; return graph;
}
function controlNode(graph: ExactFiniteAutomaton, phase: string, inserted: boolean, conflict: boolean): string {
  const node = graph.nodes.find(node => node.values.phase?.value === phase && node.values.hasInserted?.value === inserted && node.values.hasConflict?.value === conflict);
  assert.ok(node); return node.id;
}

test('partition plans admit a complete row fold and retain Same and repeated Clash observations', () => {
  const plan = validatePartitionPlan(partitionPlan());
  assert.equal(plan.runtimeProfile, 'unbound-partition-v1');
  const proof = inspectSymbolicOrbits(plan.row.model);
  assert.ok(proof.edges.some(edge => edge.action === 'Same' && edge.from === edge.to));
  assert.ok(proof.edges.some(edge => edge.action === 'Clash' && edge.from === edge.to));
  let rowState: SymbolicState = plan.row.model.initial;
  const effects: string[] = [];
  for (const frame of [{ v: 'A', p: 'r1' }, { v: 'B', p: 'r2' }, { v: 'B', p: 'r2' }, { v: 'A', p: 'r3' }]) {
    const result = stepSymbolic(plan.row.model, rowState, frame);
    assert.equal(result.kind, 'accepted'); if (result.kind !== 'accepted') throw new Error('Missing admitted row');
    rowState = result.state; effects.push(result.action);
  }
  assert.deepEqual(effects, ['Insert', 'Clash', 'Clash', 'Same']);
  assert.deepEqual(rowState.storedProvenance, { kind: 'data', domain: 'Receipts', value: 'r1' });
  assert.deepEqual(rowState.rejectedProvenance, { kind: 'data', domain: 'Receipts', value: 'r2' });
});

for (const [name, model] of [
  ['action names cannot relabel row outcomes', () => changedRow(program => { for (const branch of program.branches) branch.action = branch.action === 'Insert' ? 'Clash' : branch.action === 'Clash' ? 'Insert' : branch.action; })],
  ['Same cannot clear the rejected row', () => changedBranch('Same', branch => { branch.updates.rejected = scalar('none'); branch.updates.rejectedProvenance = scalar('none'); branch.updates.phase = scalar('present'); })],
  ['Same cannot replace retained receipt metadata', () => changedBranch('Same', branch => { branch.updates.stored = input('v'); branch.updates.storedProvenance = input('p'); })],
  ['Clash cannot replace the original stored row', () => changedBranch('Clash', branch => { branch.updates.stored = input('v'); branch.updates.storedProvenance = input('p'); })],
  ['Clash must retain the complete incoming rejected row', () => changedBranch('Clash', branch => { branch.updates.rejected = state('stored'); branch.updates.rejectedProvenance = state('storedProvenance'); })],
  ['Insert cannot discard the incoming row', () => changedBranch('Insert', branch => { branch.updates.stored = scalar('none'); branch.updates.storedProvenance = scalar('none'); })],
  ['provenance-dependent admission cannot disable equal payloads', () => changedBranch('Same', branch => { branch.guard = { kind: 'and', terms: [branch.guard, { kind: 'not-equal', left: input('p'), right: state('storedProvenance') }] }; })],
  ['all unequal payload inputs must remain admitted', () => changedBranch('Clash', branch => { branch.guard = { kind: 'boolean', value: false }; })],
  ['unused action declarations cannot widen the source vocabulary', () => changedRow(program => { const branch = program.branches[0]; assert.ok(branch); program.branches.push({ ...branch, action: 'Invented', guard: { kind: 'boolean', value: false } }); })],
] satisfies [string, () => SymbolicModelV2][]) {
  test(`the complete row role gate rejects: ${name}`, () => {
    const plan = partitionPlan(); plan.row.model = model();
    assert.throws(() => validatePartitionPlan(plan), /TLC30[1256]/);
  });
}

test('partition row role validation does not project away an extra model variable', () => {
  const plan = partitionPlan();
  plan.row.model = changedRow(program => {
    program.variables.push('hidden'); program.initial.hidden = { kind: 'boolean', value: false };
    for (const branch of program.branches) branch.updates.hidden = state('hidden');
  });
  assert.throws(() => validatePartitionPlan(plan), /TLC306.*only phase/);
});

test('all supported tuple widths use audited raw i64 payload fields', () => {
  for (const key of [['key'], ['key', 'value'], ['key', 'value', 'time']]) {
    const plan = partitionPlan(); const family = plan.contract.families[0]; assert.ok(family); family.key = key;
    assert.deepEqual(validatePartitionPlan(plan).contract.families[0]?.key, key);
  }
});
for (const [name, change] of [
  ['normalized u32 schema key', (plan: PartitionPlan) => { const family = plan.contract.families[0]; assert.ok(family); family.key = ['schema']; }],
  ['provenance-only key', (plan: PartitionPlan) => { const family = plan.contract.families[0]; assert.ok(family); family.key = ['received']; }],
  ['unknown key getter', (plan: PartitionPlan) => { const family = plan.contract.families[0]; assert.ok(family); family.key = ['missing']; }],
  ['non-string symbol', (plan: PartitionPlan) => { const family = plan.contract.families[0]; assert.ok(family); family.symbol = 'key'; }],
  ['non-i64 calendar time', (plan: PartitionPlan) => { const family = plan.contract.families[0]; assert.ok(family); family.time = 'schema'; }],
  ['unmapped source Fact', (plan: PartitionPlan) => { const family = plan.contract.families[0]; assert.ok(family); family.name = 'Unaudited'; }],
  ['omitted source Fact family', (plan: PartitionPlan) => { const fact = plan.row.plan.facts[0]; const binding = plan.row.binding.source.facts[0]; assert.ok(fact && binding); plan.row.plan.facts.push({ ...fact, name: 'OtherFact', rustPath: 'crate::facts::OtherFact' }); plan.row.binding.source.facts.push({ ...binding, name: 'OtherFact', rustPath: 'crate::facts::OtherFact' }); }],
] satisfies [string, (plan: PartitionPlan) => void][]) {
  test(`partition source projections refuse ${name}`, () => { const plan = partitionPlan(); change(plan); assert.throws(() => validatePartitionPlan(plan), /TLC306/); });
}

test('the exact controller keeps all flags, close choices, and one consumption per ready state', () => {
  const graph = partitionControl();
  assert.deepEqual(validatePartitionControl(graph), graph);
  const duplicate = graph.edges[0]; assert.ok(duplicate);
  assert.equal(validatePartitionControl(changeEdges(graph, edges => edges.push({ ...duplicate }))).edges.length, 21);
});
for (const [name, mutate] of [
  ['omitted successful Same self edge', (graph: ExactFiniteAutomaton) => changeEdges(graph, edges => { const index = edges.findIndex(edge => edge.event === 'Same'); edges.splice(index, 1); })],
  ['wrong close choice after no insertion', (graph: ExactFiniteAutomaton) => changeEdges(graph, edges => { const edge = edges.find(edge => edge.event === 'CloseNoop'); assert.ok(edge); edge.event = 'CloseWrite'; })],
  ['forgotten sticky insertion after a conflict', (graph: ExactFiniteAutomaton) => changeEdges(graph, edges => { const edge = edges.find(edge => edge.from === controlNode(graph, 'Open', true, false) && edge.event === 'Clash'); assert.ok(edge); edge.to = controlNode(graph, 'Open', false, true); })],
  ['caller observation after close', (graph: ExactFiniteAutomaton) => changeEdges(graph, edges => { const from = controlNode(graph, 'ReadyWrite', true, false); edges.push({ from, to: from, event: 'Same' }); })],
  ['reopening a consumed controller', (graph: ExactFiniteAutomaton) => changeEdges(graph, edges => { edges.push({ from: controlNode(graph, 'Consumed', false, false), to: controlNode(graph, 'Open', false, false), event: 'Same' }); })],
  ['ambiguous event successor', (graph: ExactFiniteAutomaton) => changeEdges(graph, edges => { edges.push({ from: controlNode(graph, 'Open', false, false), to: controlNode(graph, 'Open', true, false), event: 'Same' }); })],
] satisfies [string, (graph: ExactFiniteAutomaton) => ExactFiniteAutomaton][]) {
  test(`the full controller gate rejects ${name}`, () => assert.throws(() => validatePartitionControl(mutate(partitionControl())), /TLC(?:204|306)/));
}

test('projecting controller flags away cannot create a closed fold authority', () => {
  const graph = partitionControl();
  graph.variables.push({ name: 'unmodeled', kind: 'boolean' });
  for (const node of graph.nodes) node.values.unmodeled = { kind: 'boolean', value: false };
  assert.throws(() => validatePartitionControl(graph), /TLC306.*exactly phase/);
});

async function checkedControl(text?: string, configuration?: string) {
  assert.ok(jar); const directory = await mkdtemp(join(tmpdir(), 'sgd-partition-control-source-'));
  try {
    const source = text ?? await readFile(resolve('examples/partition-control/model.tla'), 'utf8');
    const config = configuration ?? await readFile(resolve('examples/partition-control/model.cfg'), 'utf8');
    const spec = join(directory, 'model.tla'); const path = join(directory, 'model.cfg');
    await writeFile(spec, source); await writeFile(path, config);
    return await runControlledTlc({ spec, config: path, jar }, 'finite-owned-v1');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('actual controlled TLC source and its full graph pass independent partition obligations', { skip: !jar }, async () => {
  const run = await checkedControl();
  validatePartitionControlSource(run);
  validatePartitionControl(importFiniteDot({ dot: run.dot, name: 'PartitionControl' }));
});

test('source obligation checking resolves a transparent SANY helper instead of requiring original text', { skip: !jar }, async () => {
  const source = await readFile(resolve('examples/partition-control/model.tla'), 'utf8');
  const aliased = source.replace('ConflictSticky ==', 'ConflictStickyBody ==').replace(/^=+/m, 'ConflictSticky == ConflictStickyBody\n\n====');
  const run = await checkedControl(aliased);
  validatePartitionControlSource(run);
  validatePartitionControl(importFiniteDot({ dot: run.dot, name: 'PartitionControl' }));
});
for (const obligation of ['TypeOK', 'CloseAdmission', 'CloseChoice', 'NoInputAfterClose', 'SingleConsumption', 'ConflictSticky', 'InsertSticky', 'NoReopen']) {
  test(`a passing TLC run cannot hide weakened ${obligation} == TRUE`, { skip: !jar }, async () => {
    const source = await readFile(resolve('examples/partition-control/model.tla'), 'utf8');
    const replaced = source.replace(new RegExp(`^${obligation} ==[\\s\\S]*?(?=^[A-Za-z][A-Za-z0-9]* ==|^=+)`, 'm'), `${obligation} == TRUE\n\n`);
    assert.notEqual(replaced, source);
    const run = await checkedControl(replaced);
    assert.throws(() => validatePartitionControlSource(run), new RegExp(`TLC306.*${obligation}`));
    // The behavior still satisfies the complete graph laws; source admission is a separate check.
    validatePartitionControl(importFiniteDot({ dot: run.dot, name: 'PartitionControl' }));
  });
}

test('partition source configuration must retain every required obligation', { skip: !jar }, async () => {
  const configuration = await readFile(resolve('examples/partition-control/model.cfg'), 'utf8');
  const run = await checkedControl(undefined, configuration.replace(' ConflictSticky', '').replace('PROPERTIES ConflictSticky ', 'PROPERTIES '));
  assert.throws(() => validatePartitionControlSource(run), /TLC306.*configuration/);
});
