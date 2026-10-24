import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { FINITE_TLC_JAR_SHA256, runFiniteTlc, validateFiniteConfig } from '../src/finite-tlc.js';
import { runTlc } from '../src/tlc.js';
import { TlcFailureDiagnosticSchema, TlcFailureError } from '../src/tlc-failure.js';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const jar = process.env.TLA2TOOLS_JAR ? resolve(process.env.TLA2TOOLS_JAR) : undefined;
const model = String.raw`---- MODULE Guarded ----
VARIABLES phase, approved
Init == /\ phase = "New" /\ approved = FALSE
Approve == /\ phase = "New" /\ ~approved /\ approved' = TRUE /\ UNCHANGED phase
Submit == /\ phase = "New" /\ approved /\ phase' = "Submitted" /\ UNCHANGED approved
Done == /\ phase = "Submitted" /\ UNCHANGED <<phase, approved>>
Next == Approve \/ Submit \/ Done
Spec == Init /\ [][Next]_<<phase, approved>>
====
`;

async function fixture(): Promise<{ directory: string; spec: string; config: string; dispose: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'sgd-finite-test-'));
  const spec = join(directory, 'Guarded.tla');
  const config = join(directory, 'Guarded.cfg');
  await writeFile(spec, model);
  await writeFile(config, 'SPECIFICATION Spec\n');
  return { directory, spec, config, dispose: () => rm(directory, { recursive: true, force: true }) };
}

async function observeSnapshot(existing: ReadonlySet<string>, expectedSource = model): Promise<string> {
  for (let attempt = 0; attempt < 250; attempt++) {
    for (const name of await readdir(tmpdir())) {
      if (!name.startsWith('sgd-finite-') || existing.has(name)) continue;
      const candidate = join(tmpdir(), name);
      try {
        if ((await readFile(join(candidate, 'models', 'Guarded.tla'), 'utf8')) === expectedSource) return candidate;
      } catch { /* The private copy may still be in progress or already removed. */ }
    }
    await delay(20);
  }
  assert.fail('observe the actual copied model while verification is running');
}

test('finite config lexer ignores strings, line comments, and nested block comments', () => {
  validateFiniteConfig(String.raw`(* SYMMETRY Hidden (* VIEW Other *) ALIAS Hidden *)
SPECIFICATION Spec
CONSTANTS Label = "SYMMETRY VIEW ALIAS CONSTRAINT ACTION_CONSTRAINT <-"
  Escaped = "quote: \" and slash: \\"
  Count = 2 Values = {"New", "Done"} Flags = {TRUE, FALSE} Numbers = {0, 1}
\* VIEW Hidden
INVARIANTS Safe TypeOK
PROPERTIES Live
CHECK_DEADLOCK FALSE
`);
  validateFiniteConfig('INIT Init NEXT Next CONSTANT Empty = {}');
});

test('finite config profile refuses graph reductions, relabeling, modes, and overrides', () => {
  for (const directive of ['SYMMETRY', 'VIEW', 'ALIAS', 'CONSTRAINT', 'CONSTRAINTS', 'ACTION_CONSTRAINT', 'ACTION_CONSTRAINTS', 'TYPE', 'TYPE_CONSTRAINT', 'SIMULATION', 'SIMULATE', 'DIFFTRACE', 'POSTCONDITION']) {
    assert.throws(() => validateFiniteConfig(`SPECIFICATION Spec\n${directive} Hidden`), /TLC201/, directive);
    assert.throws(() => validateFiniteConfig(`SPECIFICATION Spec (* safe *) ${directive} Hidden`), /TLC201/, directive);
  }
  for (const config of ['SPECIFICATION Spec CONSTANT Max <- Replacement', 'SPECIFICATION Spec CONSTANT Max <- [Other] Replacement',
    'SPECIFICATION Spec -simulate', 'SPECIFICATION Spec UNKNOWN Option', 'SPECIFICATION Spec INIT Init',
    'SPECIFICATION Spec SPECIFICATION Other', 'INIT Init', 'NEXT Next', '', 'SPECIFICATION Spec CONSTANT N = -TRUE', 'SPECIFICATION Spec CONSTANT N = -2',
    'SPECIFICATION Spec CONSTANT N = {1,{2}}', 'SPECIFICATION Spec CONSTANT N = {TRUE, "x"}', 'SPECIFICATION Spec CONSTANT N = ModelValue',
    'SPECIFICATION Spec CONSTANT N = 1..2', 'SPECIFICATION Spec (* unterminated', 'SPECIFICATION Spec CONSTANT S = "unterminated',
    'SPECIFICATION Spec CONSTANT S = "line\nbreak"']) {
    assert.throws(() => validateFiniteConfig(config), /TLC201/, config);
  }
});

test('finite runner refuses inherited JVM/TLA overrides without exposing their values', async () => {
  for (const name of ['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH', 'TLA_LIBRARY', 'TLA-Library']) {
    const previous = process.env[name];
    process.env[name] = 'sensitive-override-value';
    try {
      await assert.rejects(runFiniteTlc({ spec: 'unused.tla', config: 'unused.cfg', jar: 'unused.jar' }), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /TLC202/);
        assert.ok(error.message.includes(name));
        assert.ok(!error.message.includes('sensitive-override-value'));
        return true;
      });
    } finally {
      if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
    }
  }
});

test('finite runner refuses unpinned tool bytes', async () => {
  const files = await fixture();
  try {
    const fakeJar = join(files.directory, 'fake.jar');
    await writeFile(fakeJar, 'not the pinned executable');
    await assert.rejects(runFiniteTlc({ ...files, jar: fakeJar }), /TLC202.*pinned/);
  } finally { await files.dispose(); }
});

test('real finite TLC snapshot preserves guarded full-state edges and binds reproducible evidence', { skip: !jar }, async () => {
  assert.ok(jar);
  const files = await fixture();
  try {
    const first = await runFiniteTlc({ ...files, jar });
    const second = await runFiniteTlc({ ...files, jar });
    assert.equal(first.dot, second.dot);
    assert.deepEqual(first.evidence, second.evidence);
    assert.equal(first.evidence.kind, 'tlc-finite-completed');
    assert.equal(first.evidence.jarSha256, FINITE_TLC_JAR_SHA256);
    assert.deepEqual(first.evidence.moduleClosure, [{ name: 'Guarded.tla', sha256: hash(model) }]);
    assert.equal(first.evidence.configSha256, hash('SPECIFICATION Spec\n'));
    assert.equal(first.evidence.dotSha256, hash(first.dot));
    assert.deepEqual(first.evidence.standardModules, []);
    assert.match(first.dot, /approved = FALSE/);
    assert.match(first.dot, /approved = TRUE/);
    assert.match(first.dot, /label="Approve"/);
    assert.match(first.dot, /label="Submit"/);
    assert.match(first.dot, /label="Done"/);
    assert.match(first.log, /0 states left on queue\./);
  } finally { await files.dispose(); }
});

test('real SANY discovers EXTENDS and INSTANCE module closure, not unrelated files', { skip: !jar }, async () => {
  assert.ok(jar);
  const files = await fixture();
  const helper = '---- MODULE Helper ----\nEXTENDS Naturals\nValue == 1 + 1\n====\n';
  const nested = '---- MODULE Nested ----\nH == INSTANCE Helper\nValue == H!Value\n====\n';
  try {
    await writeFile(join(files.directory, 'Helper.tla'), helper);
    await writeFile(join(files.directory, 'Nested.tla'), nested);
    await writeFile(join(files.directory, 'Unused.tla'), 'not a valid module; SANY must not load this');
    await writeFile(files.spec, model.replace('VARIABLES phase', 'EXTENDS Nested\nVARIABLES phase').replace('approved = FALSE', 'approved = (Value = 3)'));
    const checked = await runFiniteTlc({ ...files, jar });
    assert.deepEqual(checked.evidence.moduleClosure.map(file => file.name), ['Guarded.tla', 'Helper.tla', 'Nested.tla']);
    assert.deepEqual(checked.evidence.standardModules, ['Naturals']);
    await writeFile(join(files.directory, 'Helper.tla'), helper.replace('1 + 1', '1 + 2'));
    const changed = await runFiniteTlc({ ...files, jar });
    assert.notEqual(checked.evidence.moduleClosure.find(file => file.name === 'Helper.tla')?.sha256,
      changed.evidence.moduleClosure.find(file => file.name === 'Helper.tla')?.sha256);
    assert.notEqual(checked.dot, changed.dot);
  } finally { await files.dispose(); }
});

test('real finite configuration preserves literal strings and finite scalar constant assignments', { skip: !jar }, async () => {
  assert.ok(jar);
  const files = await fixture();
  try {
    await writeFile(files.spec, model.replace('VARIABLES phase', 'CONSTANTS Label, Count, Values\nVARIABLES phase')
      .replace('phase = "New" /\\ approved = FALSE', 'phase = Label /\\ approved = (Count = 0)'));
    await writeFile(files.config, String.raw`(* VIEW Ignored (* ALIAS Ignored *) *)
SPECIFICATION Spec
CONSTANTS Label = "New" Count = 2 Values = {"SYMMETRY", "VIEW"}
\* ACTION_CONSTRAINT Ignored
`);
    const checked = await runFiniteTlc({ ...files, jar });
    assert.match(checked.dot, /approved = FALSE/);
    assert.match(checked.dot, /label="Submit"/);
  } finally { await files.dispose(); }
});

test('real finite verification uses copied sources, rejects changed originals, and removes its snapshot on failure', { skip: !jar }, async () => {
  assert.ok(jar);
  const files = await fixture();
  try {
    const existing = new Set(await readdir(tmpdir()));
    const pending = runFiniteTlc({ ...files, jar }).then(value => ({ kind: 'success', value }), error => ({ kind: 'failure', error }));
    const snapshot = await observeSnapshot(existing);
    await writeFile(files.config, 'SPECIFICATION Spec\n\\* changed while TLC checks its isolated copy\n');
    const result = await pending;
    assert.equal(result.kind, 'failure');
    assert.ok('error' in result && result.error instanceof Error);
    assert.match(result.error.message, /TLC203.*configuration or JAR changed/);
    await assert.rejects(lstat(snapshot), { code: 'ENOENT' });
  } finally { await files.dispose(); }
});

test('finite runner accepts its verified co-located input JAR without exposing source-directory Java artifacts to the model snapshot', { skip: !jar }, async () => {
  assert.ok(jar);
  const files = await fixture();
  try {
    const selectedJar = join(files.directory, 'tla2tools.jar');
    const selectedBytes = await readFile(jar);
    await writeFile(selectedJar, selectedBytes);
    const source = `${model}\\* co-located tool fixture ${files.directory}\n`;
    await writeFile(files.spec, source);
    const existing = new Set(await readdir(tmpdir()));
    const pending = runFiniteTlc({ ...files, jar: selectedJar });
    const snapshot = await observeSnapshot(existing, source);
    assert.deepEqual((await readdir(join(snapshot, 'models'))).filter(name => /\.(?:jar|java|class)$/i.test(name)), []);
    assert.deepEqual(await readFile(join(snapshot, 'tla2tools.jar')), selectedBytes);
    assert.equal((await pending).evidence.jarSha256, FINITE_TLC_JAR_SHA256);
    await assert.rejects(lstat(snapshot), { code: 'ENOENT' });
    for (const artifact of ['override.jar', 'Guarded.class']) {
      await writeFile(join(files.directory, artifact), selectedBytes);
      await assert.rejects(runFiniteTlc({ ...files, jar: selectedJar }), /TLC203.*Java override artifact/);
      await rm(join(files.directory, artifact));
    }
    await symlink(selectedJar, join(files.directory, 'alias.jar'));
    await assert.rejects(runFiniteTlc({ ...files, jar: selectedJar }), /TLC203.*Java override artifact alias.jar/);
    await rm(join(files.directory, 'alias.jar'));

    const beforeChangedRun = new Set(await readdir(tmpdir()));
    const changing = runFiniteTlc({ ...files, jar: selectedJar }).then(value => ({ kind: 'success', value }), error => ({ kind: 'failure', error }));
    const copied = await observeSnapshot(beforeChangedRun, source);
    await writeFile(selectedJar, 'changed after the verified JAR was copied');
    const result = await changing;
    assert.equal(result.kind, 'failure');
    assert.ok('error' in result && result.error instanceof Error);
    assert.match(result.error.message, /TLC203.*configuration or JAR changed/);
    await assert.rejects(lstat(copied), { code: 'ENOENT' });
  } finally { await files.dispose(); }
});

test('real SANY semantic failure cannot be mistaken for success despite its zero exit status', { skip: !jar }, async () => {
  assert.ok(jar);
  const files = await fixture();
  try {
    await writeFile(files.spec, model.replace('approved = FALSE', 'approved = UndefinedName'));
    await assert.rejects(runFiniteTlc({ ...files, jar }), error => {
      assert.ok(error instanceof TlcFailureError);
      assert.match(error.message, /TLC204.*SANY/s);
      assert.deepEqual(error.diagnostic.failure, { kind: 'parse_error', phase: 'sany', evidence: { kind: 'sany-error-summary', stage: 'semantic' } });
      return true;
    });
    await writeFile(files.spec, model.replace('VARIABLES phase', 'EXTENDS MissingExternalModule\nVARIABLES phase'));
    await assert.rejects(runFiniteTlc({ ...files, jar }), error => {
      assert.ok(error instanceof TlcFailureError);
      assert.match(error.message, /TLC204/);
      assert.deepEqual(error.diagnostic.failure, { kind: 'unknown', phase: 'sany' });
      return true;
    });
    await writeFile(files.spec, model.replace('Init == /\\', 'Init == ) /\\'));
    await assert.rejects(runFiniteTlc({ ...files, jar }), error => {
      assert.ok(error instanceof TlcFailureError);
      assert.deepEqual(error.diagnostic.failure, { kind: 'parse_error', phase: 'sany', evidence: { kind: 'sany-error-summary', stage: 'syntax' } });
      return true;
    });
  } finally { await files.dispose(); }
});

test('real finite TLC rejects constraints, native side effects, overrides, and symlink modules', { skip: !jar }, async () => {
  assert.ok(jar);
  const files = await fixture();
  try {
    await writeFile(files.config, 'SPECIFICATION Spec\nCONSTRAINT Limited\n');
    await assert.rejects(runFiniteTlc({ ...files, jar }), /TLC201.*CONSTRAINT/);
    await writeFile(files.config, 'SPECIFICATION Spec\n');
    for (const dependency of ['TLC', 'Randomization', 'Toolbox', 'Bags']) {
      await writeFile(files.spec, model.replace('VARIABLES phase', `EXTENDS ${dependency}\nVARIABLES phase`));
      await assert.rejects(runFiniteTlc({ ...files, jar }), /TLC203.*standard module/);
    }
    await writeFile(files.spec, model);
    await writeFile(join(files.directory, 'Guarded.class'), 'arbitrary Java override');
    await assert.rejects(runFiniteTlc({ ...files, jar }), /TLC203.*Java override/);
    await rm(join(files.directory, 'Guarded.class'));
    await writeFile(join(files.directory, 'Naturals.tla'), '---- MODULE Naturals ----\n====');
    await assert.rejects(runFiniteTlc({ ...files, jar }), /TLC203.*shadows/);
    await rm(join(files.directory, 'Naturals.tla'));
    await writeFile(join(files.directory, 'TransitiveClosure.tla'), '---- MODULE TransitiveClosure ----\nTC(R) == {}\n====');
    await assert.rejects(runFiniteTlc({ ...files, jar }), /TLC203.*native Java override/);
    await rm(join(files.directory, 'TransitiveClosure.tla'));
    await symlink(files.spec, join(files.directory, 'Linked.tla'));
    await assert.rejects(runFiniteTlc({ ...files, jar }), /TLC203.*non-symlink/);
  } finally { await files.dispose(); }
});

test('real finite TLC classifies initial and behavior invariant errors without retaining private traces', { skip: !jar }, async () => {
  assert.ok(jar);
  const files = await fixture();
  try {
    await writeFile(files.config, 'SPECIFICATION Spec\nINVARIANT Safe\n');
    for (const [condition, code] of [['TRUE', 2107], ['FALSE', 2110]] satisfies [string, number][]) {
      const source = model.replace('====', `Safe == approved = ${condition}\n====`);
      await writeFile(files.spec, source);
      const existing = new Set(await readdir(tmpdir()));
      const pending = runFiniteTlc({ ...files, jar }).then(value => ({ kind: 'success', value }), error => ({ kind: 'failure', error }));
      const snapshot = await observeSnapshot(existing, source);
      const result = await pending;
      assert.ok('error' in result && result.error instanceof TlcFailureError);
      assert.match(result.error.message, /TLC204/);
      assert.ok(result.error.cause instanceof Error, 'the actual nonzero TLC exit remains the cause');
      assert.deepEqual(result.error.diagnostic.failure, { kind: 'invariant_violation', phase: 'tlc', invariant: 'Safe', evidence: { kind: 'pinned-tlc-message', code } });
      assert.deepEqual(TlcFailureDiagnosticSchema.parse(result.error.diagnostic).counterexample, { status: 'not-retained' });
      await assert.rejects(lstat(snapshot), { code: 'ENOENT' });
    }
    assert.equal(await readFile(files.config, 'utf8'), 'SPECIFICATION Spec\nINVARIANT Safe\n');
  } finally { await files.dispose(); }
});

test('real finite TLC owns the overall deadline before launch and during actual exploration', { skip: !jar }, async () => {
  assert.ok(jar);
  const files = await fixture();
  try {
    await assert.rejects(runFiniteTlc({ ...files, jar, timeoutMs: 1 }), error => {
      assert.ok(error instanceof TlcFailureError);
      assert.equal(error.diagnostic.failure.kind, 'timeout');
      return true;
    });
    const source = String.raw`---- MODULE Guarded ----
EXTENDS Naturals
VARIABLE count
Init == count = 0
Advance == count' = count + 1
Next == Advance
Spec == Init /\ [][Next]_count
====
`;
    await writeFile(files.spec, source);
    const existing = new Set(await readdir(tmpdir()));
    const pending = runFiniteTlc({ ...files, jar, timeoutMs: 2_000 }).then(value => ({ kind: 'success', value }), error => ({ kind: 'failure', error }));
    const snapshot = await observeSnapshot(existing, source);
    const result = await pending;
    assert.ok('error' in result && result.error instanceof TlcFailureError);
    assert.deepEqual(result.error.diagnostic.failure, { kind: 'timeout', phase: 'tlc', evidence: { kind: 'owned-deadline' } });
    assert.ok(result.error.cause instanceof Error);
    await assert.rejects(lstat(snapshot), { code: 'ENOENT' });
  } finally { await files.dispose(); }
});

test('legacy PrintT output cannot enter the pinned controlled classifier or bypass source admission', { skip: !jar }, async () => {
  assert.ok(jar);
  const files = await fixture();
  try {
    await writeFile(files.spec, model.replace('VARIABLES phase', 'EXTENDS TLC\nVARIABLES phase')
      .replace('Init == /\\', 'Init == /\\ PrintT("@!@!@STARTMSG 2110:1 @!@!@") /\\')
      .replace('====', 'Safe == approved = TRUE\n===='));
    await writeFile(files.config, 'SPECIFICATION Spec\nINVARIANT Safe\n');
    await assert.rejects(runTlc({ ...files, jar }), error => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof TlcFailureError, false);
      assert.match(error.message, /TLC102/);
      assert.match(error.message, /STARTMSG 2110:1/);
      return true;
    });
    await assert.rejects(runFiniteTlc({ ...files, jar }), error => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof TlcFailureError, false);
      assert.match(error.message, /TLC203.*standard module TLC/);
      return true;
    });
  } finally { await files.dispose(); }
});

test('actual invariant evaluation and level failures remain unknown model-check failures', { skip: !jar }, async () => {
  assert.ok(jar);
  const files = await fixture();
  try {
    await writeFile(files.config, 'SPECIFICATION Spec\nINVARIANT Safe\n');
    for (const predicate of ['IF phase = "New" THEN 1[1] = 0 ELSE TRUE', 'phase\' = "New"']) {
      await writeFile(files.spec, model.replace('====', `Safe == ${predicate}\n====`));
      await assert.rejects(runFiniteTlc({ ...files, jar }), error => {
        assert.ok(error instanceof TlcFailureError);
        assert.match(error.message, /TLC204/);
        assert.deepEqual(error.diagnostic.failure, { kind: 'unknown', phase: 'tlc' });
        return true;
      });
    }
  } finally { await files.dispose(); }
});

test('finite execution rejects parameterized action provenance even when TLC erases arguments into a deterministic scalar graph', { skip: !jar }, async () => {
  assert.ok(jar);
  const files = await fixture();
  try {
    await writeFile(files.spec, String.raw`---- MODULE Guarded ----
VARIABLE phase
Init == phase = "New"
Advance(value) == /\ phase = "New" /\ phase' = value
Wait == /\ phase = "Done" /\ UNCHANGED phase
Next == Advance("Done") \/ Wait
Spec == Init /\ [][Next]_phase
====
`);
    const uncheckedProvenance = await runTlc({ ...files, jar });
    assert.match(uncheckedProvenance.dot, /label="Advance"/);
    assert.doesNotMatch(uncheckedProvenance.dot, /Advance\(/);
    await assert.rejects(runFiniteTlc({ ...files, jar }), error => {
      assert.ok(error instanceof TlcFailureError);
      assert.match(error.message, /TLC204.*parameterized action Advance/);
      assert.deepEqual(error.diagnostic.failure, { kind: 'unknown', phase: 'source-admission' });
      return true;
    });
    // Calling through an unparameterized wrapper must not erase the actual action's semantic provenance.
    const wrapped = (await readFile(files.spec, 'utf8')).replace('Next == Advance("Done") \\/ Wait', 'Wrapped == Advance("Done")\nNext == Wrapped \\/ Wait');
    await writeFile(files.spec, wrapped);
    await assert.rejects(runFiniteTlc({ ...files, jar }), /TLC204.*parameterized action Advance/);
    await writeFile(join(files.directory, 'Helper.tla'), String.raw`---- MODULE Helper ----
VARIABLE phase
Advance(value) == /\ phase = "New" /\ phase' = value
====
`);
    await writeFile(files.spec, String.raw`---- MODULE Guarded ----
EXTENDS Helper
Init == phase = "New"
Wait == /\ phase = "Done" /\ UNCHANGED phase
Next == Advance("Done") \/ Wait
Spec == Init /\ [][Next]_phase
====
`);
    await assert.rejects(runFiniteTlc({ ...files, jar }), /TLC204.*parameterized action Advance/);
  } finally { await files.dispose(); }
});

test('finite execution permits unused parameterized definitions and reachable pure parameterized helpers', { skip: !jar }, async () => {
  assert.ok(jar);
  const files = await fixture();
  try {
    await writeFile(files.spec, model.replace('Submit ==', 'Unused(value) == phase\' = value\nIsNew(value) == value = "New"\nSubmit ==')
      .replace('Submit == /\\ phase = "New"', 'Submit == /\\ IsNew(phase)'));
    const result = await runFiniteTlc({ ...files, jar });
    assert.match(result.dot, /label="Submit"/);
  } finally { await files.dispose(); }
});

test('finite execution rejects action-level applications of pure helpers, including inside retained LET nodes', { skip: !jar }, async () => {
  assert.ok(jar);
  const files = await fixture();
  try {
    const pureDefinition = String.raw`---- MODULE Guarded ----
VARIABLE phase
Init == phase = "New"
Equal(a,b) == a=b
Next == \E value \in {"Done"} : Equal(phase',value)
Spec == Init /\ [][Next]_phase
====
`;
    await writeFile(files.spec, pureDefinition);
    assert.match((await runTlc({ ...files, jar })).dot, /label="Equal"/);
    await assert.rejects(runFiniteTlc({ ...files, jar }), /TLC204.*parameterized action Equal at application level 2/);
    await writeFile(files.spec, pureDefinition.replace('Equal(a,b) == a=b\nNext ==', 'Next == LET Equal(a,b) == a=b IN'));
    await assert.rejects(runFiniteTlc({ ...files, jar }), /TLC204.*parameterized action Equal at application level 2/);
    await writeFile(files.spec, String.raw`---- MODULE Guarded ----
VARIABLE phase
Init == phase = "New"
Advance == LET Equal(a,b) == a=b IN /\ Equal(phase,"New") /\ phase' = "Done"
Wait == /\ phase = "Done" /\ UNCHANGED phase
Next == Advance \/ Wait
Spec == Init /\ [][Next]_phase
====
`);
    assert.match((await runFiniteTlc({ ...files, jar })).dot, /label="Advance"/);
  } finally { await files.dispose(); }
});
