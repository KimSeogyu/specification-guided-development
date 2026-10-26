import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { generateBendCore } from '../src/backends/bend.js';
import { FiniteGraphSchema } from '../src/finite-types.js';

const graph = FiniteGraphSchema.parse({ version: 1, kind: 'exact-finite', name: 'BendProbe',
  variables: [{ name: 'text', kind: 'string' }, { name: 'approved', kind: 'boolean' }, { name: 'amount', kind: 'integer' }],
  nodes: ['s0', 's1'].map((id, i) => ({ id, values: {
    text: { kind: 'string', value: 'Quote " newline\n한글🙂' },
    approved: { kind: 'boolean', value: i === 1 },
    amount: { kind: 'integer', value: '-900719925474099312345' },
  } })), initial: ['s0'], actions: ['Approve', 'Wait'],
  edges: [{ from: 's0', event: 'Approve', to: 's1' }, { from: 's1', event: 'Wait', to: 's1' }],
  source: { dotSha256: '0'.repeat(64), stateCount: 2, edgeCount: 2 },
});

test('Bend core emits complete decision and valuation laws with explicit pure-core scope', () => {
  const files = generateBendCore({ automaton: graph, className: 'Probe' });
  const laws = files.find(file => file.path === 'LAWS.bend')?.content ?? '';
  assert.equal((laws.match(/^law transition_/gm) ?? []).length, 4);
  assert.equal((laws.match(/^law valuation_/gm) ?? []).length, 2);
  assert.match(files.find(file => file.path === 'README.md')?.content ?? '', /constructors are public/);
  const reordered = { ...graph, nodes: [...graph.nodes].reverse(), actions: [...graph.actions].reverse(), edges: [...graph.edges].reverse(), variables: [...graph.variables].reverse() };
  const regenerated = generateBendCore({ automaton: reordered, className: 'Probe' });
  for (const file of files.filter(file => file.path !== 'model.json')) {
    assert.equal(regenerated.find(item => item.path === file.path)?.content, file.content);
  }
  assert.throws(() => generateBendCore({ automaton: { ...graph,
    edges: [...graph.edges, { from: 's0', event: 'Approve', to: 's0' }],
    source: { ...graph.source, edgeCount: 3 } }, className: 'Probe' }), /ambiguous/);
});

const bend = process.env.SGD_BEND_BINARY;
const kernel = process.env.SGD_BEND_KERNEL;
test('Bend kernel checks generated laws, JS preserves Unicode and integers, and altered code is rejected', {
  skip: !bend || !kernel ? 'Set SGD_BEND_BINARY and SGD_BEND_KERNEL for real Bend checks' : false,
  timeout: 120000,
}, async t => {
  assert.ok(bend); assert.ok(kernel);
  const root = await mkdtemp(join(tmpdir(), 'sgd-bend-test-'));
  let cleanupSafe = true;
  t.after(async () => {
    if (cleanupSafe) await rm(root, { recursive: true, force: true });
    else t.diagnostic(`Preserved ${root}: native process completion is uncertain.`);
  });
  const files = generateBendCore({ automaton: graph, className: 'Probe' });
  for (const file of files) await writeFile(join(root, file.path), file.content);
  const invoke = (args: string[]) => {
    const result = spawnSync(bend, args, { cwd: root,
      env: { ...process.env, BEND_NO_TELEMETRY: '1', BENDTT: kernel }, encoding: 'utf8', timeout: 60000 });
    if (result.error || result.signal) cleanupSafe = false;
    assert.ifError(result.error);
    return result;
  };
  const valid = invoke(['PROOF.bend', '--verdict']);
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  assert.equal(valid.stdout.trim(), 'ALL PROOFS CHECK');
  const built = invoke(['domain.bend', '-o', 'domain.mjs']);
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const runtime = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import core from ${JSON.stringify(pathToFileURL(join(root, 'domain.mjs')).href)};
    const state = core.initial();
    assert.equal(state.$, 'SgdProbeS0');
    assert.equal(core.step(state, {$:'SgdProbeE0'}).state.$, 'SgdProbeS1');
    assert.equal(core.step(state, {$:'SgdProbeE1'}).$, 'SgdProbeRejected');
    const values = {};
    for (let xs=core.read(state);xs.$==='Con';xs=xs.tail) values[xs.head.name]=xs.head.value;
    assert.equal(values.text.value, ${JSON.stringify(graph.nodes[0]?.values['text']?.value)});
    assert.equal(values.amount.decimal, '-900719925474099312345');
    assert.equal(values.approved.value, false);
  `], { encoding: 'utf8', timeout: 30000 });
  if (runtime.error || runtime.signal) cleanupSafe = false;
  assert.ifError(runtime.error);
  assert.equal(runtime.status, 0, runtime.stdout + runtime.stderr);
  const original = await readFile(join(root, 'domain.bend'), 'utf8');
  await writeFile(join(root, 'domain.bend'), original.replace('SgdProbeAccepted{SgdProbeS1{}}', 'SgdProbeRejected{SgdProbeS1{}}'));
  const mutatedTypecheck = invoke(['domain.bend', '--check-only']);
  assert.equal(mutatedTypecheck.status, 0, mutatedTypecheck.stdout + mutatedTypecheck.stderr);
  const invalid = invoke(['PROOF.bend', '--verdict']);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stdout + invalid.stderr, /SOME PROOFS FAIL/);
});
