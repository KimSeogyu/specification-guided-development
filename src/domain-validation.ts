import { DomainBindingSchema, type DomainBinding, type DomainOperation } from './domain-types.js';
import { validateExecutableGraph, type ExactFiniteAutomaton } from './finite-types.js';

export interface DomainPlan {
  domain: DomainBinding;
  operations: Array<DomainOperation & { pendingStates: string[] }>;
  publicEvents: string[];
  completionEvents: string[];
}

function fail(message: string): never { throw new Error(`TLC208: ${message}`); }

/** A serial, per-live-owner port protocol. Effects cannot choose their completion action. */
export function validateDomainBinding(input: { automaton: ExactFiniteAutomaton; domain: DomainBinding }): DomainPlan {
  const graph = validateExecutableGraph(input.automaton);
  const parsed = DomainBindingSchema.safeParse(input.domain);
  if (!parsed.success) fail(`invalid domain binding: ${parsed.error.message}`);
  const domain = parsed.data;
  const names = new Set<string>();
  const roles = new Set<string>();
  const pendingOwner = new Map<string, string>();
  const completionEvents: string[] = [];
  for (const operation of domain.operations) {
    if (names.has(operation.name)) fail(`duplicate operation ${operation.name}`);
    names.add(operation.name);
    for (const action of [operation.start, operation.success, operation.failure]) {
      if (roles.has(action)) fail(`action ${action} has multiple domain roles`);
      if (!graph.actions.includes(action)) fail(`unknown model action ${action}`);
      roles.add(action);
    }
    completionEvents.push(operation.success, operation.failure);
  }
  const operations = domain.operations.map(operation => {
    const pendingStates = [...new Set(graph.edges.filter(edge => edge.event === operation.start).map(edge => edge.to))].sort();
    if (pendingStates.length === 0) fail(`operation ${operation.name} has no reachable start edge`);
    for (const state of pendingStates) {
      if (pendingOwner.has(state)) fail(`pending state ${state} is shared by operations`);
      pendingOwner.set(state, operation.name);
      const outgoing = graph.edges.filter(edge => edge.from === state);
      for (const outcome of [operation.success, operation.failure]) {
        if (!outgoing.some(edge => edge.event === outcome)) fail(`pending state ${state} lacks ${outcome}`);
      }
      if (outgoing.some(edge => edge.event !== operation.success && edge.event !== operation.failure)) {
        fail(`pending state ${state} permits an action outside ${operation.name}'s completion protocol`);
      }
    }
    return { ...operation, pendingStates };
  });
  for (const initial of graph.initial) {
    if (pendingOwner.has(initial)) fail('initial state cannot contain an operation without a live invocation');
  }
  for (const operation of operations) {
    for (const edge of graph.edges) {
      if (operation.pendingStates.includes(edge.to) && edge.event !== operation.start) {
        fail(`pending state ${edge.to} can only be entered by ${operation.start}`);
      }
      if (edge.event !== operation.success && edge.event !== operation.failure) continue;
      if (!operation.pendingStates.includes(edge.from)) fail(`completion ${edge.event} is enabled outside its pending states`);
      if (pendingOwner.has(edge.to)) fail(`completion ${edge.event} leaves an orphaned pending operation`);
    }
  }
  return { domain, operations, publicEvents: graph.actions.filter(action => !roles.has(action)).sort(), completionEvents };
}
