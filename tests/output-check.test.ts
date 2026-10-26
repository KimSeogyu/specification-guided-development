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
import type { GeneratedFile } from '../src/types.js';

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const digest = (letter: string): string => letter.repeat(64);
function receipt(sourceDigest: string) {
  return {
    kind: 'tlc-symbolic-completed', profile: 'symbolic-owned-v1',
    moduleClosure: [{ name: 'Write.tla', sha256: sourceDigest }, { name: 'Common.tla', sha256: digest('a') }],
  };
}
function artifacts(sourceDigest: string): GeneratedFile[] {
  return [
    ...['verification.json', 'models/secondary/verification.json'].map(path => ({
      path, content: json({ ...receipt(sourceDigest), timestamp: sourceDigest }),
      volatile: true, stableJsonKeys: ['kind', 'profile', 'moduleClosure'],
    })),
    { path: 'typescript/authority.ts', content: 'export interface ModelOwner {}\n' },
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

test('a source-only maintenance check identifies stale model receipts without rewriting generated code', async () => {
  const out = await mkdtemp(join(tmpdir(), 'sgd-why-stale-'));
  try {
    const before = artifacts(digest('a'));
    const after = artifacts(digest('b'));
    await writeGenerated({ out, files: before });
    const original = await snapshot(out);
    const result = await refusal(writeGenerated({ out, files: after, check: true }));
    assert.deepEqual(result.differences.map(difference => 'path' in difference ? difference.path : null), [
      'verification.json', 'models/secondary/verification.json',
    ]);
    assert.equal(result.sourceInventories.length, 2);
    for (const source of result.sourceInventories) {
      assert.equal(source.kind, 'model-module');
      assert.equal(source.status, 'compared');
      assert.deepEqual(source.changes, [{ name: 'Write.tla', change: 'changed' }]);
    }
    assert.equal(result.generatedSources.status, 'unchanged');
    assert.deepEqual(result.generatedSources.unchanged, ['typescript/authority.ts', 'typescript/owner.ts']);
    assert.ok(result.nextAction.includes('explicitly rerun'));
    assert.ok(!JSON.stringify(result).includes(digest('a')));
    assert.ok(!JSON.stringify(result).includes(digest('b')));
    assert.deepEqual(await snapshot(out), original);
  } finally { await rm(out, { recursive: true, force: true }); }
});

test('receipt differences aggregate stable fields, retain separate model origins, and ignore transient changes', async () => {
  const before: GeneratedFile[] = ['verification.json', 'models/secondary/verification.json'].map(path => ({
    path, volatile: true, stableJsonKeys: ['kind', 'profile', 'moduleClosure', 'configSha256'],
    content: json({ kind: 'tlc-symbolic-completed', profile: 'symbolic-owned-v1',
      moduleClosure: [{ name: 'Shared.tla', sha256: digest('a') }], configSha256: digest('a'), timestamp: 'old' }),
  }));
  await compare(before, before.map(file => ({ ...file, content: file.content.replace('"timestamp": "old"', '"timestamp": "new"') })));
  const after = before.map((file, index) => ({ ...file, content: json({
    kind: 'tlc-symbolic-completed', profile: 'symbolic-owned-v1',
    moduleClosure: [{ name: 'Shared.tla', sha256: digest(index === 0 ? 'b' : 'c') }],
    configSha256: digest('b'), timestamp: 'new',
  }) }));
  const result = await refusal(compare(before, after));
  assert.deepEqual(result.differences, before.map(file => ({ kind: 'receipt', path: file.path, fields: ['moduleClosure', 'configSha256'] })));
  assert.deepEqual(result.sourceInventories.map(source => [source.kind, source.artifact, source.field, source.status]), [
    ['model-module', 'verification.json', '/moduleClosure', 'compared'],
    ['model-module', 'models/secondary/verification.json', '/moduleClosure', 'compared'],
  ]);
  assert.deepEqual(result.sourceInventories.map(source => source.changes), [
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
  const changed = receipt(digest('a'));
  changed.moduleClosure = [{ name: 'Removed.tla', sha256: digest('c') }];
  const result = await refusal(compare([{ ...after, content: json(changed) }], [after]));
  assert.deepEqual(result.sourceInventories[0]?.changes, [
    { name: 'Common.tla', change: 'added' }, { name: 'Removed.tla', change: 'removed' }, { name: 'Write.tla', change: 'added' },
  ]);
  const duplicate = receipt(digest('a'));
  duplicate.moduleClosure.push({ name: 'Write.tla', sha256: digest('b') });
  for (const before of [{ ...after, content: '{broken' }, { ...after, content: json(duplicate) }]) {
    const unavailable = await refusal(compare([before], [after]));
    assert.equal(unavailable.sourceInventories[0]?.status, 'previous-unavailable');
    assert.deepEqual(unavailable.sourceInventories[0]?.changes, []);
  }
  const missing = await refusal(compare([], [after], [after.path]));
  assert.deepEqual(missing.differences, [{ kind: 'missing', path: after.path }]);
  assert.equal(missing.sourceInventories[0]?.status, 'previous-unavailable');
  const checkedReceipt = artifacts(digest('b')).find(file => file.stableJsonKeys);
  assert.ok(checkedReceipt);
  const malformed = await refusal(compare([{ ...checkedReceipt, content: '{broken' }], [checkedReceipt]));
  assert.deepEqual(malformed.differences, [{ kind: 'invalid-receipt', path: checkedReceipt.path }]);
});

test('output inventory changes and missing generated code cannot appear as unchanged source bytes', async () => {
  const before = [{ path: 'typescript/authority.ts', content: 'old authority source' }, { path: 'typescript/owner.ts', content: 'old TS source' }];
  const after = [{ path: 'typescript/authority.ts', content: 'changed authority source' }, { path: 'javascript/owner.mjs', content: 'new JS source' }];
  const result = await refusal(compare(before, after));
  assert.deepEqual(result.differences, [
    { kind: 'inventory', added: ['javascript/owner.mjs'], removed: ['typescript/owner.ts'] },
    { kind: 'content', path: 'typescript/authority.ts' }, { kind: 'missing', path: 'javascript/owner.mjs' },
  ]);
  assert.equal(result.generatedSources.status, 'incomplete');
  assert.deepEqual(result.generatedSources.removed, ['typescript/owner.ts']);
  assert.deepEqual(result.generatedSources.changed, ['typescript/authority.ts']);
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
    await writeFile(project, json({ version: 1, name: 'Example', spec: 'Example.tla', config: 'Example.cfg', stateVariable: 'state', targets: ['typescript'], binding: { kind: 'transition', function: 'transition' } }));
    await writeFile(dot, String.raw`digraph DiskGraph { 1 [label="state = \"New\"", style=filled]; 1 -> 1 [label="Wait"]; }`);
    await compileProject({ project, dot, out });
    await writeFile(join(out, 'typescript/checker.mjs'), 'edited TS');
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
