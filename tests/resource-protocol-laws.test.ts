import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { ResourceProtocolBindingSchema, validateResourceProtocol, type ResourceProtocolBinding } from '../src/resource-protocol.js';
import { lowerSymbolicModel } from '../src/symbolic-lower.js';
import { inspectSymbolicOrbits } from '../src/symbolic-semantics.js';
import { parseSanyXml } from '../src/sany-xml.js';
import { runSymbolicTlc } from '../src/symbolic-tlc.js';
import { symbolicModel, type SymbolicExpression, type SymbolicGuard, type SymbolicModelV3 } from '../src/symbolic-types.js';

const jar = process.env.TLA2TOOLS_JAR;
const binding: ResourceProtocolBinding = {
  version: 1, inputs: { resource: 'r', event: 'event' },
  variables: { phase: 'phase', selected: 'selected', loaded: 'loaded', prepared: 'prepared', attempted: 'attempted', loadOutcome: 'loadOutcome', decision: 'decision', coverage: 'coverage', attempts: 'attempts', replacements: 'replacements', effect: 'effect' },
};
const fixtureRoot = resolve('tests/fixtures/resource-protocol');
async function compile(config: 'Fixture.cfg' | 'ResourceProtocol.cfg', change?: (source: string) => string): Promise<SymbolicModelV3> {
  if (!jar) throw new Error('real pinned TLC JAR is required');
  const directory = await mkdtemp(join(tmpdir(), 'sgd-resource-laws-'));
  try {
    await cp(fixtureRoot, directory, { recursive: true });
    const spec = join(directory, 'ResourceProtocol.tla');
    if (change) await writeFile(spec, change(await readFile(spec, 'utf8')));
    const result = await runSymbolicTlc({ spec, config: join(directory, config), jar: resolve(jar) });
    const model = lowerSymbolicModel({ name: 'ResourceProtocol', semantic: parseSanyXml(result.xml), config: result.config, profile: 'protocol' });
    if (model.version !== 3) throw new Error('expected mixed input IR');
    return model;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
let fixturePromise: Promise<SymbolicModelV3> | undefined;
let productionPromise: Promise<SymbolicModelV3> | undefined;
const fixture = (): Promise<SymbolicModelV3> => fixturePromise ??= compile('Fixture.cfg');
const production = (): Promise<SymbolicModelV3> => productionPromise ??= compile('ResourceProtocol.cfg');

function changedModel(original: SymbolicModelV3, change: (model: SymbolicModelV3) => void): SymbolicModelV3 {
  const model = structuredClone(original); change(model);
  const { source: _source, ...program } = model;
  const changed = symbolicModel(program);
  if (changed.version !== 3) throw new Error('unexpected IR variant');
  return changed;
}
function mapGuard(guard: SymbolicGuard, expression: (value: SymbolicExpression) => SymbolicExpression): SymbolicGuard {
  switch (guard.kind) {
    case 'boolean': return guard;
    case 'equal': case 'not-equal': return { ...guard, left: expression(guard.left), right: expression(guard.right) };
    case 'member': return { ...guard, value: expression(guard.value), elements: guard.elements.map(value => {
      const mapped = expression({ kind: 'literal', value });
      if (mapped.kind !== 'literal') throw new Error('test mapping must preserve literal member values');
      return mapped.value;
    }) };
    case 'in-domain': return { ...guard, value: expression(guard.value) };
    case 'and': case 'or': return { ...guard, terms: guard.terms.map(term => mapGuard(term, expression)) };
    case 'not': return { ...guard, term: mapGuard(guard.term, expression) };
    case 'implies': case 'equivalent': return { ...guard, left: mapGuard(guard.left, expression), right: mapGuard(guard.right, expression) };
  }
}
function reorder(guard: SymbolicGuard): SymbolicGuard {
  switch (guard.kind) {
    case 'and': case 'or': return { ...guard, terms: guard.terms.map(reorder).reverse() };
    case 'equal': case 'not-equal': return { ...guard, left: guard.right, right: guard.left };
    case 'member': return { ...guard, elements: [...guard.elements].reverse() };
    case 'not': return { ...guard, term: reorder(guard.term) };
    case 'implies': case 'equivalent': return { ...guard, left: reorder(guard.left), right: reorder(guard.right) };
    case 'boolean': case 'in-domain': return guard;
  }
}
function branch(model: SymbolicModelV3, action: string) {
  const result = model.branches.find(branch => branch.action === action);
  if (!result) throw new Error(`missing source branch ${action}`);
  return result;
}
function removeIdentityGuard(guard: SymbolicGuard): SymbolicGuard {
  if (guard.kind === 'equal' && (guard.left.kind === 'input' || guard.right.kind === 'input') && (guard.left.kind === 'state' || guard.right.kind === 'state')) return { kind: 'boolean', value: true };
  if (guard.kind === 'and' || guard.kind === 'or') return { ...guard, terms: guard.terms.map(removeIdentityGuard) };
  return guard;
}

test('resource syntax roles are strict and do not carry policy tables', () => {
  assert.deepEqual(ResourceProtocolBindingSchema.parse(binding), binding);
  assert.equal(ResourceProtocolBindingSchema.safeParse({ ...binding, actions: { Write: 'trusted_write' } }).success, false);
  assert.equal(ResourceProtocolBindingSchema.safeParse({ ...binding, variables: { ...binding.variables, hidden: 'hidden' } }).success, false);
});

test('real controlled fixture and production source yield explicitly abstract evidence', { skip: !jar }, async () => {
  const independent = validateResourceProtocol({ model: await fixture(), binding, coverage: 'independent' });
  const required = validateResourceProtocol({ model: await production(), binding, coverage: 'required-before-write' });
  assert.equal(independent.kind, 'abstract-resource-protocol'); assert.equal(independent.storageAuthority, false);
  assert.equal(required.scope, 'complete-equality-copy-orbits'); assert.equal(required.storageAuthority, false);
  assert.ok(independent.proof.states.some(state => state.phase?.value === 'Attempted' && state.coverage?.value === false && state.effect?.value === 'Write'));
  assert.ok(required.proof.states.every(state => state.effect?.value !== 'Write' || state.coverage?.value === true));
  assert.throws(() => validateResourceProtocol({ model: independent.model, binding, coverage: 'required-before-write' }), /TLC305: missing configured coverage before Write attempt/);
});

test('generic real source lowering and orbits accept weakened affinity and Load, while resource admission refuses it', { skip: !jar }, async () => {
  const model = await compile('Fixture.cfg', source => {
    const start = source.indexOf('ReadPresent(r, event) =='); const end = source.indexOf('ReadAbsent(r, event) ==');
    const load = source.slice(start, end).replace('/\\ r = selected', '/\\ TRUE');
    return (source.slice(0, start) + load + source.slice(end)).replace(/Affinity ==[\s\S]*?\nReadOrigin ==/, 'Affinity == TRUE\nReadOrigin ==');
  });
  const orbits = inspectSymbolicOrbits(model);
  assert.ok(orbits.states.some(state => state.loaded?.kind === 'data' && state.selected?.kind === 'data' && state.loaded.value !== state.selected.value));
  assert.throws(() => validateResourceProtocol({ model, binding, coverage: 'independent' }), /TLC305: missing configured affinity source obligation/);
});

test('property-only TRUE weakening refuses although reachable behavior remains unchanged', { skip: !jar }, async () => {
  for (const [name, next] of [['Affinity', 'ReadOrigin'], ['ReadOrigin', 'WriteOnly'], ['WriteOnly', 'TerminalStep'], ['TerminalStep', 'Terminal'], ['CoverageStep', 'CoverageBeforeFact']]) {
    const model = await compile('ResourceProtocol.cfg', source => {
      const start = source.indexOf(`${name} ==`); const end = source.indexOf(`\n${next} ==`, start);
      if (start < 0 || end < 0) throw new Error(`missing source obligation ${name}`);
      return source.slice(0, start) + `${name} == TRUE` + source.slice(end);
    });
    inspectSymbolicOrbits(model);
    assert.throws(() => validateResourceProtocol({ model, binding, coverage: 'required-before-write' }), /TLC305: missing configured/);
  }
});

test('source law names, order, commutative boolean terms and equality direction are irrelevant', { skip: !jar }, async () => {
  const model = changedModel(await production(), model => {
    model.invariants.reverse(); model.actionProperties.reverse();
    for (const [index, property] of [...model.invariants, ...model.actionProperties].entries()) { property.name = `Claim${index}`; property.predicate = reorder(property.predicate); }
    for (const [index, action] of model.branches.entries()) action.action = `Operation${index}`;
  });
  assert.equal(validateResourceProtocol({ model, binding, coverage: 'required-before-write' }).storageAuthority, false);
});

test('renamed syntax roles and arbitrary renamed finite events retain admission', { skip: !jar }, async () => {
  const original = await production();
  const names = new Map(original.variables.map((variable, index) => [variable, `state${index}`]));
  const event = original.inputs.find(input => input.kind === 'finite');
  if (!event || event.kind !== 'finite') throw new Error('missing event input');
  const events = new Map(event.values.map((value, index) => [value.value, `choice${index}`]));
  const expression = (value: SymbolicExpression): SymbolicExpression => {
    if (value.kind === 'state' || value.kind === 'next-state') return { ...value, variable: names.get(value.variable) ?? value.variable };
    if (value.kind === 'input' && 'parameter' in value) return { ...value, parameter: value.parameter === 'r' ? 'resourceArg' : 'eventArg' };
    if (value.kind === 'literal' && value.value.kind === 'string' && events.has(value.value.value)) return { ...value, value: { kind: 'string', value: events.get(value.value.value) ?? '' } };
    return value;
  };
  const model = changedModel(original, model => {
    model.variables = model.variables.map(variable => names.get(variable) ?? variable);
    model.initial = Object.fromEntries(Object.entries(model.initial).map(([variable, value]) => [names.get(variable) ?? variable, value]));
    for (const input of model.inputs) {
      input.parameter = input.kind === 'opaque' ? 'resourceArg' : 'eventArg';
      if (input.kind === 'finite') input.values = input.values.map(value => ({ kind: 'string', value: events.get(value.value) ?? '' })).sort((a, b) => JSON.stringify(a.value).localeCompare(JSON.stringify(b.value)));
    }
    for (const action of model.branches) { action.guard = mapGuard(action.guard, expression); action.updates = Object.fromEntries(Object.entries(action.updates).map(([variable, update]) => [names.get(variable) ?? variable, expression(update)])); }
    for (const property of [...model.invariants, ...model.actionProperties]) property.predicate = mapGuard(property.predicate, expression);
  });
  const renamedBinding = ResourceProtocolBindingSchema.parse({ ...binding, inputs: { resource: 'resourceArg', event: 'eventArg' }, variables: Object.fromEntries(Object.entries(binding.variables).map(([role, variable]) => [role, names.get(variable)])) });
  assert.equal(validateResourceProtocol({ model, binding: renamedBinding, coverage: 'required-before-write' }).storageAuthority, false);
});

test('resource role omissions and aliases fail bijective coverage', { skip: !jar }, async () => {
  const model = await fixture();
  assert.throws(() => validateResourceProtocol({ model, binding: { ...binding, variables: { ...binding.variables, loaded: 'selected' } }, coverage: 'independent' }), /TLC305: resource roles must bijectively bind/);
  const { attempted: _attempted, ...variables } = binding.variables;
  assert.throws(() => validateResourceProtocol({ model, binding: { ...binding, variables }, coverage: 'independent' }), /TLC305: invalid resource role binding/);
  assert.throws(() => validateResourceProtocol({ model, binding: { ...binding, inputs: { resource: 'event', event: 'r' } }, coverage: 'independent' }), /TLC305: resource and event roles/);
});

test('complete role relation rejects resource substitution, false absence and forbidden effects', { skip: !jar }, async () => {
  const original = await fixture();
  const mutations: [string, (model: SymbolicModelV3) => void][] = [
    ['wrong load resource', model => { branch(model, 'ReadPresent').guard = removeIdentityGuard(branch(model, 'ReadPresent').guard); }],
    ['wrong attempt resource', model => { branch(model, 'AttemptWrite').guard = removeIdentityGuard(branch(model, 'AttemptWrite').guard); }],
    ['Noop writer', model => { branch(model, 'AttemptNoop').updates.effect = { kind: 'literal', value: { kind: 'string', value: 'Write' } }; }],
    ['Refused writer', model => { branch(model, 'AttemptRefused').updates.effect = { kind: 'literal', value: { kind: 'string', value: 'Write' } }; }],
    ['read error promoted to absence', model => { const action = branch(model, 'ReadError'); action.updates.phase = { kind: 'literal', value: { kind: 'string', value: 'Loaded' } }; action.updates.loaded = { kind: 'input', parameter: 'r' }; }],
    ['second attempt', model => { branch(model, 'Idle').updates.attempts = { kind: 'literal', value: { kind: 'integer', value: '2' } }; }],
    ['effect before consumption', model => { branch(model, 'AttemptWrite').updates.attempts = { kind: 'literal', value: { kind: 'integer', value: '0' } }; }],
    ['terminal identity reset', model => { branch(model, 'Idle').updates.selected = { kind: 'literal', value: { kind: 'string', value: 'none' } }; }],
  ];
  for (const [name, change] of mutations) assert.throws(() => validateResourceProtocol({ model: changedModel(original, change), binding, coverage: 'independent' }), /TLC305:/, name);
});

test('coverage is required before the first Write attempt rather than eventual success', { skip: !jar }, async () => {
  const model = changedModel(await production(), model => {
    const action = branch(model, 'AttemptWriteCovered');
    const removeCoverage = (guard: SymbolicGuard): SymbolicGuard => {
      if (guard.kind === 'equal' && ((guard.left.kind === 'state' && guard.left.variable === 'coverage') || (guard.right.kind === 'state' && guard.right.variable === 'coverage'))) return { kind: 'boolean', value: true };
      return guard.kind === 'and' ? { ...guard, terms: guard.terms.map(removeCoverage) } : guard;
    };
    action.guard = removeCoverage(action.guard);
    branch(model, 'FinishWrite').updates.coverage = { kind: 'literal', value: { kind: 'boolean', value: true } };
  });
  assert.throws(() => validateResourceProtocol({ model, binding, coverage: 'required-before-write' }), /TLC305:/);
});

test('disabled, terminal-only, missing decision and partial per-state behavior do not pass vacuously', { skip: !jar }, async () => {
  const original = await fixture();
  for (const keep of [new Set(['Idle']), new Set(['Select', 'Idle']), new Set(original.branches.map(branch => branch.action).filter(action => action !== 'PrepareRefused'))]) {
    const model = changedModel(original, model => { model.checkDeadlock = false; model.branches = model.branches.filter(branch => keep.has(branch.action)); });
    inspectSymbolicOrbits(model);
    assert.throws(() => validateResourceProtocol({ model, binding, coverage: 'independent' }), /TLC305: resource protocol omits meaningful/);
  }
  const partial = changedModel(original, model => {
    const action = branch(model, 'PrepareNoop');
    action.guard = { kind: 'and', terms: [action.guard, { kind: 'equal', left: { kind: 'state', variable: 'loadOutcome' }, right: { kind: 'literal', value: { kind: 'string', value: 'Present' } } }] };
  });
  inspectSymbolicOrbits(partial);
  assert.throws(() => validateResourceProtocol({ model: partial, binding, coverage: 'independent' }), /TLC305: resource transition .* omits or exceeds its inferred PrepareNoop role/);
});

test('unregistered equivalent source formulas fail the bounded source profile explicitly', { skip: !jar }, async () => {
  const model = changedModel(await fixture(), model => {
    const property = model.invariants.find(property => property.name === 'Affinity');
    if (!property || property.predicate.kind !== 'and') throw new Error('missing affinity conjuncts');
    property.predicate = { kind: 'and', terms: property.predicate.terms.map(term => term.kind === 'implies' ? { kind: 'or', terms: [{ kind: 'not', term: term.left }, term.right] } : term) };
  });
  inspectSymbolicOrbits(model);
  assert.throws(() => validateResourceProtocol({ model, binding, coverage: 'independent' }), /TLC305: missing configured affinity source obligation in the supported normalized expression form/);
});
