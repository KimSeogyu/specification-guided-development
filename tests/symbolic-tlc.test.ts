import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parseSymbolicConfig, runSymbolicTlc } from '../src/symbolic-tlc.js';
import { runFiniteTlc, validateFiniteConfig } from '../src/finite-tlc.js';
import { parseSanyXml } from '../src/sany-xml.js';

const jar = process.env.TLA2TOOLS_JAR ? resolve(process.env.TLA2TOOLS_JAR) : undefined;
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
// This retains the Parangsae ManifestWrite contract and its original two-model-value configuration.
const manifest = String.raw`---- MODULE ManifestWrite ----
EXTENDS Integers
CONSTANT Values
VARIABLES phase, stored, rejected
vars == <<phase, stored, rejected>>
Init == /\ phase = "absent" /\ stored = "none" /\ rejected = "none"
Insert(v) == /\ phase = "absent" /\ v \in Values
             /\ phase' = "present" /\ stored' = v /\ rejected' = "none"
Same(v) == /\ phase \in {"present", "conflict"} /\ v = stored /\ UNCHANGED vars
Clash(v) == /\ phase \in {"present", "conflict"} /\ v \in Values /\ v # stored
            /\ phase' = "conflict" /\ rejected' = v /\ UNCHANGED stored
Next == \E v \in Values: Insert(v) \/ Same(v) \/ Clash(v)
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"absent", "present", "conflict"}
          /\ (phase = "absent") <=> (stored = "none")
          /\ phase = "conflict" => (rejected \in Values /\ rejected # stored)
          /\ phase = "present" => rejected = "none"
          /\ phase = "absent" => rejected = "none"
          /\ stored = "none" \/ stored \in Values
ConflictKeepsStored == phase = "conflict" => stored \in Values
StoredStable == [][stored # "none" => stored' = stored]_vars
====
`;
const manifestConfig = 'SPECIFICATION Spec\nCONSTANT Values = {v1, v2}\nINVARIANT TypeOK\nINVARIANT ConflictKeepsStored\nPROPERTY StoredStable\n';

async function fixture(): Promise<{ directory: string; spec: string; config: string; dispose: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'sgd-symbolic-test-'));
  const spec = join(directory, 'ManifestWrite.tla');
  const config = join(directory, 'ManifestWrite.cfg');
  await writeFile(spec, manifest);
  await writeFile(config, manifestConfig);
  return { directory, spec, config, dispose: () => rm(directory, { recursive: true, force: true }) };
}

test('symbolic configuration retains typed behavior, constants, and finite verification selections', () => {
  assert.deepEqual(parseSymbolicConfig(manifestConfig), {
    behavior: { kind: 'specification', operator: 'Spec' },
    constants: { Values: { kind: 'set', values: [{ kind: 'model-value', value: 'v1' }, { kind: 'model-value', value: 'v2' }] } },
    invariants: ['TypeOK', 'ConflictKeepsStored'], properties: ['StoredStable'], checkDeadlock: true,
  });
  const parsed = parseSymbolicConfig(String.raw`INIT Init NEXT Next
CONSTANTS Label = "VIEW \"quoted\"" Count = 0002 Flag = FALSE One = v1
  Words = {"SYMMETRY", "ALIAS"} Empty = {}
CHECK_DEADLOCK FALSE
(* VIEW Hidden (* ALIAS Hidden *) *)
\* CONSTRAINT Hidden
`);
  assert.deepEqual(parsed.behavior, { kind: 'init-next', init: 'Init', next: 'Next' });
  assert.deepEqual(parsed.constants.Count, { kind: 'integer', value: '2' });
  assert.deepEqual(parsed.constants.Label, { kind: 'string', value: 'VIEW "quoted"' });
  assert.deepEqual(parsed.constants.One, { kind: 'model-value', value: 'v1' });
  assert.equal(parsed.checkDeadlock, false);
  assert.throws(() => validateFiniteConfig(manifestConfig), /TLC201/);
});

test('symbolic configuration rejects all reductions and duplicate or ambiguous declarations', () => {
  for (const directive of ['SYMMETRY', 'VIEW', 'ALIAS', 'CONSTRAINT', 'CONSTRAINTS', 'ACTION_CONSTRAINT', 'ACTION_CONSTRAINTS', 'SIMULATE', 'DIFFTRACE']) {
    assert.throws(() => parseSymbolicConfig(`${manifestConfig}\n${directive} Hidden`), /TLC201/, directive);
  }
  for (const config of [
    'SPECIFICATION Spec CONSTANT Values <- Replacement',
    'SPECIFICATION Spec CONSTANT Values = {v1,"v2"}',
    'SPECIFICATION Spec CONSTANT Values = {v1,2}',
    'SPECIFICATION Spec CONSTANT Values = {v1,TRUE}',
    'SPECIFICATION Spec CONSTANT Values = {v1} Values = {v2}',
    'SPECIFICATION Spec INVARIANT Safe INVARIANTS Other Safe',
    'SPECIFICATION Spec PROPERTY Live PROPERTIES Live',
    'SPECIFICATION Spec CHECK_DEADLOCK TRUE CHECK_DEADLOCK FALSE',
    'SPECIFICATION Spec INIT Init NEXT Next',
    'INIT Init INIT Other NEXT Next',
  ]) assert.throws(() => parseSymbolicConfig(config), /TLC201/, config);
});

test('real symbolic runner verifies the original ManifestWrite finite model and exports its parameterized semantic XML', { skip: !jar }, async () => {
  assert.ok(jar);
  const files = await fixture();
  try {
    await writeFile(join(files.directory, 'Unused.tla'), 'invalid, unreferenced sibling must not enter the module closure');
    const result = await runSymbolicTlc({ ...files, jar });
    assert.deepEqual(result.config, parseSymbolicConfig(manifestConfig));
    assert.equal(result.evidence.kind, 'tlc-symbolic-completed');
    assert.equal(result.evidence.profile, 'symbolic-owned-v1');
    assert.equal(result.evidence.extractor, 'SANY-XML-v1');
    assert.equal(result.evidence.xmlSha256, hash(result.xml));
    assert.equal(result.evidence.dotSha256, hash(result.dot));
    assert.equal(result.evidence.configSha256, hash(manifestConfig));
    assert.deepEqual(result.evidence.moduleClosure, [{ name: 'ManifestWrite.tla', sha256: hash(manifest) }]);
    assert.deepEqual(result.evidence.standardModules, ['Integers', 'Naturals']);
    assert.match(result.log, /Model checking completed\. No error has been found\./);
    assert.match(result.log, /0 states left on queue\./);
    assert.match(result.dot, /label="Insert"/);
    assert.match(result.dot, /label="Clash"/);
    const module = parseSanyXml(result.xml);
    assert.equal(module.root, 'ManifestWrite');
    assert.deepEqual(module.definitions.filter(def => ['Insert', 'Same', 'Clash'].includes(def.name)).map(def => [def.name, def.arity]).sort(),
      [['Clash', 1], ['Insert', 1], ['Same', 1]]);
    assert.ok(!result.xml.includes(files.directory));
    assert.equal(await readFile(files.spec, 'utf8'), manifest);
    await assert.rejects(runFiniteTlc({ ...files, jar }), /TLC201/);
  } finally { await files.dispose(); }
});

test('real symbolic runner preserves INIT/NEXT config and rejects semantic errors and unsafe dependencies', { skip: !jar }, async () => {
  assert.ok(jar);
  const files = await fixture();
  try {
    await writeFile(files.config, manifestConfig.replace('SPECIFICATION Spec', 'INIT Init\nNEXT Next'));
    const result = await runSymbolicTlc({ ...files, jar });
    assert.deepEqual(result.config.behavior, { kind: 'init-next', init: 'Init', next: 'Next' });
    await writeFile(files.spec, manifest.replace('EXTENDS Integers', 'EXTENDS TLC'));
    await assert.rejects(runSymbolicTlc({ ...files, jar }), /TLC203.*standard module/);
    await writeFile(files.spec, manifest.replace('stored = "none"', 'stored = UndefinedName'));
    await assert.rejects(runSymbolicTlc({ ...files, jar }), /TLC204.*SANY/s);
  } finally { await files.dispose(); }
});
