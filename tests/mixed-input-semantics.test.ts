import assert from 'node:assert/strict';
import test from 'node:test';
import type { FiniteValue } from '../src/finite-types.js';
import { verifySymbolicErasure } from '../src/symbolic-refinement.js';
import { evaluateGuard, inspectSymbolicOrbits, stepSymbolic } from '../src/symbolic-semantics.js';
import { symbolicFiniteValueKey, symbolicModel, type SymbolicGuard, type SymbolicModelV3 } from '../src/symbolic-types.js';

const literal = (value: string): FiniteValue => ({ kind: 'string', value });
const vocabulary = (values: FiniteValue[]): FiniteValue[] => [...values].sort((a, b) => {
  const left = symbolicFiniteValueKey(a); const right = symbolicFiniteValueKey(b);
  return left < right ? -1 : left > right ? 1 : 0;
});
const events = vocabulary([literal('Commit'), literal('Abort'), literal('Idle')]);

function mixed(values = events): SymbolicModelV3 {
  const first = values[0]; assert.ok(first);
  return symbolicModel({
    version: 3, kind: 'symbolic-owned', name: 'Mixed', checkDeadlock: true,
    variables: ['payload', 'event'], next: 'Next',
    inputs: [{ kind: 'opaque', parameter: 'value', domain: 'Values' }, { kind: 'finite', parameter: 'operation', domain: 'Events', values }],
    initial: { payload: literal('none'), event: first },
    branches: [{ action: 'Dispatch', source: null, guard: { kind: 'boolean', value: true }, updates: {
      payload: { kind: 'input', parameter: 'value' }, event: { kind: 'input', parameter: 'operation' },
    } }],
    invariants: [], actionProperties: [],
  });
}

function program(model: SymbolicModelV3) {
  const { source: _source, ...value } = model;
  return value;
}

const erasureBinding = {
  version: 1, variables: { payload: 'stored', event: 'mode' },
  inputs: { value: 'data', operation: 'op' }, actions: { Write: 'Dispatch' },
};

function concrete(high = mixed()): SymbolicModelV3 {
  const finite = high.inputs.find(input => input.kind === 'finite'); assert.ok(finite && finite.kind === 'finite');
  return symbolicModel({
    version: 3, kind: 'symbolic-owned', name: 'Envelope', checkDeadlock: false,
    variables: ['stored', 'mode', 'receipt'], next: 'Next',
    inputs: [{ kind: 'finite', parameter: 'op', domain: 'Operations', values: finite.values },
      { kind: 'opaque', parameter: 'data', domain: 'Data' }, { kind: 'opaque', parameter: 'metadata', domain: 'Receipts' }],
    initial: { stored: high.initial.payload ?? literal('none'), mode: high.initial.event ?? literal('none'), receipt: literal('none') },
    branches: [{ action: 'Write', source: null, guard: { kind: 'boolean', value: true }, updates: {
      stored: { kind: 'input', parameter: 'data' }, mode: { kind: 'input', parameter: 'op' }, receipt: { kind: 'input', parameter: 'metadata' },
    } }],
    invariants: [], actionProperties: [],
  });
}

test('mixed frames preserve finite strings, booleans and arbitrary precision integers as literals', () => {
  for (const values of [events, [{ kind: 'boolean', value: false }, { kind: 'boolean', value: true }] satisfies FiniteValue[],
    vocabulary([{ kind: 'integer', value: '-9223372036854775809' }, { kind: 'integer', value: '0' }, { kind: 'integer', value: '9223372036854775808' }])]) {
    const model = mixed(values);
    for (const value of values) {
      const result = stepSymbolic(model, model.initial, { value: 'Commit', operation: value });
      assert.equal(result.kind, 'accepted'); if (result.kind !== 'accepted') throw new Error('dispatch missing');
      assert.deepEqual(result.state.event, value);
      assert.notEqual(result.state.event, value);
      assert.deepEqual(result.state.payload, { kind: 'data', domain: 'Values', value: 'Commit' });
    }
    const proof = inspectSymbolicOrbits(model);
    const owned = proof.states.find(state => state.payload?.kind === 'data'); assert.ok(owned);
    assert.deepEqual(new Set(proof.states.filter(state => state.payload?.kind === 'data').map(state => JSON.stringify(state.event))), new Set(values.map(value => JSON.stringify(value))));
    assert.ok(proof.states.every(state => state.event?.kind !== 'data'));
    assert.equal(proof.edges.filter(edge => edge.from === 0).length, values.length);
    assert.equal(proof.edges.filter(edge => edge.from === 1).length, values.length * 2);
  }
});

test('literal spelling never becomes an opaque identity or finite domain tag', () => {
  const model = mixed();
  const result = stepSymbolic(model, model.initial, { value: 'Commit', operation: literal('Commit') });
  assert.equal(result.kind, 'accepted'); if (result.kind !== 'accepted') throw new Error('dispatch missing');
  assert.equal(evaluateGuard({ kind: 'equal', left: { kind: 'state', variable: 'payload' }, right: { kind: 'state', variable: 'event' } }, result.state, null), false);
  assert.equal(evaluateGuard({ kind: 'in-domain', value: { kind: 'state', variable: 'event' }, domain: 'Events' }, result.state, null), false);
  assert.throws(() => stepSymbolic(model, { ...model.initial, payload: { kind: 'data', domain: 'Events', value: 'Commit' } }, { value: 'Commit', operation: literal('Commit') }), /TLC301.*undeclared opaque domain/);
  for (const operation of ['Commit', literal('Unknown'), { kind: 'data', domain: 'Events', value: 'Commit' }, { kind: 'integer', value: '1' }, { kind: 'string', value: '\ud800' }]) {
    assert.throws(() => stepSymbolic(model, model.initial, { value: 'Commit', operation }), /TLC301/);
  }
});

test('two finite inputs form the complete literal product with retained and fresh opaque inputs', () => {
  const source = program(mixed([{ kind: 'boolean', value: false }, { kind: 'boolean', value: true }]));
  const values = vocabulary([{ kind: 'integer', value: '-999999999999999999999' }, { kind: 'integer', value: '0' }, { kind: 'integer', value: '999999999999999999999' }]);
  const model = symbolicModel({ ...source, inputs: [...source.inputs, { kind: 'finite', parameter: 'counter', domain: 'Counters', values }],
    variables: [...source.variables, 'counter'], initial: { ...source.initial, counter: values[0] ?? literal('none') },
    branches: source.branches.map(branch => ({ ...branch, updates: { ...branch.updates, counter: { kind: 'input', parameter: 'counter' } } })),
  });
  const proof = inspectSymbolicOrbits(model);
  assert.equal(proof.states.length, 7);
  assert.equal(proof.edges.filter(edge => edge.from === 0).length, 6);
  const frames = proof.edges.filter(edge => edge.from === 1).map(edge => edge.input);
  assert.equal(frames.length, 12);
  assert.equal(new Set(frames.map(frame => JSON.stringify(frame))).size, 12);
  for (const frame of frames) {
    assert.notEqual(typeof frame, 'string'); if (typeof frame === 'string') throw new Error('named frame missing');
    assert.ok(frame.value === 'a0' || frame.value === 'a1');
    assert.ok(typeof frame.operation === 'object' && frame.operation.kind === 'boolean');
    assert.ok(typeof frame.counter === 'object' && frame.counter.kind === 'integer');
  }
});

test('mixed boundary snapshots reject missing, additional and accessor properties without executing getters', () => {
  const model = mixed();
  let reads = 0;
  const frames = [
    { value: 'A', get operation() { reads++; return literal('Commit'); } },
    { value: 'A', operation: { get kind() { reads++; return 'string'; }, value: 'Commit' } },
    { value: 'A', operation: { kind: 'string', get value() { reads++; return 'Commit'; } } },
  ];
  for (const frame of frames) assert.throws(() => stepSymbolic(model, model.initial, frame), /TLC301.*own data properties/);
  assert.equal(reads, 0);
  for (const frame of [{ value: 'A' }, { value: 'A', operation: literal('Commit'), extra: 'x' },
    { value: 'A', operation: { ...literal('Commit'), extra: true } },
    { value: 'A', operation: Object.assign(literal('Commit'), { [Symbol('hidden')]: 'x' }) },
    { value: 'A', operation: Object.create({ kind: 'string', value: 'Commit' }) }]) {
    assert.throws(() => stepSymbolic(model, model.initial, frame), /TLC301/);
  }
});

test('declared finite inputs distinguish disabled decisions from unknown vocabulary and ambiguous dispatch', () => {
  const model = mixed(); const source = program(model);
  const guard: SymbolicGuard = { kind: 'equal', left: { kind: 'input', parameter: 'operation' }, right: { kind: 'literal', value: literal('Commit') } };
  const branches = source.branches.map(branch => ({ ...branch, guard }));
  const selective = symbolicModel({ ...source, checkDeadlock: false, branches });
  assert.deepEqual(stepSymbolic(selective, selective.initial, { value: 'A', operation: literal('Idle') }), { kind: 'disabled' });
  assert.throws(() => stepSymbolic(selective, selective.initial, { value: 'A', operation: literal('Unknown') }), /TLC301.*vocabulary/);
  const proof = inspectSymbolicOrbits(selective);
  assert.deepEqual(new Set(proof.disabled.map(item => typeof item.input === 'string' ? item.input : JSON.stringify(item.input.operation))), new Set([JSON.stringify(literal('Abort')), JSON.stringify(literal('Idle'))]));
  assert.ok(proof.edges.every(edge => typeof edge.input !== 'string' && JSON.stringify(edge.input.operation) === JSON.stringify(literal('Commit'))));
  const ambiguous = symbolicModel({ ...source, branches: [...branches, ...branches] });
  assert.deepEqual(stepSymbolic(ambiguous, ambiguous.initial, { value: 'A', operation: literal('Commit') }), { kind: 'ambiguous' });
  assert.throws(() => inspectSymbolicOrbits(ambiguous), /TLC302.*more than one symbolic action/);
});

test('mixed orbit checking enforces source invariants and finite-only square-action changes', () => {
  const source = program(mixed());
  const invariant: SymbolicGuard = { kind: 'not-equal', left: { kind: 'state', variable: 'event' }, right: { kind: 'literal', value: literal('Idle') } };
  assert.throws(() => inspectSymbolicOrbits(symbolicModel({ ...source, invariants: [{ name: 'NeverIdle', predicate: invariant }] })), /TLC302.*NeverIdle/);
  const property: SymbolicGuard = { kind: 'implies',
    left: { kind: 'equal', left: { kind: 'state', variable: 'payload' }, right: { kind: 'next-state', variable: 'payload' } },
    right: { kind: 'equal', left: { kind: 'state', variable: 'event' }, right: { kind: 'next-state', variable: 'event' } },
  };
  assert.throws(() => inspectSymbolicOrbits(symbolicModel({ ...source, actionProperties: [{ kind: 'square-action', name: 'PayloadStableKeepsEvent', predicate: property }] })), /TLC302.*PayloadStableKeepsEvent/);
  const stutter = symbolicModel({ ...source, branches: source.branches.map(branch => ({ ...branch, updates: { payload: { kind: 'state', variable: 'payload' }, event: { kind: 'state', variable: 'event' } } })),
    actionProperties: [{ kind: 'square-action', name: 'FalseButUnchanged', predicate: { kind: 'boolean', value: false } }],
  });
  assert.equal(inspectSymbolicOrbits(stutter).states.length, 1);
});

test('mixed finite products enforce attempt and orbit bounds without partial success', () => {
  const values = vocabulary(Array.from({ length: 64 }, (_, index) => literal(`event-${String(index).padStart(2, '0')}`)));
  const source = program(mixed(values));
  const attempts = symbolicModel({ ...source, inputs: [...source.inputs, { kind: 'finite', parameter: 'other', domain: 'OtherEvents', values }],
    variables: [...source.variables, 'other'], initial: { ...source.initial, other: values[0] ?? literal('none') },
    branches: source.branches.map(branch => ({ ...branch, updates: { ...branch.updates, other: { kind: 'input', parameter: 'other' } } })),
  });
  assert.throws(() => inspectSymbolicOrbits(attempts), /TLC302.*attempt limit.*no partial success/);
  const orbit = symbolicModel({ ...source, variables: ['a', 'b', 'c'], initial: { a: literal('none'), b: literal('none'), c: literal('none') },
    branches: [{ action: 'Shift', source: null, guard: { kind: 'boolean', value: true }, updates: { a: { kind: 'input', parameter: 'operation' }, b: { kind: 'state', variable: 'a' }, c: { kind: 'state', variable: 'b' } } }],
  });
  assert.throws(() => inspectSymbolicOrbits(orbit), /TLC302.*orbit limit.*no partial success/);
});

test('mixed erasure preserves full literal vocabularies, renamed parameters and erased opaque metadata', () => {
  for (const values of [events, [{ kind: 'boolean', value: false }, { kind: 'boolean', value: true }] satisfies FiniteValue[], vocabulary([{ kind: 'integer', value: '-999999999999999999999' }, { kind: 'integer', value: '999999999999999999999' }])]) {
    const high = mixed(values); const low = concrete(high);
    const evidence = verifySymbolicErasure({ abstract: high, concrete: low, binding: erasureBinding });
    assert.equal(evidence.kind, 'symbolic-enabled-input-erasure');
    assert.equal(evidence.disabledCases, 0);
    assert.equal(evidence.acceptedCases, evidence.checkedCases);
    assert.equal(evidence.checkedCases, values.length + values.length * values.length * 4);
  }
});

test('mixed-to-v1 erasure checks every erased finite event and the single-input shape', () => {
  const high = symbolicModel({
    version: 1, kind: 'symbolic-owned', name: 'Abstract', checkDeadlock: true, variables: ['payload'],
    input: { parameter: 'value', domain: 'Values', next: 'Next' }, initial: { payload: literal('none') },
    branches: [{ action: 'Dispatch', source: null, guard: { kind: 'boolean', value: true }, updates: { payload: { kind: 'input' } } }],
    invariants: [], actionProperties: [],
  });
  const low = mixed();
  const binding = { version: 1, variables: { payload: 'payload' }, inputs: { value: 'value' }, actions: { Dispatch: 'Dispatch' } };
  const evidence = verifySymbolicErasure({ abstract: high, concrete: low, binding });
  assert.equal(evidence.acceptedCases, 21);
  const source = program(low);
  const erasedEventGuard: SymbolicGuard = { kind: 'not-equal', left: { kind: 'input', parameter: 'operation' }, right: { kind: 'literal', value: literal('Idle') } };
  const gated = symbolicModel({ ...source, branches: source.branches.map(branch => ({ ...branch, guard: erasedEventGuard })) });
  assert.throws(() => verifySymbolicErasure({ abstract: high, concrete: gated, binding }), /TLC304.*enabled-input decision differs/);
  assert.ok(inspectSymbolicOrbits(high).edges.every(edge => typeof edge.input === 'string'));
});

test('erasure refuses input kind and finite vocabulary mismatches before nominal projection', () => {
  const high = mixed(); const low = concrete(high); const source = program(low);
  const replace = (values: FiniteValue[]) => symbolicModel({ ...source, inputs: source.inputs.map(input => input.kind === 'finite' ? { ...input, values } : input) });
  for (const values of [events.slice(1), vocabulary([...events, literal('Other')]), [{ kind: 'boolean', value: false }] satisfies FiniteValue[]]) {
    assert.throws(() => verifySymbolicErasure({ abstract: high, concrete: replace(values), binding: erasureBinding }), /TLC304.*finite input vocabularies differ/);
  }
  const swapped = { ...erasureBinding, inputs: { value: 'op', operation: 'data' } };
  assert.throws(() => verifySymbolicErasure({ abstract: high, concrete: low, binding: swapped }), /TLC304.*input kinds differ/);
});

test('complete mixed erasure representatives detect retained-atom and fresh-atom admission differences', () => {
  const high = mixed(); const low = concrete(high); const source = program(low);
  const finiteCase: SymbolicGuard = { kind: 'equal', left: { kind: 'input', parameter: 'op' }, right: { kind: 'literal', value: literal('Idle') } };
  for (const kind of ['equal', 'not-equal'] satisfies ('equal' | 'not-equal')[]) {
    const sameData: SymbolicGuard = { kind: 'equal', left: { kind: 'input', parameter: 'data' }, right: { kind: 'state', variable: 'stored' } };
    const metadataCase: SymbolicGuard = { kind, left: { kind: 'input', parameter: 'metadata' }, right: { kind: 'state', variable: 'receipt' } };
    const admission: SymbolicGuard = { kind: 'not', term: { kind: 'and', terms: [finiteCase, sameData, metadataCase] } };
    const changed = symbolicModel({ ...source, branches: source.branches.map(branch => ({ ...branch, guard: admission })) });
    assert.throws(() => verifySymbolicErasure({ abstract: high, concrete: changed, binding: erasureBinding }), /TLC304.*enabled-input decision differs/);
  }
});

test('mixed erasure retains finite disabled decisions and checks finite successors', () => {
  const high = mixed(); const low = concrete(high);
  const highGuard: SymbolicGuard = { kind: 'not-equal', left: { kind: 'input', parameter: 'operation' }, right: { kind: 'literal', value: literal('Idle') } };
  const lowGuard: SymbolicGuard = { kind: 'not-equal', left: { kind: 'input', parameter: 'op' }, right: { kind: 'literal', value: literal('Idle') } };
  const selectiveHigh = symbolicModel({ ...program(high), checkDeadlock: false, branches: high.branches.map(branch => ({ ...branch, guard: highGuard })) });
  const selectiveLow = symbolicModel({ ...program(low), branches: low.branches.map(branch => ({ ...branch, guard: lowGuard })) });
  assert.ok(verifySymbolicErasure({ abstract: selectiveHigh, concrete: selectiveLow, binding: erasureBinding }).disabledCases > 0);
  const altered = symbolicModel({ ...program(low), branches: low.branches.map(branch => ({ ...branch, updates: { ...branch.updates, mode: { kind: 'literal', value: literal('Abort') } } })) });
  assert.throws(() => verifySymbolicErasure({ abstract: high, concrete: altered, binding: erasureBinding }), /TLC304.*projected successor differs/);
});
