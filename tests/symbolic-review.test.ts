import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { runFiniteTlc } from '../src/finite-tlc.js';
import { lowerSymbolicModel } from '../src/symbolic-lower.js';
import { inspectSymbolicOrbits } from '../src/symbolic-semantics.js';
import { parseSanyXml } from '../src/sany-xml.js';
import { runSymbolicTlc } from '../src/symbolic-tlc.js';

const jar = process.env.TLA2TOOLS_JAR ? resolve(process.env.TLA2TOOLS_JAR) : undefined;
const behavior = String.raw`
VARIABLE x
vars == <<x>>
Init == x = "none"
Write(v) == x' = v
Next == \E v \in Values : Write(v)
Spec == Init /\ [][Next]_vars
`;
const config = 'SPECIFICATION Spec\nCONSTANT Values = {v1,v2}\n';

async function verified(source: string, extraSources: Record<string, string> = {}, extraConfig = '', atoms = 'v1,v2') {
  assert.ok(jar);
  const directory = await mkdtemp(join(tmpdir(), 'sgd-symbolic-review-'));
  try {
    const spec = join(directory, 'Review.tla');
    const configPath = join(directory, 'Review.cfg');
    await writeFile(spec, source);
    await writeFile(configPath, config.replace('{v1,v2}', `{${atoms}}`) + extraConfig);
    for (const [name, contents] of Object.entries(extraSources)) await writeFile(join(directory, name), contents);
    const result = await runSymbolicTlc({ spec, config: configPath, jar });
    assert.match(result.log, /Model checking completed\. No error has been found\./);
    return { semantic: parseSanyXml(result.xml), config: result.config, name: 'Review' };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('symbolic action squares preserve both implicit stutters and explicit no-change action steps', { skip: !jar }, async () => {
  const input = await verified(String.raw`---- MODULE Review ----
CONSTANT Values
${behavior}
Changes == [][x' /= x]_vars
====
`, {}, 'PROPERTY Changes\n');
  const model = lowerSymbolicModel(input);
  const orbits = inspectSymbolicOrbits(model);
  assert.equal(orbits.states.length, 2);
  assert.ok(orbits.edges.some(edge => edge.from === edge.to && edge.action === 'Write'));
});

test('symbolic lowering rejects root assumptions that constrain the finite domain', { skip: !jar }, async () => {
  const input = await verified(String.raw`---- MODULE Review ----
CONSTANT Values
ASSUME \A a,b,c \in Values : a=b \/ a=c \/ b=c
${behavior}
====
`);
  assert.throws(() => lowerSymbolicModel(input), /TLC301/);
});

test('symbolic lowering rejects assumptions inherited through EXTENDS', { skip: !jar }, async () => {
  const input = await verified(String.raw`---- MODULE Review ----
EXTENDS Base
${behavior}
====
`, {
    'Base.tla': String.raw`---- MODULE Base ----
CONSTANT Values
ASSUME \A a,b,c \in Values : a=b \/ a=c \/ b=c
====
`,
  });
  assert.throws(() => lowerSymbolicModel(input), /TLC301/);
});

test('finite provenance rejects a parameterized predicate applied at action level', { skip: !jar }, async () => {
  assert.ok(jar);
  const directory = await mkdtemp(join(tmpdir(), 'sgd-finite-action-review-'));
  try {
    const spec = join(directory, 'Review.tla');
    const configPath = join(directory, 'Review.cfg');
    await writeFile(spec, String.raw`---- MODULE Review ----
VARIABLE phase
Init == phase = "New"
Equal(a,b) == a=b
Next == \E value \in {"Done"} : Equal(phase',value)
Spec == Init /\ [][Next]_phase
====
`);
    await writeFile(configPath, 'SPECIFICATION Spec\n');
    await assert.rejects(runFiniteTlc({ spec, config: configPath, jar }), /TLC204.*parameterized/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('symbolic lifting rejects a scalar type mismatch reachable only beyond the configured atom count', { skip: !jar }, async () => {
  const input = await verified(String.raw`---- MODULE Review ----
CONSTANT Values
VARIABLES phase,a,b,c
vars == <<phase,a,b,c>>
Init == /\ phase="0" /\ a="none" /\ b="none" /\ c="none"
First(v) == /\ phase="0" /\ phase'="1" /\ a'=v /\ UNCHANGED <<b,c>>
Second(v) == /\ phase="1" /\ phase'="2" /\ b'=v /\ UNCHANGED <<a,c>>
Third(v) == /\ phase="2" /\ phase'="3" /\ c'=v /\ UNCHANGED <<a,b>>
Wait(v) == /\ phase="3"
           /\ ((a # b /\ a # c /\ b # c) => (FALSE = "x"))
           /\ UNCHANGED vars
Next == \E v \in Values : First(v) \/ Second(v) \/ Third(v) \/ Wait(v)
Spec == Init /\ [][Next]_vars
====
`, {}, 'CHECK_DEADLOCK FALSE\n');
  // Two configured atoms hide the ill-typed equality. Three distinct runtime
  // atoms reach it; pinned TLC reports a Boolean/non-Boolean comparison error.
  assert.throws(() => inspectSymbolicOrbits(lowerSymbolicModel(input)), /TLC30[12]/);
});

test('symbolic opaque domains reject TLC typed model values', { skip: !jar }, async () => {
  const input = await verified(String.raw`---- MODULE Review ----
CONSTANT Values
${behavior}
====
`, {}, '', 'A_v1,A_v2');
  assert.throws(() => lowerSymbolicModel(input), /TLC301/);
});

test('symbolic deadlock checking reaches a state with three distinct runtime atoms', { skip: !jar }, async () => {
  const source = String.raw`---- MODULE Review ----
CONSTANT Values
VARIABLES phase,a,b,c
vars == <<phase,a,b,c>>
Init == /\ phase="0" /\ a="none" /\ b="none" /\ c="none"
First(v) == /\ phase="0" /\ phase'="1" /\ a'=v /\ UNCHANGED <<b,c>>
Second(v) == /\ phase="1" /\ phase'="2" /\ b'=v /\ UNCHANGED <<a,c>>
Third(v) == /\ phase="2" /\ phase'="3" /\ c'=v /\ UNCHANGED <<a,b>>
Wait(v) == /\ phase="3" /\ ~(a # b /\ a # c /\ b # c) /\ UNCHANGED vars
Next == \E v \in Values : First(v) \/ Second(v) \/ Third(v) \/ Wait(v)
Spec == Init /\ [][Next]_vars
====
`;
  // The two-atom witness cannot make all three registers distinct.
  const checked = await verified(source);
  assert.throws(() => inspectSymbolicOrbits(lowerSymbolicModel(checked)), /TLC302.*deadlock/i);
  const unchecked = await verified(source, {}, 'CHECK_DEADLOCK FALSE\n');
  assert.doesNotThrow(() => inspectSymbolicOrbits(lowerSymbolicModel(unchecked)));
});
