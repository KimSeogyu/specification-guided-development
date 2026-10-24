import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { compileProject, writeGenerated } from '../src/compiler.js';
import { createServer } from '../src/mcp.js';
import { checkGeneratedOutput, StaleOutputError, StaleOutputDiagnosticSchema, type StaleOutputDiagnostic } from '../src/output-check.js';
import { RowBindingPlanSchema } from '../src/row-binding-types.js';
import type { GeneratedFile } from '../src/types.js';

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const digest = (letter: string): string => letter.repeat(64);
function plan(sourceDigest: string) {
  return RowBindingPlanSchema.parse({
    version: 1, profile: 'rust-whole-row-v1', crateName: 'fixture',
    sources: [{ path: 'src/run.rs', sha256: sourceDigest }, { path: 'src/fact.rs', sha256: digest('a') }],
    facts: [{ name: 'Fact', rustPath: 'crate::Fact', fields: [{ name: 'value', rustType: 'i64', codec: { kind: 'i64', getters: [] }, payload: true, provenance: false }] }],
  });
}
function artifacts(sourceDigest: string): GeneratedFile[] {
  const row = plan(sourceDigest);
  return [
    { path: 'row-binding-plan.json', content: json(row) },
    { path: 'models/row/row-binding-plan.json', content: json(row) },
    { path: 'partition-plan.json', content: json({ kind: 'closed-partition-fold', row: { plan: row } }) },
    { path: 'models/row/verification.json', content: json({ kind: 'tlc-symbolic-completed', generation: 'whole-row-authority', rowBinding: { profile: row.profile, sources: row.sources, planSha256: sourceDigest }, timestamp: sourceDigest }), volatile: true, stableJsonKeys: ['kind', 'generation', 'rowBinding'] },
    { path: 'verification.json', content: json({ kind: 'controlled-partition-fold', source: row.sources, planSha256: sourceDigest, timestamp: sourceDigest }), volatile: true, stableJsonKeys: ['kind', 'source', 'planSha256'] },
    { path: 'rust/src/lib.rs', content: 'pub struct FactOwner;\n' },
    { path: 'typescript/owner.ts', content: 'export const createOwner = () => Object.freeze({});\n' },
    { path: 'tlc.log', content: `volatile run ${sourceDigest}`, volatile: true },
  ];
}
async function refusal(operation: Promise<unknown>): Promise<StaleOutputDiagnostic> {
  try { await operation; }
  catch (error) {
    assert.ok(error instanceof StaleOutputError);
    assert.match(error.message, /^TLC104:/);
    return StaleOutputDiagnosticSchema.parse(error.diagnostic);
  }
  assert.fail('A stale output must fail.');
}
function compare(before: GeneratedFile[], after: GeneratedFile[], previous = before.map(file => file.path)): Promise<void> {
  return Promise.resolve().then(() => checkGeneratedOutput({ previous, files: after.map(file => ({ file, current: before.find(old => old.path === file.path) ? Buffer.from(before.find(old => old.path === file.path)?.content ?? '') : null })) }));
}
async function snapshot(root: string): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  async function visit(directory: string, relative: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), name);
      else values.set(name, (await readFile(join(directory, entry.name))).toString('base64'));
    }
  }
  await visit(root, '');
  return values;
}

test('a source-only maintenance check names the original source and all five stale artifacts without rewriting native code', async () => {
  const out = await mkdtemp(join(tmpdir(), 'sgd-why-stale-'));
  try {
    const before = artifacts(digest('a'));
    const after = artifacts(digest('b'));
    await writeGenerated({ out, files: before });
    const original = await snapshot(out);
    const result = await refusal(writeGenerated({ out, files: after, check: true }));
    assert.deepEqual(result.differences.map(difference => 'path' in difference ? difference.path : null), [
      'row-binding-plan.json', 'models/row/row-binding-plan.json', 'partition-plan.json', 'models/row/verification.json', 'verification.json',
    ]);
    assert.equal(result.sourceInventories.length, 5);
    for (const source of result.sourceInventories) {
      assert.equal(source.kind, 'application-source');
      assert.equal(source.status, 'compared');
      assert.deepEqual(source.changes, [{ path: 'src/run.rs', change: 'changed' }]);
    }
    assert.equal(result.generatedSources.status, 'unchanged');
    assert.deepEqual(result.generatedSources.unchanged, ['rust/src/lib.rs', 'typescript/owner.ts']);
    assert.ok(result.nextAction.includes('explicitly rerun'));
    assert.ok(!JSON.stringify(result).includes(digest('a')));
    assert.ok(!JSON.stringify(result).includes(digest('b')));
    assert.deepEqual(await snapshot(out), original);
  } finally { await rm(out, { recursive: true, force: true }); }
});

test('receipt differences aggregate stable fields, retain separate model origins, and ignore transient changes', async () => {
  const before: GeneratedFile = { path: 'verification.json', volatile: true, stableJsonKeys: ['kind', 'source', 'control', 'metadata'],
    content: json({ kind: 'controlled-partition-fold', source: plan(digest('a')).sources, control: { moduleClosure: [{ name: 'Shared.tla', sha256: digest('a') }] }, metadata: { moduleClosure: [{ name: 'Shared.tla', sha256: digest('a') }] }, timestamp: 'old' }) };
  await compare([before], [{ ...before, content: before.content.replace('"timestamp": "old"', '"timestamp": "new"') }]);
  const after = { ...before, content: json({ kind: 'controlled-partition-fold', source: plan(digest('b')).sources, control: { moduleClosure: [{ name: 'Shared.tla', sha256: digest('b') }] }, metadata: { moduleClosure: [{ name: 'Shared.tla', sha256: digest('c') }] }, timestamp: 'new' }) };
  const result = await refusal(compare([before], [after]));
  assert.deepEqual(result.differences, [{ kind: 'receipt', path: 'verification.json', fields: ['source', 'control', 'metadata'] }]);
  assert.deepEqual(result.sourceInventories.map(source => [source.kind, source.field, source.status]), [
    ['application-source', '/source', 'compared'], ['model-module', '/control/moduleClosure', 'compared'], ['model-module', '/metadata/moduleClosure', 'compared'],
  ]);
  assert.deepEqual(result.sourceInventories.filter(source => source.kind === 'model-module').map(source => source.changes), [
    [{ name: 'Shared.tla', change: 'changed' }], [{ name: 'Shared.tla', change: 'changed' }],
  ]);
  assert.equal(result.generatedSources.status, 'not-generated');
});

test('a controlled finite receipt reports actual flat TLA filenames and retains the stale failure', async () => {
  const before: GeneratedFile = { path: 'models/control/verification.json', volatile: true, stableJsonKeys: ['kind', 'profile', 'moduleClosure'],
    content: json({ kind: 'tlc-finite-completed', profile: 'finite-owned-v1', moduleClosure: [{ name: 'Approval.tla', sha256: digest('a') }] }) };
  const after = { ...before, content: before.content.replace(digest('a'), digest('b')) };
  const result = await refusal(compare([before], [after]));
  assert.deepEqual(result.sourceInventories, [{ kind: 'model-module', artifact: before.path, field: '/moduleClosure', status: 'compared', changes: [{ name: 'Approval.tla', change: 'changed' }] }]);
  assert.deepEqual(result.differences, [{ kind: 'receipt', path: before.path, fields: ['moduleClosure'] }]);
});

test('valid source additions and removals are distinct from malformed or missing previous provenance', async () => {
  const after = artifacts(digest('b'))[0];
  assert.ok(after);
  const changed = plan(digest('a'));
  changed.sources = [{ path: 'src/removed.rs', sha256: digest('c') }];
  const result = await refusal(compare([{ ...after, content: json(changed) }], [after]));
  assert.deepEqual(result.sourceInventories[0]?.changes, [
    { path: 'src/fact.rs', change: 'added' }, { path: 'src/removed.rs', change: 'removed' }, { path: 'src/run.rs', change: 'added' },
  ]);
  const duplicate = plan(digest('a'));
  duplicate.sources.push({ path: 'src/run.rs', sha256: digest('b') });
  for (const before of [{ ...after, content: '{broken' }, { ...after, content: json(duplicate) }]) {
    const unavailable = await refusal(compare([before], [after]));
    assert.equal(unavailable.sourceInventories[0]?.status, 'previous-unavailable');
    assert.deepEqual(unavailable.sourceInventories[0]?.changes, []);
  }
  const missing = await refusal(compare([], [after], [after.path]));
  assert.deepEqual(missing.differences, [{ kind: 'missing', path: after.path }]);
  assert.equal(missing.sourceInventories[0]?.status, 'previous-unavailable');
  const receipt = artifacts(digest('b')).find(file => file.stableJsonKeys);
  assert.ok(receipt);
  const malformed = await refusal(compare([{ ...receipt, content: '{broken' }], [receipt]));
  assert.deepEqual(malformed.differences, [{ kind: 'invalid-receipt', path: receipt.path }]);
});

test('output inventory changes and missing generated code cannot appear as unchanged source bytes', async () => {
  const before = [{ path: 'rust/src/lib.rs', content: 'old Rust source' }, { path: 'typescript/owner.ts', content: 'old TS source' }];
  const after = [{ path: 'rust/src/lib.rs', content: 'changed Rust source' }, { path: 'javascript/owner.mjs', content: 'new JS source' }];
  const result = await refusal(compare(before, after));
  assert.deepEqual(result.differences, [
    { kind: 'inventory', added: ['javascript/owner.mjs'], removed: ['typescript/owner.ts'] },
    { kind: 'content', path: 'rust/src/lib.rs' }, { kind: 'missing', path: 'javascript/owner.mjs' },
  ]);
  assert.equal(result.generatedSources.status, 'incomplete');
  assert.deepEqual(result.generatedSources.removed, ['typescript/owner.ts']);
  assert.deepEqual(result.generatedSources.changed, ['rust/src/lib.rs']);
  assert.deepEqual(result.generatedSources.added, ['javascript/owner.mjs']);
});

test('arbitrary path/digest metadata is not reclassified as a checked source inventory', async () => {
  const before = { path: 'application-settings.json', content: json({ sources: [{ path: 'private.txt', sha256: digest('a') }] }) };
  const after = { ...before, content: before.content.replace(digest('a'), digest('b')) };
  const result = await refusal(compare([before], [after]));
  assert.deepEqual(result.sourceInventories, []);
});

test('invalid UTF-8 generated source fails a byte comparison even when decoded text would match', async () => {
  const out = await mkdtemp(join(tmpdir(), 'sgd-output-bytes-'));
  try {
    const source = { path: 'owner.ts', content: 'export const value = "�";\n' };
    await writeGenerated({ out, files: [source] });
    const corrupt = Buffer.concat([Buffer.from('export const value = "'), Buffer.from([0xff]), Buffer.from('";\n')]);
    assert.equal(corrupt.toString('utf8'), source.content);
    await writeFile(join(out, source.path), corrupt);
    const result = await refusal(writeGenerated({ out, files: [source], check: true }));
    assert.equal(result.generatedSources.status, 'changed');
    assert.deepEqual(await readFile(join(out, source.path)), corrupt);
  } finally { await rm(out, { recursive: true, force: true }); }
});

test('CLI and MCP expose the same structured stale-output diagnostic with their existing failure contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sgd-output-channels-'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: 'sgd-stale-test', version: '1.0.0' });
  try {
    const project = join(root, 'project.json'); const dot = join(root, 'model.dot'); const out = join(root, 'generated');
    await writeFile(project, json({ version: 1, name: 'Example', spec: 'Example.tla', config: 'Example.cfg', stateVariable: 'state', targets: ['typescript', 'rust'], binding: { kind: 'transition', function: 'transition' } }));
    await writeFile(dot, String.raw`digraph DiskGraph { 1 [label="state = \"New\"", style=filled]; 1 -> 1 [label="Wait"]; }`);
    await compileProject({ project, dot, out });
    await writeFile(join(out, 'typescript/checker.mjs'), 'edited TS');
    await writeFile(join(out, 'rust/src/main.rs'), 'edited Rust');
    const original = await snapshot(out);
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    let cliOutput: unknown;
    try { await promisify(execFile)(process.execPath, ['--import', 'tsx', cli, 'compile', '--project', project, '--dot', dot, '--out', out, '--check']); assert.fail('CLI check must fail.'); }
    catch (error) {
      assert.ok(error instanceof Error && 'code' in error && 'stderr' in error && 'stdout' in error);
      assert.equal(error.code, 2); assert.equal(error.stdout, '');
      cliOutput = JSON.parse(String(error.stderr));
    }
    assert.ok(typeof cliOutput === 'object' && cliOutput !== null && 'error' in cliOutput && 'diagnostic' in cliOutput);
    assert.match(String(cliOutput.error), /^TLC104:/);
    const expected = StaleOutputDiagnosticSchema.parse(cliOutput.diagnostic);
    assert.equal(expected.generatedSources.status, 'changed');
    await server.connect(serverTransport); await client.connect(clientTransport);
    const checked = await client.callTool({ name: 'sgd_compile', arguments: { project, dot, out, check: true } });
    assert.equal(checked.isError, true);
    assert.ok(Array.isArray(checked.content) && checked.content.length === 1);
    const content = checked.content[0];
    assert.ok(content && content.type === 'text');
    const response: unknown = JSON.parse(content.text);
    assert.ok(typeof response === 'object' && response !== null && 'error' in response && 'diagnostic' in response);
    assert.match(String(response.error), /^TLC104:/);
    assert.deepEqual(StaleOutputDiagnosticSchema.parse(response.diagnostic), expected);
    assert.deepEqual(await snapshot(out), original);
  } finally { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
