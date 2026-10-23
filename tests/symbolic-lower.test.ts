import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runSymbolicTlc } from '../src/symbolic-tlc.js';
import { parseSanyXml } from '../src/sany-xml.js';
import { lowerSymbolicModel } from '../src/symbolic-lower.js';
import { inspectSymbolicOrbits, stepSymbolic } from '../src/symbolic-semantics.js';
import { symbolicModel } from '../src/symbolic-types.js';

const jar = process.env.TLA2TOOLS_JAR;
async function fixture(work: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'sgd-symbolic-lower-'));
  try { await cp(resolve('examples/fact-merge'), directory, { recursive: true }); await work(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function compile(directory: string) {
  const result = await runSymbolicTlc({ spec: join(directory, 'ManifestWrite.tla'), config: join(directory, 'ManifestWrite.cfg'), jar: jar! });
  return lowerSymbolicModel({ name: 'ManifestWrite', semantic: parseSanyXml(result.xml), config: result.config });
}

test('actual source lowers all variables, domain guards, updates and square properties without graph-law inference', { skip: !jar }, async () => fixture(async directory => {
  const model = await compile(directory);
  assert.deepEqual(model.variables, ['phase', 'rejected', 'stored']);
  assert.deepEqual(model.input, { domain: 'Values', parameter: 'v', next: 'Next' });
  assert.equal(model.checkDeadlock, true);
  assert.equal(model.actionProperties[0]?.kind, 'square-action');
  assert.ok(model.branches.every(branch => branch.guard.kind === 'and' && branch.guard.terms[0]?.kind === 'in-domain'));
  const proof = inspectSymbolicOrbits(model);
  assert.equal(proof.states.length, 3);
  let state = model.initial;
  const actions: string[] = [];
  for (const input of ['A', 'B', 'C', 'A']) {
    const next = stepSymbolic(model, state, input); assert.equal(next.kind, 'accepted');
    if (next.kind !== 'accepted') throw new Error('expected complete merge input');
    state = next.state; actions.push(next.action);
  }
  assert.deepEqual(actions, ['Insert', 'Clash', 'Clash', 'Same']);
  assert.deepEqual(state.stored, { kind: 'data', domain: 'Values', value: 'A' });
  assert.deepEqual(state.rejected, { kind: 'data', domain: 'Values', value: 'C' });
  assert.equal(stepSymbolic(model, model.initial, 'none').kind, 'accepted');
}));

test('UID substitution handles reused and renamed parameter names through value and predicate helpers', { skip: !jar }, async () => fixture(async directory => {
  const path = join(directory, 'ManifestWrite.tla');
  const original = await readFile(path, 'utf8');
  const changed = original.replace('Insert(v) ==', 'Identity(v) == v\nEqual(v, w) == v = w\n\nInsert(v) ==')
    .replace("stored' = v", "stored' = Identity(v)")
    .replace('/\\ v = stored', '/\\ Equal(v, stored)')
    .replace(/\bv\b/g, 'incoming');
  await writeFile(path, changed);
  const model = await compile(directory); inspectSymbolicOrbits(model);
  assert.equal(model.input.parameter, 'incoming');
  const first = stepSymbolic(model, model.initial, 'not-a-fixture-atom');
  assert.equal(first.kind, 'accepted');
  if (first.kind === 'accepted') {
    assert.deepEqual(first.state.stored, { kind: 'data', domain: 'Values', value: 'not-a-fixture-atom' });
    const repeated = stepSymbolic(model, first.state, 'not-a-fixture-atom');
    assert.equal(repeated.kind, 'accepted'); if (repeated.kind === 'accepted') assert.equal(repeated.action, 'Same');
  }
}));

test('overlapping pure guard disjunctions remain one logical predicate rather than fake action choices', { skip: !jar }, async () => fixture(async directory => {
  const path = join(directory, 'ManifestWrite.tla');
  const source = await readFile(path, 'utf8');
  await writeFile(path, source.replaceAll('phase \\in {"present", "conflict"}', '(phase \\in {"present", "conflict"} \\/ stored \\in Values)'));
  const model = await compile(directory);
  assert.equal(model.branches.length, 3);
  assert.equal(inspectSymbolicOrbits(model).states.length, 3);
}));

test('source profile rejects hidden unsupported operators, unconstrained and duplicate updates, and primed RHS', { skip: !jar }, async () => fixture(async directory => {
  const path = join(directory, 'ManifestWrite.tla');
  const source = await readFile(path, 'utf8');
  const cases = [
    source.replace('EXTENDS Integers', 'EXTENDS Integers, FiniteSets').replace('Insert(v) ==', 'Allowed(v) == Cardinality(Values) = 2\n\nInsert(v) ==').replace('/\\ v \\in Values', '/\\ Allowed(v) /\\ v \\in Values'),
    source.replace('/\\ UNCHANGED stored', '/\\ stored = stored'),
    source.replace("/\\ stored' = v", "/\\ stored' = v /\\ stored' = v"),
    source.replace("/\\ rejected' = v", "/\\ rejected' = stored'"),
  ];
  for (const changed of cases) {
    await writeFile(path, changed);
    try { const model = await compile(directory); assert.fail(`unsupported source was accepted: ${model.name}`); }
    catch (error) { assert.match(String(error), /TLC30[12]|TLC204/); }
  }
}));

test('canonical semantic identity is independent of object property insertion order', { skip: !jar }, async () => fixture(async directory => {
  const model = await compile(directory);
  const { source: _source, ...program } = model;
  const reordered = symbolicModel({ ...program, initial: Object.fromEntries(Object.entries(program.initial).reverse()), branches: program.branches.map(branch => ({ ...branch, updates: Object.fromEntries(Object.entries(branch.updates).reverse()) })) });
  assert.equal(reordered.source.semanticSha256, model.source.semanticSha256);
}));
