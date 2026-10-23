import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { importFiniteDot } from '../src/finite-dot.js';
import { runFiniteTlc } from '../src/finite-tlc.js';
import { importDot } from '../src/dot.js';
import { validateExecutableGraph } from '../src/finite-types.js';

function graph(labels: string[], edges: [number, string, number][], initial = [0]): string {
  return 'strict digraph DiskGraph { subgraph cluster_graph {\n' + labels.map((label, i) =>
    `${100 + i} [label=${JSON.stringify(label)}${initial.includes(i) ? ',style=filled' : ''}];`).join('\n') + '\n' +
    edges.map(([from, event, to]) => `${100 + from} -> ${100 + to} [label=${JSON.stringify(event)}];`).join('\n') + '\n}}';
}
const labels = [
  '/\\ phase = "New"\n/\\ approved = FALSE',
  '/\\ phase = "New"\n/\\ approved = TRUE',
  '/\\ phase = "Submitted"\n/\\ approved = TRUE',
];
const edges: [number, string, number][] = [[0, 'Approve', 1], [1, 'Submit', 2], [2, 'Wait', 2]];

test('full valuations preserve two different guard states with the same projected phase', () => {
  const dot = graph(labels, edges);
  const exact = importFiniteDot({ dot, name: 'Approval' });
  validateExecutableGraph(exact);
  const projected = importDot({ dot, name: 'Approval', stateVariable: 'phase' });
  assert.equal(exact.nodes.length, 3);
  assert.equal(projected.states.length, 2);
  const unapproved = exact.nodes.find(node => node.values.approved?.value === false);
  const approved = exact.nodes.find(node => node.values.phase?.value === 'New' && node.values.approved?.value === true);
  assert.ok(unapproved && approved);
  assert.ok(!exact.edges.some(edge => edge.from === unapproved.id && edge.event === 'Submit'));
  assert.ok(exact.edges.some(edge => edge.from === approved.id && edge.event === 'Submit'));
});

test('scalar values retain string escapes, booleans, empty strings, and large exact integers', () => {
  for (const value of ['', '1', '한글 😀', 'quote " slash \\ literal \\n', 'line\nfeed\ttab']) {
    const dot = graph([`/\\ text = ${JSON.stringify(value)}\n/\\ flag = FALSE\n/\\ count = -900719925474099312345`], [[0, 'Wait', 0]]);
    const model = importFiniteDot({ dot, name: 'Scalars' });
    assert.deepEqual(model.nodes[0]?.values, {
      count: { kind: 'integer', value: '-900719925474099312345' },
      flag: { kind: 'boolean', value: false }, text: { kind: 'string', value },
    });
  }
});

test('canonical graph identities depend on full valuations, not DOT fingerprint or traversal order', () => {
  const first = importFiniteDot({ dot: graph(labels, edges), name: 'Approval' });
  const reordered = graph([...labels].reverse(), edges.map(([from, event, to]) => [2 - from, event, 2 - to]), [2])
    .replaceAll('100', 'fpa').replaceAll('101', 'fpb').replaceAll('102', 'fpc');
  const second = importFiniteDot({ dot: reordered, name: 'Approval' });
  const { source: _firstSource, ...firstSemantics } = first;
  const { source: _secondSource, ...secondSemantics } = second;
  assert.deepEqual(firstSemantics, secondSemantics);
  assert.notEqual(first.source.dotSha256, second.source.dotSha256);
});

test('raw strict DOT retains parallel action labels and repeated identical edges', () => {
  const model = importFiniteDot({ dot: graph(labels, [...edges, [0, 'AlsoApprove', 1], [0, 'Approve', 1]]), name: 'Approval' });
  assert.equal(model.source.edgeCount, 5);
  assert.equal(model.edges.length, 5);
  assert.ok(model.actions.includes('AlsoApprove'));
});

test('unsupported or incomplete full states fail instead of becoming an executable projection', () => {
  const base = graph(labels, edges);
  for (const dot of [
    graph([labels[0]!, '/\\ phase = "New"'], edges),
    graph(['phase = <<1, 2>>'], [[0, 'Wait', 0]]),
    graph(['phase = [x |-> 1]'], [[0, 'Wait', 0]]),
    graph(['phase = ModelValue'], [[0, 'Wait', 0]]),
    graph(['phase = 1', 'phase = "1"'], [[0, 'Change', 1]]),
    graph(['phase = "New"\nphase = "Other"'], [[0, 'Wait', 0]]),
    graph(['__proto__ = "New"'], [[0, 'Wait', 0]]),
    graph(labels, [[0, 'Approve(1)', 1]]),
    base.replace('[label="Approve"]', ''),
    base.replace('style=filled', 'style=solid'),
    base.replace('subgraph cluster_graph {', 'subgraph cluster_graph { node [label="phase = 1"];'),
    base.slice(0, -1),
  ]) assert.throws(() => importFiniteDot({ dot, name: 'Bad' }));
});

test('unsupported executable choices fail even when graph import is structurally valid', () => {
  assert.throws(() => validateExecutableGraph(importFiniteDot({ dot: graph(labels, edges, [0, 1]), name: 'ManyInit' })), /TLC204/);
  assert.throws(() => validateExecutableGraph(importFiniteDot({ dot: graph(labels, [...edges, [0, 'Approve', 2]]), name: 'Nondeterministic' })), /TLC204/);
});

const jar = process.env.TLA2TOOLS_JAR;
test('real isolated TLC guard graph retains the variable changed by Approve', { skip: !jar }, async () => {
  const model = await runFiniteTlc({ spec: resolve('examples/approval/Approval.tla'), config: resolve('examples/approval/Approval.cfg'), jar: jar! });
  const exact = importFiniteDot({ dot: model.dot, name: 'Approval' });
  validateExecutableGraph(exact);
  assert.equal(exact.nodes.length, 3);
  const initial = exact.nodes.find(node => node.id === exact.initial[0]);
  assert.deepEqual(initial?.values.approved, { kind: 'boolean', value: false });
  assert.equal(exact.edges.filter(edge => edge.from === initial?.id && edge.event === 'Submit').length, 0);
  assert.equal(exact.edges.filter(edge => edge.event === 'Submit').length, 1);
});
