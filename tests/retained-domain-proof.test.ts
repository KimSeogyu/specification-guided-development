import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyDomainProof } from '../src/domain-proof.js';
import type { ExactFiniteAutomaton } from '../src/finite-types.js';

const lean = process.env.SGD_LEAN_BINARY;
const graph: ExactFiniteAutomaton = {
  version: 1, kind: 'exact-finite', name: 'Report',
  variables: [{ name: 'phase', kind: 'string' }, { name: 'resident', kind: 'boolean' }],
  nodes: [
    { id: 's0', values: { phase: { kind: 'string', value: 'ready' }, resident: { kind: 'boolean', value: true } } },
    { id: 's1', values: { phase: { kind: 'string', value: 'pending' }, resident: { kind: 'boolean', value: true } } },
    { id: 's2', values: { phase: { kind: 'string', value: 'done' }, resident: { kind: 'boolean', value: true } } },
  ],
  initial: ['s0'], actions: ['Start', 'Failed', 'Succeeded'],
  edges: [
    { from: 's0', event: 'Start', to: 's1' },
    { from: 's1', event: 'Failed', to: 's0' },
    { from: 's1', event: 'Succeeded', to: 's2' },
  ],
  source: { dotSha256: 'a'.repeat(64), stateCount: 3, edgeCount: 3 },
};
const domain = { operations: [{ name: 'report', port: 'write', start: 'Start', success: 'Succeeded', failure: 'Failed' }] };

test('Lean checks per-graph resident state and generic retained owner together', {
  skip: !lean ? 'Set SGD_LEAN_BINARY to Lean 4.35.0' : false, timeout: 180_000,
}, async () => {
  assert.ok(lean);
  const result = await verifyDomainProof({ automaton: graph, domain, lean, retainedVariable: 'resident' });
  assert.equal(result.verification.retainedProof?.variable, 'resident');
  assert.equal(result.verification.retainedProof.scope, 'abstract-owner-token-and-graph-residency');
  assert.equal(result.verification.scope.nativeCompilerCorrespondence, 'not-proved');
  assert.ok(result.files.some(file => file.path === 'proof/RetainedProtocol.lean'));
  const project = result.files.find(file => file.path === 'proof/DomainProof.lean');
  assert.match(project?.content ?? '', /theorem retained_owner_preserves_residency_and_payload/);
  const wrongGraph: ExactFiniteAutomaton = {
    ...graph,
    nodes: graph.nodes.map(node => node.id === 's2' ? {
      ...node, values: { ...node.values, resident: { kind: 'boolean', value: false } },
    } : node),
  };
  await assert.rejects(verifyDomainProof({ automaton: wrongGraph, domain, lean, retainedVariable: 'resident' }), /retained variable/);
  await assert.rejects(verifyDomainProof({ automaton: graph, domain, lean, retainedVariable: 'phase' }), /retained variable/);
});
