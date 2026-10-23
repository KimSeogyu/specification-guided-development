import { type SymbolicExpression, type SymbolicGuard, type SymbolicModel, type SymbolicValue, validateSymbolicModel } from './symbolic-types.js';

export type SymbolicState = Record<string, SymbolicValue>;
export const sameSymbolicValue = (a: SymbolicValue, b: SymbolicValue): boolean => a.kind === b.kind && a.value === b.value && (a.kind !== 'data' || (b.kind === 'data' && a.domain === b.domain));
function compareGuardValues(a: SymbolicValue, b: SymbolicValue): boolean {
  if (a.kind !== b.kind && a.kind !== 'data' && b.kind !== 'data') throw new Error('TLC302: mixed scalar kinds are unsupported in a TLC equality or membership comparison');
  return sameSymbolicValue(a, b);
}

export function evaluateExpression(expression: SymbolicExpression, state: SymbolicState, input: SymbolicValue | null, next: SymbolicState | null = null): SymbolicValue {
  switch (expression.kind) {
    case 'literal': return expression.value;
    case 'input': {
      if (!input) throw new Error('TLC301: input is unavailable');
      return input;
    }
    case 'state': case 'next-state': {
      const value = (expression.kind === 'state' ? state : next)?.[expression.variable];
      if (!value) throw new Error(`TLC301: unavailable state variable ${expression.variable}`);
      return value;
    }
  }
}

export function evaluateGuard(guard: SymbolicGuard, state: SymbolicState, input: SymbolicValue | null, next: SymbolicState | null = null): boolean {
  const value = (expression: SymbolicExpression) => evaluateExpression(expression, state, input, next);
  const test = (predicate: SymbolicGuard): boolean => evaluateGuard(predicate, state, input, next);
  switch (guard.kind) {
    case 'boolean': return guard.value;
    case 'equal': return compareGuardValues(value(guard.left), value(guard.right));
    case 'not-equal': return !compareGuardValues(value(guard.left), value(guard.right));
    case 'member': return guard.elements.some(element => compareGuardValues(value(guard.value), element));
    case 'in-domain': { const item = value(guard.value); return item.kind === 'data' && item.domain === guard.domain; }
    case 'and': return guard.terms.every(test);
    case 'or': return guard.terms.some(test);
    case 'not': return !test(guard.term);
    case 'implies': return !test(guard.left) || test(guard.right);
    case 'equivalent': return test(guard.left) === test(guard.right);
  }
}

export type SymbolicStep =
  | { kind: 'accepted'; action: string; state: SymbolicState; updates: Record<string, SymbolicExpression> }
  | { kind: 'disabled' }
  | { kind: 'ambiguous' };
export function stepSymbolic(model: SymbolicModel, state: SymbolicState, input: string): SymbolicStep {
  const value: SymbolicValue = { kind: 'data', domain: model.input.domain, value: input };
  const enabled = model.branches.filter(branch => evaluateGuard(branch.guard, state, value));
  if (enabled.length === 0) return { kind: 'disabled' };
  if (enabled.length !== 1) return { kind: 'ambiguous' };
  const branch = enabled[0];
  if (!branch) throw new Error('TLC301: enabled branch disappeared');
  const next = Object.fromEntries(model.variables.map(variable => {
    const expression = branch.updates[variable];
    if (!expression) throw new Error('TLC301: incomplete simultaneous update');
    return [variable, evaluateExpression(expression, state, value)];
  }));
  return { kind: 'accepted', action: branch.action, state: next, updates: branch.updates };
}

function canonicalState(model: SymbolicModel, state: SymbolicState): SymbolicState {
  const atoms = new Map<string, string>();
  return Object.fromEntries(model.variables.map(variable => {
    const value = state[variable];
    if (!value) throw new Error('TLC301: incomplete abstract state');
    if (value.kind !== 'data') return [variable, value];
    let name = atoms.get(value.value);
    if (name === undefined) { name = `a${atoms.size}`; atoms.set(value.value, name); }
    return [variable, { kind: 'data', domain: model.input.domain, value: name }];
  }));
}

/** Equality and copy commute with atom renaming. Each state needs its existing atoms plus one fresh input. */
export function inspectSymbolicOrbits(input: unknown): {
  kind: 'equality-copy-orbits'; states: SymbolicState[];
  edges: { from: number; input: string; action: string; to: number }[];
  disabled: { state: number; input: string }[];
} {
  const model = validateSymbolicModel(input);
  const states: SymbolicState[] = [canonicalState(model, model.initial)];
  const ids = new Map([[JSON.stringify(states[0]), 0]]);
  const edges: { from: number; input: string; action: string; to: number }[] = [];
  const disabled: { state: number; input: string }[] = [];
  for (let index = 0; index < states.length; index++) {
    const state = states[index];
    if (!state) throw new Error('TLC301: abstract state disappeared');
    for (const invariant of model.invariants) {
      if (!evaluateGuard(invariant.predicate, state, null)) throw new Error(`TLC302: invariant ${invariant.name} fails in an equality/copy orbit`);
    }
    // [P]_vars means P OR UNCHANGED vars. Its implicit stuttering step always satisfies it.
    const atoms = [...new Set(Object.values(state).flatMap(value => value.kind === 'data' ? [value.value] : []))];
    const inputs = [...atoms, `a${atoms.length}`];
    let accepted = 0;
    for (const value of inputs) {
      const result = stepSymbolic(model, state, value);
      if (result.kind === 'disabled') { disabled.push({ state: index, input: value }); continue; }
      if (result.kind === 'ambiguous') throw new Error('TLC302: more than one symbolic action is enabled for the same state and input');
      accepted++;
      const unchanged = model.variables.every(variable => {
        const before = state[variable]; const after = result.state[variable];
        return before !== undefined && after !== undefined && sameSymbolicValue(before, after);
      });
      if (!unchanged) for (const property of model.actionProperties) {
        if (!evaluateGuard(property.predicate, state, null, result.state)) throw new Error(`TLC302: action property ${property.name} fails on ${result.action}`);
      }
      const next = canonicalState(model, result.state);
      const key = JSON.stringify(next);
      let target = ids.get(key);
      if (target === undefined) {
        if (states.length >= 10_000) throw new Error('TLC302: symbolic orbit limit exceeded; no partial success is permitted');
        target = states.length; ids.set(key, target); states.push(next);
      }
      edges.push({ from: index, input: value, action: result.action, to: target });
    }
    if (model.checkDeadlock && accepted === 0) throw new Error('TLC302: deadlock in a symbolic equality/copy orbit');
  }
  return { kind: 'equality-copy-orbits', states, edges, disabled };
}
