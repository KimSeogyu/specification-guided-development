#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const temporary = await mkdtemp(join(tmpdir(), 'sgd-plugin-install-'));
const results = [];
try {
  for (const name of ['codex', 'claude-code']) {
    const plugin = join(temporary, `${name} installed cache`);
    await cp(resolve('plugins', name), plugin, { recursive: true });
    const client = new Client({ name: 'sgd-package-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(plugin, 'scripts/run.mjs'), 'mcp'], cwd: temporary });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
      assert.deepEqual(tools, ['sgd_build', 'sgd_compile', 'sgd_inspect', 'sgd_model', 'sgd_visualize']);
      const out = join(temporary, name, 'generated');
      const built = await client.callTool({ name: 'sgd_build', arguments: {
        project: resolve('examples/order/project.json'), jar: resolve(process.env.TLA2TOOLS_JAR ?? '.runtime/tla2tools.jar'), out,
      } });
      assert.ok(!built.isError, JSON.stringify(built));
      const inspected = await client.callTool({ name: 'sgd_inspect', arguments: { ir: join(out, 'automaton.json') } });
      assert.ok(!inspected.isError, JSON.stringify(inspected));
      await writeFile(join(temporary, 'contract.ts'), 'transition("Pending", "Ack", "Acked");\n');
      const checked = execFileSync(process.execPath, [join(out, 'typescript/checker.mjs'), '--root', temporary, 'contract.ts'], {
        cwd: join(plugin, 'runtime'), encoding: 'utf8', timeout: 30_000,
      });
      assert.deepEqual(JSON.parse(checked), []);
      const visualized = await client.callTool({ name: 'sgd_visualize', arguments: { ir: [join(out, 'automaton.json')], out: join(temporary, name, 'view') } });
      assert.ok(!visualized.isError, JSON.stringify(visualized));
      assert.match(await readFile(join(temporary, name, 'view/index.html'), 'utf8'), /Model explorer/);
      results.push({ plugin: name, nativeRuntime: `${process.platform}-${process.arch}`, tools, modelCheck: 'completed', generatedTypeScript: 'accepted', pele: 'rendered' });
    } finally { await client.close(); }
  }
  await mkdir(resolve('.runtime'), { recursive: true });
  await writeFile(resolve('.runtime/plugin-verification.json'), JSON.stringify(results, null, 2) + '\n');
  process.stdout.write('Both isolated plugin caches completed MCP, TLC, generated native TypeScript checks, and Pele rendering.\n');
} finally { await rm(temporary, { recursive: true, force: true }); }
