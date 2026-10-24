import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp.js';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ReleaseVersionSchema } from '../src/version.js';
import { BuildSummarySchema, buildProject } from '../src/compiler.js';

test('runtime release versions follow the standalone distribution semantic version profile', () => {
  for (const value of ['0.0.0', '1.2.3', '0.2.0-alpha.1', '1.2.3-0', '1.2.3-alpha-01', '1.2.3+build.01', '1.2.3-alpha.1+build.01']) {
    assert.equal(ReleaseVersionSchema.parse(value), value);
  }
  for (const value of ['dev', '01.2.3', '1.02.3', '1.2.03', '0.2.0-01', '0.2.0-alpha.01', '1.2.3-', '1.2.3+', '1.2.3-alpha..1', '1.2.3\n', '1.2.3\r\n', '1.2.3\u2028', '1.2.3\u2029', '1.2.3+build.01\n']) {
    assert.equal(ReleaseVersionSchema.safeParse(value).success, false, value);
  }
});

test('MCP negotiates tools and reports a failed read as a tool error', async () => {
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  const server=createServer();const client=new Client({name:'sgd-test',version:'1.0.0'});
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    const metadata: unknown = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.ok(typeof metadata === 'object' && metadata !== null && 'version' in metadata);
    assert.equal(client.getServerVersion()?.version, metadata.version);
    const cli = await promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/cli.ts', import.meta.url)), '--version']);
    assert.equal(cli.stdout.trim(), metadata.version);
    const list=await client.listTools();
    assert.deepEqual(list.tools.map(tool=>tool.name).sort(),['sgd_build','sgd_check_contracts','sgd_compile','sgd_inspect','sgd_model','sgd_refine','sgd_update_status','sgd_visualize']);
    for (const name of ['sgd_build', 'sgd_compile']) {
      const tool = list.tools.find(tool => tool.name === name);
      assert.ok(tool);
      assert.deepEqual([...(tool.inputSchema.required ?? [])].sort(), (name === 'sgd_build' ? ['jar', 'out', 'project'] : ['dot', 'out', 'project']));
      const check = tool.inputSchema.properties?.check;
      assert.ok(check && typeof check === 'object');
      assert.ok('default' in check && 'type' in check);
      assert.equal(check.default, false);
      assert.equal(check.type, 'boolean');
    }
    for (const name of ['sgd_build', 'sgd_model']) {
      const detail = list.tools.find(tool => tool.name === name)?.inputSchema.properties?.detail;
      assert.ok(detail && typeof detail === 'object' && 'default' in detail && 'enum' in detail);
      assert.equal(detail.default, 'summary');
      assert.deepEqual(detail.enum, ['summary', 'full']);
    }
    assert.ok(!('check' in (list.tools.find(tool => tool.name === 'sgd_model')?.inputSchema.properties ?? {})));
    const result=await client.callTool({name:'sgd_inspect',arguments:{ir:'/does-not-exist/automaton.json'}});
    assert.equal(result.isError,true);
    assert.equal(list.tools.find(tool=>tool.name==='sgd_refine')?.annotations?.readOnlyHint,true);
    const erasure=await client.callTool({name:'sgd_refine',arguments:{abstract:'/does-not-exist/high.json',concrete:'/does-not-exist/low.json',binding:'/does-not-exist/binding.json'}});
    assert.equal(erasure.isError,true);
  } finally {await client.close();await server.close();}
});

test('MCP rejects invalid detail before reading model inputs or creating output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sgd-mcp-detail-'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(); const client = new Client({ name: 'sgd-detail-test', version: '1.0.0' });
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    for (const name of ['sgd_build', 'sgd_model']) {
      const out = join(root, name);
      const result = await client.callTool({ name, arguments: { project: '/absent/project.json', jar: '/absent/tla2tools.jar', out, detail: 'nodes' } });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /Invalid arguments|invalid_value/);
      assert.doesNotMatch(JSON.stringify(result.content), /ENOENT/);
      await assert.rejects(access(out), { code: 'ENOENT' });
    }
  } finally { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('real MCP summary and full views run one pipeline and preserve inspect, SDK, and CLI IR contracts', { skip: !process.env.TLA2TOOLS_JAR, timeout: 120_000 }, async () => {
  const jar = process.env.TLA2TOOLS_JAR; assert.ok(jar);
  const root = await mkdtemp(join(tmpdir(), 'sgd-mcp-build-report-'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(); const client = new Client({ name: 'sgd-build-report-test', version: '1.0.0' });
  const originalPath = process.env.PATH;
  const execute = promisify(execFile);
  await server.connect(serverTransport);
  try {
    const java = (await execute('which', ['java'])).stdout.trim();
    const counter = join(root, 'java-calls.jsonl');
    const binaries = join(root, 'bin'); await mkdir(binaries);
    await writeFile(counter, '');
    await writeFile(join(binaries, 'java'), `#!${process.execPath}\nconst fs = require('node:fs');\nconst { spawnSync } = require('node:child_process');\nconst args = process.argv.slice(2);\nif (args.includes('tlc2.TLC')) fs.appendFileSync(${JSON.stringify(counter)}, JSON.stringify(args) + '\\n');\nconst child = spawnSync(${JSON.stringify(java)}, args, { stdio: 'inherit' });\nprocess.exit(child.status ?? 1);\n`, { mode: 0o755 });
    process.env.PATH = `${binaries}:${originalPath ?? ''}`;
    const calls = async () => (await readFile(counter, 'utf8')).split('\n').filter(Boolean).length;
    await client.connect(clientTransport);
    const input = { project: resolve('examples/approval/project.json'), jar: resolve(jar), out: join(root, 'generated') };
    async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
      const before = await calls();
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      assert.equal(await calls() - before, name === 'sgd_inspect' ? 0 : 1, `${name} must not repeat TLC for its response`);
      const content = result.content;
      assert.ok(Array.isArray(content));
      const first = content[0]; assert.ok(first && first.type === 'text' && typeof first.text === 'string');
      return JSON.parse(first.text);
    }
    const summary = BuildSummarySchema.parse(await call('sgd_build', input));
    assert.equal(summary.operation, 'build');
    assert.ok(!('nodes' in summary.graph));
    const published = JSON.parse(await readFile(join(input.out, 'automaton.json'), 'utf8'));
    assert.deepEqual(await call('sgd_build', { ...input, check: true, detail: 'full' }), published);
    assert.deepEqual(await call('sgd_inspect', { ir: join(input.out, 'automaton.json') }), published);
    const beforeSdk = await calls();
    assert.deepEqual(await buildProject({ ...input, check: true }), published);
    assert.equal(await calls() - beforeSdk, 1);
    const beforeCli = await calls();
    const cli = await execute(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
      'build', '--project', input.project, '--jar', input.jar, '--out', input.out, '--check']);
    assert.deepEqual(JSON.parse(cli.stdout), published);
    assert.equal(await calls() - beforeCli, 1);
    const modeled = BuildSummarySchema.parse(await call('sgd_model', input));
    assert.equal(modeled.operation, 'model');
    assert.deepEqual(modeled.verification.checks.map(check => check.kind), ['controlled-tlc']);
    assert.deepEqual(await call('sgd_model', { ...input, detail: 'full' }), published);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await client.close(); await server.close(); await rm(root, { recursive: true, force: true });
  }
});

test('MCP release awareness is read-only, strict, and does not turn offline metadata into a tool error', async () => {
  const transport = mock.method(globalThis, 'fetch', async () => { throw new TypeError('offline fixture'); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(); const client = new Client({ name: 'sgd-update-test', version: '1.0.0' });
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    const tool = (await client.listTools()).tools.find(tool => tool.name === 'sgd_update_status');
    assert.ok(tool);
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    const result = await client.callTool({ name: 'sgd_update_status', arguments: { host: 'codex', channel: 'alpha' } });
    assert.ok(!result.isError);
    assert.match(JSON.stringify(result.content), /unknown/);
    assert.match(JSON.stringify(result.content), /network/);
    for (const args of [{ host: 'codex' }, { host: 'codex', channel: 'beta' }, { host: 'codex', channel: 'alpha', url: 'https://example.com' }]) {
      const invalid = await client.callTool({ name: 'sgd_update_status', arguments: args });
      assert.equal(invalid.isError, true);
    }
    assert.equal(transport.mock.callCount(), 1);
  } finally { await client.close(); await server.close(); transport.mock.restore(); }
});

test('MCP check mode refuses edited generated output without repairing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sgd-mcp-check-'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(); const client = new Client({ name: 'sgd-check-test', version: '1.0.0' });
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    const project = join(root, 'project.json'); const dot = join(root, 'model.dot'); const out = join(root, 'generated');
    await writeFile(project, JSON.stringify({ version: 1, name: 'Example', spec: 'Example.tla', config: 'Example.cfg', stateVariable: 'state', targets: ['typescript'], binding: { kind: 'transition', function: 'transition' } }));
    await writeFile(dot, String.raw`digraph DiskGraph { 1 [label="state = \"New\"", style=filled]; 1 -> 1 [label="Wait"]; }`);
    const args = { project, dot, out };
    const invalidOut = join(root, 'invalid-output');
    const invalid = await client.callTool({ name: 'sgd_compile', arguments: { project, dot, out: invalidOut, check: 'yes' } });
    assert.equal(invalid.isError, true);
    assert.match(JSON.stringify(invalid.content), /Invalid arguments|invalid_type/);
    await assert.rejects(access(invalidOut), { code: 'ENOENT' });
    const built = await client.callTool({ name: 'sgd_compile', arguments: args });
    assert.ok(!built.isError, JSON.stringify(built));
    const original = await readFile(join(out, 'typescript/checker.mjs'));
    const checked = await client.callTool({ name: 'sgd_compile', arguments: { ...args, check: true } });
    assert.ok(!checked.isError, JSON.stringify(checked));
    assert.deepEqual(await readFile(join(out, 'typescript/checker.mjs')), original);
    await writeFile(join(out, 'typescript/checker.mjs'), 'user edit');
    const refused = await client.callTool({ name: 'sgd_compile', arguments: { ...args, check: true } });
    assert.equal(refused.isError, true);
    assert.match(JSON.stringify(refused.content), /TLC104: stale generated file/);
    assert.equal(await readFile(join(out, 'typescript/checker.mjs'), 'utf8'), 'user edit');
  } finally { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
