import { generateRust } from '../../src/backends/rust.js';
import { generateOwnedRust } from '../../src/backends/owned-rust.js';
import { generateSymbolicRust } from '../../src/backends/symbolic-rust.js';
import { generateRowRust } from '../../src/backends/row-rust.js';
import { generatePartitionRust } from '../../src/backends/partition-rust.js';
import { FiniteGraphSchema } from '../../src/finite-types.js';
import type { PartitionPlan } from '../../src/partition-types.js';
import { symbolicModel, type SymbolicExpression, type SymbolicGuard } from '../../src/symbolic-types.js';
import { AutomatonSchema, type GeneratedFile } from '../../src/types.js';

const state = (variable: string): SymbolicExpression => ({ kind: 'state', variable });
const scalar = (value: string): SymbolicExpression => ({ kind: 'literal', value: { kind: 'string', value } });
const parameter = (name: string): SymbolicExpression => ({ kind: 'input', parameter: name });
const equal = (left: SymbolicExpression, right: SymbolicExpression): SymbolicGuard => ({ kind: 'equal', left, right });
const unequal = (left: SymbolicExpression, right: SymbolicExpression): SymbolicGuard => ({ kind: 'not-equal', left, right });
const variables = ['phase', 'stored', 'storedProvenance', 'rejected', 'rejectedProvenance'];
const retained = Object.fromEntries(variables.map(name => [name, state(name)]));
const occupied = unequal(state('phase'), scalar('absent'));
const rowModel = symbolicModel({
  version: 2, kind: 'symbolic-owned', name: 'ArtifactRow', checkDeadlock: true, variables,
  inputs: [{ parameter: 'v', domain: 'Values' }, { parameter: 'p', domain: 'Receipts' }], next: 'Next',
  initial: Object.fromEntries(variables.map(name => [name, { kind: 'string', value: name === 'phase' ? 'absent' : 'none' }])),
  branches: [
    { action: 'Insert', guard: equal(state('phase'), scalar('absent')), updates: { ...retained, phase: scalar('present'), stored: parameter('v'), storedProvenance: parameter('p') }, source: null },
    { action: 'Same', guard: { kind: 'and', terms: [occupied, equal(parameter('v'), state('stored'))] }, updates: retained, source: null },
    { action: 'Clash', guard: { kind: 'and', terms: [occupied, unequal(parameter('v'), state('stored'))] }, updates: { ...retained, phase: scalar('conflict'), rejected: parameter('v'), rejectedProvenance: parameter('p') }, source: null },
  ], invariants: [], actionProperties: [],
});

const singleModel = symbolicModel({
  version: 1, kind: 'symbolic-owned', name: 'ArtifactSingle', checkDeadlock: true,
  variables: ['stored'], input: { parameter: 'v', domain: 'Values', next: 'Next' },
  initial: { stored: { kind: 'string', value: 'none' } },
  branches: [{ action: 'Store', guard: { kind: 'boolean', value: true }, updates: { stored: { kind: 'input' } }, source: null }],
  invariants: [], actionProperties: [],
});

const combinations = [[false, false], [true, false], [false, true], [true, true]];
const nodes = combinations.flatMap(([inserted, conflict], index) => {
  const values = { hasInserted: { kind: 'boolean', value: inserted }, hasConflict: { kind: 'boolean', value: conflict } };
  return [
    { id: `s${index}`, values: { phase: { kind: 'string', value: 'Open' }, ...values } },
    { id: `s${index + 4}`, values: { phase: { kind: 'string', value: conflict ? 'ReadyRefused' : inserted ? 'ReadyWrite' : 'ReadyNoop' }, ...values } },
    { id: `s${index + 8}`, values: { phase: { kind: 'string', value: 'Consumed' }, ...values } },
  ];
});
const edges = combinations.flatMap(([inserted, conflict], index) => [
  { from: `s${index}`, event: 'Insert', to: `s${conflict ? 3 : 1}` },
  { from: `s${index}`, event: 'Same', to: `s${index}` },
  { from: `s${index}`, event: 'Clash', to: `s${inserted ? 3 : 2}` },
  { from: `s${index}`, event: conflict ? 'CloseRefused' : inserted ? 'CloseWrite' : 'CloseNoop', to: `s${index + 4}` },
  { from: `s${index + 4}`, event: conflict ? 'ConsumeRefused' : inserted ? 'ConsumeWrite' : 'ConsumeNoop', to: `s${index + 8}` },
]);
const control = FiniteGraphSchema.parse({
  version: 1, kind: 'exact-finite', name: 'ArtifactControl',
  variables: [{ name: 'phase', kind: 'string' }, { name: 'hasInserted', kind: 'boolean' }, { name: 'hasConflict', kind: 'boolean' }],
  nodes, initial: ['s0'], actions: ['Insert', 'Same', 'Clash', 'CloseWrite', 'CloseNoop', 'CloseRefused', 'ConsumeWrite', 'ConsumeNoop', 'ConsumeRefused'], edges,
  source: { dotSha256: 'a'.repeat(64), stateCount: nodes.length, edgeCount: edges.length },
});

const plan: PartitionPlan = {
  version: 1, kind: 'closed-partition-fold', runtimeProfile: 'unbound-partition-v1', control,
  contract: { version: 1, calendar: 'utc-micros-nonnegative-day-v1', families: [{ name: 'Fact', key: ['key'], symbol: 'symbol', time: 'time', datasets: ['facts'] }] },
  row: {
    model: rowModel,
    binding: {
      version: 1, profile: 'rust-whole-row-v1',
      source: { manifest: 'Cargo.toml', module: 'crate::facts', facts: [{ name: 'Fact', rustPath: 'crate::facts::Fact', metadata: ['received'] }] },
      model: { payloadInput: 'v', provenanceInput: 'p', pairs: [{ name: 'stored', payload: 'stored', provenance: 'storedProvenance' }, { name: 'rejected', payload: 'rejected', provenance: 'rejectedProvenance' }] },
    },
    plan: {
      version: 1, profile: 'rust-whole-row-v1', crateName: 'artifact-consumer', sources: [{ path: 'src/lib.rs', sha256: 'a'.repeat(64) }],
      facts: [{ name: 'Fact', rustPath: 'crate::facts::Fact', fields: [
        { name: 'symbol', rustType: 'String', codec: { kind: 'string', getters: [] }, payload: true, provenance: false },
        { name: 'key', rustType: 'i64', codec: { kind: 'i64', getters: [] }, payload: true, provenance: false },
        { name: 'time', rustType: 'i64', codec: { kind: 'i64', getters: [] }, payload: true, provenance: false },
        { name: 'value', rustType: 'i64', codec: { kind: 'i64', getters: [] }, payload: true, provenance: false },
        { name: 'received', rustType: 'i64', codec: { kind: 'i64', getters: [] }, payload: false, provenance: true },
      ] }],
    },
  },
};

const diagnostic = AutomatonSchema.parse({
  version: 1, name: 'ArtifactDiagnostic', stateVariable: 'phase', states: ['New', 'Done'], initialStates: ['New'],
  transitions: [{ from: 'New', event: 'Finish', to: 'Done' }], source: { dotSha256: 'a'.repeat(64), stateCount: 2, edgeCount: 1 },
});

export const rustArtifactCases: { name: string; files: () => GeneratedFile[]; consumer: 'standalone' | 'dependency' | 'adapter' }[] = [
  { name: 'v1 diagnostic', files: () => generateRust({ automaton: diagnostic, binding: { kind: 'transition', function: 'transition' } }), consumer: 'standalone' },
  { name: 'v2 finite-owned', files: () => generateOwnedRust({ automaton: control, className: 'ArtifactControl' }), consumer: 'dependency' },
  { name: 'v3 symbolic-owned', files: () => generateSymbolicRust({ model: singleModel, className: 'ArtifactSingle' }), consumer: 'dependency' },
  { name: 'v4 product-inputs', files: () => generateSymbolicRust({ model: rowModel, className: 'ArtifactProduct' }), consumer: 'dependency' },
  { name: 'v5 row-owned', files: () => generateRowRust({ ...plan.row, className: 'ArtifactRow', rustCrateMode: 'standalone' }), consumer: 'adapter' },
  { name: 'v6 partition-fold', files: () => generatePartitionRust({ plan, className: 'ArtifactPartition', rustCrateMode: 'standalone' }), consumer: 'adapter' },
];

export const consumerFacts = `pub mod facts {
    #[derive(Clone, Debug)]
    pub struct Fact {
        pub symbol: String,
        pub key: i64,
        pub time: i64,
        pub value: i64,
        pub received: i64,
    }

    impl PartialEq for Fact {
        fn eq(&self, other: &Self) -> bool {
            self.symbol == other.symbol
                && self.key == other.key
                && self.time == other.time
                && self.value == other.value
        }
    }

    impl Eq for Fact {}
}
`;
