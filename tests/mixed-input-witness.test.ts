import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { type FiniteValue } from '../src/finite-types.js';
import { lowerSymbolicModel } from '../src/symbolic-lower.js';
import { parseSanyXml } from '../src/sany-xml.js';
import { stepSymbolic } from '../src/symbolic-semantics.js';
import { runSymbolicTlc } from '../src/symbolic-tlc.js';
import { symbolicFiniteValueKey, symbolicModel, type SymbolicModelV3 } from '../src/symbolic-types.js';
import { importSymbolicDot, verifySymbolicWitness } from '../src/symbolic-witness.js';

const jar = process.env.TLA2TOOLS_JAR ? resolve(process.env.TLA2TOOLS_JAR) : undefined;
const source = String.raw`---- MODULE ResourceProtocol ----
CONSTANTS Resources, Events
VARIABLES phase, selected, loaded, attempted, lastEvent
vars == <<phase, selected, loaded, attempted, lastEvent>>
Init ==
  /\ phase = "New"
  /\ selected = "none"
  /\ loaded = "none"
  /\ attempted = "none"
  /\ lastEvent = "none"
Select(r, event) ==
  /\ phase = "New"
  /\ event = "select"
  /\ phase' = "Selected"
  /\ selected' = r
  /\ lastEvent' = event
  /\ UNCHANGED <<loaded, attempted>>
Load(r, event) ==
  /\ phase = "Selected"
  /\ event = "load"
  /\ r = selected
  /\ phase' = "Loaded"
  /\ loaded' = r
  /\ lastEvent' = event
  /\ UNCHANGED <<selected, attempted>>
Attempt(r, event) ==
  /\ phase = "Loaded"
  /\ event = "attempt"
  /\ r = loaded
  /\ phase' = "Done"
  /\ attempted' = r
  /\ lastEvent' = event
  /\ UNCHANGED <<selected, loaded>>
Idle(r, event) ==
  /\ phase = "Done"
  /\ event = "r1"
  /\ UNCHANGED vars
Next ==
  \E r \in Resources, event \in Events:
    \/ Select(r, event)
    \/ Load(r, event)
    \/ Attempt(r, event)
    \/ Idle(r, event)
Spec == Init /\ [][Next]_vars
Affinity ==
  /\ (loaded # "none" => loaded = selected)
  /\ (attempted # "none" => attempted = loaded)
====
`;
const configuration = 'SPECIFICATION Spec\nCONSTANT Resources = {r1, r2, r3}\nCONSTANT Events = {"r1", "select", "attempt", "load"}\nINVARIANT Affinity\nCHECK_DEADLOCK TRUE\n';

type VerifiedFixture = { spec: string; config: string; run: Awaited<ReturnType<typeof runSymbolicTlc>>; model: SymbolicModelV3; jar: string };
async function fixture(work: (input: VerifiedFixture) => Promise<void>, text = source, cfg = configuration): Promise<void> {
  assert.ok(jar);
  const directory = await mkdtemp(join(tmpdir(), 'sgd-mixed-witness-'));
  const spec = join(directory, 'ResourceProtocol.tla');
  const config = join(directory, 'ResourceProtocol.cfg');
  try {
    await writeFile(spec, text);
    await writeFile(config, cfg);
    const run = await runSymbolicTlc({ spec, config, jar });
    const model = lowerSymbolicModel({ name: 'ResourceProtocol', semantic: parseSanyXml(run.xml), config: run.config, profile: 'protocol' });
    assert.equal(model.version, 3);
    await work({ spec, config, run, model, jar });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function withValues(model: SymbolicModelV3, values: FiniteValue[]): SymbolicModelV3 {
  const { source: _source, ...program } = model;
  return symbolicModel({ ...program, inputs: model.inputs.map(input => input.kind === 'finite'
    ? { ...input, values: [...values].sort((a, b) => symbolicFiniteValueKey(a) < symbolicFiniteValueKey(b) ? -1 : 1) } : input) });
}

test('mixed original-action oracle preserves finite scalars, opaque atoms and every disabled tuple', { skip: !jar }, async () => fixture(async input => {
  const verified = await verifySymbolicWitness(input);
  assert.equal(verified.witness.version, 2);
  assert.ok('domains' in verified.witness);
  assert.deepEqual(verified.witness.domains, { Resources: ['r1', 'r2', 'r3'] });
  assert.ok('symbolicIrVersion' in verified.evidence);
  assert.equal(verified.evidence.symbolicIrVersion, 3);
  assert.equal(verified.evidence.inputProfile, 'mixed-finite-opaque-v1');
  assert.deepEqual(verified.evidence.inputs, input.model.inputs);
  assert.equal(verified.evidence.checkedCases, verified.witness.nodes.length * 3 * 4);
  assert.equal(verified.evidence.acceptedCases + verified.evidence.disabledCases, verified.evidence.checkedCases);
  assert.ok(verified.evidence.acceptedCases > 0 && verified.evidence.disabledCases > 0);
  assert.match(verified.oracleLog, /Model checking completed\. No error has been found\./);
  assert.ok(verified.witness.nodes.some(node => node.values.selected?.kind === 'data' && node.values.selected.value === 'r3'));
  const oracle = importSymbolicDot({ dot: verified.oracleDot, name: 'MixedOracle', domains: { Resources: ['r1', 'r2', 'r3'] } });
  assert.ok(oracle.nodes.some(node => Object.entries(node.values).some(([name, value]) => /Input1$/.test(name) && value.kind === 'string' && value.value === 'r1')));
  let state = input.model.initial;
  const arbitrary = 'root-that-was-not-in-the-finite-fixture';
  for (const { event, action } of [{ event: 'select', action: 'Select' }, { event: 'load', action: 'Load' }, { event: 'attempt', action: 'Attempt' }, { event: 'r1', action: 'Idle' }]) {
    const next = stepSymbolic(input.model, state, { r: arbitrary, event: { kind: 'string', value: event } });
    assert.equal(next.kind, 'accepted');
    if (next.kind !== 'accepted') throw new Error('expected complete mixed input transition');
    assert.equal(next.action, action);
    state = next.state;
    if (action === 'Select') assert.equal(stepSymbolic(input.model, state, { r: 'different-resource', event: { kind: 'string', value: 'load' } }).kind, 'disabled');
  }
  assert.deepEqual(state.attempted, { kind: 'data', domain: 'Resources', value: arbitrary });
  assert.equal(await readFile(input.spec, 'utf8'), source);
}));

test('mixed oracle refuses finite vocabulary drift before accepting source/config evidence', { skip: !jar }, async () => fixture(async input => {
  const finite = input.model.inputs.find(item => item.kind === 'finite');
  assert.ok(finite?.kind === 'finite');
  for (const values of [finite.values.slice(1), [...finite.values, { kind: 'string', value: 'invented-outcome' } satisfies FiniteValue]]) {
    await assert.rejects(verifySymbolicWitness({ ...input, model: withValues(input.model, values) }), /TLC303.*finite input vocabulary differs/);
  }
  const { source: _source, ...program } = input.model;
  const missingDomain = symbolicModel({ ...program, inputs: input.model.inputs.map(item => item.kind === 'finite' ? { ...item, domain: 'UnconfiguredEvents' } : item) });
  await assert.rejects(verifySymbolicWitness({ ...input, model: missingDomain }), /TLC303.*configured scalar vocabulary/);
  await writeFile(input.config, configuration.replace('"load"', '"new-load"'));
  await assert.rejects(verifySymbolicWitness(input), /TLC303.*differs from the completed base run/);
}));

test('mixed oracle compares original enabled decisions and complete successors instead of trusting IR claims', { skip: !jar }, async () => fixture(async input => {
  const { source: _source, ...program } = input.model;
  const disabledLoad = symbolicModel({ ...program, branches: input.model.branches.map(branch => branch.action === 'Load'
    ? { ...branch, guard: { kind: 'boolean', value: false } } : branch) });
  await assert.rejects(verifySymbolicWitness({ ...input, model: disabledLoad }), /TLC303.*disables an original enabled/);
  const wrongAttempt = symbolicModel({ ...program, branches: input.model.branches.map(branch => branch.action === 'Attempt'
    ? { ...branch, updates: { ...branch.updates, attempted: { kind: 'literal', value: { kind: 'string', value: 'none' } } } } : branch) });
  await assert.rejects(verifySymbolicWitness({ ...input, model: wrongAttempt }), /TLC303.*complete successor differs/);
  const missingAction = symbolicModel({ ...program, branches: input.model.branches.filter(branch => branch.action !== 'Idle') });
  await assert.rejects(verifySymbolicWitness({ ...input, model: missingAction }), /TLC303.*omits an action observed/);
}));

for (const scalar of [
  { initial: 'FALSE', values: '{TRUE, FALSE}', expected: [{ kind: 'boolean', value: false }, { kind: 'boolean', value: true }] },
  { initial: '0', values: '{2147483647, 0}', expected: [{ kind: 'integer', value: '0' }, { kind: 'integer', value: '2147483647' }] },
]) test(`mixed oracle retains exact ${scalar.expected[0]?.kind} finite inputs when finite is the first binder`, { skip: !jar }, async () => {
  const text = String.raw`---- MODULE ResourceProtocol ----
CONSTANTS Resources, Choices
VARIABLES phase, selected, choice
vars == <<phase, selected, choice>>
Init == /\ phase = "New" /\ selected = "none" /\ choice = INITIAL
Capture(event, r) == /\ phase = "New" /\ phase' = "Done" /\ selected' = r /\ choice' = event
Idle(event, r) == /\ phase = "Done" /\ UNCHANGED vars
Next == \E event \in Choices, r \in Resources: Capture(event,r) \/ Idle(event,r)
Spec == Init /\ [][Next]_vars
====
`.replace('INITIAL', scalar.initial);
  const cfg = `SPECIFICATION Spec\nCONSTANT Resources = {r1, r2}\nCONSTANT Choices = ${scalar.values}\nCHECK_DEADLOCK TRUE\n`;
  await fixture(async input => {
    const verified = await verifySymbolicWitness(input);
    assert.ok('symbolicIrVersion' in verified.evidence);
    assert.deepEqual(verified.evidence.inputs[0], { kind: 'finite', parameter: 'event', domain: 'Choices', values: scalar.expected });
    assert.equal(verified.evidence.checkedCases, verified.witness.nodes.length * 4);
    assert.equal(verified.evidence.disabledCases, 0);
    assert.ok(verified.witness.nodes.some(node => node.values.choice?.kind === scalar.expected[1]?.kind && node.values.choice?.value === scalar.expected[1]?.value));
  }, text, cfg);
});


test('controlled TLC refuses an oversized finite configured integer without producing oracle evidence', { skip: !jar }, async () => {
  const text = String.raw`---- MODULE ResourceProtocol ----
CONSTANTS Resources, Choices
VARIABLES selected, choice
vars == <<selected, choice>>
Init == /\ selected = "none" /\ choice = 0
Capture(r, event) == /\ selected' = r /\ choice' = event
Next == \E r \in Resources, event \in Choices: Capture(r, event)
Spec == Init /\ [][Next]_vars
====
`;
  const cfg = 'SPECIFICATION Spec\nCONSTANT Resources = {r1, r2}\nCONSTANT Choices = {0, 9007199254740993}\nCHECK_DEADLOCK TRUE\n';
  await assert.rejects(fixture(async () => assert.fail('an incomplete TLC run cannot reach the oracle'), text, cfg), /TLC204[\s\S]*NumberFormatException/);
});
