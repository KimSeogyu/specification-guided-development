import assert from 'node:assert/strict';
import test from 'node:test';
import { checkContractClosure, ContractGraphError, lowerStructuralContracts } from '../src/contract-graph.js';
import { ContractBindingsSchema, ContractDeclarationsSchema, ContractProjectSchema, type ContractDeclarations } from '../src/contract-types.js';
import type { SanyDefinition, SanyExpression, SanyModule, SanySymbol } from '../src/sany-xml.js';

const relation = {
  id: 'EnvelopePayload', kind: 'enabled-input-erasure', upper: 'Payload', lower: 'Envelope',
  variables: { phase: 'phase', stored: 'stored', rejected: 'rejected' }, inputs: { v: 'v' },
  actions: { Insert: 'Insert', Same: 'Same', Clash: 'Clash' },
};
const baseline = ContractDeclarationsSchema.parse({ version: 1, scope: 'model-composition', contracts: ['Payload', 'Envelope'], relations: [relation], native: [] });
const models = { Payload: { project: 'payload.json' }, Envelope: { project: 'envelope.json' } };
const bindings = { version: 1, bindings: {} };
const writer = { id: 'PartitionWriter', kind: 'resource-authority', owner: 'Envelope', role: 'writer' };

// Semantic-constructor fixtures test only the pure lowerer, not SANY execution or provenance.
function semanticFixture(declarations: ContractDeclarations = baseline) {
  const symbols = new Map<string, SanySymbol>();
  for (const name of ['$RcdConstructor', '$Pair', '$Tuple', '$SetEnumerate']) {
    symbols.set(name, { kind: 'builtin', uid: name, name, arity: -1, parameters: [], source: null, level: 0 });
  }
  const literal = (value: string | number): SanyExpression => ({ kind: 'literal', value: typeof value === 'number'
    ? { kind: 'integer', value: String(value) } : { kind: 'string', value }, source: null, level: 0 });
  const apply = (name: string, arguments_: readonly SanyExpression[]): SanyExpression => ({ kind: 'apply',
    operator: { uid: name, name, kind: 'builtin' }, arguments: arguments_, bounded: [], unbounded: [], source: null, level: 0 });
  const record = (pairs: readonly [string, SanyExpression][]): SanyExpression => apply('$RcdConstructor', pairs.map(([name, value]) => apply('$Pair', [literal(name), value])));
  const value = (input: unknown): SanyExpression => {
    if (typeof input === 'number' || typeof input === 'string') return literal(input);
    if (Array.isArray(input)) return apply('$Tuple', input.map(value));
    if (typeof input === 'object' && input !== null) return record(Object.entries(input).map(([name, item]) => [name, value(item)]));
    throw new Error('Unsupported test fixture value');
  };
  const body = record(Object.entries(declarations).map(([name, item]) => [name, name === 'contracts'
    ? apply('$SetEnumerate', declarations.contracts.map(literal)) : value(item)]));
  const definition: SanyDefinition = { kind: 'definition', uid: 'definition', name: 'SGDContracts', arity: 0, parameters: [], recursive: false,
    source: { module: 'SystemContracts', beginLine: 2, beginColumn: 1, endLine: 10, endColumn: 1 }, level: 0, body };
  symbols.set(definition.uid, definition);
  const module: SanyModule = { root: 'SystemContracts', modules: [{ kind: 'module', uid: 'module', name: 'SystemContracts', source: null, level: 0,
    members: [{ uid: definition.uid, name: definition.name, kind: 'definition' }], unsupported: [] }], symbols, definitions: [definition], constants: [], variables: [] };
  return { module, definition, symbols, literal, apply, record };
}
const lower = (semantic: SanyModule) => lowerStructuralContracts({ semantic, module: 'SystemContracts', operator: 'SGDContracts' });
const closure = (candidate: unknown = baseline, accepted: unknown = baseline, selectors: unknown = bindings, references: unknown = models) =>
  checkContractClosure({ baseline: accepted, candidate, bindings: selectors, models: references });

test('literal contract extraction preserves name mappings and empty native tuples without producing evidence', () => {
  const fixture = semanticFixture();
  const result = lower(fixture.module);
  assert.deepEqual(result, { ...baseline, contracts: ['Envelope', 'Payload'] });
  assert.equal(Object.hasOwn(result, 'checked'), false);
  assert.equal(Object.hasOwn(result, 'sourceProvenance'), false);
  const withWriter = ContractDeclarationsSchema.parse({ ...baseline, native: [writer] });
  assert.deepEqual(lower(semanticFixture(withWriter).module).native, [writer]);
});

test('strict declarations and location bindings reject caller status, unknown kinds, duplicates, and prototype keys', () => {
  const project = { version: 1, profile: 'contract-system', root: { spec: 'SystemContracts.tla', operator: 'SGDContracts' }, models, bindings: 'bindings.json' };
  assert.equal(ContractProjectSchema.safeParse(project).success, true);
  assert.equal(ContractProjectSchema.safeParse({ ...project, checked: true }).success, false);
  for (const candidate of [
    { ...baseline, contracts: ['Payload', 'Payload'] },
    { ...baseline, relations: [relation, relation] },
    { ...baseline, relations: [{ ...relation, kind: 'contains' }] },
    { ...baseline, relations: [{ ...relation, upper: 'Missing' }] },
    { ...baseline, native: [writer, writer] },
    { ...baseline, native: [{ ...writer, kind: 'caller-authorized' }] },
    { ...baseline, checked: true },
    { ...baseline, repairKind: 'implementation' },
  ]) assert.equal(ContractDeclarationsSchema.safeParse(candidate).success, false);
  assert.equal(ContractBindingsSchema.safeParse({ version: 1, bindings: { PartitionWriter: {} } }).success, false);
  assert.equal(ContractBindingsSchema.safeParse({ version: 1, bindings: { PartitionWriter: { language: 'rust', file: 'src/store.rs', symbol: 'crate::store::write', checked: true } } }).success, false);
  assert.throws(() => closure(baseline, baseline, bindings, JSON.parse('{"__proto__":{"project":"payload.json"}}')), /TLC311/);
});

test('literal lowerer refuses helpers, computed forms, wrong constructors, and counterfeit builtins', () => {
  const helper = semanticFixture();
  const originalModule = helper.module.modules[0]; assert.ok(originalModule);
  assert.throws(() => lower({ ...helper.module, modules: [{ ...originalModule, members: [...originalModule.members, { uid: 'helper', name: 'Helper', kind: 'definition' }] }] }), /TLC311/);
  const computed = semanticFixture();
  assert.throws(() => lower({ ...computed.module, definitions: [{ ...computed.definition, body: computed.literal('computed') }] }), /literal \$RcdConstructor/);
  const wrongBuiltin = semanticFixture();
  wrongBuiltin.symbols.set('$RcdConstructor', { kind: 'builtin', uid: '$RcdConstructor', name: '$Tuple', arity: -1, parameters: [], source: null, level: 0 });
  assert.throws(() => lower(wrongBuiltin.module), /TLC311/);
  const wrongKind = semanticFixture();
  wrongKind.symbols.set('$RcdConstructor', { kind: 'constant', uid: '$RcdConstructor', name: '$RcdConstructor', arity: 0, source: null, level: 0 });
  assert.throws(() => lower(wrongKind.module), /TLC311/);
});

test('literal lowerer refuses duplicate/unknown fields and unsupported relation kinds instead of dropping them', () => {
  const fixture = semanticFixture();
  const pair = (name: string, expression: SanyExpression): [string, SanyExpression] => [name, expression];
  const fields = [pair('version', fixture.literal(1)), pair('scope', fixture.literal('model-composition')),
    pair('contracts', fixture.apply('$SetEnumerate', [fixture.literal('Payload')])), pair('relations', fixture.apply('$Tuple', [])), pair('native', fixture.apply('$Tuple', []))];
  for (const body of [fixture.record([...fields, pair('version', fixture.literal(1))]), fixture.record([...fields, pair('checked', fixture.literal('true'))]),
    fixture.record(fields.map(([name, value]) => [name, name === 'relations' ? fixture.apply('$SetEnumerate', []) : value]))]) {
    assert.throws(() => lower({ ...fixture.module, definitions: [{ ...fixture.definition, body }] }), /TLC311/);
  }
  const unknown = fixture.record(fields.map(([name, value]) => [name, name === 'relations' ? fixture.apply('$Tuple', [fixture.record([
    pair('id', fixture.literal('UnknownLink')), pair('kind', fixture.literal('caller-rule')),
  ])]) : value]));
  assert.throws(() => lower({ ...fixture.module, definitions: [{ ...fixture.definition, body: unknown }] }), /unsupported contract relation kind caller-rule/);
  const unknownNative = fixture.record(fields.map(([name, value]) => [name, name === 'native' ? fixture.apply('$Tuple', [fixture.record([
    pair('id', fixture.literal('UnknownNative')), pair('kind', fixture.literal('caller-authorized')),
    pair('owner', fixture.literal('Payload')), pair('role', fixture.literal('writer')),
  ])]) : value]));
  assert.throws(() => lower({ ...fixture.module, definitions: [{ ...fixture.definition, body: unknownNative }] }), /unsupported native contract obligation kind caller-authorized/);
});

test('complete closure enumerates baseline behavior, retained properties, and candidate relations without a checked status', () => {
  const result = closure();
  assert.deepEqual(result.findings, []);
  assert.ok(result.obligations.some(obligation => obligation.kind === 'baseline-properties' && obligation.contract === 'Envelope'));
  assert.ok(result.obligations.some(obligation => obligation.kind === 'baseline-behavior' && obligation.contract === 'Envelope'));
  assert.ok(result.obligations.some(obligation => obligation.kind === 'enabled-input-erasure' && obligation.relation.id === relation.id));
  assert.equal(result.semanticVerification, 'not-performed');
  assert.equal(result.sourceProvenance, 'not-established');
  assert.equal(result.independentlySelectedBaseline, 'not-established');
  assert.equal(Object.hasOwn(result, 'checked'), false);
});

test('removing a required leaf or relation keeps its baseline obligations in the worklist', () => {
  const noRelation = closure({ ...baseline, relations: [] });
  assert.ok(noRelation.findings.some(finding => finding.kind === 'missing-obligation' && finding.obligation === 'relation' && finding.id === relation.id));
  assert.ok(noRelation.obligations.some(obligation => obligation.kind === 'enabled-input-erasure' && obligation.relation.id === relation.id));
  const noLeaf = closure({ ...baseline, contracts: ['Payload'], relations: [] }, baseline, bindings, { Payload: models.Payload });
  assert.ok(noLeaf.findings.some(finding => finding.kind === 'missing-contract' && finding.contract === 'Envelope'));
  assert.ok(noLeaf.obligations.some(obligation => obligation.kind === 'baseline-behavior' && obligation.contract === 'Envelope'));
});

test('baseline relation comparison includes direction and every model-name mapping', () => {
  for (const changed of [
    { ...relation, upper: relation.lower, lower: relation.upper },
    { ...relation, inputs: {} },
    { ...relation, variables: { phase: 'phase' } },
    { ...relation, actions: { ...relation.actions, Same: 'Clash', Clash: 'Same' } },
  ]) assert.ok(closure({ ...baseline, relations: [changed] }).findings.some(finding => finding.kind === 'changed-obligation' && finding.obligation === 'relation'));
  assert.deepEqual(closure({ ...baseline, contracts: [...baseline.contracts].reverse(), relations: [{ ...relation, inputs: { v: 'v' } }] }).findings, []);
});

test('deleting native requirements or changing owner/kind/role does not erase the accepted obligation', () => {
  const accepted = { ...baseline, native: [writer] };
  const removed = closure(baseline, accepted);
  assert.ok(removed.findings.some(finding => finding.kind === 'missing-obligation' && finding.obligation === 'native'));
  assert.ok(removed.findings.some(finding => finding.kind === 'missing-binding' && finding.id === writer.id));
  assert.ok(removed.obligations.some(obligation => obligation.kind === 'native' && obligation.declaration.id === writer.id));
  for (const changed of [{ ...writer, owner: 'Payload' }, { ...writer, role: 'other' }, { ...writer, kind: 'scheduling' }]) {
    const result = closure({ ...baseline, native: [changed] }, accepted);
    assert.ok(result.findings.some(finding => finding.kind === 'changed-obligation' && finding.obligation === 'native'));
  }
});

test('supplied native selectors remain unsupported and invalid selectors fail parsing', () => {
  const accepted = { ...baseline, native: [writer] };
  const selectors = { version: 1, bindings: { PartitionWriter: { language: 'rust', file: 'src/store.rs', symbol: 'crate::store::write' } } };
  const result = closure(accepted, accepted, selectors);
  assert.ok(result.findings.some(finding => finding.kind === 'unsupported' && finding.obligation === 'native' && finding.id === writer.id));
  assert.equal(result.findings.some(finding => finding.kind === 'missing-binding'), false);
  assert.throws(() => closure(accepted, accepted, { version: 1, bindings: { PartitionWriter: {} } }), ContractGraphError);
});

test('all candidate additions become obligations and unclassified model/binding entries fail closure', () => {
  const candidate = { ...baseline, contracts: [...baseline.contracts, 'Added'], relations: [...baseline.relations, { ...relation, id: 'AddedPayload', lower: 'Added' }], native: [writer] };
  const result = closure(candidate, baseline, bindings, { ...models, Added: { project: 'unsupported-profile.json' } });
  assert.ok(result.obligations.some(obligation => obligation.kind === 'model-verification' && obligation.contract === 'Added'));
  assert.ok(result.obligations.some(obligation => obligation.kind === 'enabled-input-erasure' && obligation.relation.id === 'AddedPayload'));
  assert.ok(result.findings.some(finding => finding.kind === 'missing-binding' && finding.id === writer.id));
  assert.ok(closure().findings.length === 0);
  assert.ok(closure(baseline, baseline, bindings, { Payload: models.Payload }).findings.some(finding => finding.kind === 'missing-model-reference'));
  assert.ok(closure(baseline, baseline, bindings, { ...models, Extra: { project: 'extra.json' } }).findings.some(finding => finding.kind === 'extra-model-reference'));
  assert.ok(closure(baseline, baseline, { version: 1, bindings: { Extra: { language: 'rust', file: 'src/extra.rs', symbol: 'extra' } } }).findings.some(finding => finding.kind === 'extra-binding'));
});

test('scope downgrade and application claims remain failing independently of native selectors', () => {
  const result = closure(baseline, { ...baseline, scope: 'application' });
  assert.ok(result.findings.some(finding => finding.kind === 'changed-scope'));
  assert.ok(result.findings.some(finding => finding.kind === 'unsupported' && finding.obligation === 'application-coverage'));
  assert.ok(result.obligations.some(obligation => obligation.kind === 'application-coverage'));
});
