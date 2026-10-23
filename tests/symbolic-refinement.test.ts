import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { lowerSymbolicModel } from '../src/symbolic-lower.js';
import { parseSanyXml } from '../src/sany-xml.js';
import { verifySymbolicErasure } from '../src/symbolic-refinement.js';
import { runSymbolicTlc } from '../src/symbolic-tlc.js';
import { symbolicModel } from '../src/symbolic-types.js';

const jar = process.env.TLA2TOOLS_JAR ? resolve(process.env.TLA2TOOLS_JAR) : undefined;
const execute = promisify(execFile);
const binding = {
  version: 1, variables: { phase: 'phase', stored: 'stored', rejected: 'rejected' },
  inputs: { v: 'v' }, actions: { Insert: 'Insert', Same: 'Same', Clash: 'Clash' },
};
async function loadModels() {
  assert.ok(jar);
  const paths = ['fact-merge/ManifestWrite', 'fact-envelope/FactWriteEnvelope'];
  const runs = await Promise.all(paths.map(path => runSymbolicTlc({ spec: resolve(`examples/${path}.tla`), config: resolve(`examples/${path}.cfg`), jar })));
  const high = runs[0]; const low = runs[1]; assert.ok(high && low);
  return {
    abstract: lowerSymbolicModel({ name: 'ManifestWrite', semantic: parseSanyXml(high.xml), config: high.config }),
    concrete: lowerSymbolicModel({ name: 'FactWriteEnvelope', semantic: parseSanyXml(low.xml), config: low.config, profile: 'product' }),
  };
}
let cached: ReturnType<typeof loadModels> | undefined;
const models = () => cached ??= loadModels();

test('envelope erasure preserves every enabled input, action, and complete abstract successor', { skip: !jar }, async () => {
  const pair = await models();
  const evidence = verifySymbolicErasure({ ...pair, binding });
  assert.equal(evidence.kind, 'symbolic-enabled-input-erasure');
  assert.equal(evidence.scope, 'admitted-equality-copy-orbits');
  assert.ok(evidence.concreteOrbitCount > 0);
  assert.ok(evidence.checkedCases > evidence.concreteOrbitCount);
  assert.equal(evidence.acceptedCases, evidence.checkedCases);
  assert.equal(evidence.disabledCases, 0);
  assert.equal(evidence.abstract.semanticSha256, pair.abstract.source.semanticSha256);
});

test('erasure rejects provenance-dependent admission even when emitted state edges still project safely', { skip: !jar }, async () => {
  const pair = await models();
  const { source: _source, ...program } = pair.concrete;
  const concrete = symbolicModel({ ...program, branches: program.branches.map(branch => branch.action === 'Same'
    ? { ...branch, guard: { kind: 'and', terms: [branch.guard, { kind: 'not-equal', left: { kind: 'input', parameter: 'provenance' }, right: { kind: 'state', variable: 'storedProvenance' } }] } } : branch) });
  assert.throws(() => verifySymbolicErasure({ ...pair, concrete, binding }), /TLC304.*enabled-input decision differs/);
});

test('erasure checks projected assignments, nominal domains, initial state and action classification', { skip: !jar }, async () => {
  const pair = await models();
  const { source: _source, ...program } = pair.concrete;
  const overwrite = symbolicModel({ ...program, invariants: [], actionProperties: [], branches: program.branches.map(branch => branch.action === 'Clash'
    ? { ...branch, updates: { ...branch.updates, stored: { kind: 'input', parameter: 'v' } } } : branch) });
  assert.throws(() => verifySymbolicErasure({ ...pair, concrete: overwrite, binding }), /TLC304.*projected successor differs/);
  const wrongInit = symbolicModel({ ...program, initial: { ...program.initial, phase: { kind: 'string', value: 'other' } } });
  assert.throws(() => verifySymbolicErasure({ ...pair, concrete: wrongInit, binding }), /TLC304.*initial state differs/);
  assert.throws(() => verifySymbolicErasure({ ...pair, binding: { ...binding, inputs: { v: 'provenance' } } }), /TLC304.*erased domain/);
  assert.throws(() => verifySymbolicErasure({ ...pair, binding: { ...binding, actions: { Insert: 'Insert', Same: 'Clash', Clash: 'Same' } } }), /TLC304.*observable action differs/);
  assert.throws(() => verifySymbolicErasure({ ...pair, binding: { ...binding, variables: { stored: 'stored' } } }), /TLC304.*variable projection/);
  assert.throws(() => verifySymbolicErasure({ ...pair, binding: { ...binding, actions: { Insert: 'Insert', Same: 'Same', Clash: 'Same' } } }), /TLC304.*action projection/);
});

test('metadata-only writes use concrete square stuttering and need an explicit concrete contract', { skip: !jar }, async () => {
  const pair = await models();
  const { source: _source, ...program } = pair.concrete;
  const branches = program.branches.map(branch => branch.action === 'Same'
    ? { ...branch, updates: { ...branch.updates, storedProvenance: { kind: 'input' as const, parameter: 'provenance' } } } : branch);
  const concrete = symbolicModel({ ...program, branches });
  assert.throws(() => verifySymbolicErasure({ ...pair, concrete, binding }), /TLC302.*ProvenanceStable/);
  // Erasure deliberately cannot prove an erased metadata law on its own.
  const unconstrainedMetadata = symbolicModel({ ...program, branches, actionProperties: [] });
  assert.ok(verifySymbolicErasure({ ...pair, concrete: unconstrainedMetadata, binding }).acceptedCases > 0);
});

test('CLI erasure writes deterministic managed evidence and detects stale bindings', { skip: !jar }, async () => {
  const pair = await models();
  const root = await mkdtemp(join(tmpdir(), 'sgd-erasure-cli-'));
  try {
    const abstract = join(root, 'abstract.json'); const concrete = join(root, 'concrete.json'); const map = join(root, 'binding.json'); const out = join(root, 'out');
    await Promise.all([writeFile(abstract, JSON.stringify(pair.abstract)), writeFile(concrete, JSON.stringify(pair.concrete)), writeFile(map, JSON.stringify(binding))]);
    const args = ['--import', 'tsx', resolve('src/cli.ts'), 'refine', '--abstract', abstract, '--concrete', concrete, '--binding', map, '--out', out];
    await execute(process.execPath, args);
    const bytes = await readFile(join(out, 'refinement.json'), 'utf8');
    await execute(process.execPath, [...args, '--check']);
    assert.equal(await readFile(join(out, 'refinement.json'), 'utf8'), bytes);
    await writeFile(join(out, 'refinement.json'), bytes + ' ');
    await assert.rejects(execute(process.execPath, [...args, '--check']), error => error instanceof Error && 'stderr' in error && String(error.stderr).includes('TLC104'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
