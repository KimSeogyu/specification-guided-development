import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp.js';

test('MCP negotiates tools and reports a failed read as a tool error', async () => {
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  const server=createServer();const client=new Client({name:'sgd-test',version:'1.0.0'});
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    const list=await client.listTools();
    assert.deepEqual(list.tools.map(tool=>tool.name).sort(),['sgd_build','sgd_compile','sgd_inspect','sgd_model','sgd_refine','sgd_visualize']);
    const result=await client.callTool({name:'sgd_inspect',arguments:{ir:'/does-not-exist/automaton.json'}});
    assert.equal(result.isError,true);
    assert.equal(list.tools.find(tool=>tool.name==='sgd_refine')?.annotations?.readOnlyHint,true);
    const erasure=await client.callTool({name:'sgd_refine',arguments:{abstract:'/does-not-exist/high.json',concrete:'/does-not-exist/low.json',binding:'/does-not-exist/binding.json'}});
    assert.equal(erasure.isError,true);
  } finally {await client.close();await server.close();}
});
