import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertModelRefusal } from './verify-result.mjs';

const sdkRoot = fileURLToPath(new URL('../../', import.meta.url));
const exampleRoot = fileURLToPath(new URL('./', import.meta.url));
const cli = path.join(sdkRoot, 'dist/cli.js');
const jar = process.env.TLA2TOOLS_JAR
  ? path.resolve(process.env.TLA2TOOLS_JAR)
  : path.join(sdkRoot, '.runtime/tla2tools.jar');

assert.ok(fs.existsSync(cli), 'Build the SDK first with npm run build.');
assert.ok(fs.existsSync(jar), 'Set TLA2TOOLS_JAR or run node scripts/fetch-tlc.mjs from the SDK root.');
const { TlcFailureDiagnosticSchema } = await import('../../dist/tlc-failure.js');

const source = fs.readFileSync(path.join(exampleRoot, 'model.tla'), 'utf8');
const config = fs.readFileSync(path.join(exampleRoot, 'model.cfg'), 'utf8');
const project = fs.readFileSync(path.join(exampleRoot, 'project.json'), 'utf8');
const scratchParent = path.join(sdkRoot, '.runtime/partition-control');
fs.mkdirSync(scratchParent, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchParent, 'verify-model-'));

function build(projectPath, out, check = false) {
  const result = spawnSync(process.execPath, [
    cli, 'build', '--project', projectPath, '--jar', jar, '--out', out,
    ...(check ? ['--check'] : []),
  ], {
    cwd: sdkRoot,
    encoding: 'utf8',
    // The controlled runner bounds Java at 120 seconds. Leave time for its cleanup.
    timeout: 135_000,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(result.error, undefined, `Compiler process failed: ${result.error?.message ?? ''}\n${output}`);
  assert.equal(result.signal, null, `Compiler process was interrupted: ${result.signal}\n${output}`);
  return { status: result.status, signal: result.signal, error: result.error, stdout: result.stdout, stderr: result.stderr, output };
}

const variants = [
  {
    name: 'ambiguous-close-after-clash',
    original: '/\\ hasInserted /\\ ~hasConflict',
    replacement: '/\\ hasInserted',
    property: 'CloseChoice',
    kind: 'invariant_violation',
  },
  {
    name: 'refusal-becomes-write',
    original: 'CloseRefused ==\n  /\\ phase = "Open"\n  /\\ hasConflict\n  /\\ phase\' = "ReadyRefused"',
    replacement: 'CloseRefused ==\n  /\\ phase = "Open"\n  /\\ hasConflict\n  /\\ phase\' = "ReadyWrite"',
    property: 'CloseAdmission',
    kind: 'invariant_violation',
  },
  {
    name: 'disabled-refusal-close',
    original: 'CloseRefused ==\n  /\\ phase = "Open"\n  /\\ hasConflict',
    replacement: 'CloseRefused ==\n  /\\ phase = "Open"\n  /\\ FALSE',
    property: 'CloseChoice',
    kind: 'invariant_violation',
  },
  {
    name: 'clear-refusal',
    original: "  /\\ hasInserted' = TRUE\n  /\\ UNCHANGED <<phase, hasConflict>>",
    replacement: "  /\\ hasInserted' = TRUE\n  /\\ hasConflict' = FALSE\n  /\\ UNCHANGED phase",
    property: 'ConflictSticky',
    kind: 'action_property_violation',
  },
  {
    name: 'cleared-insertion',
    original: 'Same ==\n  /\\ phase = "Open"\n  /\\ UNCHANGED vars',
    replacement: 'Same ==\n  /\\ phase = "Open"\n  /\\ hasInserted\' = FALSE\n  /\\ UNCHANGED <<phase, hasConflict>>',
    property: 'InsertSticky',
    kind: 'action_property_violation',
  },
  {
    name: 'reopen',
    original: 'ConsumeNoop ==\n  /\\ phase = "ReadyNoop"\n  /\\ phase\' = "Consumed"',
    replacement: 'ConsumeNoop ==\n  /\\ phase = "ReadyNoop"\n  /\\ phase\' = "Open"',
    property: 'NoReopen',
    kind: 'action_property_violation',
  },
  {
    name: 'consume-again',
    original: 'ConsumeRefused ==\n  /\\ phase = "ReadyRefused"',
    replacement: 'ConsumeRefused ==\n  /\\ phase \\in {"ReadyRefused", "Consumed"}',
    property: 'SingleConsumption',
    kind: 'invariant_violation',
  },
  {
    name: 'input-after-close',
    original: 'Same ==\n  /\\ phase = "Open"',
    replacement: 'Same ==\n  /\\ phase \\in {"Open", "Consumed"}',
    property: 'NoInputAfterClose',
    kind: 'invariant_violation',
  },
];

try {
  const positiveOutput = path.join(scratch, 'positive');
  const positiveProject = path.join(exampleRoot, 'project.json');
  const initial = build(positiveProject, positiveOutput);
  assert.equal(initial.status, 0, `The authoritative model failed verification.\n${initial.output}`);
  assert.ok(fs.existsSync(path.join(positiveOutput, 'typescript/machine.ts')), 'The positive build did not generate TypeScript authority.');
  assert.ok(fs.existsSync(path.join(positiveOutput, 'rust/src/lib.rs')), 'The positive build did not generate Rust authority.');
  const repeated = build(positiveProject, positiveOutput, true);
  assert.equal(repeated.status, 0, `Fresh generation differs from its checked artifacts.\n${repeated.output}`);
  process.stdout.write('Authoritative partition model: build and --check passed.\n');

  for (const variant of variants) {
    assert.equal(source.split(variant.original).length, 2, `${variant.name}: expected exactly one mutation location. Update this mutation when the model changes.`);
    const directory = path.join(scratch, variant.name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'model.tla'), source.replace(variant.original, variant.replacement));
    fs.writeFileSync(path.join(directory, 'model.cfg'), config);
    fs.writeFileSync(path.join(directory, 'project.json'), project);
    const out = path.join(directory, 'out');
    const result = build(path.join(directory, 'project.json'), out);
    const expected = variant.kind === 'invariant_violation'
      ? { kind: variant.kind, phase: 'tlc', invariant: variant.property, evidence: { kind: 'pinned-tlc-message', code: 2110 } }
      : { kind: variant.kind, phase: 'tlc', property: variant.property, evidence: { kind: 'pinned-tlc-message', code: 2112 } };
    assertModelRefusal(result, expected, value => TlcFailureDiagnosticSchema.parse(value));
    assert.equal(fs.existsSync(out), false, `${variant.name}: a refused model published output.`);
    process.stdout.write(`${variant.name}: TLC rejected ${variant.property}; no output published.\n`);
  }
} finally {
  // Delete only the fresh directory created by this invocation.
  assert.equal(path.dirname(scratch), scratchParent);
  assert.match(path.basename(scratch), /^verify-model-[A-Za-z0-9]+$/);
  fs.rmSync(scratch, { recursive: true, force: true });
}
