import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp.js';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('MCP negotiates tools and reports a failed read as a tool error', async () => {
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  const server=createServer();const client=new Client({name:'sgd-test',version:'1.0.0'});
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    const list=await client.listTools();
    assert.deepEqual(list.tools.map(tool=>tool.name).sort(),['sgd_build','sgd_compile','sgd_inspect','sgd_model','sgd_refine','sgd_visualize']);
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
    const result=await client.callTool({name:'sgd_inspect',arguments:{ir:'/does-not-exist/automaton.json'}});
    assert.equal(result.isError,true);
    assert.equal(list.tools.find(tool=>tool.name==='sgd_refine')?.annotations?.readOnlyHint,true);
    const erasure=await client.callTool({name:'sgd_refine',arguments:{abstract:'/does-not-exist/high.json',concrete:'/does-not-exist/low.json',binding:'/does-not-exist/binding.json'}});
    assert.equal(erasure.isError,true);
  } finally {await client.close();await server.close();}
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
