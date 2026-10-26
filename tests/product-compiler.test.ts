import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { buildProject, compileProject, readProject } from '../src/compiler.js';
import { lowerSymbolicModel } from '../src/symbolic-lower.js';
import { parseSanyXml } from '../src/sany-xml.js';
import { parseSymbolicConfig } from '../src/symbolic-tlc.js';
import { stepSymbolic, type SymbolicState } from '../src/symbolic-semantics.js';
import { SymbolicExpressionSchema, SymbolicModelV2Schema, SymbolicValueSchema, type SymbolicModelV2 } from '../src/symbolic-types.js';
import { SymbolicWitnessSchema } from '../src/symbolic-witness.js';
import { generateVisualization, loadAutomaton } from '../src/visualize.js';

const execute = promisify(execFile);
const jar = process.env.TLA2TOOLS_JAR ? resolve(process.env.TLA2TOOLS_JAR) : undefined;
const tsc = resolve('node_modules/typescript/bin/tsc');
const example = resolve('examples/fact-envelope');
const Frame = z.object({ v: z.string(), provenance: z.string() }).strict();
const Snapshot = z.object({ model: z.string(), modelRevision: z.string(), revision: z.string(), values: z.record(z.string(), SymbolicValueSchema) }).strict();
const Trace = z.array(z.object({ input: Frame, action: z.string(), before: Snapshot, after: Snapshot, updates: z.record(z.string(), SymbolicExpressionSchema) }).strict());
const Traces = z.array(Trace);
const RuntimeDomains = z.object({
  kind: z.literal('disjoint-untyped-opaque-unicode-string-identities'),
  inputs: z.array(z.object({ parameter: z.string(), domain: z.string() }).strict()),
  domains: z.record(z.string(), z.object({ finiteWitnessAtoms: z.array(z.string()) }).strict()),
}).strict();

function interpretedTrace(model: SymbolicModelV2, inputs: z.infer<typeof Frame>[]): z.infer<typeof Trace> {
  let state: SymbolicState = model.initial;
  let revision = 0;
  const snapshot = () => ({ model: model.name, modelRevision: model.source.semanticSha256, revision: String(revision), values: state });
  return inputs.map(input => {
    const before = snapshot();
    const result = stepSymbolic(model, state, input);
    if (result.kind !== 'accepted') throw new Error('Expected the total fact-envelope relation');
    state = result.state;
    revision++;
    return { input, action: result.action, before, after: snapshot(), updates: result.updates };
  });
}

test('v4 project is explicit and imported DOT cannot create product-input authority', async () => {
  const project = await readProject(join(example, 'project.json'));
  assert.equal(project.version, 4);
  const temp = await mkdtemp(join(tmpdir(), 'sgd-product-import-'));
  try {
    const out = join(temp, 'out');
    await assert.rejects(compileProject({ project: join(example, 'project.json'), dot: join(temp, 'absent.dot'), out }), /TLC206: imported DOT cannot generate symbolic-owned authority/);
    await assert.rejects(access(out), { code: 'ENOENT' });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('real v4 build retains all domains and provenance in source, witness, oracle, Pele, and stable regeneration', { skip: !jar, timeout: 180_000 }, async () => {
  assert.ok(jar);
  const temp = await mkdtemp(join(tmpdir(), 'sgd-product-build-'));
  try {
    const models = join(temp, 'models');
    await cp(example, models, { recursive: true });
    const out = join(temp, 'out');
    const input = { project: join(models, 'project.json'), jar, out };
    const witness = SymbolicWitnessSchema.parse(await buildProject(input));
    assert.equal(witness.version, 2);
    if (witness.version !== 2) throw new Error('Expected a product-domain witness');
    assert.deepEqual(witness.domains, { Receipts: ['p1', 'p2'], Values: ['v1', 'v2'] });
    assert.deepEqual(witness.variables, ['phase', 'rejected', 'rejectedProvenance', 'stored', 'storedProvenance']);
    const model = SymbolicModelV2Schema.parse(JSON.parse(await readFile(join(out, 'symbolic-model.json'), 'utf8')));
    assert.deepEqual(model.inputs, [{ parameter: 'v', domain: 'Values' }, { parameter: 'provenance', domain: 'Receipts' }]);
    assert.deepEqual(model.actionProperties.map(property => property.name), ['StoredStable', 'ProvenanceStable']);
    const xml = await readFile(join(out, 'semantic.xml'), 'utf8');
    assert.deepEqual(model, lowerSymbolicModel({ name: model.name, semantic: parseSanyXml(xml), config: parseSymbolicConfig(await readFile(join(models, 'FactWriteEnvelope.cfg'), 'utf8')), profile: 'product' }));
    const oracle = z.object({ kind: z.literal('tlc-finite-input-oracle'), scope: z.literal('configured-reachable-state-input-product'),
      checkedCases: z.number(), acceptedCases: z.number(), disabledCases: z.number(),
      inputs: z.array(z.object({ parameter: z.string(), domain: z.string() })), domains: z.record(z.string(), z.array(z.string())),
    }).parse(JSON.parse(await readFile(join(out, 'input-verification.json'), 'utf8')));
    assert.deepEqual(oracle.inputs, model.inputs);
    assert.deepEqual(oracle.domains, witness.domains);
    assert.equal(oracle.checkedCases, witness.nodes.length * 2 * 2);
    assert.equal(oracle.acceptedCases, oracle.checkedCases);
    assert.equal(oracle.disabledCases, 0);
    assert.match(await readFile(join(out, 'input-oracle.log'), 'utf8'), /Model checking completed\. No error has been found\./);
    const receipt = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(join(out, 'verification.json'), 'utf8')));
    assert.equal(receipt.profile, 'symbolic-owned-v1');
    assert.equal(receipt.symbolicIrVersion, 2);
    assert.equal(receipt.inputProfile, 'disjoint-input-product-v1');
    const runtimeDomain = RuntimeDomains.parse(receipt.runtimeDomain);
    assert.deepEqual(runtimeDomain, {
      kind: 'disjoint-untyped-opaque-unicode-string-identities', inputs: model.inputs,
      domains: { Values: { finiteWitnessAtoms: ['v1', 'v2'] }, Receipts: { finiteWitnessAtoms: ['p1', 'p2'] } },
    });
    assert.deepEqual(await loadAutomaton(join(out, 'automaton.json')), witness);
    assert.deepEqual(await loadAutomaton(join(out, 'symbolic-model.json')), model);
    const view = generateVisualization([witness, model]);
    assert.deepEqual(JSON.parse(view.find(file => file.path === 'models.json')?.content ?? 'null'), [witness, model]);
    const html = view.find(file => file.path === 'index.html')?.content ?? '';
    assert.match(html, /configured finite witness states/);
    assert.match(html, /storedProvenance/);
    assert.match(html, /rejectedProvenance/);
    assert.match(html, /data\(Values/);
    assert.match(html, /data\(Receipts/);
    assert.match(html, /v\[Values\]/);
    assert.match(html, /provenance\[Receipts\]/);
    assert.doesNotMatch(html, /\[object Object\]/);
    const inventory = z.object({ version: z.literal(1), files: z.array(z.string()) }).parse(JSON.parse(await readFile(join(out, '.sgd-generated.json'), 'utf8')));
    const bytes = await Promise.all(inventory.files.map(file => readFile(join(out, file))));
    await buildProject({ ...input, check: true });
    assert.deepEqual(await Promise.all(inventory.files.map(file => readFile(join(out, file)))), bytes);
    await writeFile(join(out, 'verification.json'), JSON.stringify({ ...receipt,
      runtimeDomain: { ...runtimeDomain, domains: { ...runtimeDomain.domains, Receipts: { finiteWitnessAtoms: [] } } },
    }));
    await assert.rejects(buildProject({ ...input, check: true }), /TLC104: stale receipt field runtimeDomain/);
    await writeFile(join(out, 'verification.json'), JSON.stringify({ ...receipt, inputProfile: 'single-input' }));
    await assert.rejects(buildProject({ ...input, check: true }), /TLC104: stale receipt field inputProfile/);
    await buildProject(input);
    await buildProject({ ...input, modelOnly: true });
    for (const file of [...inventory.files.filter(path => path.startsWith('typescript/')), 'input-verification.json', 'input-oracle.dot', 'orbit-proof.json']) {
      await assert.rejects(access(join(out, file)), { code: 'ENOENT' });
    }
    assert.equal(z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(join(out, 'verification.json'), 'utf8'))).generation, 'model-only');
    assert.deepEqual(SymbolicWitnessSchema.parse(JSON.parse(await readFile(join(out, 'automaton.json'), 'utf8'))).version, 2);
    const project = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(input.project, 'utf8')));
    await writeFile(input.project, JSON.stringify({ ...project, version: 3 }));
    await assert.rejects(buildProject({ ...input, out: join(temp, 'wrong-profile'), modelOnly: true }), /TLC301.*(?:one|single)/i);
    await assert.rejects(access(join(temp, 'wrong-profile')), { code: 'ENOENT' });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('real v4 source drives matching native payload and provenance traces through repeated rejected inputs', { skip: !jar, timeout: 180_000 }, async () => {
  assert.ok(jar);
  const temp = await mkdtemp(join(tmpdir(), 'sgd-product-native-'));
  try {
    const out = join(temp, 'out');
    await buildProject({ project: join(example, 'project.json'), jar, out });
    const model = SymbolicModelV2Schema.parse(JSON.parse(await readFile(join(out, 'symbolic-model.json'), 'utf8')));
    const sequences = [
      [{ v: 'A', provenance: 'r1' }, { v: 'B', provenance: 'r2' }, { v: 'B', provenance: 'r3' }, { v: 'A', provenance: 'r4' }],
      [{ v: 'none', provenance: 'none' }, { v: 'none', provenance: 'other' }, { v: 'C', provenance: 'none' }, { v: 'D', provenance: 'r5' }],
    ];
    assert.match((await execute(process.execPath, [tsc, '--version'], { timeout: 30_000 })).stdout, /^Version 7\.0\.2\s*$/);
    await execute(process.execPath, [tsc, '-p', join(out, 'typescript/tsconfig.json')], { timeout: 30_000 });
    const runner = join(temp, 'run.mjs');
    await writeFile(runner, `import { createFactEnvelopeMachine } from './out/typescript/dist/machine.js';
const traces = JSON.parse(process.argv[2]).map(inputs => {
  const machine = createFactEnvelopeMachine();
  return inputs.map(input => {
    const result = machine.send(input.v, input.provenance);
    if (!result.ok) throw new Error(JSON.stringify(result));
    const { action, before, after, updates } = result;
    return { input, action, before, after, updates };
  });
});
process.stdout.write(JSON.stringify(traces));
`);
    const typescript = await execute(process.execPath, [runner, JSON.stringify(sequences)], { timeout: 15_000 });
    const tsTraces = Traces.parse(JSON.parse(typescript.stdout));
    assert.deepEqual(tsTraces, sequences.map(inputs => interpretedTrace(model, inputs)));
    const trace = tsTraces[0];
    assert.ok(trace);
    assert.deepEqual(trace.map(step => step.action), ['Insert', 'Clash', 'Clash', 'Same']);
    assert.deepEqual(trace[3]?.after.values, {
      phase: { kind: 'string', value: 'conflict' },
      stored: { kind: 'data', domain: 'Values', value: 'A' }, rejected: { kind: 'data', domain: 'Values', value: 'B' },
      storedProvenance: { kind: 'data', domain: 'Receipts', value: 'r1' }, rejectedProvenance: { kind: 'data', domain: 'Receipts', value: 'r3' },
    });
    assert.deepEqual(trace[2]?.updates.rejected, { kind: 'input', parameter: 'v' });
    assert.deepEqual(trace[2]?.updates.rejectedProvenance, { kind: 'input', parameter: 'provenance' });
    assert.deepEqual(tsTraces[1]?.[0]?.after.values.stored, { kind: 'data', domain: 'Values', value: 'none' });
    assert.deepEqual(tsTraces[1]?.[0]?.after.values.storedProvenance, { kind: 'data', domain: 'Receipts', value: 'none' });
    await buildProject({ project: join(example, 'project.json'), jar, out, check: true });
  } finally { await rm(temp, { recursive: true, force: true }); }
});
