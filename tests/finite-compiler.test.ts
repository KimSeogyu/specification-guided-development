import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildProject, compileProject } from '../src/compiler.js';
import { FiniteGraphSchema } from '../src/finite-types.js';
import { generateVisualization, loadAutomaton } from '../src/visualize.js';

const execute = promisify(execFile);
const jar = process.env.TLA2TOOLS_JAR;
const tsc = resolve('node_modules/typescript/bin/tsc');

test('unverified DOT cannot produce finite-owned authority or create its output directory', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'sgd-unverified-owner-'));
  try {
    const out = join(temp, 'out');
    await assert.rejects(compileProject({ project: resolve('examples/approval/project.json'), dot: join(temp, 'not-read.dot'), out }), /TLC206/);
    await assert.rejects(access(out));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('model-only exports choices and terminal graphs without inventing executable authority', { skip: !jar }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'sgd-finite-choices-'));
  try {
    const project = join(temp, 'project.json');
    const config = join(temp, 'Choice.cfg');
    const spec = join(temp, 'Choice.tla');
    await writeFile(project, JSON.stringify({ version: 2, profile: 'finite-owned', name: 'Choice', spec: 'Choice.tla', config: 'Choice.cfg', targets: ['typescript'], binding: { className: 'ChoiceMachine' } }));
    await writeFile(config, 'SPECIFICATION Spec\nCHECK_DEADLOCK FALSE\n');
    for (const [init, next, expected] of [
      ['phase \\in {"A", "B"}', 'Step', /exactly one initial/],
      ['phase = "A"', 'Step', /ambiguous action successors/],
      ['phase = "A"', 'FALSE', /at least one named action/],
    ] satisfies [string, string, RegExp][]) {
      await writeFile(spec, `---- MODULE Choice ----\nVARIABLE phase\nInit == ${init}\nStep == phase' \\in {"A", "B"}\nNext == ${next}\nSpec == Init /\\ [][Next]_phase\n====\n`);
      const out = join(temp, 'out');
      const input = { project, jar: jar!, out };
      const model = FiniteGraphSchema.parse(await buildProject({ ...input, modelOnly: true }));
      assert.ok(generateVisualization([model]).some(file => file.path === 'structure.svg'));
      await assert.rejects(access(join(out, 'typescript/machine.ts')));
      await assert.rejects(buildProject(input), expected);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('real TLC build preserves typed IR, complete receipt, Pele view, stale detection, and managed output lifecycle', { skip: !jar }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'sgd-finite-build-'));
  try {
    const input = { project: resolve('examples/approval/project.json'), jar: jar!, out: temp };
    const model = FiniteGraphSchema.parse(await buildProject(input));
    assert.equal(model.nodes.length, 3);
    assert.equal(model.variables.length, 2);
    assert.deepEqual(await loadAutomaton(join(temp, 'automaton.json')), model);
    await access(join(temp, 'typescript/machine.ts'));
    const receipt = JSON.parse(await readFile(join(temp, 'verification.json'), 'utf8'));
    assert.equal(receipt.kind, 'tlc-finite-completed');
    assert.equal(receipt.profile, 'finite-owned-v1');
    assert.equal(receipt.moduleClosure[0]?.name, 'Approval.tla');
    assert.equal(receipt.dotSha256, model.source.dotSha256);
    await buildProject({ ...input, check: true });
    await writeFile(join(temp, 'verification.json'), JSON.stringify({ ...receipt, moduleClosure: [] }));
    await assert.rejects(buildProject({ ...input, check: true }), /TLC104: stale receipt field moduleClosure/);
    await buildProject(input);
    const view = generateVisualization([model]);
    assert.deepEqual(JSON.parse(view.find(file => file.path === 'models.json')!.content), [model]);
    const html = view.find(file => file.path === 'index.html')!.content;
    assert.match(html, /full concrete states/);
    assert.match(html, /approved = FALSE/);
    assert.match(html, /approved = TRUE/);
    assert.match(html, /persistent identity/);
    await writeFile(join(temp, 'typescript/machine.ts'), '// edited generated state');
    await assert.rejects(buildProject({ ...input, check: true }), /TLC104/);
    await buildProject({ ...input, modelOnly: true });
    await assert.rejects(access(join(temp, 'typescript/machine.ts')));
    await access(join(temp, 'automaton.json'));
    await buildProject({ ...input, project: resolve('examples/order/project.json') });
    await access(join(temp, 'typescript/checker.mjs'));
    await assert.rejects(access(join(temp, 'typescript/machine.ts')));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('actual TLC-to-native TypeScript owner follows the graph, and a requirement change regenerates their behavior', { skip: !jar, timeout: 180_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'sgd-finite-native-'));
  try {
    const models = join(temp, 'model');
    await cp(resolve('examples/approval'), models, { recursive: true });
    const out = join(temp, 'out');
    const input = { project: join(models, 'project.json'), jar: jar!, out };
    await buildProject(input);
    const jsRunner = join(out, 'typescript/run.mjs');
    await writeFile(jsRunner, `import { createApprovalMachine, isApprovalMachine } from './dist/machine.js';
const machine = createApprovalMachine();
if (!isApprovalMachine(machine)) throw new Error('not an owner');
const trace = [];
for (const event of ['Submit', 'Approve', 'Submit', 'Approve', 'Wait']) {
  const before = machine.read(); const result = machine.send(event);
  trace.push({ event, accepted: result.ok, before, after: machine.read() });
}
process.stdout.write(JSON.stringify(trace));
`);
    async function nativeTraces(): Promise<{ event: string; accepted: boolean }[]> {
      await execute(process.execPath, [tsc, '-p', join(out, 'typescript/tsconfig.json')], { timeout: 30_000 });
      const typescript = await execute(process.execPath, [jsRunner], { timeout: 15_000 });
      const tsTrace = JSON.parse(typescript.stdout);
      return tsTrace;
    }
    assert.deepEqual((await nativeTraces()).map(step => step.accepted), [false, true, true, false, true]);
    const spec = join(models, 'Approval.tla');
    const source = await readFile(spec, 'utf8');
    const changed = source.replace('          /\\ approved\n', '').replace("          /\\ UNCHANGED approved\n", "          /\\ approved' = TRUE\n");
    assert.notEqual(source, changed);
    await writeFile(spec, changed);
    await assert.rejects(buildProject({ ...input, check: true }), /TLC104/);
    await buildProject(input);
    assert.deepEqual((await nativeTraces()).map(step => step.accepted), [true, false, false, false, true]);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
