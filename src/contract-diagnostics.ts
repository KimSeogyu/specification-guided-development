import { ContractComparisonError, ContractVerificationError } from './contract-check.js';
import { ContractGraphError } from './contract-graph.js';

/** Preserve the owning obligation instead of reducing a failed contract to an error string. */
export function contractDiagnostic(error: unknown) {
  if (error instanceof ContractComparisonError) return {
    schema: 'sgd-contract-failure-v1' as const, ruleId: 'TLC312' as const,
    kind: 'unresolved-obligations' as const, source: error.source, findings: error.findings,
  };
  if (error instanceof ContractVerificationError) return {
    schema: 'sgd-contract-failure-v1' as const, kind: 'verification-failure' as const, ...error.diagnostic,
  };
  if (error instanceof ContractGraphError) return {
    schema: 'sgd-contract-failure-v1' as const, ...error.diagnostic,
  };
  return undefined;
}
