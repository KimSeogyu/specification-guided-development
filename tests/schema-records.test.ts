import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifySymbolicErasure } from '../src/symbolic-refinement.js';
import { symbolicModel, validateSymbolicModel } from '../src/symbolic-types.js';
import { SymbolicWitnessSchema } from '../src/symbolic-witness.js';
import { ProjectSchema } from '../src/types.js';

function model(variable = 'stored', parameter = 'v', action = 'Write', domain = 'Values') {
  return symbolicModel({
    version: 1, kind: 'symbolic-owned', name: 'RecordBoundary', checkDeadlock: true,
    variables: [variable], input: { parameter, domain, next: 'Next' },
    initial: { [variable]: { kind: 'string', value: 'none' } },
    branches: [{ action, guard: { kind: 'boolean', value: true }, updates: { [variable]: { kind: 'input' } }, source: null }],
    invariants: [], actionProperties: [],
  });
}

function binding(variable = 'stored', parameter = 'v', action = 'Write') {
  return { version: 1, variables: { [variable]: variable }, inputs: { [parameter]: parameter }, actions: { [action]: action } };
}

function ownProto<RecordValue extends object>(record: RecordValue, value: unknown) {
  const result = { ...record };
  Object.defineProperty(result, '__proto__', { value, enumerable: true, configurable: true, writable: true });
  assert.equal(Object.hasOwn(result, '__proto__'), true);
  return result;
}

function witness(name = 'stored') {
  return {
    version: 2, kind: 'symbolic-witness', name: 'RecordWitness', variables: [name],
    domains: { [name]: ['v1', 'v2'] },
    nodes: [{ id: 's0', values: { [name]: { kind: 'string', value: 'none' } } }],
    initial: ['s0'], edges: [], source: { dotSha256: 'a'.repeat(64), stateCount: 1, edgeCount: 0 },
  };
}

function dependencyProject(modules: unknown) {
  return {
    version: 1, name: 'RecordProject', spec: 'RecordProject.tla', config: 'RecordProject.cfg',
    stateVariable: 'phase', targets: ['typescript'], binding: { kind: 'dependency', modules },
  };
}

test('symbolic validation refuses an own __proto__ initial value instead of dropping it under the original digest', () => {
  const valid = model();
  assert.deepEqual(validateSymbolicModel(valid), valid);
  const forged = { ...valid, initial: ownProto(valid.initial, { kind: 'string', value: 'forged' }) };
  assert.equal(forged.source.semanticSha256, valid.source.semanticSha256);
  assert.throws(() => validateSymbolicModel(forged), /TLC301/);
});

test('symbolic validation refuses an own __proto__ update instead of dropping it under the original digest', () => {
  const valid = model();
  const forged = { ...valid, branches: valid.branches.map(branch => ({ ...branch, updates: ownProto(branch.updates, { kind: 'input' }) })) };
  assert.equal(forged.source.semanticSha256, valid.source.semanticSha256);
  assert.throws(() => validateSymbolicModel(forged), /TLC301/);
});

for (const field of ['variables', 'inputs', 'actions']) {
  test(`enabled-input erasure refuses an own __proto__ ${field} mapping instead of certifying a filtered binding`, () => {
    const valid = model();
    const identity = binding();
    assert.ok(verifySymbolicErasure({ abstract: valid, concrete: valid, binding: identity }).acceptedCases > 0);
    const record = field === 'variables' ? identity.variables : field === 'inputs' ? identity.inputs : identity.actions;
    const forged = { ...identity, [field]: ownProto(record, 'forged') };
    assert.throws(() => verifySymbolicErasure({ abstract: valid, concrete: valid, binding: forged }), /TLC304.*invalid erasure binding/);
  });
}

test('witness validation refuses an own __proto__ valuation instead of silently omitting a variable', () => {
  const valid = witness();
  assert.equal(SymbolicWitnessSchema.safeParse(valid).success, true);
  const forged = { ...valid, nodes: valid.nodes.map(node => ({ ...node, values: ownProto(node.values, { kind: 'boolean', value: true }) })) };
  assert.equal(SymbolicWitnessSchema.safeParse(forged).success, false);
});

test('witness validation refuses an own __proto__ domain instead of silently omitting its atoms', () => {
  const valid = witness();
  const forged = { ...valid, domains: ownProto(valid.domains, ['forgedAtom']) };
  assert.equal(SymbolicWitnessSchema.safeParse(forged).success, false);
});

test('dependency project validation refuses an own __proto__ module binding instead of omitting a source location', () => {
  const project = dependencyProject(ownProto({ Main: ['src/main.ts'] }, ['src/forged.ts']));
  assert.equal(ProjectSchema.safeParse(project).success, false);
});

test('enabled-input erasure refuses inherited enumerable mapping entries', () => {
  const valid = model();
  const variables: object = Object.create({ bad: 'stored' });
  Object.defineProperty(variables, 'stored', { value: 'stored', enumerable: true });
  assert.equal(Object.hasOwn(variables, 'bad'), false);
  assert.throws(() => verifySymbolicErasure({ abstract: valid, concrete: valid, binding: { ...binding(), variables } }), /TLC304.*invalid erasure binding/);
});

test('enabled-input erasure retains valid own entries from null-prototype records', () => {
  const valid = model();
  const variables: object = Object.create(null);
  Object.defineProperty(variables, 'stored', { value: 'stored', enumerable: true });
  const result = verifySymbolicErasure({ abstract: valid, concrete: valid, binding: { ...binding(), variables } });
  assert.ok(result.acceptedCases > 0);
  assert.deepEqual(result.binding.variables, { stored: 'stored' });
});

for (const name of ['constructor', 'prototype', 'toString']) {
  test(`record boundaries preserve the supported own key ${name}`, () => {
    const valid = model(name, name, name, name);
    assert.deepEqual(validateSymbolicModel(valid), valid);
    assert.equal(Object.hasOwn(valid.initial, name), true);
    assert.ok(valid.branches.every(branch => Object.hasOwn(branch.updates, name)));
    const identity = binding(name, name, name);
    const erasure = verifySymbolicErasure({ abstract: valid, concrete: valid, binding: identity });
    assert.ok(erasure.acceptedCases > 0);
    assert.deepEqual(erasure.binding, identity);

    const graph = witness(name);
    assert.deepEqual(SymbolicWitnessSchema.parse(graph), graph);
    const project = dependencyProject({ [name]: [`src/${name}.ts`] });
    assert.deepEqual(ProjectSchema.parse(project), project);
  });
}
