import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRustDomainArtifact, extractRustDomainFacts } from '../src/rust-domain-artifact.js';
import { generateDomainRust } from '../src/backends/domain-rust.js';
import type { ExactFiniteAutomaton } from '../src/finite-types.js';

const graph: ExactFiniteAutomaton = {
  version: 1, kind: 'exact-finite', name: 'Approval',
  variables: [{ name: 'phase', kind: 'string' }],
  nodes: [
    { id: 's0', values: { phase: { kind: 'string', value: 'ready' } } },
    { id: 's1', values: { phase: { kind: 'string', value: 'pending' } } },
    { id: 's2', values: { phase: { kind: 'string', value: 'done' } } },
  ],
  initial: ['s0'], actions: ['Start', 'Failed', 'Succeeded'],
  edges: [
    { from: 's0', event: 'Start', to: 's1' },
    { from: 's1', event: 'Failed', to: 's0' },
    { from: 's1', event: 'Succeeded', to: 's2' },
  ],
  source: { dotSha256: 'a'.repeat(64), stateCount: 3, edgeCount: 3 },
};
const domain = { operations: [{ name: 'publish', port: 'writer', start: 'Start', success: 'Succeeded', failure: 'Failed' }] };
const source = `const INITIAL_STATE: usize = 0;
const TRANSITIONS: &[(usize, usize, usize)] = &[
    (0, 1, 1),
    (1, 0, 0),
    (1, 2, 2),
];
const OPERATION_ROLES: &[(usize, usize, usize)] = &[
    (1, 2, 0),
];
`;

test('the extracted Rust declarations agree with the input automaton and domain roles', () => {
  assert.deepEqual(extractRustDomainFacts({ source, automaton: graph, domain }), {
    initial: 0, transitions: [[0, 1, 1], [1, 0, 0], [1, 2, 2]], operationRoles: [[1, 2, 0]],
  });
});

test('rejects altered, ambiguous, or unsupported Rust declarations', () => {
  for (const modified of [
    source.replace('INITIAL_STATE: usize = 0', 'INITIAL_STATE: usize = 1'),
    source.replace('(1, 2, 2),', '(1, 2, 0),'),
    source.replace('(1, 2, 0),', '(1, 0, 2),'),
    source.replace('(0, 1, 1),', '(00, 1, 1),'),
    source.replace('(0, 1, 1),', '(0, 1, 1),\n    (0, 1, 1),'),
    source + 'const INITIAL_STATE: usize = 0;\n',
    source.replace('const TRANSITIONS:', 'static TRANSITIONS:'),
  ]) {
    assert.throws(() => extractRustDomainFacts({ source: modified, automaton: graph, domain }), /TLC208/);
  }
});

test('checks the emitted transition implementation and operation calls', () => {
  const artifact = generateDomainRust({ automaton: graph, domain, className: 'Approval' })
    .find(file => file.path === 'src/lib.rs');
  assert.ok(artifact);
  const input = { source: artifact.content, automaton: graph, domain, className: 'Approval' };
  assert.deepEqual(checkRustDomainArtifact(input).operationRoles, [[1, 2, 0]]);
  for (const modified of [
    artifact.content.replace('state: INITIAL_STATE,\n            revision: 0', 'state: 1,\n            revision: 0'),
    artifact.content.replace('*action == event', '*action != event'),
    artifact.content.replace('OPERATION_ROLES[0].1', 'OPERATION_ROLES[0].2'),
    artifact.content.replace('<P as Ports>::writer(&self.ports, input).await', '<P as Ports>::other(&self.ports, input).await'),
    artifact.content.replace('self.machine.revision > u64::MAX - 2', 'self.machine.revision > u64::MAX - 1'),
    artifact.content.replace('VALUES_0)', 'VALUES_1)'),
    artifact.content.replace('Value::String("ready")', 'Value::String("wrong")'),
    artifact.content.replace('pub const MODEL: &str = "Approval";', 'pub const MODEL: &str = "Other";'),
    artifact.content.replace(`pub const MODEL_REVISION: &str = "${'a'.repeat(64)}";`, `pub const MODEL_REVISION: &str = "${'b'.repeat(64)}";`),
    artifact.content.replace('&mut self.ports, &self.payload, input', '&mut self.ports, &self.payload, panic!()'),
    artifact.content.replace('payload: P::Payload,', 'pub payload: P::Payload,'),
    artifact.content.replace('snapshot: self.machine.read(),', 'snapshot: panic!(),'),
    artifact.content.replace('(self.payload, self.ports, snapshot)', '(panic!(), self.ports, snapshot)'),
  ]) {
    assert.notEqual(modified, artifact.content);
    assert.throws(() => checkRustDomainArtifact({ ...input, source: modified }), /TLC208/);
  }
});

test('retained binding requires resident state and hides the non-retaining facade', () => {
  const resident: ExactFiniteAutomaton = {
    ...graph, variables: [...graph.variables, { name: 'resident', kind: 'boolean' }],
    nodes: graph.nodes.map(node => ({ ...node, values: { ...node.values, resident: { kind: 'boolean', value: true } } })),
  };
  const retainedVariable = 'resident';
  const artifact = generateDomainRust({ automaton: resident, domain, className: 'Approval', retainedVariable })
    .find(file => file.path === 'src/lib.rs');
  assert.ok(artifact);
  const input = { source: artifact.content, automaton: resident, domain, className: 'Approval', retainedVariable };
  checkRustDomainArtifact(input);
  for (const bypass of [
    '\npub struct ApprovalDomain<P: Ports> {}\n',
    '\nstruct ApprovalDomain<P: Ports> {}\n',
    '\npub trait Ports {}\n',
    '\nuse std::future::Future;\n',
    '\npub async fn bypass() {}\n',
  ]) assert.throws(() => checkRustDomainArtifact({ ...input, source: artifact.content + bypass }), /TLC208/);
  const invalid = { ...resident, nodes: resident.nodes.map((node, i) => i === 2
    ? { ...node, values: { ...node.values, resident: { kind: 'boolean' as const, value: false } } } : node) };
  assert.throws(() => generateDomainRust({ automaton: invalid, domain, className: 'Approval', retainedVariable }), /TLC208/);
});

test('rejects a public-event mapping that exposes an operation action', () => {
  const withReset: ExactFiniteAutomaton = {
    ...graph, actions: [...graph.actions, 'Reset'],
    edges: [...graph.edges, { from: 's2', event: 'Reset', to: 's0' }],
    source: { ...graph.source, edgeCount: 4 },
  };
  const artifact = generateDomainRust({ automaton: withReset, domain, className: 'Approval' })
    .find(file => file.path === 'src/lib.rs');
  assert.ok(artifact);
  const input = { source: artifact.content, automaton: withReset, domain, className: 'Approval' };
  checkRustDomainArtifact(input);
  const modified = artifact.content.replace('Self::Event1 => 1,', 'Self::Event1 => 2,');
  assert.notEqual(modified, artifact.content);
  assert.throws(() => checkRustDomainArtifact({ ...input, source: modified }), /TLC208/);
});
