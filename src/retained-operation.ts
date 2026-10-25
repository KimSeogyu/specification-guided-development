import { validateExecutableGraph, type ExactFiniteAutomaton } from './finite-types.js';
import { RetainedOperationSchema, type RetainedOperation } from './retained-operation-types.js';

export interface RetainedOperationInput {
  automaton: ExactFiniteAutomaton;
  className: string;
  operation: RetainedOperation;
}

/** This checks a finite operation law, not application binding or persistence. */
export function validateRetainedOperation(input: RetainedOperationInput): void {
  const graph = validateExecutableGraph(input.automaton);
  const operation = RetainedOperationSchema.parse(input.operation);
  const actions = [operation.start, operation.success, operation.failure];
  if (new Set(actions).size !== actions.length || actions.some(action => !graph.actions.includes(action))) {
    throw new Error('TLC207: retained operation roles require three distinct observed model actions');
  }
  const variable = graph.variables.find(item => item.name === operation.retainedVariable);
  if (variable?.kind !== 'boolean' || graph.nodes.some(node => {
    const value = node.values[operation.retainedVariable];
    return value?.kind !== 'boolean' || value.value !== true;
  })) {
    throw new Error('TLC207: retained operation requires its Boolean payload-retention variable to stay true in every reachable state');
  }
  const initial = graph.initial[0];
  const start = graph.edges.find(edge => edge.from === initial && edge.event === operation.start);
  // A disabled initial operation is a valid refusal, with no callback invocation.
  if (start === undefined) return;
  for (const outcome of [operation.success, operation.failure]) {
    if (!graph.edges.some(edge => edge.from === start.to && edge.event === outcome)) {
      throw new Error('TLC207: both observed operation outcomes must be enabled after the initial start action');
    }
  }
}
