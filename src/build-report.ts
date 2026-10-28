import { resolve } from 'node:path';
import { z } from 'zod';
import type { Automaton, GeneratedFile } from './types.js';
import type { ExactFiniteAutomaton } from './finite-types.js';
import type { SymbolicWitnessGraph } from './symbolic-witness.js';

export type BuildAutomaton = Automaton | ExactFiniteAutomaton | SymbolicWitnessGraph;
const Count = z.number().int().nonnegative();
const ModelRole = z.literal('model');

export const GraphSummarySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('projected'), name: z.string(), stateVariable: z.string(),
    projectedStates: Count, projectedTransitions: Count, concreteSourceStates: Count, concreteSourceEdges: Count }).strict(),
  z.object({ kind: z.literal('exact-finite'), role: z.literal('model'), name: z.string(),
    variables: z.array(z.string()), states: Count, edges: Count, initialStates: Count }).strict(),
  z.object({ kind: z.literal('symbolic-witness'), name: z.string(), states: Count, edges: Count,
    domains: z.array(z.object({ name: z.string(), atoms: Count }).strict()) }).strict(),
]);
export type GraphSummary = z.infer<typeof GraphSummarySchema>;

export const VerificationCheckSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('domain-protocol'), role: ModelRole,
    scope: z.enum(['per-live-owner-serial-async-ports', 'per-live-owner-serial-ports']), proof: z.literal('lean4-kernel'),
    leanVersion: z.literal('4.35.0'), operations: z.array(z.string()),
    nativeBackend: z.literal('not-formally-verified') }).strict(),
  z.object({ kind: z.literal('retained-operation'), role: ModelRole,
    scope: z.literal('one-borrowed-synchronous-callback'), payload: z.literal('retained-on-all-return-paths') }).strict(),
  z.object({ kind: z.literal('legacy-tlc'), role: z.literal('model'),
    scope: z.literal('observed-possible-transitions') }).strict(),
  z.object({ kind: z.literal('controlled-tlc'), role: ModelRole,
    profile: z.enum(['finite-owned-v1', 'symbolic-owned-v1']),
    scope: z.enum(['configured-finite-model', 'configured-bounded-witness']), rootModule: z.string(),
    invariants: z.array(z.string()), properties: z.array(z.string()), checkDeadlock: z.boolean() }).strict(),
  z.object({ kind: z.literal('executable-graph'), role: ModelRole,
    scope: z.literal('per-live-object'), profile: z.literal('finite-owned-v1') }).strict(),
  z.object({ kind: z.literal('symbolic-source'), role: ModelRole, profile: z.enum(['single-input', 'disjoint-input-product']),
    scope: z.literal('accepted-SANY-equality-copy-grammar'),
    inputs: z.array(z.object({ parameter: z.string(), domain: z.string() }).strict()) }).strict(),
  z.object({ kind: z.literal('symbolic-orbit'), role: ModelRole, profile: z.literal('equality-copy-orbits'),
    scope: z.literal('accepted-equality-copy-grammar'), states: Count, edges: Count, disabledCases: Count,
    invariants: z.array(z.string()), actionProperties: z.array(z.string()), checkDeadlock: z.boolean() }).strict(),
  z.object({ kind: z.literal('input-oracle'), role: ModelRole, profile: z.literal('tlc-finite-input-oracle'),
    scope: z.literal('configured-reachable-state-input-product'), states: Count,
    checkedCases: Count, acceptedCases: Count, disabledCases: Count }).strict(),

]);
export type VerificationCheck = z.infer<typeof VerificationCheckSchema>;

const EvidenceRole = z.enum(['verification', 'log', 'orbit', 'input-oracle', 'source-plan']);
export const EvidenceArtifactSchema = z.object({ path: z.string(), role: EvidenceRole,
  freshness: z.enum(['current-invocation', 'retained-output']) }).strict();
export type EvidenceArtifact = z.infer<typeof EvidenceArtifactSchema>;

export const BuildSummarySchema = z.object({
  schema: z.literal('sgd-build-summary-v1'), operation: z.enum(['model', 'build']),
  output: z.object({ directory: z.string(), artifacts: z.array(z.string()) }).strict(),
  graph: GraphSummarySchema,
  verification: z.object({ invocation: z.literal('completed'), output: z.enum(['generated', 'checked']),
    freshInvocationLogRetained: z.boolean(), checks: z.array(VerificationCheckSchema) }).strict(),
  evidence: z.array(EvidenceArtifactSchema),
  limits: z.object({ applicationIntegration: z.literal('not-established'), persistence: z.literal('not-established'),
    externalEffects: z.literal('not-established') }).strict(),
}).strict();
export type BuildSummary = z.infer<typeof BuildSummarySchema>;
export type BuildReport = { automaton: BuildAutomaton; summary: BuildSummary };

/** Collector metadata references the generated file registered at its creation site. */
export type CollectedEvidence = { file: GeneratedFile; role: EvidenceArtifact['role'] };

export function summarizeGraph(automaton: BuildAutomaton, role: 'model'): GraphSummary {
  if (!('kind' in automaton)) return { kind: 'projected', name: automaton.name, stateVariable: automaton.stateVariable,
    projectedStates: automaton.states.length, projectedTransitions: automaton.transitions.length,
    concreteSourceStates: automaton.source.stateCount, concreteSourceEdges: automaton.source.edgeCount };
  switch (automaton.kind) {
    case 'exact-finite': return { kind: 'exact-finite', role, name: automaton.name,
      variables: automaton.variables.map(variable => variable.name), states: automaton.nodes.length,
      edges: automaton.edges.length, initialStates: automaton.initial.length };
    case 'symbolic-witness': return { kind: 'symbolic-witness', name: automaton.name,
      states: automaton.nodes.length, edges: automaton.edges.length,
      domains: Object.entries(automaton.version === 1 ? { [automaton.domain]: automaton.atoms } : automaton.domains)
        .map(([name, atoms]) => ({ name, atoms: atoms.length })) };
    default: { const exhaustive: never = automaton; return exhaustive; }
  }
}

/** Project only facts collected by this invocation; do not inspect published files. */
export function summarizeBuild(input: {
  operation: BuildSummary['operation']; out: string; check: boolean; graph: GraphSummary;
  files: readonly GeneratedFile[]; checks: VerificationCheck[]; evidence: CollectedEvidence[];
}): BuildSummary {
  return BuildSummarySchema.parse({
    schema: 'sgd-build-summary-v1', operation: input.operation,
    output: { directory: input.out, artifacts: input.files.map(file => file.path) }, graph: input.graph,
    verification: { invocation: 'completed', output: input.check ? 'checked' : 'generated',
      freshInvocationLogRetained: !input.check && input.evidence.some(item => item.role === 'log'), checks: input.checks },
    evidence: input.evidence.map(({ file, role }) => ({ path: resolve(input.out, file.path), role,
      freshness: input.check ? 'retained-output' : 'current-invocation' })),
    limits: { applicationIntegration: 'not-established', persistence: 'not-established', externalEffects: 'not-established' },
  });
}
