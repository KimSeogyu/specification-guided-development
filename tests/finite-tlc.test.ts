import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { FINITE_TLC_JAR_SHA256, runFiniteTlc, validateFiniteConfig } from '../src/finite-tlc.js';

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
    let snapshot: string | undefined;
    for (let attempt = 0; attempt < 250 && snapshot === undefined; attempt++) {
      for (const name of await readdir(tmpdir())) {
        if (!name.startsWith('sgd-finite-') || existing.has(name)) continue;
        const candidate = join(tmpdir(), name);
        try {
          if ((await readFile(join(candidate, 'models', 'Guarded.tla'), 'utf8')) === model) snapshot = candidate;
        } catch { /* The private copy may still be in progress or already removed. */ }
      }
      if (snapshot === undefined) await delay(20);
    }
    assert.ok(snapshot, 'observe the actual copied model before changing its original');
    await writeFile(files.config, 'SPECIFICATION Spec\n\\* changed while TLC checks its isolated copy\n');
    const result = await pending;
    assert.equal(result.kind, 'failure');
    assert.ok('error' in result && result.error instanceof Error);
    assert.match(result.error.message, /TLC203.*configuration or JAR changed/);
    await assert.rejects(lstat(snapshot), { code: 'ENOENT' });
  } finally { await files.dispose(); }
});

test('real SANY semantic failure cannot be mistaken for success despite its zero exit status', { skip: !jar }, async () => {
  assert.ok(jar);
  const files = await fixture();
  try {
    await writeFile(files.spec, model.replace('approved = FALSE', 'approved = UndefinedName'));
    await assert.rejects(runFiniteTlc({ ...files, jar }), /TLC204.*SANY/s);
    await writeFile(files.spec, model.replace('VARIABLES phase', 'EXTENDS MissingExternalModule\nVARIABLES phase'));
    await assert.rejects(runFiniteTlc({ ...files, jar }), /TLC204/);
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

test('real finite TLC rejects invariant errors and timeouts without completion evidence', { skip: !jar }, async () => {
  assert.ok(jar);
  const files = await fixture();
  try {
    await writeFile(files.spec, model.replace('====', 'Safe == approved = FALSE\n===='));
    await writeFile(files.config, 'SPECIFICATION Spec\nINVARIANT Safe\n');
    await assert.rejects(runFiniteTlc({ ...files, jar }), /TLC204/);
    await assert.rejects(runFiniteTlc({ ...files, jar, timeoutMs: 1 }), /TLC204/);
    assert.equal(await readFile(files.config, 'utf8'), 'SPECIFICATION Spec\nINVARIANT Safe\n');
  } finally { await files.dispose(); }
});
