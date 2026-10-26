#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildProjectReport, readProject, writeGenerated } from '../dist/compiler.js';
import { generateBendCore } from '../dist/backends/bend.js';

const execute = promisify(execFile);
const args = process.argv.slice(2);
const flags = new Map();
while (args.length) {
  const key = args.shift(); const value = args.shift();
  if (!['--project', '--jar', '--bend', '--kernel', '--out'].includes(key) || !value || flags.has(key)) {
    throw new Error('Use --project FILE --jar FILE --bend FILE --kernel FILE --out DIR, each once');
  }
  flags.set(key, resolve(value));
}
for (const key of ['--project', '--jar', '--bend', '--kernel', '--out']) {
  if (!flags.has(key)) throw new Error(`Missing ${key}`);
}
const project = await readProject(flags.get('--project'));
if (project.version !== 2 || project.binding.domain || project.binding.operation) {
  throw new Error('Experimental Bend core requires a plain finite-owned project; DI/retained bindings are not generated');
}
const workspace = await mkdtemp(join(tmpdir(), 'sgd-bend-evaluation-'));
const records = [];
let cleanupSafe = true;
const env = { ...process.env, BEND_NO_TELEMETRY: '1', BENDTT: flags.get('--kernel') };
async function run(name, executable, arguments_, expectFailure = false) {
  let result;
  try {
    const value = await execute(executable, arguments_, { cwd: workspace, env, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    result = { exit: 0, stdout: value.stdout, stderr: value.stderr };
  } catch (error) {
    if (typeof error.code !== 'number' || error.killed || error.signal) {
      cleanupSafe = false;
      throw error;
    }
    result = { exit: error.code, stdout: error.stdout, stderr: error.stderr };
  }
  records.push({ name, ...result, stdout: result.stdout.replaceAll(workspace, '<workspace>'), stderr: result.stderr.replaceAll(workspace, '<workspace>') });
  assert.equal(result.exit === 0, !expectFailure, `${name}: ${result.stdout}\n${result.stderr}`);
  return result;
}
try {
  const bend = flags.get('--bend');
  const version = await run('version', bend, ['version']);
  assert.match(version.stdout, /\b2\.0\.39\b/, 'This experiment is pinned to Bend 2.0.39');
  const model = await buildProjectReport({ project: flags.get('--project'), jar: flags.get('--jar'), out: join(workspace, 'model'), modelOnly: true });
  assert.equal(model.automaton.kind, 'exact-finite');
  const files = generateBendCore({ automaton: model.automaton, className: project.binding.className });
  const bendDirectory = join(workspace, 'bend'); await mkdir(bendDirectory);
  for (const file of files) await writeFile(join(bendDirectory, file.path), file.content);
  const proof = join(bendDirectory, 'PROOF.bend'); const domain = join(bendDirectory, 'domain.bend');
  const verdict = await run('kernel-verdict', bend, [proof, '--verdict']);
  assert.equal(verdict.stdout.trim(), 'ALL PROOFS CHECK');
  assert.doesNotMatch(verdict.stdout + verdict.stderr, /SOME PROOFS FAIL|PANIC/);
  await run('js-build', bend, [domain, '-o', join(bendDirectory, 'domain.mjs')]);
  const core = (await import(pathToFileURL(join(bendDirectory, 'domain.mjs')).href)).default;
  const metadata = JSON.parse(files.find(file => file.path === 'model.json').content);
  const graph = model.automaton;
  assert.deepEqual(metadata.states.map(state => state.id).sort(), graph.nodes.map(node => node.id).sort());
  assert.deepEqual(metadata.actions.map(action => action.name).sort(), [...graph.actions].sort());
  assert.equal(new Set(metadata.states.map(state => state.constructor)).size, graph.nodes.length);
  assert.equal(new Set(metadata.actions.map(action => action.constructor)).size, graph.actions.length);
  const prefix = metadata.stateType.slice(0, -'State'.length);
  const expectedCodes = [];
  assert.equal(core.initial().$, metadata.states.find(state => state.id === graph.initial[0]).constructor);
  for (const state of metadata.states) {
    for (const action of metadata.actions) {
      const edge = graph.edges.find(edge => edge.from === state.id && edge.event === action.name);
      const target = metadata.states.find(item => item.id === (edge?.to ?? state.id));
      const result = core.step({ $: state.constructor }, { $: action.constructor });
      assert.equal(result.$, `${prefix}${edge ? 'Accepted' : 'Rejected'}`);
      assert.equal(result.state.$, target.constructor);
      const expected = metadata.states.indexOf(target) * 2 + (edge ? 1 : 0);
      assert.equal(core.result_code(result), expected); expectedCodes.push(expected);
    }
    const values = {};
    let fields = core.read({ $: state.constructor });
    while (fields.$ === 'Con') {
      const field = fields.head; const value = field.value;
      values[field.name] = value.$ === `${prefix}Text` ? { kind: 'string', value: value.value }
        : value.$ === `${prefix}Flag` ? { kind: 'boolean', value: value.value }
          : { kind: 'integer', value: value.decimal };
      fields = fields.tail;
    }
    assert.equal(fields.$, 'Nil');
    assert.deepEqual(values, graph.nodes.find(node => node.id === state.id).values);
  }
  await run('native-build', bend, [join(bendDirectory, 'cases.bend'), '-o', join(bendDirectory, 'cases')]);
  const native = await run('native-execution', join(bendDirectory, 'cases'), []);
  assert.deepEqual(JSON.parse(native.stdout.trim()), expectedCodes);
  const original = await readFile(domain, 'utf8');
  const accepted = metadata.cases.find(item => item.accepted);
  assert(accepted, 'Nonempty accepted behavior is required for this experiment');
  const expression = `${prefix}Accepted{${metadata.states[accepted.next].constructor}{}}`;
  const mutation = original.replace(expression, `${prefix}Rejected{${metadata.states[accepted.next].constructor}{}}`);
  assert.notEqual(mutation, original);
  await writeFile(domain, mutation);
  await run('mutant-remains-well-typed', bend, [domain, '--check-only']);
  const rejected = await run('unchanged-laws-reject-mutated-domain', bend, [proof, '--verdict'], true);
  assert.match(rejected.stdout + rejected.stderr, /SOME PROOFS FAIL/);
  await writeFile(domain, original);
  await writeFile(proof, 'import Base\n\ndef main() -> U32:\n  0\n');
  const omitted = await run('omitted-law-import-is-rejected', bend, [proof, '--verdict'], true);
  assert.match(omitted.stdout + omitted.stderr, /must import.*LAWS\.bend/);
  const interop = [];
  for (const state of metadata.states) {
    try { interop.push({ state: state.id, returned: core.step({ $: state.constructor }, { $: 'NotAnEvent' }) }); }
    catch { interop.push({ state: state.id, throws: true }); }
  }
  const report = { bendVersion: version.stdout.trim(), decisionsChecked: expectedCodes.length,
    valuationsChecked: metadata.states.length, kernel: 'passed', js: 'matches-model', native: 'matches-model',
    mutation: 'well-typed implementation rejected by unchanged laws', omittedLaws: 'rejected',
    foreignJsProbe: interop, limitations: metadata.limits, records };
  const output = [...files.map(file => ({ ...file, path: `bend/${file.path}` })),
    { path: 'evaluation.json', content: JSON.stringify(report, null, 2) + '\n' }];
  for (const path of model.summary.output.artifacts) {
    const relative = path.startsWith(join(workspace, 'model')) ? path.slice(join(workspace, 'model').length + 1) : path;
    output.push({ path: `model/${relative}`, content: await readFile(join(workspace, 'model', relative), 'utf8') });
  }
  await writeGenerated({ out: flags.get('--out'), files: output });
  console.log(JSON.stringify({ output: flags.get('--out'), kernel: 'passed', decisionsChecked: expectedCodes.length,
    mutation: 'rejected', native: 'matches-model', scope: 'experimental pure Bend core; no private owner or DI driver' }, null, 2));
} finally {
  if (cleanupSafe) await rm(workspace, { recursive: true, force: true });
  else console.error(`Preserved ${workspace}: native process completion is uncertain.`);
}
