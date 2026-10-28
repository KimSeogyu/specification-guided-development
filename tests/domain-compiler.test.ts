import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildProjectReport } from '../src/compiler.js';
import { DomainProofError, verifyDomainProof } from '../src/domain-proof.js';
import { FiniteGraphSchema } from '../src/finite-types.js';

const jar = process.env.TLA2TOOLS_JAR;
const lean = process.env.SGD_LEAN_BINARY;
const domain = { operations: [{ name: 'publish', port: 'write',
  start: 'Start', success: 'Succeeded', failure: 'Failed' }] };
const model = `---------------- MODULE Delivery ----------------
VARIABLE phase
Init == phase = "Ready"
Start == /\\ phase = "Ready" /\\ phase' = "Pending"
Succeeded == /\\ phase = "Pending" /\\ phase' = "Done"
Failed == /\\ phase = "Pending" /\\ phase' = "Failed"
Reset == /\\ phase \\in {"Done", "Failed"} /\\ phase' = "Ready"
Next == Start \\/ Succeeded \\/ Failed \\/ Reset
TypeOK == phase \\in {"Ready", "Pending", "Done", "Failed"}
=================================================
`;

async function contents(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(relative: string): Promise<void> {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await visit(path);
      else result[path] = await readFile(join(root, path), 'utf8');
    }
  }
  await visit('');
  return result;
}

test('controlled TLC domain build requires a real Lean proof and preserves published output on rejection', {
  skip: !jar || !lean ? 'Set TLA2TOOLS_JAR and SGD_LEAN_BINARY for real TLC and Lean integration' : false,
  timeout: 180_000,
}, async t => {
  assert.ok(jar);
  assert.ok(lean);
  const root = await mkdtemp(join(tmpdir(), 'sgd-domain-build-'));
  let cleanupSafe = true;
  t.after(async () => {
    if (cleanupSafe) await rm(root, { recursive: true, force: true });
    else t.diagnostic(`Preserved fixture after uncertain native process completion: ${root}`);
  });
  const project = join(root, 'project.json');
  const out = join(root, 'generated');
  const configuration = {
    version: 2, profile: 'finite-owned', name: 'Delivery', spec: 'Delivery.tla',
    config: 'Delivery.cfg', targets: ['typescript'],
    binding: { className: 'Delivery', domain },
  };
  await writeFile(project, JSON.stringify(configuration));
  await writeFile(join(root, 'Delivery.tla'), model);
  await writeFile(join(root, 'Delivery.cfg'), 'INIT Init\nNEXT Next\nINVARIANT TypeOK\n');
  const input = { project, jar, lean, out };
  await assert.rejects(buildProjectReport({ project, jar, out }), /TLC208.*requires --lean/);
  await buildProjectReport(input);
  const published = await contents(out);
  assert.match(published['typescript/domain.ts'] ?? '', /createDeliveryDomain/);
  assert.match(published['proof/DomainProof.lean'] ?? '', /theorem protocol_valid/);
  assert.match(published['proof/verification.json'] ?? '', /nativeCompilerCorrespondence/);
  await buildProjectReport({ ...input, check: true });
  // Compile the actual controlled-build output, not a hand-authored facade.
  const native = spawnSync(process.execPath, [
    resolve('node_modules/typescript/bin/tsc'), '-p', join(out, 'typescript/tsconfig.json'),
  ], { encoding: 'utf8', timeout: 30_000 });
  if (native.error) cleanupSafe = false;
  assert.ifError(native.error);
  assert.equal(native.status, 0, native.stdout + native.stderr);
  const runtime = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createDeliveryDomain } from './generated/typescript/dist/domain.js';
    const payload = { report: 'actual TLC build' };
    let calls = 0;
    const owner = createDeliveryDomain({write: input => {calls++; return input;}});
    const result = await owner.publish(payload);
    assert.equal(result.kind, 'success');
    assert.equal(result.value, payload);
    assert.equal(result.completion.event, 'Succeeded');
    assert.equal(calls, 1);
    assert.equal(owner.send('Succeeded').reason, 'unknown-event');
  `], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  if (runtime.error) cleanupSafe = false;
  assert.ifError(runtime.error);
  assert.equal(runtime.status, 0, runtime.stdout + runtime.stderr);
  // Native compilation is consumer work, not a compiler-owned publication.
  await rm(join(out, 'typescript/dist'), { recursive: true, force: true });

  // This bypasses only the JS protocol validator: the real kernel must reject
  // a graph whose pending state has no failure completion.
  const graph = FiniteGraphSchema.parse(JSON.parse(published['automaton.json'] ?? 'null'));
  const edges = graph.edges.map(edge => edge.event === 'Failed' ? { ...edge, event: 'Reset' } : edge);
  const invalid = { ...graph, edges, source: { ...graph.source, edgeCount: edges.length } };
  await assert.rejects(verifyDomainProof({ automaton: invalid, domain, lean }), error => {
    assert.ok(error instanceof DomainProofError);
    assert.ok(error.diagnostics.some(item => item.stage === 'project' && item.exitCode !== 0));
    return true;
  });
  assert.deepEqual(await contents(out), published);

  await assert.rejects(buildProjectReport({ ...input, lean: join(root, 'missing-lean') }), /TLC208/);
  assert.deepEqual(await contents(out), published);
  await writeFile(project, JSON.stringify({ ...configuration, binding: {
    ...configuration.binding, domain: { operations: [{ ...domain.operations[0], failure: 'Reset' }] },
  } }));
  await assert.rejects(buildProjectReport(input), /TLC208/);
  assert.deepEqual(await contents(out), published);
  await writeFile(project, JSON.stringify({ ...configuration, targets: ['unsupported'] }));
  await assert.rejects(buildProjectReport(input), /TypeScript|typescript|TLC208/);
  assert.deepEqual(await contents(out), published);
});
