import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { lowerSymbolicModel } from '../src/symbolic-lower.js';
import { parseSanyXml } from '../src/sany-xml.js';
import { runSymbolicTlc } from '../src/symbolic-tlc.js';
import { symbolicModel } from '../src/symbolic-types.js';
import { importSymbolicDot, SymbolicWitnessSchema, verifySymbolicWitness } from '../src/symbolic-witness.js';

const jar = process.env.TLA2TOOLS_JAR ? resolve(process.env.TLA2TOOLS_JAR) : undefined;
const domains = { Values: ['v1', 'v2'], Receipts: ['p1', 'p2'] };

test('product DOT retains nominal domains and refuses ambiguous atom ownership in saved evidence', () => {
  const dot = 'strict digraph DiskGraph { subgraph cluster_graph {\n' +
    '100 [label="/\\\\ stored = v1\\n/\\\\ provenance = p1\\n/\\\\ text = \\\"p1\\\"",style=filled];\n}}';
  const witness = importSymbolicDot({ dot, name: 'Product', domains });
  assert.equal(witness.version, 2);
  assert.deepEqual(witness.nodes[0]?.values, {
    provenance: { kind: 'data', domain: 'Receipts', value: 'p1' },
    stored: { kind: 'data', domain: 'Values', value: 'v1' },
    text: { kind: 'string', value: 'p1' },
  });
  assert.throws(() => importSymbolicDot({ dot, name: 'Product', domains: { ...domains, Receipts: ['v1', 'p1'] } }), /TLC303.*overlapping/);
  assert.equal(SymbolicWitnessSchema.safeParse({ ...witness, domains: { ...domains, Receipts: ['v1', 'p1'] } }).success, false);
  const node = witness.nodes[0]; assert.ok(node);
  assert.equal(SymbolicWitnessSchema.safeParse({ ...witness, nodes: [{ ...node, values: { ...node.values, provenance: { kind: 'data', domain: 'Values', value: 'p1' } } }] }).success, false);
});

test('original-action product oracle checks complete provenance and every configured input combination', { skip: !jar }, async () => {
  assert.ok(jar);
  const spec = resolve('examples/fact-envelope/FactWriteEnvelope.tla');
  const config = resolve('examples/fact-envelope/FactWriteEnvelope.cfg');
  const original = await readFile(spec, 'utf8');
  const run = await runSymbolicTlc({ spec, config, jar });
  const model = lowerSymbolicModel({ name: 'FactWriteEnvelope', semantic: parseSanyXml(run.xml), config: run.config, profile: 'product' });
  assert.equal(model.version, 2);
  const result = await verifySymbolicWitness({ model, run, spec, config, jar });
  assert.equal(result.witness.version, 2);
  assert.equal(result.evidence.checkedCases, result.witness.nodes.length * 4);
  assert.equal(result.evidence.acceptedCases, result.evidence.checkedCases);
  assert.equal(result.evidence.disabledCases, 0);
  assert.ok(result.oracleDot.includes('Input0') && result.oracleDot.includes('Input1'));
  const { source: _source, ...program } = model;
  const wrongMetadata = symbolicModel({ ...program, branches: model.branches.map(branch => branch.action === 'Clash'
    ? { ...branch, updates: { ...branch.updates, rejectedProvenance: { kind: 'state', variable: 'rejectedProvenance' } } } : branch) });
  await assert.rejects(verifySymbolicWitness({ model: wrongMetadata, run, spec, config, jar }), /TLC303.*complete successor differs/);
  const provenanceGuard = symbolicModel({ ...program, branches: model.branches.map(branch => branch.action === 'Same'
    ? { ...branch, guard: { kind: 'and', terms: [branch.guard, { kind: 'not-equal', left: { kind: 'input', parameter: 'provenance' }, right: { kind: 'state', variable: 'storedProvenance' } }] } } : branch) });
  await assert.rejects(verifySymbolicWitness({ model: provenanceGuard, run, spec, config, jar }), /TLC303.*disables an original enabled/);
  assert.equal(await readFile(spec, 'utf8'), original);
});
