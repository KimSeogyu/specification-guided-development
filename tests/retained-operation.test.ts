import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { validateRetainedOperation } from '../src/retained-operation.js';
import { MachineProjectSchema, type ExactFiniteAutomaton } from '../src/finite-types.js';
import { buildProjectReport, compileProject } from '../src/compiler.js';

const operation = { kind: 'retained-operation', start: 'Start', success: 'Success', failure: 'Failure', retainedVariable: 'resident' } as const;
const graph: ExactFiniteAutomaton = {
  version: 1, kind: 'exact-finite', name: 'Custody',
  variables: [{ name: 'phase', kind: 'string' }, { name: 'resident', kind: 'boolean' }],
  nodes: ['Ready', 'Reporting', 'Done', 'Failed'].map((phase, index) => ({ id: `s${index}`, values: {
    phase: { kind: 'string', value: phase }, resident: { kind: 'boolean', value: true },
  } })),
  initial: ['s0'], actions: ['Start', 'Success', 'Failure'],
  edges: [{ from: 's0', event: 'Start', to: 's1' }, { from: 's1', event: 'Success', to: 's2' }, { from: 's1', event: 'Failure', to: 's3' }],
  source: { dotSha256: 'a'.repeat(64), stateCount: 4, edgeCount: 3 },
};

test('retained operation rejects ambiguous roles, lost payload states and missing failure completion', () => {
  const input = { automaton: graph, className: 'Custody', operation };
  validateRetainedOperation(input);
  assert.throws(() => validateRetainedOperation({ ...input, operation: { ...operation, failure: 'Success' } }), /TLC207/);
  assert.throws(() => validateRetainedOperation({ ...input, operation: { ...operation, failure: 'Typo' } }), /TLC207/);
  const lost = structuredClone(graph);
  const failed = lost.nodes[3];
  assert.ok(failed);
  failed.values.resident = { kind: 'boolean', value: false };
  assert.throws(() => validateRetainedOperation({ ...input, automaton: lost }), /TLC207.*stay true/);
  const missing = structuredClone(graph);
  missing.edges[2] = { from: 's2', event: 'Failure', to: 's3' };
  assert.throws(() => validateRetainedOperation({ ...input, automaton: missing }), /TLC207.*both observed/);
});

test('operation binding refuses arbitrary policy and unverified DOT', async t => {
  const project = JSON.parse(await readFile(resolve('examples/retained-operation/project.json'), 'utf8'));
  assert.equal(MachineProjectSchema.safeParse(project).success, true);
  assert.equal(MachineProjectSchema.safeParse({ ...project, binding: { ...project.binding, operation: { ...project.binding.operation, releaseOnSuccess: true } } }).success, false);
  const out = await mkdtemp(join(tmpdir(), 'sgd-custody-import-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  await assert.rejects(compileProject({ project: resolve('examples/retained-operation/project.json'), dot: '/not-read.dot', out }), /TLC206/);
});

const jar = process.env.TLA2TOOLS_JAR;
test('real TLC retained operation build records scope, changes admission, checks freshness and rejects payload loss', { skip: !jar, timeout: 180_000 }, async t => {
  assert.ok(jar);
  const root = await mkdtemp(join(tmpdir(), 'sgd-custody-tlc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const model = join(root, 'model');
  await cp(resolve('examples/retained-operation'), model, { recursive: true });
  const project = join(model, 'project.json');
  const out = join(root, 'out');
  const report = await buildProjectReport({ project, out, jar });
  assert.ok(report.summary.verification.checks.some(check => check.kind === 'retained-operation'));
  assert.equal(report.summary.limits.applicationIntegration, 'not-established');
  assert.ok('kind' in report.automaton && report.automaton.kind === 'exact-finite');
  assert.ok(report.automaton.edges.some(edge => edge.from === report.automaton.initial[0] && edge.event === 'StartReport'));
  await buildProjectReport({ project, out, jar, check: true });
  const projectValue = JSON.parse(await readFile(project, 'utf8'));
  await writeFile(project, JSON.stringify({ ...projectValue, config: 'NotReady.cfg' }));
  const refused = await buildProjectReport({ project, out, jar });
  assert.ok('kind' in refused.automaton && refused.automaton.kind === 'exact-finite');
  assert.equal(refused.automaton.edges.some(edge => edge.from === refused.automaton.initial[0] && edge.event === 'StartReport'), false);
  await writeFile(project, JSON.stringify(projectValue));
  const spec = join(model, 'ReportCustody.tla');
  const source = await readFile(spec, 'utf8');
  await writeFile(spec, source.replace('/\\ phase\' = "Failed"\n                /\\ UNCHANGED <<ready, resident>>', '/\\ phase\' = "Failed"\n                /\\ resident\' = FALSE /\\ UNCHANGED ready'));
  await assert.rejects(buildProjectReport({ project, out, jar }), /PayloadRetained/);
});
