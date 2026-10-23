import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { buildProject, compileProject } from '../src/compiler.js';
import { parseSanyXml } from '../src/sany-xml.js';
import { lowerSymbolicModel } from '../src/symbolic-lower.js';
import { stepSymbolic, type SymbolicState } from '../src/symbolic-semantics.js';
import { parseSymbolicConfig } from '../src/symbolic-tlc.js';
import { SymbolicExpressionSchema, SymbolicModelSchema, SymbolicValueSchema, type SymbolicModel } from '../src/symbolic-types.js';
import { SymbolicWitnessSchema } from '../src/symbolic-witness.js';
import { generateVisualization, loadAutomaton } from '../src/visualize.js';

const execute = promisify(execFile);
const jar = process.env.TLA2TOOLS_JAR ? resolve(process.env.TLA2TOOLS_JAR) : undefined;
const tsc = resolve('node_modules/typescript/bin/tsc');
const example = resolve('examples/fact-merge');
const Snapshot = z.object({ model: z.string(), modelRevision: z.string(), revision: z.string(), values: z.record(SymbolicValueSchema) }).strict();
const Trace = z.array(z.object({ input: z.string(), action: z.string(), before: Snapshot, after: Snapshot, updates: z.record(SymbolicExpressionSchema) }).strict());
const Traces = z.array(Trace);
type NativeTrace = z.infer<typeof Trace>;

function interpretedTrace(model: SymbolicModel, inputs: string[]): NativeTrace {
  let state: SymbolicState = model.initial;
  let revision = 0;
  const snapshot = () => ({ model: model.name, modelRevision: model.source.semanticSha256, revision: String(revision), values: state });
  return inputs.map(input => {
    const before = snapshot();
    const result = stepSymbolic(model, state, input);
    assert.equal(result.kind, 'accepted');
    if (result.kind !== 'accepted') throw new Error('Expected the total fact merge relation');
    state = result.state;
    revision++;
    return { input, action: result.action, before, after: snapshot(), updates: result.updates };
  });
}

test('v3 imported DOT refuses symbolic authority before reading DOT or creating output', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'sgd-symbolic-import-'));
  try {
    const out = join(temp, 'out');
    await assert.rejects(compileProject({ project: join(example, 'project.json'), dot: join(temp, 'does-not-exist.dot'), out }), /TLC206: imported DOT cannot generate symbolic-owned authority/);
    await assert.rejects(access(out), { code: 'ENOENT' });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('real v3 build preserves SANY, finite input oracle, symbolic program, stable provenance, both Pele views, and output ownership', { skip: !jar, timeout: 180_000 }, async () => {
  assert.ok(jar);
  const temp = await mkdtemp(join(tmpdir(), 'sgd-symbolic-build-'));
  try {
    const input = { project: join(example, 'project.json'), jar, out: temp };
    const witness = SymbolicWitnessSchema.parse(await buildProject(input));
    assert.equal(witness.kind, 'symbolic-witness');
    assert.deepEqual(witness.variables, ['phase', 'rejected', 'stored']);
    assert.deepEqual(witness.atoms, ['v1', 'v2']);
    assert.equal(witness.nodes.length, 5);
    const model = SymbolicModelSchema.parse(JSON.parse(await readFile(join(temp, 'symbolic-model.json'), 'utf8')));
    const xml = await readFile(join(temp, 'semantic.xml'), 'utf8');
    assert.deepEqual(model, lowerSymbolicModel({ name: 'ManifestWrite', semantic: parseSanyXml(xml), config: parseSymbolicConfig(await readFile(join(example, 'ManifestWrite.cfg'), 'utf8')) }));
    assert.deepEqual(model.branches.map(branch => branch.action), ['Insert', 'Same', 'Clash']);
    assert.deepEqual(model.invariants.map(item => item.name), ['TypeOK', 'ConflictKeepsStored']);
    assert.deepEqual(model.actionProperties.map(item => item.name), ['StoredStable']);
    const oracle = JSON.parse(await readFile(join(temp, 'input-verification.json'), 'utf8'));
    assert.equal(oracle.kind, 'tlc-finite-input-oracle');
    assert.equal(oracle.scope, 'configured-reachable-state-input-product');
    assert.equal(oracle.checkedCases, witness.nodes.length * witness.atoms.length);
    assert.equal(oracle.acceptedCases, oracle.checkedCases);
    assert.equal(oracle.disabledCases, 0);
    assert.match(await readFile(join(temp, 'input-oracle.log'), 'utf8'), /Model checking completed\. No error has been found\./);
    assert.match(await readFile(join(temp, 'input-oracle.dot'), 'utf8'), /before/);
    assert.match(await readFile(join(temp, 'input-oracle.dot'), 'utf8'), /after/);
    const receipt = JSON.parse(await readFile(join(temp, 'verification.json'), 'utf8'));
    assert.equal(receipt.kind, 'tlc-symbolic-completed');
    assert.equal(receipt.profile, 'symbolic-owned-v1');
    assert.equal(receipt.extractor, 'SANY-XML-v1');
    assert.equal(receipt.semanticSha256, model.source.semanticSha256);
    assert.equal(receipt.dotSha256, witness.source.dotSha256);
    assert.equal(receipt.generation, 'symbolic-authority');
    assert.deepEqual(receipt.runtimeDomain, { kind: 'untyped-opaque-unicode-string-identities', constant: 'Values', finiteWitnessAtoms: ['v1', 'v2'] });
    assert.deepEqual(receipt.orbitVerification.invariants, ['TypeOK', 'ConflictKeepsStored']);
    assert.deepEqual(receipt.orbitVerification.actionProperties, ['StoredStable']);
    assert.equal(receipt.moduleClosure[0]?.name, 'ManifestWrite.tla');
    assert.deepEqual(await loadAutomaton(join(temp, 'automaton.json')), witness);
    assert.deepEqual(await loadAutomaton(join(temp, 'symbolic-model.json')), model);
    const view = generateVisualization([witness, model]);
    assert.deepEqual(JSON.parse(view.find(file => file.path === 'models.json')!.content), [witness, model]);
    const html = view.find(file => file.path === 'index.html')!.content;
    assert.match(html, /configured finite witness states/);
    assert.match(html, /equality\/copy orbits/);
    assert.match(html, /input-verification\.json/);
    assert.match(html, /data\(Values/);
    assert.ok(view.some(file => file.path === 'structure.svg'));
    const inventory = z.object({ version: z.literal(1), files: z.array(z.string()) }).parse(JSON.parse(await readFile(join(temp, '.sgd-generated.json'), 'utf8')));
    const bytes = await Promise.all(inventory.files.map(file => readFile(join(temp, file))));
    await buildProject({ ...input, check: true });
    assert.deepEqual(await Promise.all(inventory.files.map(file => readFile(join(temp, file)))), bytes, 'check mode must preserve the actual output bytes, including receipts');
    await writeFile(join(temp, 'verification.json'), JSON.stringify({ ...receipt, moduleClosure: [] }));
    await assert.rejects(buildProject({ ...input, check: true }), /TLC104: stale receipt field moduleClosure/);
    await buildProject(input);
    await writeFile(join(temp, 'typescript/machine.ts'), '// stale generated policy\n');
    await assert.rejects(buildProject({ ...input, check: true }), /TLC104: stale generated file typescript\/machine\.ts/);
    await buildProject({ ...input, modelOnly: true });
    const nativeArtifacts = inventory.files.filter(path => path.startsWith('typescript/') || path.startsWith('rust/'));
    assert.ok(nativeArtifacts.includes('typescript/machine.ts') && nativeArtifacts.includes('rust/src/lib.rs'));
    for (const path of [...nativeArtifacts, 'input-verification.json', 'input-oracle.dot', 'orbit-proof.json']) await assert.rejects(access(join(temp, path)), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(join(temp, 'verification.json'), 'utf8')).generation, 'model-only');
    await access(join(temp, 'automaton.json'));
    await access(join(temp, 'symbolic-model.json'));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('real ManifestWrite source selects native actions, retains latest conflict, distinguishes sentinels, and regenerates a conflict-resolution requirement', { skip: !jar, timeout: 240_000 }, async () => {
  assert.ok(jar);
  const temp = await mkdtemp(join(tmpdir(), 'sgd-symbolic-native-'));
  const target = resolve('.runtime/symbolic-compiler-tests/target');
  try {
    const models = join(temp, 'model');
    await cp(example, models, { recursive: true });
    const out = join(temp, 'out');
    const input = { project: join(models, 'project.json'), jar, out };
    await buildProject(input);
    assert.match((await execute(process.execPath, [tsc, '--version'], { timeout: 30_000 })).stdout, /^Version 7\.0\.2\s*$/);
    const sequences = [['A', 'B', 'C', 'A'], ['none', 'none', 'A', 'none'], ['Same', 'Clash', 'Insert']];
    const runner = join(temp, 'run.mjs');
    await writeFile(runner, `import { createFactMachine, isFactMachine } from './out/typescript/dist/machine.js';
const traces = JSON.parse(process.argv[2]).map(inputs => {
  const machine = createFactMachine();
  if (!isFactMachine(machine)) throw new Error('Expected authentic generated owner');
  return inputs.map(input => {
    const result = machine.send(input);
    if (!result.ok) throw new Error(JSON.stringify(result));
    const { action, before, after, updates } = result;
    return { input, action, before, after, updates };
  });
});
process.stdout.write(JSON.stringify(traces));
`);
    const consumer = join(temp, 'consumer');
    await mkdir(join(consumer, 'src'), { recursive: true });
    const manifest = await readFile(join(out, 'rust/Cargo.toml'), 'utf8');
    const packageName = /^name = "([^"]+)"$/m.exec(manifest)?.[1];
    assert.ok(packageName);
    await writeFile(join(consumer, 'Cargo.toml'), `[package]\nname = "symbolic-integration-consumer"\nversion = "0.0.0"\nedition = "2021"\n[workspace]\n[dependencies]\nauthority = { package = ${JSON.stringify(packageName)}, path = "../out/rust" }\nserde_json = "=1.0.154"\n`);
    await writeFile(join(consumer, 'src/main.rs'), `#![forbid(unsafe_code)]
use authority::FactMachine;
fn main() {
    let sequences: Vec<Vec<String>> = serde_json::from_str(&std::env::args().nth(1).unwrap()).unwrap();
    let traces: Vec<_> = sequences.iter().map(|inputs| {
        let mut machine = FactMachine::new();
        inputs.iter().map(|input| {
            let before = machine.read();
            let result = machine.send(input).expect("fact input is enabled");
            assert_eq!(result.before, before);
            assert_eq!(result.after, machine.read());
            serde_json::json!({"input": input, "action": result.action, "before": result.before, "after": result.after, "updates": result.updates})
        }).collect::<Vec<_>>()
    }).collect();
    print!("{}", serde_json::to_string(&traces).unwrap());
}
`);
    const cargoOptions = { timeout: 120_000, env: { ...process.env, CARGO_TARGET_DIR: target, CARGO_BUILD_JOBS: '2' }, maxBuffer: 4 * 1024 * 1024 };
    await execute('cargo', ['fetch', '--manifest-path', join(consumer, 'Cargo.toml')], cargoOptions);
    async function nativeTraces(): Promise<z.infer<typeof Traces>> {
      await execute(process.execPath, [tsc, '-p', join(out, 'typescript/tsconfig.json')], { timeout: 30_000 });
      const [typescript, rust] = await Promise.all([
        execute(process.execPath, [runner, JSON.stringify(sequences)], { timeout: 15_000 }),
        execute('cargo', ['run', '--offline', '--quiet', '--manifest-path', join(consumer, 'Cargo.toml'), '--', JSON.stringify(sequences)], cargoOptions),
      ]);
      const tsTrace = Traces.parse(JSON.parse(typescript.stdout));
      const rustTrace = Traces.parse(JSON.parse(rust.stdout));
      assert.deepEqual(tsTrace, rustTrace, 'native receipts must agree in complete snapshots, action choice, and assignment origins');
      const model = SymbolicModelSchema.parse(JSON.parse(await readFile(join(out, 'symbolic-model.json'), 'utf8')));
      assert.deepEqual(tsTrace, sequences.map(inputs => interpretedTrace(model, inputs)));
      return tsTrace;
    }
    const original = await nativeTraces();
    const trace = original[0];
    assert.ok(trace);
    assert.deepEqual(trace.map(step => step.action), ['Insert', 'Clash', 'Clash', 'Same']);
    assert.deepEqual(trace.map(step => step.after.values.stored), Array(4).fill({ kind: 'data', domain: 'Values', value: 'A' }));
    assert.deepEqual(trace.map(step => step.after.values.rejected), [{ kind: 'string', value: 'none' }, { kind: 'data', domain: 'Values', value: 'B' }, { kind: 'data', domain: 'Values', value: 'C' }, { kind: 'data', domain: 'Values', value: 'C' }]);
    assert.deepEqual(trace[3]?.updates, { phase: { kind: 'state', variable: 'phase' }, rejected: { kind: 'state', variable: 'rejected' }, stored: { kind: 'state', variable: 'stored' } });
    assert.deepEqual(trace[3]?.after.values.phase, { kind: 'string', value: 'conflict' });
    const sentinel = original[1]?.[0];
    assert.deepEqual(sentinel?.before.values.stored, { kind: 'string', value: 'none' });
    assert.deepEqual(sentinel?.after.values.stored, { kind: 'data', domain: 'Values', value: 'none' });
    assert.deepEqual(original[1]?.map(step => step.action), ['Insert', 'Same', 'Clash', 'Same']);
    assert.deepEqual(original[2]?.map(step => step.action), ['Insert', 'Clash', 'Clash']);
    const spec = join(models, 'ManifestWrite.tla');
    const source = await readFile(spec, 'utf8');
    const changed = source.replace('  /\\ UNCHANGED vars\n', '  /\\ phase\' = "present"\n  /\\ rejected\' = "none"\n  /\\ UNCHANGED stored\n');
    assert.notEqual(changed, source, 'the requirement change must edit the original Same action');
    await writeFile(spec, changed);
    await assert.rejects(buildProject({ ...input, check: true }), /TLC104/);
    await buildProject(input);
    const regenerated = await nativeTraces();
    assert.deepEqual(regenerated[0]?.map(step => step.action), ['Insert', 'Clash', 'Clash', 'Same']);
    const final = regenerated[0]?.[3];
    assert.deepEqual(final?.after.values, { phase: { kind: 'string', value: 'present' }, rejected: { kind: 'string', value: 'none' }, stored: { kind: 'data', domain: 'Values', value: 'A' } });
    assert.deepEqual(final?.updates, { phase: { kind: 'literal', value: { kind: 'string', value: 'present' } }, rejected: { kind: 'literal', value: { kind: 'string', value: 'none' } }, stored: { kind: 'state', variable: 'stored' } });
    assert.notEqual(final?.after.modelRevision, trace[3]?.after.modelRevision);
    const regeneratedModel = SymbolicModelSchema.parse(JSON.parse(await readFile(join(out, 'symbolic-model.json'), 'utf8')));
    assert.deepEqual(regeneratedModel.invariants.map(item => item.name), ['TypeOK', 'ConflictKeepsStored']);
    assert.deepEqual(regeneratedModel.actionProperties.map(item => item.name), ['StoredStable']);
    assert.equal(await readFile(join(example, 'ManifestWrite.tla'), 'utf8'), source, 'the real example must remain unchanged');
  } finally { await rm(temp, { recursive: true, force: true }); }
});
