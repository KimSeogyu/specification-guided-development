import { z } from 'zod';
import { inspectSymbolicOrbits, sameSymbolicValue, stepSymbolic, type SymbolicState } from './symbolic-semantics.js';
import { validateSymbolicModel, type SymbolicExpression, type SymbolicGuard, type SymbolicModelV3, type SymbolicValue } from './symbolic-types.js';

const Identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).refine(value => value !== '__proto__');
export const ResourceProtocolBindingSchema = z.object({
  version: z.literal(1),
  inputs: z.object({ resource: Identifier, event: Identifier }).strict(),
  variables: z.object({
    phase: Identifier, selected: Identifier, loaded: Identifier, prepared: Identifier, attempted: Identifier,
    loadOutcome: Identifier, decision: Identifier, coverage: Identifier, attempts: Identifier, replacements: Identifier, effect: Identifier,
  }).strict(),
}).strict();
export type ResourceProtocolBinding = z.infer<typeof ResourceProtocolBindingSchema>;
export type ResourceCoverage = 'required-before-write' | 'independent';
type Role = keyof ResourceProtocolBinding['variables'];
const phases = ['New', 'Selected', 'Loaded', 'Prepared', 'Attempted', 'Done', 'Failed'];
const roles = ['phase', 'selected', 'loaded', 'prepared', 'attempted', 'loadOutcome', 'decision', 'coverage', 'attempts', 'replacements', 'effect'] satisfies Role[];
const OperationSchema = z.enum(['Select', 'Present', 'NotFound', 'ReadError', 'DecodeError', 'PrepareWrite', 'PrepareNoop', 'PrepareRefused', 'CoverSuccess', 'CoverFailure', 'AttemptWrite', 'AttemptNoop', 'AttemptRefused', 'FinishSuccess', 'FinishFailure', 'Terminal']);
const operations = OperationSchema.options;
type Operation = z.infer<typeof OperationSchema>;
const fail: (message: string) => never = message => { throw new Error(`TLC305: ${message}`); };
const literal = (value: string): SymbolicExpression => ({ kind: 'literal', value: { kind: 'string', value } });
const integer = (value: string): SymbolicExpression => ({ kind: 'literal', value: { kind: 'integer', value } });
const boolean = (value: boolean): SymbolicExpression => ({ kind: 'literal', value: { kind: 'boolean', value } });
const equal = (left: SymbolicExpression, right: SymbolicExpression): SymbolicGuard => ({ kind: 'equal', left, right });
const and = (...terms: SymbolicGuard[]): SymbolicGuard => ({ kind: 'and', terms });
const implies = (left: SymbolicGuard, right: SymbolicGuard): SymbolicGuard => ({ kind: 'implies', left, right });
const member = (value: SymbolicExpression, values: string[]): SymbolicGuard => ({ kind: 'member', value, elements: values.map(value => ({ kind: 'string', value })) });

function parseInput(input: { model: unknown; binding: unknown; coverage: ResourceCoverage }): { model: SymbolicModelV3; binding: ResourceProtocolBinding; coverage: ResourceCoverage } {
  if (input.coverage !== 'required-before-write' && input.coverage !== 'independent') return fail('resource coverage composition must be explicit');
  const parsed = ResourceProtocolBindingSchema.safeParse(input.binding);
  if (!parsed.success) return fail(`invalid resource role binding: ${parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  let model;
  try { model = validateSymbolicModel(input.model); }
  catch (error) { return fail(`invalid resource model: ${error instanceof Error ? error.message : String(error)}`); }
  const binding = parsed.data;
  if (model.version !== 3 || model.inputs.length !== 2) return fail('resource protocol requires mixed IR v3 with exactly one opaque resource and one finite event input');
  const resource = model.inputs.find(value => value.parameter === binding.inputs.resource);
  const event = model.inputs.find(value => value.parameter === binding.inputs.event);
  if (resource?.kind !== 'opaque' || event?.kind !== 'finite') return fail('resource and event roles must bind distinct opaque and finite inputs');
  if (event.values.some(value => value.kind !== 'string')) return fail('resource event input must be a finite string vocabulary');
  const variables = Object.values(binding.variables);
  if (variables.length !== model.variables.length || new Set(variables).size !== variables.length || variables.some(variable => !model.variables.includes(variable))) return fail('resource roles must bijectively bind all eleven model variables');
  return { model, binding, coverage: input.coverage };
}

/** Normalize only the admitted expression grammar: associative/commutative and/or,
 * symmetric equality/inequality and finite-set order. Do not simplify or infer
 * logically equivalent formulas. Each required invariant must retain its complete
 * conjunct group in one configured predicate; each temporal requirement must be
 * a configured square-action predicate. Alternative forms need a profile extension. */
function normalGuard(guard: SymbolicGuard): string {
  const expression = (value: SymbolicExpression): string => JSON.stringify(value);
  switch (guard.kind) {
    case 'and': case 'or': {
      const kind = guard.kind;
      const flatten = (term: SymbolicGuard): SymbolicGuard[] => term.kind === kind ? term.terms.flatMap(flatten) : [term];
      return JSON.stringify([kind, ...guard.terms.flatMap(flatten).map(normalGuard).sort()]);
    }
    case 'equal': case 'not-equal': return JSON.stringify([guard.kind, ...[expression(guard.left), expression(guard.right)].sort()]);
    case 'member': return JSON.stringify([guard.kind, expression(guard.value), ...guard.elements.map(value => JSON.stringify(value)).sort()]);
    case 'in-domain': return JSON.stringify([guard.kind, expression(guard.value), guard.domain]);
    case 'boolean': return JSON.stringify([guard.kind, guard.value]);
    case 'not': return JSON.stringify([guard.kind, normalGuard(guard.term)]);
    case 'implies': case 'equivalent': return JSON.stringify([guard.kind, normalGuard(guard.left), normalGuard(guard.right)]);
  }
}

function sourceObligations(binding: ResourceProtocolBinding): { invariants: { role: string; predicate: SymbolicGuard }[]; terminal: SymbolicGuard; coverage: SymbolicGuard } {
  const state = (role: Role): SymbolicExpression => ({ kind: 'state', variable: binding.variables[role] });
  const next = (role: Role): SymbolicExpression => ({ kind: 'next-state', variable: binding.variables[role] });
  const notNone = (role: Role): SymbolicGuard => ({ kind: 'not-equal', left: state(role), right: literal('none') });
  return {
    invariants: [
      { role: 'affinity', predicate: and(
        implies(notNone('loaded'), equal(state('loaded'), state('selected'))),
        implies(notNone('prepared'), equal(state('prepared'), state('loaded'))),
        implies(notNone('attempted'), equal(state('attempted'), state('prepared'))),
      ) },
      { role: 'read origin', predicate: and(
        implies(notNone('loaded'), member(state('loadOutcome'), ['Present', 'NotFound'])),
        implies(member(state('loadOutcome'), ['ReadError', 'DecodeError']), and(equal(state('loaded'), literal('none')), equal(state('phase'), literal('Failed')))),
      ) },
      { role: 'Write-only replacement', predicate: and(
        implies(equal(state('replacements'), integer('1')), and(equal(state('decision'), literal('Write')), equal(state('effect'), literal('Write')), equal(state('attempts'), integer('1')), equal(state('phase'), literal('Done')))),
        implies(member(state('decision'), ['Noop', 'Refused']), equal(state('replacements'), integer('0'))),
        implies(equal(state('attempts'), integer('0')), equal(state('replacements'), integer('0'))),
      ) },
    ],
    terminal: implies(member(state('phase'), ['Done', 'Failed']), and(...roles.map(role => equal(next(role), state(role))))),
    coverage: implies(and(equal(state('attempts'), integer('0')), equal(next('attempts'), integer('1')), equal(next('effect'), literal('Write'))), equal(state('coverage'), boolean(true))),
  };
}

/** Configured lowered predicates are checked as source expressions, not by names
 * or hashes. This assumes supplied IR faithfully represents its source; it does
 * not establish SANY/TLC provenance or authenticate any native resource. */
export function validateResourceProtocolSource(input: { model: unknown; binding: unknown; coverage: ResourceCoverage }): void {
  const { model, binding, coverage } = parseInput(input);
  const required = sourceObligations(binding);
  for (const obligation of required.invariants) {
    if (!model.invariants.some(invariant => normalGuard(invariant.predicate) === normalGuard(obligation.predicate))) return fail(`missing configured ${obligation.role} source obligation in the supported normalized expression form`);
  }
  for (const [role, predicate] of [['terminal preservation', required.terminal], ...(coverage === 'required-before-write' ? [['coverage before Write attempt', required.coverage] satisfies [string, SymbolicGuard]] : [])] satisfies [string, SymbolicGuard][]) {
    if (!model.actionProperties.some(property => normalGuard(property.predicate) === normalGuard(predicate))) return fail(`missing configured ${role} square-action source obligation in the supported normalized expression form`);
  }
}

function expectedInitial(binding: ResourceProtocolBinding): SymbolicState {
  const values: Record<Role, SymbolicValue> = {
    phase: { kind: 'string', value: 'New' }, selected: { kind: 'string', value: 'none' }, loaded: { kind: 'string', value: 'none' }, prepared: { kind: 'string', value: 'none' }, attempted: { kind: 'string', value: 'none' },
    loadOutcome: { kind: 'string', value: 'none' }, decision: { kind: 'string', value: 'none' }, coverage: { kind: 'boolean', value: false }, attempts: { kind: 'integer', value: '0' }, replacements: { kind: 'integer', value: '0' }, effect: { kind: 'string', value: 'none' },
  };
  return Object.fromEntries(roles.map(role => [binding.variables[role], values[role]]));
}

function sameState(variables: readonly string[], left: SymbolicState, right: SymbolicState): boolean {
  return variables.every(variable => {
    const a = left[variable]; const b = right[variable];
    return a !== undefined && b !== undefined && sameSymbolicValue(a, b);
  });
}

/** Complete role transitions, without event or action spelling. The association
 * between finite inputs and these operations is inferred from actual behavior. */
function expectedSteps(input: { state: SymbolicState; resource: SymbolicValue; binding: ResourceProtocolBinding; coverage: ResourceCoverage }): Map<Operation, SymbolicState> {
  const { state, resource, binding, coverage } = input;
  const value = (role: Role): SymbolicValue => state[binding.variables[role]] ?? fail(`missing ${role} state`);
  const is = (role: Role, expected: string): boolean => value(role).value === expected;
  const phase = value('phase');
  if (phase.kind !== 'string' || !phases.includes(phase.value)) return fail('unsupported resource phase');
  const expected = new Map<Operation, SymbolicState>();
  const add = (operation: Operation, changes: Partial<Record<Role, SymbolicValue>>): void => {
    const next = { ...state };
    for (const role of roles) { const changed = changes[role]; if (changed !== undefined) next[binding.variables[role]] = changed; }
    expected.set(operation, next);
  };
  const string = (value: string): SymbolicValue => ({ kind: 'string', value });
  if (phase.value === 'Done' || phase.value === 'Failed') { add('Terminal', {}); return expected; }
  if (phase.value === 'New') {
    add('Select', { phase: string('Selected'), selected: resource }); return expected;
  }
  if (!sameSymbolicValue(value('selected'), resource)) return expected;
  if (phase.value === 'Selected') {
    for (const outcome of ['Present', 'NotFound'] satisfies Operation[]) add(outcome, { phase: string('Loaded'), loaded: resource, loadOutcome: string(outcome) });
    for (const outcome of ['ReadError', 'DecodeError'] satisfies Operation[]) add(outcome, { phase: string('Failed'), loadOutcome: string(outcome) });
    return expected;
  }
  if (phase.value === 'Loaded') {
    for (const [operation, decision] of [['PrepareWrite', 'Write'], ['PrepareNoop', 'Noop'], ['PrepareRefused', 'Refused']] satisfies [Operation, string][]) add(operation, { phase: string('Prepared'), prepared: value('loaded'), decision: string(decision) });
    return expected;
  }
  if (phase.value === 'Prepared') {
    if (value('coverage').value === false) { add('CoverSuccess', { coverage: { kind: 'boolean', value: true } }); add('CoverFailure', { phase: string('Failed') }); }
    for (const [operation, decision, effect] of [['AttemptWrite', 'Write', 'Write'], ['AttemptNoop', 'Noop', 'None'], ['AttemptRefused', 'Refused', 'Diagnostic']] satisfies [Operation, string, string][]) {
      if (!is('decision', decision) || !is('attempts', '0') || (decision === 'Write' && coverage === 'required-before-write' && value('coverage').value !== true)) continue;
      add(operation, { phase: string(decision === 'Noop' ? 'Done' : 'Attempted'), attempted: resource, attempts: { kind: 'integer', value: '1' }, effect: string(effect) });
    }
    return expected;
  }
  if (phase.value === 'Attempted') {
    add('FinishFailure', { phase: string('Failed') });
    if (is('effect', 'Write')) add('FinishSuccess', { phase: string('Done'), replacements: { kind: 'integer', value: '1' } });
    else if (is('effect', 'Diagnostic')) add('FinishSuccess', { phase: string('Done') });
    else return fail('unsupported attempted effect');
    return expected;
  }
  return fail('unmatched resource role state');
}

/** Abstract equality/copy evidence only. No generated code, real loaded origin,
 * native writer, archive coverage, filesystem authority or TLC provenance is
 * established by this library check. All accepted AND disabled input orbits are
 * compared with the admitted relation, so removing progress is not a proof. */
export function validateResourceProtocol(input: { model: unknown; binding: unknown; coverage: ResourceCoverage }) {
  const { model, binding, coverage } = parseInput(input);
  validateResourceProtocolSource({ model, binding, coverage });
  if (!sameState(model.variables, model.initial, expectedInitial(binding))) return fail('resource protocol must initialize every role to its exact supported sentinel or count');
  let proof;
  try { proof = inspectSymbolicOrbits(model); }
  catch (error) { return fail(`resource relation cannot be exhaustively inspected: ${error instanceof Error ? error.message : String(error)}`); }
  const resourceInput = model.inputs.find(value => value.parameter === binding.inputs.resource);
  if (resourceInput?.kind !== 'opaque') return fail('missing opaque resource input');
  const observations: { before: SymbolicState; event: string; expected: Map<Operation, SymbolicState>; actual: ReturnType<typeof stepSymbolic> }[] = [];
  const eventRoles = new Map<string, Operation>();
  for (const observation of [...proof.edges.map(edge => ({ state: edge.from, input: edge.input })), ...proof.disabled]) {
    const before = proof.states[observation.state];
    if (!before || typeof observation.input !== 'object') return fail('missing complete resource orbit input');
    const identity = observation.input[binding.inputs.resource]; const event = observation.input[binding.inputs.event];
    if (typeof identity !== 'string' || typeof event !== 'object' || event.kind !== 'string') return fail('resource input orbit has incorrect scalar kinds');
    const expected = expectedSteps({ state: before, resource: { kind: 'data', domain: resourceInput.domain, value: identity }, binding, coverage });
    // Orbit endpoint states are canonicalized independently. Re-evaluate the
    // original input to preserve identity comparisons across this transition.
    const actual = stepSymbolic(model, before, observation.input);
    if (actual.kind === 'accepted') {
      const matches = [...expected].filter(([, next]) => sameState(model.variables, actual.state, next));
      const operation = matches.length === 1 ? matches[0]?.[0] : undefined;
      if (!operation) return fail(`resource transition at ${String(before[binding.variables.phase]?.value)}/${event.value} violates the complete supported role relation`);
      const previous = eventRoles.get(event.value);
      if (previous !== undefined && previous !== operation) return fail(`finite event ${event.value} has inconsistent operation roles`);
      eventRoles.set(event.value, operation);
    } else if (actual.kind !== 'disabled') return fail('ambiguous resource transition');
    observations.push({ before, event: event.value, expected, actual });
  }
  for (const operation of operations) if (![...eventRoles.values()].includes(operation)) return fail(`resource protocol omits meaningful ${operation} progress`);
  for (const observation of observations) {
    const operation = eventRoles.get(observation.event);
    const expected = operation === undefined ? undefined : observation.expected.get(operation);
    const { actual } = observation;
    if (expected === undefined ? actual.kind !== 'disabled' : actual.kind !== 'accepted' || !sameState(model.variables, actual.state, expected)) return fail(`resource transition at ${String(observation.before[binding.variables.phase]?.value)}/${observation.event} omits or exceeds its inferred ${operation ?? 'disabled'} role`);
  }
  return {
    version: 1, kind: 'abstract-resource-protocol', storageAuthority: false,
    scope: 'complete-equality-copy-orbits', coverage, model, binding, proof,
  } satisfies { version: 1; kind: 'abstract-resource-protocol'; storageAuthority: false; scope: 'complete-equality-copy-orbits'; coverage: ResourceCoverage; model: SymbolicModelV3; binding: ResourceProtocolBinding; proof: ReturnType<typeof inspectSymbolicOrbits> };
}
