import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FiniteGraphSchema, FiniteValueSchema, validateExecutableGraph, type ExactFiniteAutomaton } from '../src/finite-types.js';

const graph: ExactFiniteAutomaton = {
  version: 1, kind: 'exact-finite', name: 'ScalarModel',
  variables: [{ name: 'phase', kind: 'string' }, { name: 'approved', kind: 'boolean' }, { name: 'quantity', kind: 'integer' }],
  nodes: [
    { id: 's0', values: { phase: { kind: 'string', value: 'New\n"한글 😀"' }, approved: { kind: 'boolean', value: false }, quantity: { kind: 'integer', value: '1234567890123456789012345678901234567890' } } },
    { id: 's1', values: { phase: { kind: 'string', value: 'New\n"한글 😀"' }, approved: { kind: 'boolean', value: true }, quantity: { kind: 'integer', value: '1234567890123456789012345678901234567890' } } },
  ],
  initial: ['s0'], actions: ['Approve', 'Reset', 'Disabled', '한글 action'],
  edges: [{ from: 's0', event: 'Approve', to: 's1' }, { from: 's1', event: 'Reset', to: 's0' }],
  source: { dotSha256: 'c'.repeat(64), stateCount: 2, edgeCount: 2 },
};

function invalid(input: unknown, expected: RegExp): void {
  assert.throws(() => validateExecutableGraph(input), expected);
}

function withNode(node: ExactFiniteAutomaton['nodes'][number], edges: ExactFiniteAutomaton['edges']): ExactFiniteAutomaton {
  return { ...graph, nodes: [...graph.nodes, node], edges, source: { ...graph.source, stateCount: graph.nodes.length + 1, edgeCount: edges.length } };
}

test('exact finite IR preserves every scalar and the complete declared action vocabulary', () => {
  assert.deepEqual(validateExecutableGraph(graph), graph);
  assert.deepEqual(FiniteGraphSchema.parse(graph), graph);
  assert.equal(validateExecutableGraph(graph).nodes[0]?.values.quantity?.value, '1234567890123456789012345678901234567890');
  const terminal: ExactFiniteAutomaton = {
    ...graph, nodes: [graph.nodes[0]!], edges: [],
    source: { ...graph.source, stateCount: 1, edgeCount: 0 },
  };
  assert.deepEqual(validateExecutableGraph(terminal), terminal, 'known actions can be globally disabled in a terminal model');
});

test('duplicate identical edges are retained, counted, and executable as one deterministic successor', () => {
  const duplicate: ExactFiniteAutomaton = {
    ...graph, edges: [...graph.edges, graph.edges[0]!], source: { ...graph.source, edgeCount: 3 },
  };
  assert.deepEqual(validateExecutableGraph(duplicate), duplicate);
  assert.equal(validateExecutableGraph(duplicate).edges.length, 3);
});

test('general exact IR represents multiple initial states and nondeterminism; executable profile rejects both', () => {
  const multipleInitial = { ...graph, initial: ['s0', 's1'] };
  assert.deepEqual(FiniteGraphSchema.parse(multipleInitial), multipleInitial);
  invalid(multipleInitial, /TLC204:.*exactly one initial/);
  const nondeterministic = {
    ...graph, edges: [...graph.edges, { from: 's0', event: 'Approve', to: 's0' }], source: { ...graph.source, edgeCount: 3 },
  };
  assert.deepEqual(FiniteGraphSchema.parse(nondeterministic), nondeterministic);
  invalid(nondeterministic, /TLC204:.*ambiguous action successors/);
});

test('direct callers cannot bypass identity, valuation and source-boundary validation', () => {
  for (const [input, expected] of [
    [null, /TLC204:.*invalid exact finite graph/],
    [{ ...graph, kind: 'projected' }, /TLC204:.*kind/],
    [{ ...graph, initial: [] }, /TLC204:.*initial/],
    [{ ...graph, actions: [] }, /TLC204:.*Unknown graph identity/],
    [{ ...graph, variables: [] }, /TLC204:.*variables/],
    [{ ...graph, nodes: [] }, /TLC204:.*nodes/],
    [{ ...graph, initial: ['s0', 's0'] }, /TLC204:.*Duplicate initial/],
    [{ ...graph, initial: ['s99'] }, /TLC204:.*Unknown graph identity/],
    [{ ...graph, actions: [...graph.actions, 'Approve'] }, /TLC204:.*Duplicate action/],
    [{ ...graph, variables: [...graph.variables, { name: 'approved', kind: 'boolean' }] }, /TLC204:.*Duplicate variable/],
    [{ ...graph, nodes: [...graph.nodes, graph.nodes[0]], source: { ...graph.source, stateCount: 3 } }, /TLC204:.*Duplicate node/],
    [{ ...graph, edges: [{ from: 's0', event: 'Absent', to: 's1' }] , source: { ...graph.source, edgeCount: 1 } }, /TLC204:.*Unknown graph identity/],
    [{ ...graph, edges: [{ from: 's0', event: 'Approve', to: 's99' }], source: { ...graph.source, edgeCount: 1 } }, /TLC204:.*Unknown graph identity/],
    [{ ...graph, source: { ...graph.source, stateCount: 1 } }, /TLC204:.*stateCount/],
    [{ ...graph, source: { ...graph.source, edgeCount: 1 } }, /TLC204:.*edgeCount/],
    [{ ...graph, source: { ...graph.source, dotSha256: 'fixture' } }, /TLC204:.*dotSha256/],
    [{ ...graph, source: { ...graph.source, dotSha256: 'A'.repeat(64) } }, /TLC204:.*dotSha256/],
    [{ ...graph, extra: true }, /TLC204:.*Unrecognized key/],
  ] satisfies [unknown, RegExp][]) invalid(input, expected);
});

test('a terminal model can be inspected without inventing an executable event vocabulary', () => {
  const terminal = {
    ...graph, nodes: [graph.nodes[0]], actions: [], edges: [], source: { ...graph.source, stateCount: 1, edgeCount: 0 },
  };
  assert.deepEqual(FiniteGraphSchema.parse(terminal), terminal);
  invalid(terminal, /TLC204:.*at least one named action/);
});

test('unreachable nodes and duplicate full valuations are rejected independent of property ordering', () => {
  invalid(withNode({ id: 's2', values: { phase: { kind: 'string', value: 'Lost' }, approved: { kind: 'boolean', value: false }, quantity: { kind: 'integer', value: '0' } } }, graph.edges), /TLC204:.*Unreachable concrete node s2/);
  const initialValues = graph.nodes[0]?.values;
  assert.ok(initialValues);
  invalid(withNode({ id: 's2', values: Object.fromEntries(Object.entries(initialValues).reverse()) }, [
    ...graph.edges, { from: 's1', event: 'Disabled', to: 's2' },
  ]), /TLC204:.*Duplicate equivalent concrete valuation/);
  const wrongKind = structuredClone(graph);
  wrongKind.nodes[0]!.values.approved = { kind: 'string', value: 'FALSE' };
  invalid(wrongKind, /TLC204:.*valuation.*variable schema/);
  const extraValue = structuredClone(graph);
  extraValue.nodes[0]!.values.unmodeled = { kind: 'boolean', value: true };
  invalid(extraValue, /TLC204:.*valuation.*variable schema/);
  const missingValue = structuredClone(graph);
  delete missingValue.nodes[0]!.values.quantity;
  invalid(missingValue, /TLC204:.*valuation.*variable schema/);
});

test('unsupported labels and Unicode are rejected while scalar strings retain control characters as values', () => {
  for (const label of ['', 'Approve\n', 'Approve\r', 'Approve\u0000', 'Approve\u007f', 'Approve\u0085', '\ud800', '\udfff']) {
    invalid({ ...graph, actions: [...graph.actions, label] }, /TLC204:.*actions/);
  }
  for (const name of ['phase-name', 'phase.name', '', '__proto__']) {
    invalid({ ...graph, variables: [{ name, kind: 'string' }] }, /TLC204:.*variables/);
  }
  for (const id of ['node0', 's-1', '', 's0\n']) {
    invalid({ ...graph, initial: [id] }, /TLC204:.*initial/);
  }
  assert.deepEqual(FiniteValueSchema.parse({ kind: 'string', value: '\u0000\n😀' }), { kind: 'string', value: '\u0000\n😀' });
  assert.equal(FiniteValueSchema.safeParse({ kind: 'string', value: '\ud800' }).success, false);
  for (const value of ['-0', '+1', '01', '-01', '1.0', '1e3', '', 1, 9007199254740993]) {
    assert.equal(FiniteValueSchema.safeParse({ kind: 'integer', value }).success, false, String(value));
  }
});

test('record parsing cannot silently discard a concrete __proto__ key', () => {
  const node = graph.nodes[0];
  assert.ok(node);
  const values = Object.fromEntries([...Object.entries(node.values), ['__proto__', {kind:'boolean',value:true}]]);
  assert.equal(Object.hasOwn(values, '__proto__'), true);
  invalid({ ...graph, nodes: [{ ...node, values }, graph.nodes[1]] }, /TLC204:.*__proto__/);
  const unusualNames: ExactFiniteAutomaton = {
    ...graph, variables: [{name:'constructor',kind:'string'}, {name:'prototype',kind:'integer'}],
    nodes: [{id:'s0',values:{constructor:{kind:'string',value:'data'}, prototype:{kind:'integer',value:'0'}}}],
    edges: [], source: {...graph.source,stateCount:1,edgeCount:0},
  };
  assert.deepEqual(validateExecutableGraph(unusualNames), unusualNames);
});
