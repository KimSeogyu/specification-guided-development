import type { ExactFiniteAutomaton } from '../src/finite-types.js';
import type { PartitionPlan } from '../src/partition-types.js';
import { symbolicModel, type SymbolicExpression, type SymbolicGuard, type SymbolicModelV2 } from '../src/symbolic-types.js';

const state = (variable: string): SymbolicExpression => ({ kind: 'state', variable });
const scalar = (value: string): SymbolicExpression => ({ kind: 'literal', value: { kind: 'string', value } });
const input = (parameter: string): SymbolicExpression => ({ kind: 'input', parameter });
const equal = (left: SymbolicExpression, right: SymbolicExpression): SymbolicGuard => ({ kind: 'equal', left, right });
const and = (...terms: SymbolicGuard[]): SymbolicGuard => ({ kind: 'and', terms });

export function partitionRowModel(): SymbolicModelV2 {
  const variables = ['phase', 'stored', 'storedProvenance', 'rejected', 'rejectedProvenance'];
  const unchanged = Object.fromEntries(variables.map(variable => [variable, state(variable)]));
  const occupied: SymbolicGuard = { kind: 'member', value: state('phase'), elements: ['present', 'conflict'].map(value => ({ kind: 'string', value })) };
  return symbolicModel({
    version: 2, kind: 'symbolic-owned', name: 'PartitionRow', checkDeadlock: true, variables,
    inputs: [{ parameter: 'v', domain: 'Values' }, { parameter: 'p', domain: 'Receipts' }], next: 'Next',
    initial: Object.fromEntries(variables.map(variable => [variable, { kind: 'string', value: variable === 'phase' ? 'absent' : 'none' }])),
    branches: [
      { action: 'Insert', guard: equal(state('phase'), scalar('absent')), updates: { ...unchanged, phase: scalar('present'), stored: input('v'), storedProvenance: input('p') }, source: null },
      { action: 'Same', guard: and(occupied, equal(input('v'), state('stored'))), updates: unchanged, source: null },
      { action: 'Clash', guard: and(occupied, { kind: 'not-equal', left: input('v'), right: state('stored') }), updates: { ...unchanged, phase: scalar('conflict'), rejected: input('v'), rejectedProvenance: input('p') }, source: null },
    ], invariants: [], actionProperties: [],
  });
}

/** Direct test IR; its source fields do not attest a TLC run. */
export function partitionControl(): ExactFiniteAutomaton {
  const nodes: ExactFiniteAutomaton['nodes'] = [];
  const edges: ExactFiniteAutomaton['edges'] = [];
  const states = new Map<string, string>();
  const key = (phase: string, inserted: boolean, conflict: boolean) => JSON.stringify([phase, inserted, conflict]);
  const add = (phase: string, inserted: boolean, conflict: boolean): string => {
    const id = `s${nodes.length}`;
    states.set(key(phase, inserted, conflict), id);
    nodes.push({ id, values: { phase: { kind: 'string', value: phase }, hasInserted: { kind: 'boolean', value: inserted }, hasConflict: { kind: 'boolean', value: conflict } } });
    return id;
  };
  const lookup = (phase: string, inserted: boolean, conflict: boolean): string => {
    const id = states.get(key(phase, inserted, conflict));
    if (!id) throw new Error('Incomplete partition test fixture');
    return id;
  };
  for (const [inserted, conflict] of [[false, false], [true, false], [false, true], [true, true]] satisfies [boolean, boolean][]) {
    add('Open', inserted, conflict);
    add(conflict ? 'ReadyRefused' : inserted ? 'ReadyWrite' : 'ReadyNoop', inserted, conflict);
    add('Consumed', inserted, conflict);
  }
  for (const [inserted, conflict] of [[false, false], [true, false], [false, true], [true, true]] satisfies [boolean, boolean][]) {
    const from = lookup('Open', inserted, conflict);
    const kind = conflict ? 'Refused' : inserted ? 'Write' : 'Noop';
    const ready = lookup(`Ready${kind}`, inserted, conflict);
    edges.push({ from, event: 'Insert', to: lookup('Open', true, conflict) }, { from, event: 'Same', to: from }, { from, event: 'Clash', to: lookup('Open', inserted, true) }, { from, event: `Close${kind}`, to: ready }, { from: ready, event: `Consume${kind}`, to: lookup('Consumed', inserted, conflict) });
  }
  return {
    version: 1, kind: 'exact-finite', name: 'PartitionControl',
    variables: [{ name: 'phase', kind: 'string' }, { name: 'hasInserted', kind: 'boolean' }, { name: 'hasConflict', kind: 'boolean' }],
    nodes, initial: [lookup('Open', false, false)],
    actions: ['Insert', 'Same', 'Clash', 'CloseWrite', 'CloseNoop', 'CloseRefused', 'ConsumeWrite', 'ConsumeNoop', 'ConsumeRefused'], edges,
    source: { dotSha256: 'a'.repeat(64), stateCount: nodes.length, edgeCount: edges.length },
  };
}

export function partitionPlan(): PartitionPlan {
  return {
    version: 1, kind: 'closed-partition-fold', runtimeProfile: 'unbound-partition-v1',
    contract: { version: 1, calendar: 'utc-micros-nonnegative-day-v1', families: [{ name: 'Fact', key: ['key'], symbol: 'symbol', time: 'time', datasets: ['fact'] }] },
    row: {
      model: partitionRowModel(),
      binding: { version: 1, profile: 'rust-whole-row-v1', source: { manifest: 'Cargo.toml', module: 'crate::facts', facts: [{ name: 'Fact', rustPath: 'crate::facts::Fact', metadata: ['received'] }] }, model: { payloadInput: 'v', provenanceInput: 'p', pairs: [{ name: 'stored', payload: 'stored', provenance: 'storedProvenance' }, { name: 'rejected', payload: 'rejected', provenance: 'rejectedProvenance' }] } },
      plan: { version: 1, profile: 'rust-whole-row-v1', crateName: 'partition-consumer', sources: [{ path: 'src/facts.rs', sha256: 'a'.repeat(64) }], facts: [{ name: 'Fact', rustPath: 'crate::facts::Fact', fields: [
        { name: 'symbol', rustType: 'String', codec: { kind: 'string', getters: [] }, payload: true, provenance: false },
        { name: 'key', rustType: 'i64', codec: { kind: 'i64', getters: [] }, payload: true, provenance: false },
        { name: 'time', rustType: 'i64', codec: { kind: 'i64', getters: [] }, payload: true, provenance: false },
        { name: 'value', rustType: 'i64', codec: { kind: 'i64', getters: [] }, payload: true, provenance: false },
        { name: 'schema', rustType: 'u32', codec: { kind: 'u32', getters: [] }, payload: true, provenance: true, classes: [[1, 2]] },
        { name: 'received', rustType: 'i64', codec: { kind: 'i64', getters: [] }, payload: false, provenance: true },
      ] }] },
    },
    control: partitionControl(),
  };
}
