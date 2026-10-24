import { validateExecutableGraph, type ExactFiniteAutomaton } from './finite-types.js';
import { validateWholeRowBinding } from './row-binding.js';
import { inspectSymbolicOrbits, sameSymbolicValue, stepSymbolic } from './symbolic-semantics.js';
import { type SymbolicValue } from './symbolic-types.js';
import { PartitionPlanSchema, type PartitionPlan } from './partition-types.js';
import type { ParsedSymbolicConfig } from './finite-tlc.js';
import type { SanyExpression, SanyModule } from './sany-xml.js';

const fail: (message: string) => never = message => { throw new Error(`TLC306: ${message}`); };
const observations = ['Insert', 'Same', 'Clash'];
const actions = [...observations, 'CloseWrite', 'CloseNoop', 'CloseRefused', 'ConsumeWrite', 'ConsumeNoop', 'ConsumeRefused'];
const phases = ['Open', 'ReadyWrite', 'ReadyNoop', 'ReadyRefused', 'Consumed'];

// Transparent semantic-expression profile. This checks source obligations as
// expressions; the complete graph laws below independently check behavior.
const obligations = {
  TypeOK: String.raw`$ConjList(\in(phase,$SetEnumerate("Open","ReadyWrite","ReadyNoop","ReadyRefused","Consumed")),\in(hasInserted,BOOLEAN()),\in(hasConflict,BOOLEAN()))`,
  CloseAdmission: String.raw`$ConjList(=>(=(phase,"ReadyWrite"),\land(hasInserted,\lnot(hasConflict))),=>(=(phase,"ReadyNoop"),\land(\lnot(hasInserted),\lnot(hasConflict))),=>(=(phase,"ReadyRefused"),hasConflict))`,
  CloseChoice: String.raw`=>(=(phase,"Open"),$DisjList($ConjList(ENABLED(CloseWrite),\lnot(ENABLED(CloseNoop)),\lnot(ENABLED(CloseRefused))),$ConjList(\lnot(ENABLED(CloseWrite)),ENABLED(CloseNoop),\lnot(ENABLED(CloseRefused))),$ConjList(\lnot(ENABLED(CloseWrite)),\lnot(ENABLED(CloseNoop)),ENABLED(CloseRefused))))`,
  NoInputAfterClose: String.raw`=>(/=(phase,"Open"),\lnot(ENABLED(\lor(\lor(Insert,Same),Clash))))`,
  SingleConsumption: String.raw`=>(=(phase,"Consumed"),\lnot(ENABLED(\lor(\lor(ConsumeWrite,ConsumeNoop),ConsumeRefused))))`,
  ConflictSticky: String.raw`[]($SquareAct(=>(hasConflict,'(hasConflict)),$Tuple(phase,hasInserted,hasConflict)))`,
  InsertSticky: String.raw`[]($SquareAct(=>(hasInserted,'(hasInserted)),$Tuple(phase,hasInserted,hasConflict)))`,
  NoReopen: String.raw`[]($SquareAct(=>(/=(phase,"Open"),/=('(phase),"Open")),$Tuple(phase,hasInserted,hasConflict)))`,
};

/** Initial source profile is intentionally syntactic after SANY identity resolution.
 * Equivalent formulas outside this grammar require a profile extension. */
export function validatePartitionControlSource(input: { semantic: SanyModule; config: ParsedSymbolicConfig }): void {
  const invariants = ['TypeOK', 'CloseAdmission', 'CloseChoice', 'NoInputAfterClose', 'SingleConsumption'];
  const properties = ['ConflictSticky', 'InsertSticky', 'NoReopen'];
  if (input.config.checkDeadlock || invariants.some(name => !input.config.invariants.includes(name)) || properties.some(name => !input.config.properties.includes(name))) return fail('partition control configuration must check all supported admission and temporal obligations with terminal deadlock disabled');
  const form = (expression: SanyExpression, visiting: ReadonlySet<string> = new Set()): string => {
    if (expression.kind === 'literal') return JSON.stringify(expression.value.value);
    if (expression.kind !== 'apply' || expression.bounded.length || expression.unbounded.length) return fail('unsupported partition obligation expression');
    const symbol = input.semantic.symbols.get(expression.operator.uid);
    if (!symbol) return fail('partition obligation lacks SANY identity');
    if (symbol.kind === 'variable' && expression.arguments.length === 0) return symbol.name;
    if (symbol.kind === 'definition') {
      if (actions.includes(symbol.name) && symbol.arity === 0 && expression.arguments.length === 0) return symbol.name;
      if (symbol.arity !== 0 || symbol.recursive || visiting.has(symbol.uid) || expression.arguments.length) return fail('unsupported partition obligation helper');
      return form(symbol.body, new Set([...visiting, symbol.uid]));
    }
    if (symbol.kind !== 'builtin') return fail('unsupported symbol in partition obligation');
    return `${symbol.name}(${expression.arguments.map(argument => form(argument, visiting)).join(',')})`;
  };
  for (const [name, expected] of Object.entries(obligations)) {
    const matches = input.semantic.definitions.filter(definition => definition.name === name);
    const definition = matches[0];
    if (matches.length !== 1 || !definition || definition.arity || definition.recursive || form(definition.body) !== expected) return fail(`partition obligation ${name} is outside the supported semantic-expression profile; restore its checked expression`);
  }
}

/** Check the entire concrete relation, including successful self-edge observations. */
export function validatePartitionControl(input: unknown): ExactFiniteAutomaton {
  const graph = validateExecutableGraph(input);
  if (graph.variables.length !== 3 || !graph.variables.some(variable => variable.name === 'phase' && variable.kind === 'string') ||
    ['hasInserted', 'hasConflict'].some(name => !graph.variables.some(variable => variable.name === name && variable.kind === 'boolean'))) return fail('partition control requires exactly phase, hasInserted, and hasConflict');
  if (graph.actions.length !== actions.length || actions.some(action => !graph.actions.includes(action))) return fail('partition control requires the exact observation, close, and consume action vocabulary');
  const valuation = (id: string) => {
    const node = graph.nodes.find(candidate => candidate.id === id);
    const phase = node?.values.phase; const inserted = node?.values.hasInserted; const conflict = node?.values.hasConflict;
    if (phase?.kind !== 'string' || !phases.includes(phase.value) || inserted?.kind !== 'boolean' || conflict?.kind !== 'boolean') return fail('unsupported partition control valuation');
    return { phase: phase.value, inserted: inserted.value, conflict: conflict.value };
  };
  const initialId = graph.initial[0];
  if (!initialId) return fail('partition control requires one initial state');
  const initial = valuation(initialId);
  if (initial.phase !== 'Open' || initial.inserted || initial.conflict) return fail('partition control must start open without observations');
  for (const node of graph.nodes) {
    const before = valuation(node.id);
    const expected = new Map<string, typeof before>();
    if (before.phase === 'Open') {
      expected.set('Insert', { ...before, inserted: true });
      expected.set('Same', before);
      expected.set('Clash', { ...before, conflict: true });
      const kind = before.conflict ? 'Refused' : before.inserted ? 'Write' : 'Noop';
      expected.set(`Close${kind}`, { ...before, phase: `Ready${kind}` });
    } else if (before.phase !== 'Consumed') {
      const kind = before.phase.slice('Ready'.length);
      if (kind !== (before.conflict ? 'Refused' : before.inserted ? 'Write' : 'Noop')) return fail('ready state contradicts its complete observation flags');
      expected.set(`Consume${kind}`, { ...before, phase: 'Consumed' });
    }
    const actual = new Map(graph.edges.filter(edge => edge.from === node.id).map(edge => [edge.event, edge.to]));
    if (actual.size !== expected.size) return fail(`partition control ${node.id} has missing or extra actions`);
    for (const [event, after] of expected) {
      const to = actual.get(event);
      if (!to || JSON.stringify(valuation(to)) !== JSON.stringify(after)) return fail(`partition control ${node.id}/${event} violates the closed fold protocol`);
    }
  }
  return graph;
}

/** Runtime library entry points validate supplied IR; this is not TLC provenance. */
export function validatePartitionPlan(input: unknown): PartitionPlan {
  const parsed = PartitionPlanSchema.safeParse(input);
  if (!parsed.success) return fail(`invalid partition plan: ${parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  const plan = parsed.data;
  const row = validateWholeRowBinding(plan.row);
  validatePartitionControl(plan.control);
  const { model, binding } = row;
  const stored = binding.model.pairs.find(pair => pair.name === 'stored');
  const rejected = binding.model.pairs.find(pair => pair.name === 'rejected');
  if (!stored || !rejected) return fail('partition row roles are absent');
  const pairVariables = [stored.payload, stored.provenance, rejected.payload, rejected.provenance];
  if (model.variables.length !== 5 || !model.variables.includes('phase') || pairVariables.includes('phase') || new Set(pairVariables).size !== 4 || pairVariables.some(name => !model.variables.includes(name))) return fail('partition row model must contain only phase and two complete row pairs');
  if (model.initial.phase?.kind !== 'string' || model.initial.phase.value !== 'absent') return fail('partition row model must start absent with empty scalar sentinels');
  const rowActions = new Set(model.branches.map(branch => branch.action));
  if (rowActions.size !== observations.length || observations.some(action => !rowActions.has(action))) return fail('partition rows require exactly Insert, Same, and Clash');
  const proof = inspectSymbolicOrbits(model);
  if (proof.disabled.length !== 0) return fail('every supported row input must be admitted in every reachable orbit');
  for (const edge of proof.edges) {
    const before = proof.states[edge.from];
    if (!before || typeof edge.input !== 'object') return fail('partition rows require product input orbits');
    const payload = model.inputs.find(parameter => parameter.parameter === binding.model.payloadInput);
    const provenance = model.inputs.find(parameter => parameter.parameter === binding.model.provenanceInput);
    const payloadAtom = edge.input[binding.model.payloadInput]; const provenanceAtom = edge.input[binding.model.provenanceInput];
    if (!payload || !provenance || typeof payloadAtom !== 'string' || typeof provenanceAtom !== 'string') return fail('row orbit inputs must be complete opaque identities');
    const inputPayload: SymbolicValue = { kind: 'data', domain: payload.domain, value: payloadAtom };
    const inputProvenance: SymbolicValue = { kind: 'data', domain: provenance.domain, value: provenanceAtom };
    const oldPayload = before[stored.payload];
    if (!oldPayload) return fail('stored row payload is absent');
    const phase = before.phase;
    if (phase?.kind !== 'string' || !['absent', 'present', 'conflict'].includes(phase.value)) return fail('unsupported partition row phase');
    const action = phase.value === 'absent' ? 'Insert' : sameSymbolicValue(oldPayload, inputPayload) ? 'Same' : 'Clash';
    const expected = { ...before };
    if (action === 'Insert') {
      expected.phase = { kind: 'string', value: 'present' };
      expected[stored.payload] = inputPayload; expected[stored.provenance] = inputProvenance;
      for (const name of [rejected.payload, rejected.provenance]) {
        const empty = model.initial[name];
        if (!empty) return fail('initial rejected row sentinel is absent');
        expected[name] = empty;
      }
    } else if (action === 'Clash') {
      expected.phase = { kind: 'string', value: 'conflict' };
      expected[rejected.payload] = inputPayload; expected[rejected.provenance] = inputProvenance;
    }
    // Step before canonical atom renaming so old and incoming identities stay comparable.
    const actual = stepSymbolic(model, before, edge.input);
    if (actual.kind !== 'accepted' || actual.action !== action || model.variables.some(name => {
      const left = actual.state[name]; const right = expected[name];
      return !left || !right || !sameSymbolicValue(left, right);
    })) return fail(`row action ${edge.action} does not implement its complete ${action} role`);
  }
  if (plan.contract.families.length !== row.plan.facts.length) return fail('partition families must map every source Fact exactly once');
  for (const family of plan.contract.families) {
    const fact = row.plan.facts.find(candidate => candidate.name === family.name);
    if (!fact) return fail(`partition family ${family.name} has no audited source Fact`);
    for (const name of [...family.key, family.time]) {
      const field = fact.fields.find(candidate => candidate.name === name);
      if (!field || field.codec.kind !== 'i64' || !field.payload || field.classes) return fail(`${family.name}.${name} must be an exact raw i64 payload projection`);
    }
    const symbol = fact.fields.find(field => field.name === family.symbol);
    if (!symbol || symbol.codec.kind !== 'string' || !symbol.payload || symbol.classes) return fail(`${family.name}.${family.symbol} must be an exact string payload projection`);
  }
  return plan;
}
