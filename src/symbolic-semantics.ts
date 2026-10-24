import { FiniteValueSchema, type FiniteValue } from './finite-types.js';
import { type SymbolicExpression, type SymbolicGuard, type SymbolicInput, type SymbolicInputFrameValue, type SymbolicModel, type SymbolicValue, SymbolicValueSchema, symbolicInputDefinitions, validateSymbolicModel } from './symbolic-types.js';

export type SymbolicState = Record<string, SymbolicValue>;
export const sameSymbolicValue = (a: SymbolicValue, b: SymbolicValue): boolean => a.kind === b.kind && a.value === b.value && (a.kind !== 'data' || (b.kind === 'data' && a.domain === b.domain));
function compareGuardValues(a: SymbolicValue, b: SymbolicValue): boolean {
  if (a.kind !== b.kind && a.kind !== 'data' && b.kind !== 'data') throw new Error('TLC302: mixed scalar kinds are unsupported in a TLC equality or membership comparison');
  return sameSymbolicValue(a, b);
}

export type SymbolicEvaluationInput = SymbolicValue | { kind: 'inputs'; values: ReadonlyMap<string, SymbolicValue> } | null;
export function evaluateExpression(expression: SymbolicExpression, state: SymbolicState, input: SymbolicEvaluationInput, next: SymbolicState | null = null): SymbolicValue {
  switch (expression.kind) {
    case 'literal': return expression.value;
    case 'input': {
      if (!input) throw new Error('TLC301: input is unavailable');
      if ('parameter' in expression) {
        if (input.kind !== 'inputs') throw new Error('TLC301: named input frame is unavailable');
        const value = input.values.get(expression.parameter);
        if (!value) throw new Error('TLC301: named input parameter is unavailable');
        return value;
      }
      if (input.kind === 'inputs') throw new Error('TLC301: unnamed input is unavailable in a product frame');
      return input;
    }
    case 'state': case 'next-state': {
      const value = (expression.kind === 'state' ? state : next)?.[expression.variable];
      if (!value) throw new Error(`TLC301: unavailable state variable ${expression.variable}`);
      return value;
    }
  }
}

export function evaluateGuard(guard: SymbolicGuard, state: SymbolicState, input: SymbolicEvaluationInput, next: SymbolicState | null = null): boolean {
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

function finiteInput(value: unknown, vocabulary: readonly FiniteValue[]): FiniteValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('TLC301: finite symbolic input requires a tagged scalar value');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || keys.some(key => key !== 'kind' && key !== 'value')) throw new Error('TLC301: finite symbolic input requires exactly kind and value');
  const kind = Object.getOwnPropertyDescriptor(value, 'kind');
  const payload = Object.getOwnPropertyDescriptor(value, 'value');
  if (!kind || !payload || !('value' in kind) || !('value' in payload)) throw new Error('TLC301: finite symbolic input fields must be own data properties');
  const parsed = FiniteValueSchema.safeParse({ kind: kind.value, value: payload.value });
  if (!parsed.success) throw new Error('TLC301: finite symbolic input requires a valid tagged scalar value');
  if (!vocabulary.some(candidate => sameSymbolicValue(candidate, parsed.data))) throw new Error('TLC301: finite symbolic input is outside its declared vocabulary');
  return parsed.data;
}

export function stepSymbolic(model: SymbolicModel, state: SymbolicState, input: SymbolicInput): SymbolicStep {
  const inputs = symbolicInputDefinitions(model);
  const atom = (domain: string, value: unknown): SymbolicValue => {
    const parsed = SymbolicValueSchema.safeParse({ kind: 'data', domain, value });
    if (!parsed.success) throw new Error('TLC301: symbolic input requires immutable Unicode string identities');
    return parsed.data;
  };
  let value: SymbolicEvaluationInput;
  if (model.version === 1) value = atom(model.input.domain, input);
  else {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('TLC301: product input requires a named input record');
    const keys = Reflect.ownKeys(input);
    if (keys.length !== inputs.length || keys.some(key => typeof key !== 'string' || !inputs.some(item => item.parameter === key))) throw new Error('TLC301: product input must contain every declared parameter exactly once and no other keys');
    const values = new Map(inputs.map(item => {
      const descriptor = Object.getOwnPropertyDescriptor(input, item.parameter);
      if (!descriptor || !('value' in descriptor)) throw new Error('TLC301: product input parameters must be own data properties');
      return [item.parameter, item.kind === 'opaque' ? atom(item.domain, descriptor.value) : finiteInput(descriptor.value, item.values)];
    }));
    value = { kind: 'inputs', values };
  }
  const domains = new Set(inputs.filter(item => item.kind === 'opaque').map(item => item.domain));
  if (Object.values(state).some(item => item.kind === 'data' && !domains.has(item.domain))) throw new Error('TLC301: state contains an undeclared opaque domain');
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
  const atoms = new Map(symbolicInputDefinitions(model).filter(item => item.kind === 'opaque').map(item => [item.domain, new Map<string, string>()]));
  return Object.fromEntries(model.variables.map(variable => {
    const value = state[variable];
    if (!value) throw new Error('TLC301: incomplete abstract state');
    if (value.kind !== 'data') return [variable, value];
    const domainAtoms = atoms.get(value.domain);
    if (!domainAtoms) throw new Error('TLC301: abstract state contains an undeclared opaque domain');
    let name = domainAtoms.get(value.value);
    if (name === undefined) { name = `a${domainAtoms.size}`; domainAtoms.set(value.value, name); }
    return [variable, { kind: 'data', domain: value.domain, value: name }];
  }));
}

/** Equality and copy commute with atom renaming. Finite inputs retain their complete literal vocabulary. */
export function inspectSymbolicOrbits(input: unknown): {
  kind: 'equality-copy-orbits'; states: SymbolicState[];
  edges: { from: number; input: SymbolicInput; action: string; to: number }[];
  disabled: { state: number; input: SymbolicInput }[];
} {
  const model = validateSymbolicModel(input);
  const states: SymbolicState[] = [canonicalState(model, model.initial)];
  const ids = new Map([[JSON.stringify(states[0]), 0]]);
  const edges: { from: number; input: SymbolicInput; action: string; to: number }[] = [];
  const disabled: { state: number; input: SymbolicInput }[] = [];
  let attempts = 0;
  for (let index = 0; index < states.length; index++) {
    const state = states[index];
    if (!state) throw new Error('TLC301: abstract state disappeared');
    for (const invariant of model.invariants) {
      if (!evaluateGuard(invariant.predicate, state, null)) throw new Error(`TLC302: invariant ${invariant.name} fails in an equality/copy orbit`);
    }
    // [P]_vars means P OR UNCHANGED vars. Its implicit stuttering step always satisfies it.
    let product: Record<string, SymbolicInputFrameValue>[] = [{}];
    for (const input of symbolicInputDefinitions(model)) {
      const atoms = [...new Set(Object.values(state).flatMap(value => value.kind === 'data' && value.domain === input.domain ? [value.value] : []))];
      const choices: readonly SymbolicInputFrameValue[] = input.kind === 'finite' ? input.values : [...atoms, `a${atoms.length}`];
      product = product.flatMap(frame => choices.map(value => ({ ...frame, [input.parameter]: value })));
    }
    const inputs: SymbolicInput[] = model.version === 1 ? product.map(frame => {
      const value = frame[model.input.parameter];
      if (typeof value !== 'string') throw new Error('TLC301: missing opaque orbit input');
      return value;
    }) : product;
    let accepted = 0;
    for (const value of inputs) {
      if (++attempts > 250_000) throw new Error('TLC302: symbolic input-product attempt limit exceeded; no partial success is permitted');
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
