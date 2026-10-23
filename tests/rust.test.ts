import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateRust } from '../src/backends/rust.js';
import { AutomatonSchema, type Binding } from '../src/types.js';
import { z } from 'zod';

const runtime = resolve('.runtime/rust-backend-tests');
const target = join(runtime, 'target');
const automaton = AutomatonSchema.parse({
  version: 1, name: 'Orders', stateVariable: 'state',
  states: ['Pending', 'Acked', 'Filled'], initialStates: ['Pending'],
  transitions: [
    { from: 'Pending', event: 'Ack', to: 'Acked' },
    { from: 'Acked', event: 'Fill', to: 'Filled' },
  ],
  source: { dotSha256: 'fixture', stateCount: 3, edgeCount: 2 },
});
let transitionExecutable = '';
let dependencyExecutable = '';
let project = '';
let transitionCrate = '';
const owned: string[] = [];
const DiagnosticsSchema = z.array(z.object({ ruleId: z.string(), file: z.string(), line: z.number(), column: z.number(), message: z.string() }).strict());

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function build(binding: Binding): Promise<{ executable: string; crate: string }> {
  const crate = await mkdtemp(join(runtime, 'checker-'));
  owned.push(crate);
  for (const file of generateRust({ automaton, binding })) await put(join(crate, file.path), file.content);
  const build = spawnSync('cargo', ['build', '--quiet', '--manifest-path', join(crate, 'Cargo.toml'), '--target-dir', target], {
    encoding: 'utf8', timeout: 180_000,
  });
  assert.equal(build.status, 0, `generated Rust checker must compile:\n${build.stderr}\n${build.stdout}`);
  const executable = join(crate, 'checker');
  await copyFile(join(target, 'debug/tlc-generated-checker'), executable);
  return { executable, crate };
}

function check(executable: string, files: string[]) {
  const result = spawnSync(executable, ['--root', project, ...files], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined);
  const diagnostics = DiagnosticsSchema.parse(JSON.parse(result.stdout));
  return { status: result.status, diagnostics };
}

before(async () => {
  await mkdir(runtime, { recursive: true });
  project = await mkdtemp(join(runtime, 'project-'));
  owned.push(project);
  const transition = await build({ kind: 'transition', function: 'transition' });
  transitionExecutable = transition.executable;
  transitionCrate = transition.crate;
  const dependency = await build({
    kind: 'dependency', modules: { Pending: ['src/lib.rs', 'src/pending'], Acked: ['src/acked.rs'], Filled: ['src/filled.rs'] },
  });
  dependencyExecutable = dependency.executable;
  await put(join(project, 'src/lib.rs'), 'mod pending; mod acked; mod filled;');
  await put(join(project, 'src/pending/mod.rs'), 'pub struct Item;');
  await put(join(project, 'src/acked.rs'), 'pub struct Item; pub struct Other;');
  await put(join(project, 'src/filled.rs'), 'pub struct Item;');
});

after(async () => {
  for (const path of owned) await rm(path, { recursive: true, force: true });
  // The parent task removes the shared target after all validation finishes.
});

test('Rust accepts qualified literal edge declarations', async () => {
  await put(join(project, 'valid.rs'), 'fn main() { crate::transition!("Pending", "Ack", "Acked"); transition!(r#"Acked"#, "Fill", "Filled",); }');
  assert.deepEqual(check(transitionExecutable, ['valid.rs']), { status: 0, diagnostics: [] });
});

test('Rust accepts direct and qualified function calls with literal transitions', async () => {
  await put(join(project, 'valid-calls.rs'), 'fn main() { crate::transition("Pending", "Ack", "Acked"); transition(r#"Acked"#, "Fill", "Filled",); }');
  assert.deepEqual(check(transitionExecutable, ['valid-calls.rs']), { status: 0, diagnostics: [] });
});

test('Rust reports forbidden edges with source positions', async () => {
  await put(join(project, 'invalid.rs'), 'fn main() {\n    transition!("Pending", "Fill", "Filled");\n}');
  const result = check(transitionExecutable, ['invalid.rs']);
  assert.equal(result.status, 1);
  assert.deepEqual(result.diagnostics, [{ ruleId: 'TLC001', file: 'invalid.rs', line: 2, column: 5, message: 'model forbids transition Pending --Fill--> Filled' }]);
});

test('Rust rejects dynamic arguments, indirect calls, opaque macros and attributes', async () => {
  const cases = [
    'transition!(from, "Ack", "Acked")',
    'transition!("Pending", concat!("A", "ck"), "Acked")',
    'transition!("Pending", "Ack", "Acked", "extra")',
    'transition(from, "Ack", "Acked")',
    'crate::transition("Pending", "Ack")',
    'transition("Pending", "Ack", "Acked", "extra")',
    'transition("Pending", 1, "Acked")',
    'transition::<String>("Pending", "Ack", "Acked")',
    '(transition)("Pending", "Ack", "Acked")',
    'let renamed = transition; renamed("Pending", "Ack", "Acked")',
    'let renamed = crate::transition; renamed("Pending", "Ack", "Acked")',
    'consume(crate::transition)',
    'object.transition("Pending", "Ack", "Acked")',
    'wrapper!(transition!("Pending", "Fill", "Filled"))',
    'include!("opaque.rs")',
  ];
  for (const [index, expression] of cases.entries()) {
    const file = `dynamic-${index}.rs`;
    await put(join(project, file), `fn main() { ${expression}; }`);
    const result = check(transitionExecutable, [file]);
    assert.equal(result.status, 1, expression);
    assert.ok(result.diagnostics.some(value => value.ruleId === 'TLC002'), expression);
  }
  await put(join(project, 'attribute.rs'), '#[custom_expansion]\nfn main() {}');
  assert.equal(check(transitionExecutable, ['attribute.rs']).status, 1);
  await put(join(project, 'rename.rs'), 'use crate::transition as unchecked; fn main() { unchecked!("Pending", "Ack", "Acked"); }');
  assert.equal(check(transitionExecutable, ['rename.rs']).status, 1);
  await put(join(project, 'rename-call.rs'), 'use crate::transition as unchecked; fn main() { unchecked("Pending", "Ack", "Acked"); }');
  assert.equal(check(transitionExecutable, ['rename-call.rs']).status, 1);
});

test('Rust checks architecture and behavior declarations in the same compilable source', async () => {
  const file = 'src/pending/composed.rs';
  const source = (state: string, event: string, destination: string, dependency = 'acked') => `use crate::${dependency}::Item;
fn transition(_from: &str, _event: &str, _to: &str) {}
pub fn run() { let _ = Item; transition("${state}", "${event}", "${destination}"); }
`;
  const valid = source('Pending', 'Ack', 'Acked');
  await put(join(project, file), valid);
  // Compile the actual checked file through a minimal crate root. The checker
  // enforces declarations; the function body is outside its semantic profile.
  const probe = join(project, 'src/composition-probe.rs');
  await put(probe, 'mod acked; mod filled; #[path = "pending/composed.rs"] mod composed; pub fn run() { composed::run(); }');
  const compiled = spawnSync('rustc', ['--edition=2021', '--crate-name', 'composition_probe', '--crate-type', 'lib', probe, '-o', join(project, 'composition-probe.rlib')], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.deepEqual(check(transitionExecutable, [file]), { status: 0, diagnostics: [] });
  assert.deepEqual(check(dependencyExecutable, [file]), { status: 0, diagnostics: [] });

  await put(join(project, file), source('Pending', 'Fill', 'Filled'));
  assert.deepEqual(check(dependencyExecutable, [file]), { status: 0, diagnostics: [] });
  const forbiddenTransition = check(transitionExecutable, [file]);
  assert.equal(forbiddenTransition.status, 1);
  assert.deepEqual(forbiddenTransition.diagnostics.map(value => value.ruleId), ['TLC001']);

  await put(join(project, file), source('Pending', 'Ack', 'Acked', 'filled'));
  assert.deepEqual(check(transitionExecutable, [file]), { status: 0, diagnostics: [] });
  const forbiddenDependency = check(dependencyExecutable, [file]);
  assert.equal(forbiddenDependency.status, 1);
  assert.deepEqual(forbiddenDependency.diagnostics.map(value => value.ruleId), ['TLC003']);
});

test('Rust returns exit 2 for syntax and input errors', async () => {
  await put(join(project, 'syntax.rs'), 'fn broken( {');
  assert.equal(check(transitionExecutable, ['syntax.rs']).status, 2);
  assert.equal(check(transitionExecutable, ['missing.rs']).status, 2);
  const usage = spawnSync(transitionExecutable, [], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.ok(JSON.parse(usage.stdout)[0].ruleId === 'TLC002');
});

test('Rust accepts grouped and renamed allowed dependencies and ignores external crates', async () => {
  await put(join(project, 'src/pending/good.rs'), 'use crate::acked::{Item as Renamed, Other}; use std::collections::HashMap; use ::external::Thing;');
  assert.deepEqual(check(dependencyExecutable, ['src/pending/good.rs']), { status: 0, diagnostics: [] });
});

test('Rust rejects forbidden grouped dependencies and reversed direction', async () => {
  await put(join(project, 'src/pending/bad.rs'), 'use crate::filled::{Item as Renamed};');
  const result = check(dependencyExecutable, ['src/pending/bad.rs']);
  assert.equal(result.status, 1);
  assert.ok(result.diagnostics.some(value => value.ruleId === 'TLC003' && value.message.includes('Pending -> Filled')));
  await put(join(project, 'src/filled.rs'), 'use crate::acked::Item;');
  const reversed = check(dependencyExecutable, ['src/filled.rs']);
  assert.equal(reversed.status, 1);
  assert.ok(reversed.diagnostics.some(value => value.ruleId === 'TLC003'));
  await put(join(project, 'src/filled.rs'), 'pub struct Item;');
});

test('Rust resolves self, super, inline modules and local aliases', async () => {
  await put(join(project, 'src/pending/nested.rs'), 'use super::super::acked::Item; mod inner { use super::super::super::filled::Item; }');
  const result = check(dependencyExecutable, ['src/pending/nested.rs']);
  assert.equal(result.status, 1);
  assert.equal(result.diagnostics.filter(value => value.ruleId === 'TLC003').length, 1);
  await put(join(project, 'src/pending/alias.rs'), 'use crate::filled as target; use target::Item;');
  const alias = check(dependencyExecutable, ['src/pending/alias.rs']);
  assert.equal(alias.status, 1);
  assert.equal(alias.diagnostics.filter(value => value.ruleId === 'TLC003').length, 2);
  await put(join(project, 'src/pending/block-alias.rs'), 'fn f() { use crate::acked as target; use target::Item; }');
  assert.deepEqual(check(dependencyExecutable, ['src/pending/block-alias.rs']), { status: 0, diagnostics: [] });
});

test('Rust resolves forward alias chains independently of import order in every scope', async () => {
  const chains = [
    'use bridge as target; use crate as bridge;',
    'use crate as bridge; use bridge as target;',
    'use middle as target; use bridge as middle; use crate as bridge;',
  ];
  for (const [index, chain] of chains.entries()) {
    for (const state of ['acked', 'filled']) {
      const source = `${chain} use target::${state}::Item;`;
      // These are valid Rust imports. The checker must enforce the model even
      // when the local crate alias is declared after the alias that uses it.
      const probe = join(project, 'alias-probe.rs');
      await put(probe, `pub mod acked { pub struct Item; } pub mod filled { pub struct Item; } mod pending { ${source} }`);
      const compiled = spawnSync('rustc', ['--edition=2021', '--crate-name', 'alias_probe', '--crate-type', 'lib', probe, '-o', join(project, 'alias-probe.rlib')], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(compiled.status, 0, compiled.stderr);
      for (const [scope, contents] of [['file', source], ['block', `fn f() { ${source} }`], ['module', `mod inner { ${source} }`]]) {
        const file = `src/pending/forward-${scope}-${index}-${state}.rs`;
        await put(join(project, file), contents);
        const result = check(dependencyExecutable, [file]);
        if (state === 'acked') {
          assert.deepEqual(result, { status: 0, diagnostics: [] }, contents);
        } else {
          assert.equal(result.status, 1, contents);
          assert.ok(result.diagnostics.some(value => value.ruleId === 'TLC003' && value.message.includes('Pending -> Filled')), contents);
          assert.ok(result.diagnostics.every(value => value.ruleId !== 'TLC002'), contents);
        }
      }
    }
  }
});

test('Rust normalizes raw module and alias identifiers before dependency resolution', async () => {
  for (const state of ['acked', 'filled']) {
    const sources = [
      `use crate::r#${state}; fn f() { let _ = ${state}::Item; }`,
      `use crate::r#${state} as r#target; use target::Item;`,
      `use crate::{r#${state}::{Item as r#item}};`,
    ];
    for (const [index, source] of sources.entries()) {
      const file = `src/pending/raw-${state}-${index}.rs`;
      await put(join(project, file), source);
      const result = check(dependencyExecutable, [file]);
      if (state === 'acked') {
        assert.deepEqual(result, { status: 0, diagnostics: [] }, source);
      } else {
        assert.equal(result.status, 1, source);
        assert.ok(result.diagnostics.some(value => value.ruleId === 'TLC003' && value.message.includes('Pending -> Filled')), source);
        assert.ok(result.diagnostics.every(value => value.ruleId !== 'TLC002'), source);
      }
    }
  }
  await put(join(project, 'src/pending/rawmodule/child.rs'), 'pub struct Item;');
  await put(join(project, 'src/pending/rawmodule/mod.rs'), 'mod r#child; use self::child::Item;');
  assert.deepEqual(check(dependencyExecutable, ['src/pending/rawmodule/mod.rs']), { status: 0, diagnostics: [] });
});

test('Rust rejects cyclic aliases and unknown single names instead of falling back to the crate root', async () => {
  const sources = [
    'use right as left; use left as right;',
    'fn f() { use right as left; use left as right; }',
    'use crate::missing;',
    'use crate as root; use root::missing;',
  ];
  for (const [index, source] of sources.entries()) {
    const file = `src/pending/unresolved-${index}.rs`;
    await put(join(project, file), source);
    const result = check(dependencyExecutable, [file]);
    assert.equal(result.status, 1, source);
    assert.ok(result.diagnostics.some(value => value.ruleId === 'TLC002'), source);
  }
});

test('Rust inspects mod declarations and fails closed on hidden imports', async () => {
  await put(join(project, 'src/pending/child.rs'), 'pub struct Item;');
  await put(join(project, 'src/pending/mod.rs'), 'mod child; use self::child::Item;');
  assert.deepEqual(check(dependencyExecutable, ['src/pending/mod.rs']), { status: 0, diagnostics: [] });
  await put(join(project, 'src/pending/unsupported.rs'), 'use crate::acked::*; wrapper!(use crate::filled::Item;);');
  const result = check(dependencyExecutable, ['src/pending/unsupported.rs']);
  assert.equal(result.status, 1);
  assert.equal(result.diagnostics.filter(value => value.ruleId === 'TLC002').length, 2);
  await put(join(project, 'src/pending/path.rs'), '#[path = "../filled.rs"] mod hidden;');
  assert.equal(check(dependencyExecutable, ['src/pending/path.rs']).status, 1);
  await put(join(project, 'src/pending/missing.rs'), 'mod absent; use crate::missing::Item;');
  const missing = check(dependencyExecutable, ['src/pending/missing.rs']);
  assert.equal(missing.status, 1);
  assert.equal(missing.diagnostics.filter(value => value.ruleId === 'TLC002').length, 2);
  await put(join(project, 'src/pending/self-alias.rs'), 'extern crate self as hidden; use hidden::filled::Item;');
  assert.equal(check(dependencyExecutable, ['src/pending/self-alias.rs']).status, 1);
});

test('Rust rejects ambiguous and unmapped dependencies instead of guessing ownership', async () => {
  await put(join(project, 'src/acked/mod.rs'), 'pub struct Item;');
  const ambiguous = check(dependencyExecutable, ['src/pending/good.rs']);
  assert.equal(ambiguous.status, 1);
  assert.ok(ambiguous.diagnostics.some(value => value.ruleId === 'TLC002'));
  await rm(join(project, 'src/acked'), { recursive: true, force: true });
  await put(join(project, 'src/unmapped.rs'), 'use crate::filled::Item;');
  assert.equal(check(dependencyExecutable, ['src/unmapped.rs']).status, 1);
});

test('Rust crate is standalone and rejects escaped module prefixes', () => {
  const result = spawnSync('cargo', ['check', '--quiet', '--manifest-path', join(transitionCrate, 'Cargo.toml'), '--target-dir', target], { encoding: 'utf8', timeout: 180_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.throws(() => generateRust({ automaton, binding: { kind: 'dependency', modules: { Pending: ['../outside'] } } }), /project-relative/);
});
