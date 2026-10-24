import { isDeepStrictEqual } from 'node:util';
import { symbolicInputDefinitions, validateSymbolicModel } from './symbolic-types.js';

const fail: (detail: string) => never = detail => { throw new Error(`TLC310: required contract property: ${detail}`); };

/** Compare supplied lowered properties. This establishes neither source provenance nor behavioral refinement. */
export function compareRequiredSymbolicProperties(input: { baseline: unknown; candidate: unknown }) {
  const baseline = validateSymbolicModel(input.baseline);
  const candidate = validateSymbolicModel(input.candidate);
  if (baseline.name !== candidate.name) fail('model renaming requires an explicit supported acceptance mapping');
  if (!isDeepStrictEqual([...baseline.variables].sort(), [...candidate.variables].sort())) {
    fail('complete state tuple changed; this property-retention profile requires the same variables');
  }
  if (!isDeepStrictEqual(symbolicInputDefinitions(baseline), symbolicInputDefinitions(candidate))) {
    fail('input domains or vocabularies changed; this profile requires the same input definitions');
  }
  if (baseline.checkDeadlock && !candidate.checkDeadlock) fail('required deadlock checking was disabled');

  for (const required of baseline.invariants) {
    const actual = candidate.invariants.find(property => property.name === required.name);
    if (!actual) fail(`invariant ${required.name} is not selected by the candidate`);
    if (!isDeepStrictEqual(required.predicate, actual.predicate)) fail(`invariant ${required.name} changed its lowered expression`);
  }
  for (const required of baseline.actionProperties) {
    const actual = candidate.actionProperties.find(property => property.name === required.name);
    if (!actual) fail(`action property ${required.name} is not selected by the candidate`);
    if (!isDeepStrictEqual(required, actual)) fail(`action property ${required.name} changed its lowered expression`);
  }
  return {
    kind: 'required-symbolic-property-comparison' as const,
    scope: 'supplied-lowered-expressions' as const,
    model: baseline.name,
    invariants: baseline.invariants.map(property => property.name),
    actionProperties: baseline.actionProperties.map(property => property.name),
    sourceProvenance: 'not-established' as const,
    behavioralRefinement: 'not-established' as const,
    independentlySelectedBaseline: 'not-established' as const,
  };
}
