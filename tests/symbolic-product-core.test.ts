import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parseSanyXml } from '../src/sany-xml.js';
import { lowerSymbolicModel } from '../src/symbolic-lower.js';
import { evaluateGuard, inspectSymbolicOrbits, stepSymbolic, type SymbolicState } from '../src/symbolic-semantics.js';
import { runSymbolicTlc } from '../src/symbolic-tlc.js';
import { ProductSymbolicProjectSchema, SymbolicProjectSchema, symbolicInputs, symbolicModel, symbolicNext, validateSymbolicModel, type SymbolicModelV2 } from '../src/symbolic-types.js';

const jar = process.env.TLA2TOOLS_JAR ? resolve(process.env.TLA2TOOLS_JAR) : undefined;
const source = String.raw`---- MODULE Envelope ----
CONSTANTS Values, Receipts
VARIABLES phase, stored, storedReceipt, rejected, rejectedReceipt
vars == <<phase, stored, storedReceipt, rejected, rejectedReceipt>>
Identity(v) == v
Equal(v,w) == v=w
Init == /\ phase="absent" /\ stored="none" /\ storedReceipt="none"
        /\ rejected="none" /\ rejectedReceipt="none"
Insert(payload,metadata) == /\ phase="absent" /\ phase'="present"
  /\ stored'=Identity(payload) /\ storedReceipt'=Identity(metadata)
  /\ rejected'="none" /\ rejectedReceipt'="none"
Same(payload,metadata) == /\ phase \in {"present","conflict"}
  /\ Equal(payload,stored) /\ UNCHANGED vars
Clash(payload,metadata) == /\ phase \in {"present","conflict"}
  /\ payload # stored /\ phase'="conflict"
  /\ rejected'=payload /\ rejectedReceipt'=metadata
  /\ UNCHANGED <<stored,storedReceipt>>
Next == \E v \in Values, provenance \in Receipts:
  Insert(v,provenance) \/ Same(v,provenance) \/ Clash(v,provenance)
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"absent","present","conflict"}
  /\ (stored="none" \/ stored \in Values)
  /\ (rejected="none" \/ rejected \in Values)
  /\ (storedReceipt="none" \/ storedReceipt \in Receipts)
  /\ (rejectedReceipt="none" \/ rejectedReceipt \in Receipts)
StoredStable == [][phase # "absent" =>
  (stored'=stored /\ storedReceipt'=storedReceipt)]_vars
====
`;
const config = 'SPECIFICATION Spec\nCONSTANT Values={v1,v2}\nCONSTANT Receipts={r1,r2}\nINVARIANT TypeOK\nPROPERTY StoredStable\n';

async function checked(text = source, configuration = config) {
  assert.ok(jar);
  const directory = await mkdtemp(join(tmpdir(), 'sgd-product-core-'));
  try {
    const spec = join(directory, 'Envelope.tla'); const path = join(directory, 'Envelope.cfg');
    await writeFile(spec, text); await writeFile(path, configuration);
    const run = await runSymbolicTlc({ spec, config: path, jar });
    return { name: 'Envelope', semantic: parseSanyXml(run.xml), config: run.config };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function smallProduct(): SymbolicModelV2 {
  return symbolicModel({
    version: 2, kind: 'symbolic-owned', name: 'Product', checkDeadlock: true,
    variables: ['payload', 'receipt'], inputs: [{ parameter: 'value', domain: 'Values' }, { parameter: 'kind', domain: 'Receipts' }], next: 'Next',
    initial: { payload: { kind: 'string', value: 'none' }, receipt: { kind: 'string', value: 'none' } },
    branches: [{ action: 'Write', source: null, guard: { kind: 'boolean', value: true }, updates: { payload: { kind: 'input', parameter: 'value' }, receipt: { kind: 'input', parameter: 'kind' } } }],
    invariants: [], actionProperties: [],
  });
}

test('project and IR versions keep single-input artifacts separate from named product input', () => {
  const project = { version: 4, profile: 'symbolic-owned', name: 'Envelope', spec: 'Envelope.tla', config: 'Envelope.cfg', targets: ['rust'], binding: { className: 'EnvelopeMachine' } };
  assert.equal(ProductSymbolicProjectSchema.safeParse(project).success, true);
  assert.equal(SymbolicProjectSchema.safeParse(project).success, false);
  const model = smallProduct();
  assert.deepEqual(symbolicInputs(model), [{ parameter: 'value', domain: 'Values' }, { parameter: 'kind', domain: 'Receipts' }]);
  assert.equal(symbolicNext(model), 'Next');
  const { source: _identity, ...program } = model;
  const first = program.inputs[0]; assert.ok(first);
  assert.throws(() => symbolicModel({ ...program, inputs: [first] }), /TLC301/);
  assert.throws(() => symbolicModel({ ...program, inputs: [...program.inputs, ...program.inputs] }), /TLC301/);
  assert.throws(() => symbolicModel({ ...program, inputs: [first, { parameter: 'other', domain: 'Values' }] }), /TLC301.*distinct/);
  assert.throws(() => symbolicModel({ ...program, inputs: [first, { parameter: 'value', domain: 'Receipts' }] }), /TLC301.*distinct/);
  assert.throws(() => symbolicModel({ ...program, branches: program.branches.map(branch => ({ ...branch, updates: { ...branch.updates, payload: { kind: 'input' } } })) }), /TLC301.*declared parameter/);
  assert.throws(() => symbolicModel({ ...program, branches: program.branches.map(branch => ({ ...branch, updates: { ...branch.updates, payload: { kind: 'input', parameter: 'unknown' } } })) }), /TLC301.*declared parameter/);
  assert.throws(() => symbolicModel({ ...program, invariants: [{ name: 'Foreign', predicate: { kind: 'in-domain', value: { kind: 'state', variable: 'payload' }, domain: 'Foreign' } }] }), /TLC301.*domain/);
  assert.throws(() => validateSymbolicModel({ ...model, next: 'Changed' }), /TLC301.*identity/);
  assert.throws(() => validateSymbolicModel({ ...model, input: { parameter: 'value', domain: 'Values', next: 'Next' } }), /TLC301/);
});

test('named input frames preserve nominal domains even for equal Unicode identities and reserved-looking parameter names', () => {
  const model = smallProduct();
  const result = stepSymbolic(model, model.initial, { value: 'same', kind: 'same' });
  assert.equal(result.kind, 'accepted'); if (result.kind !== 'accepted') throw new Error('write missing');
  assert.deepEqual(result.state.payload, { kind: 'data', domain: 'Values', value: 'same' });
  assert.deepEqual(result.state.receipt, { kind: 'data', domain: 'Receipts', value: 'same' });
  assert.equal(evaluateGuard({ kind: 'equal', left: { kind: 'state', variable: 'payload' }, right: { kind: 'state', variable: 'receipt' } }, result.state, null), false);
  for (const invalid of ['same', {}, { value: 'A' }, { value: 'A', kind: 'B', extra: 'C' }, { value: 'A', kind: '\ud800' }]) {
    assert.throws(() => stepSymbolic(model, model.initial, invalid), /TLC301/);
  }
  let called = false;
  const accessor = { value: 'A', get kind() { called = true; return 'B'; } };
  assert.throws(() => stepSymbolic(model, model.initial, accessor), /TLC301.*data properties/);
  assert.equal(called, false);
  assert.throws(() => stepSymbolic(model, { ...model.initial, payload: { kind: 'data', domain: 'Foreign', value: 'A' } }, { value: 'A', kind: 'B' }), /TLC301.*undeclared opaque domain/);
  const proof = inspectSymbolicOrbits(model);
  assert.equal(proof.states.length, 2);
  assert.equal(proof.edges.filter(edge => edge.from === 1).length, 4);
  assert.ok(proof.edges.every(edge => typeof edge.input === 'object'));
  assert.deepEqual(proof.states[1], { payload: { kind: 'data', domain: 'Values', value: 'a0' }, receipt: { kind: 'data', domain: 'Receipts', value: 'a0' } });
});

test('the complete low-level variable tuple controls square-action stuttering', () => {
  const model = smallProduct(); const { source: _identity, ...program } = model;
  const unstable = symbolicModel({ ...program, actionProperties: [{ kind: 'square-action', name: 'SamePayloadKeepsReceipt', predicate: {
    kind: 'implies', left: { kind: 'equal', left: { kind: 'state', variable: 'payload' }, right: { kind: 'next-state', variable: 'payload' } },
    right: { kind: 'equal', left: { kind: 'state', variable: 'receipt' }, right: { kind: 'next-state', variable: 'receipt' } },
  } }] });
  assert.throws(() => inspectSymbolicOrbits(unstable), /TLC302.*SamePayloadKeepsReceipt/);
});

test('real SANY source lowers two independent inputs and retains arbitrary native payload/provenance', { skip: !jar }, async () => {
  const input = await checked();
  assert.throws(() => lowerSymbolicModel(input), /TLC301.*one scalar/);
  const model = lowerSymbolicModel({ ...input, profile: 'product' });
  assert.equal(model.version, 2); assert.equal(symbolicNext(model), 'Next');
  assert.deepEqual(symbolicInputs(model), [{ parameter: 'v', domain: 'Values' }, { parameter: 'provenance', domain: 'Receipts' }]);
  assert.equal('input' in model, false);
  let state: SymbolicState = model.initial; const actions: string[] = [];
  for (const frame of [{ v: 'A', provenance: 'r1' }, { v: 'B', provenance: 'r2' }, { v: 'B', provenance: 'r3' }, { v: 'C', provenance: 'r4' }, { v: 'A', provenance: 'r5' }]) {
    const result = stepSymbolic(model, state, frame);
    assert.equal(result.kind, 'accepted'); if (result.kind !== 'accepted') throw new Error('admitted input missing');
    state = result.state; actions.push(result.action);
    if (result.action === 'Clash') assert.deepEqual(result.updates.rejectedReceipt, { kind: 'input', parameter: 'provenance' });
  }
  assert.deepEqual(actions, ['Insert', 'Clash', 'Clash', 'Clash', 'Same']);
  assert.deepEqual(state.stored, { kind: 'data', domain: 'Values', value: 'A' });
  assert.deepEqual(state.storedReceipt, { kind: 'data', domain: 'Receipts', value: 'r1' });
  assert.deepEqual(state.rejected, { kind: 'data', domain: 'Values', value: 'C' });
  assert.deepEqual(state.rejectedReceipt, { kind: 'data', domain: 'Receipts', value: 'r4' });
  const proof = inspectSymbolicOrbits(model);
  assert.ok(proof.states.some(item => item.storedReceipt?.kind === 'data' && item.rejectedReceipt?.kind === 'data' && item.storedReceipt.value !== item.rejectedReceipt.value));
  assert.ok(proof.edges.some(edge => edge.action === 'Same' && edge.from === edge.to));
});

test('real product lowering refuses overlapping or typed atom domains and opaque constants outside inputs', { skip: !jar }, async () => {
  for (const configuration of [
    config.replace('Receipts={r1,r2}', 'Receipts={v1,r2}'),
    config.replace('Values={v1,v2}', 'Values={V_v1,V_v2}'),
  ]) {
    const input = await checked(source, configuration.replace('INVARIANT TypeOK\n', ''));
    assert.throws(() => lowerSymbolicModel({ ...input, profile: 'product' }), /TLC301.*(?:disjoint|typed)/);
  }
  const extra = await checked(source.replace('CONSTANTS Values, Receipts', 'CONSTANTS Values, Receipts, Unused'), config + 'CONSTANT Unused={extra1,extra2}\n');
  assert.throws(() => lowerSymbolicModel({ ...extra, profile: 'product' }), /TLC301.*only the input domains/);
});

test('real action calls must pass every exact binder UID in declared order', { skip: !jar }, async () => {
  for (const text of [
    source.replace('Insert(v,provenance)', 'Insert(provenance,v)').replace('INVARIANT TypeOK', ''),
    source.replace('Insert(v,provenance)', 'Insert(v,v)'),
    source.replaceAll('(payload,metadata)', '(payload)').replaceAll('Identity(metadata)', '"none"').replaceAll("rejectedReceipt'=metadata", "rejectedReceipt'=\"none\"").replaceAll('(v,provenance)', '(v)'),
  ]) {
    const input = await checked(text, config.replace('INVARIANT TypeOK\n', '').replace('PROPERTY StoredStable\n', ''));
    assert.throws(() => lowerSymbolicModel({ ...input, profile: 'product' }), /TLC301/);
  }
});

test('real three-domain source is admitted while shared or dependent input ranges are refused', { skip: !jar }, async () => {
  const triple = String.raw`---- MODULE Envelope ----
CONSTANTS Values,Receipts,Tags
VARIABLES a,b,c
vars == <<a,b,c>>
Init == /\ a="none" /\ b="none" /\ c="none"
Write(x,y,z) == /\ a'=x /\ b'=y /\ c'=z
Next == \E x \in Values, y \in Receipts, z \in Tags: Write(x,y,z)
Spec == Init /\ [][Next]_vars
====
`;
  const configuration = 'SPECIFICATION Spec\nCONSTANT Values={v1,v2}\nCONSTANT Receipts={r1,r2}\nCONSTANT Tags={t1,t2}\n';
  const input = await checked(triple, configuration);
  const model = lowerSymbolicModel({ ...input, profile: 'product' });
  assert.equal(symbolicInputs(model).length, 3);
  assert.equal(inspectSymbolicOrbits(model).edges.filter(edge => edge.from === 1).length, 8);
  const shared = await checked(triple.replace('y \\in Receipts', 'y \\in Values'), configuration);
  assert.throws(() => lowerSymbolicModel({ ...shared, profile: 'product' }), /TLC301.*distinct/);
  const dependent = await checked(triple.replace('y \\in Receipts', 'y \\in {"fixed"}'), configuration);
  assert.throws(() => lowerSymbolicModel({ ...dependent, profile: 'product' }), /TLC301.*independent/);
  await assert.rejects(checked(triple.replace('y \\in Receipts', 'y \\in {x}'), configuration), /TLC204.*SANY/);
});
