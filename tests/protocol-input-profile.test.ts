import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { lowerSymbolicModel } from '../src/symbolic-lower.js';
import { parseSanyXml } from '../src/sany-xml.js';
import { inspectSymbolicOrbits } from '../src/symbolic-semantics.js';
import { runSymbolicTlc, parseSymbolicConfig } from '../src/symbolic-tlc.js';
import { symbolicFiniteValueKey, symbolicModel, validateSymbolicModel, type SymbolicInputDefinition, type SymbolicModelV3 } from '../src/symbolic-types.js';
import { generateVisualization } from '../src/visualize.js';

const jar = process.env.TLA2TOOLS_JAR;
const fixture = resolve('tests/fixtures/resource-protocol');
function model(): SymbolicModelV3 {
  return symbolicModel({ version: 3, kind: 'symbolic-owned', name: 'TypedInputs', checkDeadlock: true,
    variables: ['stored'], next: 'Next', initial: { stored: { kind: 'string', value: 'none' } },
    inputs: [{ kind: 'opaque', parameter: 'resource', domain: 'Resources' },
      { kind: 'finite', parameter: 'event', domain: 'Events', values: [{ kind: 'string', value: 'select' }] }],
    branches: [{ action: 'Select', guard: { kind: 'boolean', value: true }, updates: { stored: { kind: 'input', parameter: 'resource' } }, source: null }],
    invariants: [], actionProperties: [],
  });
}
function change(edit: (value: SymbolicModelV3) => void) {
  const value = model(); edit(value);
  return () => validateSymbolicModel(value);
}

test('mixed IR validates its discriminants, canonical vocabulary, bounds and named origins', () => {
  assert.throws(change(value => { value.inputs = value.inputs.map((input): SymbolicInputDefinition => ({ kind: 'opaque', parameter: input.parameter, domain: input.domain })); }), /both opaque and finite/);
  assert.throws(change(value => { value.inputs.push({ kind: 'opaque', parameter: 'extra', domain: 'Resources' }); }), /distinct.*domains/);
  assert.throws(change(value => { const branch = value.branches[0]; assert.ok(branch); branch.updates.stored = { kind: 'input' }; }), /version 3 input expressions/);
  assert.throws(change(value => { const branch = value.branches[0]; assert.ok(branch); branch.guard = { kind: 'in-domain', value: { kind: 'input', parameter: 'event' }, domain: 'Events' }; }), /unknown symbolic data domain/);
  for (const values of [[], [{ kind: 'string', value: 'z' }, { kind: 'string', value: 'a' }],
    [{ kind: 'string', value: 'a' }, { kind: 'string', value: 'a' }],
    [{ kind: 'string', value: 'a' }, { kind: 'boolean', value: true }],
    Array.from({ length: 65 }, (_, index) => ({ kind: 'string', value: String(index) }))]) {
    const original = model();
    assert.throws(() => validateSymbolicModel({ ...original, inputs: [original.inputs[0], { kind: 'finite', parameter: 'event', domain: 'Events', values }] }), /TLC301/);
  }
});

test('controlled protocol source derives the finite vocabulary and retains every state value in Pele', { skip: !jar }, async () => {
  assert.ok(jar);
  const directory = await mkdtemp(join(tmpdir(), 'sgd-protocol-source-'));
  try {
    await cp(fixture, directory, { recursive: true });
    const run = await runSymbolicTlc({ spec: join(directory, 'ResourceProtocol.tla'), config: join(directory, 'ResourceProtocol.cfg'), jar: resolve(jar) });
    const semantic = parseSanyXml(run.xml);
    const model = lowerSymbolicModel({ name: 'ResourceProtocol', semantic, config: run.config, profile: 'protocol' });
    assert.equal(model.variables.length, 11);
    assert.deepEqual(model.inputs[0], { kind: 'opaque', parameter: 'r', domain: 'Resources' });
    const event = model.inputs[1]; assert.ok(event && event.kind === 'finite');
    assert.equal(event.values.length, 17);
    assert.ok(event.values.every(value => value.kind === 'string'));
    assert.deepEqual(event.values.map(symbolicFiniteValueKey), event.values.map(symbolicFiniteValueKey).sort());
    assert.throws(() => lowerSymbolicModel({ name: model.name, semantic, config: run.config, profile: 'single' }), /one scalar bounded/);
    assert.throws(() => lowerSymbolicModel({ name: model.name, semantic, config: run.config, profile: 'product' }), /opaque input domain/);
    const proof = inspectSymbolicOrbits(model);
    assert.ok(proof.edges.length && proof.disabled.length);
    const view = generateVisualization([model]);
    const html = view.find(file => file.path === 'index.html')?.content ?? '';
    const mermaid = view.find(file => file.path === 'structure.mmd')?.content ?? '';
    assert.match(html, /opaque Resources/); assert.match(html, /finite Events/);
    assert.match(html, /Every finite choice/);
    for (const variable of model.variables) assert.ok(mermaid.includes(`${variable} = `));
    assert.ok(mermaid.includes('event[Events] = &quot;present&quot;'));
    assert.doesNotMatch(mermaid, /\[object Object\]|&quot;kind&quot;:&quot;string&quot;/);
    assert.deepEqual(JSON.parse(view.find(file => file.path === 'models.json')?.content ?? 'null'), [model]);
    const config = await readFile(join(directory, 'ResourceProtocol.cfg'), 'utf8');
    for (const entries of ['{}', '{"select", "select"}', '{"select", TRUE}',
      `{${Array.from({ length: 65 }, (_, index) => `"event${index}"`).join(', ')}}`]) {
      assert.throws(() => {
        const changed = parseSymbolicConfig(config.replace(/^CONSTANT Events = .*$/m, `CONSTANT Events = ${entries}`));
        lowerSymbolicModel({ name: model.name, semantic, config: changed, profile: 'protocol' });
      }, /TLC(?:201|301)/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
