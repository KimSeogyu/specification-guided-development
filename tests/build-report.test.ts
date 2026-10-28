import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildProject, buildProjectReport, BuildSummarySchema, type BuildReport, type BuildSummary } from '../src/compiler.js';
import { summarizeBuild, summarizeGraph } from '../src/build-report.js';
import { importDot } from '../src/dot.js';
import { FiniteGraphSchema } from '../src/finite-types.js';
import { SymbolicWitnessSchema } from '../src/symbolic-witness.js';

const jar = process.env.TLA2TOOLS_JAR ? resolve(process.env.TLA2TOOLS_JAR) : undefined;
const projectedDot = String.raw`digraph DiskGraph {
  1 [label="/\ phase = \"New\"\n/\ approved = FALSE", style=filled];
  2 [label="/\ phase = \"New\"\n/\ approved = TRUE"];
  3 [label="/\ phase = \"Done\"\n/\ approved = TRUE"];
  1 -> 2 [label="Approve"];
  2 -> 3 [label="Submit"];
  3 -> 3 [label="Wait"];
}`;

async function assertPublishedReport(report: BuildReport): Promise<void> {
  assert.deepEqual(BuildSummarySchema.parse(report.summary), report.summary);
  const { summary } = report;
  const inventory = JSON.parse(await readFile(join(summary.output.directory, '.sgd-generated.json'), 'utf8'));
  assert.deepEqual([...summary.output.artifacts].sort(), [...inventory.files].sort());
  for (const path of summary.output.artifacts) await access(join(summary.output.directory, path));
  for (const evidence of summary.evidence) {
    assert.ok(summary.output.artifacts.some(path => join(summary.output.directory, path) === evidence.path));
    await access(evidence.path);
    assert.equal(evidence.freshness, summary.verification.output === 'checked' ? 'retained-output' : 'current-invocation');
  }
  assert.ok(!('nodes' in summary.graph));
  assert.ok(!('transitions' in summary.graph));
  assert.equal(summary.verification.invocation, 'completed');
  assert.equal(summary.verification.freshInvocationLogRetained, summary.verification.output === 'generated');
}

async function managedBytes(summary: BuildSummary): Promise<Buffer[]> {
  return Promise.all(['.sgd-generated.json', ...summary.output.artifacts].map(path => readFile(join(summary.output.directory, path))));
}

test('graph summaries distinguish projected counts, complete finite state, and bounded input domains', () => {
  const projected = importDot({ dot: projectedDot, name: 'Approval', stateVariable: 'phase' });
  assert.deepEqual(summarizeGraph(projected, 'model'), { kind: 'projected', name: 'Approval', stateVariable: 'phase',
    projectedStates: 2, projectedTransitions: 3, concreteSourceStates: 3, concreteSourceEdges: 3 });
  const finite = FiniteGraphSchema.parse({ version: 1, kind: 'exact-finite', name: 'Finite', variables: [{ name: 'ready', kind: 'boolean' }],
    nodes: [{ id: 's0', values: { ready: { kind: 'boolean', value: false } } }], initial: ['s0'], actions: ['Wait'],
    edges: [{ from: 's0', event: 'Wait', to: 's0' }], source: { dotSha256: '0'.repeat(64), stateCount: 1, edgeCount: 1 } });
  assert.deepEqual(summarizeGraph(finite, 'model'), { kind: 'exact-finite', role: 'model', name: 'Finite',
    variables: ['ready'], states: 1, edges: 1, initialStates: 1 });
  const witness = SymbolicWitnessSchema.parse({ version: 2, kind: 'symbolic-witness', name: 'Witness', variables: ['stored'],
    nodes: [{ id: 's0', values: { stored: { kind: 'string', value: 'none' } } }], initial: ['s0'], edges: [],
    domains: { Values: ['v1', 'v2'], Receipts: ['p1', 'p2', 'p3'] }, source: { dotSha256: '0'.repeat(64), stateCount: 1, edgeCount: 0 } });
  assert.deepEqual(summarizeGraph(witness, 'model'), { kind: 'symbolic-witness', name: 'Witness', states: 1, edges: 0,
    domains: [{ name: 'Values', atoms: 2 }, { name: 'Receipts', atoms: 3 }] });
});

test('summary projection distinguishes this invocation from retained check evidence without reading paths', () => {
  const graph = summarizeGraph(importDot({ dot: projectedDot, name: 'Approval', stateVariable: 'phase' }), 'model');
  const log = { path: 'models/control/tlc.log', content: 'current run', volatile: true };
  const receipt = { path: 'verification.json', content: 'receipt' };
  const input = { operation: 'build' as const, out: '/never-created-report-output', graph, files: [log, receipt],
    checks: [{ kind: 'projected-tlc' as const, role: 'model' as const, scope: 'observed-possible-transitions' as const }],
    evidence: [{ file: log, role: 'log' as const }, { file: receipt, role: 'verification' as const }] };
  const generated = summarizeBuild({ ...input, check: false });
  const checked = summarizeBuild({ ...input, check: true });
  assert.equal(generated.verification.freshInvocationLogRetained, true);
  assert.equal(checked.verification.freshInvocationLogRetained, false);
  assert.equal(checked.evidence[0]?.path, '/never-created-report-output/models/control/tlc.log');
  assert.ok(checked.evidence.every(item => item.freshness === 'retained-output'));
  assert.deepEqual(checked.verification.checks, generated.verification.checks);
  assert.deepEqual(log, { path: 'models/control/tlc.log', content: 'current run', volatile: true });
});

test('real v1 report preserves projection scope and the physical published output root', { skip: !jar }, async () => {
  assert.ok(jar);
  const root = await mkdtemp(join(tmpdir(), 'sgd-report-v1-'));
  try {
    await cp(resolve('examples/approval/Approval.tla'), join(root, 'Approval.tla'));
    await cp(resolve('examples/approval/Approval.cfg'), join(root, 'Approval.cfg'));
    const project = join(root, 'project.json');
    await writeFile(project, JSON.stringify({ version: 1, name: 'ProjectedApproval', spec: 'Approval.tla', config: 'Approval.cfg', stateVariable: 'phase',
      targets: ['typescript'], binding: { kind: 'transition', function: 'transition' } }));
    const actual = join(root, 'physical'); await mkdir(actual);
    const alias = join(root, 'alias'); await symlink(actual, alias);
    const report = await buildProjectReport({ project, jar, out: join(alias, 'generated') });
    await assertPublishedReport(report);
    assert.equal(report.summary.output.directory, join(await realpath(actual), 'generated'));
    assert.equal(report.summary.graph.kind, 'projected');
    if (report.summary.graph.kind !== 'projected') throw new Error('expected projection');
    assert.equal(report.summary.graph.projectedStates, 2);
    assert.equal(report.summary.graph.concreteSourceStates, 3);
    assert.deepEqual(report.summary.verification.checks, [{ kind: 'projected-tlc', role: 'model', scope: 'observed-possible-transitions' }]);
    assert.deepEqual(await buildProject({ project, jar, out: join(alias, 'generated'), check: true }), report.automaton);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real finite reports retain current check facts, historical logs, and model-only choices', { skip: !jar }, async () => {
  assert.ok(jar);
  const root = await mkdtemp(join(tmpdir(), 'sgd-report-v2-'));
  try {
    const input = { project: resolve('examples/approval/project.json'), jar, out: join(root, 'generated') };
    const generated = await buildProjectReport(input);
    await assertPublishedReport(generated);
    assert.ok(!generated.summary.output.artifacts.includes('artifact-format.json'));
    assert.ok(generated.summary.output.artifacts.includes('typescript/machine.ts'));
    assert.deepEqual(generated.summary.verification.checks.map(check => check.kind), ['controlled-tlc', 'executable-graph']);
    const before = await managedBytes(generated.summary);
    const checked = await buildProjectReport({ ...input, check: true });
    await assertPublishedReport(checked);
    assert.deepEqual(checked.automaton, generated.automaton);
    assert.deepEqual(await managedBytes(generated.summary), before);
    await writeFile(join(input.out, 'typescript/machine.ts'), '// user edit');
    const edited = await managedBytes(generated.summary);
    await assert.rejects(buildProjectReport({ ...input, check: true }), /TLC104/);
    assert.deepEqual(await managedBytes(generated.summary), edited);
    const project = join(root, 'project.json');
    await writeFile(project, JSON.stringify({ version: 2, profile: 'finite-owned', name: 'Choice', spec: 'Choice.tla', config: 'Choice.cfg',
      targets: ['typescript'], binding: { className: 'ChoiceMachine' } }));
    await writeFile(join(root, 'Choice.cfg'), 'SPECIFICATION Spec\nCHECK_DEADLOCK FALSE\n');
    await writeFile(join(root, 'Choice.tla'), '---- MODULE Choice ----\nVARIABLE phase\nInit == phase = "A"\nStep == phase\' \\in {"A", "B"}\nNext == Step\nSpec == Init /\\ [][Next]_phase\n====\n');
    const choice = { project, jar, out: join(root, 'choice-output') };
    const modelOnly = await buildProjectReport({ ...choice, modelOnly: true });
    await assertPublishedReport(modelOnly);
    assert.equal(modelOnly.summary.operation, 'model');
    assert.deepEqual(modelOnly.summary.verification.checks.map(check => check.kind), ['controlled-tlc']);
    assert.ok(modelOnly.summary.output.artifacts.every(path => !path.startsWith('typescript/')));
    const previous = await managedBytes(modelOnly.summary);
    await assert.rejects(buildProjectReport(choice), /TLC204.*ambiguous/);
    assert.deepEqual(await managedBytes(modelOnly.summary), previous);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real single and product symbolic reports separate bounded, source, orbit, and oracle checks', { skip: !jar, timeout: 120_000 }, async () => {
  assert.ok(jar);
  const root = await mkdtemp(join(tmpdir(), 'sgd-report-symbolic-'));
  try {
    for (const example of ['fact-merge', 'fact-envelope']) {
      const input = { project: resolve('examples', example, 'project.json'), jar, out: join(root, example) };
      const generated = await buildProjectReport(input);
      await assertPublishedReport(generated);
      assert.equal(generated.summary.graph.kind, 'symbolic-witness');
      assert.deepEqual(generated.summary.verification.checks.map(check => check.kind), ['controlled-tlc', 'symbolic-source', 'symbolic-orbit', 'input-oracle']);
      const oracle = generated.summary.verification.checks.find(check => check.kind === 'input-oracle');
      assert.equal(oracle?.scope, 'configured-reachable-state-input-product');
      const modelOnly = await buildProjectReport({ ...input, modelOnly: true });
      await assertPublishedReport(modelOnly);
      assert.deepEqual(modelOnly.summary.verification.checks.map(check => check.kind), ['controlled-tlc', 'symbolic-source']);
      for (const path of ['orbit-proof.json', 'input-verification.json', 'input-oracle.log']) {
        assert.ok(!modelOnly.summary.output.artifacts.includes(path));
        assert.ok(!modelOnly.summary.evidence.some(item => item.path === join(input.out, path)));
        await assert.rejects(access(join(input.out, path)), { code: 'ENOENT' });
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
