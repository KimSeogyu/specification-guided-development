import assert from 'node:assert/strict';
import test from 'node:test';
import { compareRequiredSymbolicProperties } from '../src/contract-properties.js';
import { symbolicModel, type SymbolicProgram } from '../src/symbolic-types.js';
import { verifySymbolicErasure } from '../src/symbolic-refinement.js';

function program(): SymbolicProgram {
  return {
    version: 1, kind: 'symbolic-owned', name: 'Acceptance', checkDeadlock: true,
    variables: ['active'], input: { parameter: 'value', domain: 'Values', next: 'Next' },
    initial: { active: { kind: 'boolean', value: false } },
    branches: [{ action: 'Insert', guard: { kind: 'boolean', value: true },
      updates: { active: { kind: 'literal', value: { kind: 'boolean', value: true } } }, source: null }],
    invariants: [{ name: 'Typed', predicate: { kind: 'member', value: { kind: 'state', variable: 'active' },
      elements: [{ kind: 'boolean', value: false }, { kind: 'boolean', value: true }] } }],
    actionProperties: [{ kind: 'square-action', name: 'Retained', predicate: { kind: 'implies',
      left: { kind: 'equal', left: { kind: 'state', variable: 'active' }, right: { kind: 'literal', value: { kind: 'boolean', value: true } } },
      right: { kind: 'equal', left: { kind: 'next-state', variable: 'active' }, right: { kind: 'literal', value: { kind: 'boolean', value: true } } } } }],
  };
}

test('retains lowered properties while explicitly withholding provenance and refinement claims', () => {
  const baseline = symbolicModel(program());
  const result = compareRequiredSymbolicProperties({ baseline, candidate: baseline });
  assert.deepEqual(result.invariants, ['Typed']);
  assert.deepEqual(result.actionProperties, ['Retained']);
  assert.equal(result.sourceProvenance, 'not-established');
  assert.equal(result.behavioralRefinement, 'not-established');
  assert.equal(result.independentlySelectedBaseline, 'not-established');
});

test('rejects deleted selected properties and same-name TRUE replacements', () => {
  const original = program();
  const baseline = symbolicModel(original);
  for (const candidate of [
    symbolicModel({ ...original, invariants: [] }),
    symbolicModel({ ...original, actionProperties: [] }),
    symbolicModel({ ...original, invariants: [{ name: 'Typed', predicate: { kind: 'boolean', value: true } }] }),
    symbolicModel({ ...original, actionProperties: [{ kind: 'square-action', name: 'Retained', predicate: { kind: 'boolean', value: true } }] }),
  ]) assert.throws(() => compareRequiredSymbolicProperties({ baseline, candidate }), /TLC310/);
});

test('rejects changed state tuple and disabled baseline deadlock check', () => {
  const original = program();
  const baseline = symbolicModel(original);
  const extended = symbolicModel({ ...original, variables: ['active', 'extra'],
    initial: { ...original.initial, extra: { kind: 'boolean', value: false } },
    branches: original.branches.map(branch => ({ ...branch, updates: { ...branch.updates, extra: { kind: 'state', variable: 'extra' } } })) });
  assert.throws(() => compareRequiredSymbolicProperties({ baseline, candidate: extended }), /complete state tuple/);
  assert.throws(() => compareRequiredSymbolicProperties({ baseline, candidate: symbolicModel({ ...original, checkDeadlock: false }) }), /deadlock checking/);
});

test('correlated behavior weakening passes property retention but fails fixed-baseline behavior comparison', () => {
  const original = program();
  const baseline = symbolicModel(original);
  const candidate = symbolicModel({ ...original, branches: original.branches.map(branch => ({ ...branch,
    updates: { active: { kind: 'state', variable: 'active' } } })) });
  const binding = { version: 1, variables: { active: 'active' }, inputs: { value: 'value' }, actions: { Insert: 'Insert' } };
  compareRequiredSymbolicProperties({ baseline, candidate });
  verifySymbolicErasure({ abstract: candidate, concrete: candidate, binding });
  assert.throws(() => verifySymbolicErasure({ abstract: baseline, concrete: candidate, binding }), /projected successor differs/);
});
