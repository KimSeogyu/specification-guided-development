import assert from 'node:assert/strict';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createServer } from '../src/mcp.js';
import { BuildSummarySchema } from '../src/build-report.js';
import { FiniteGraphSchema, MachineProjectSchema } from '../src/finite-types.js';

const jar = process.env.TLA2TOOLS_JAR ? resolve(process.env.TLA2TOOLS_JAR) : undefined;
const project = fileURLToPath(new URL('../examples/retained-operation/project.json', import.meta.url));
const Response = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
});
function response(value: unknown) {
  const parsed = Response.parse(value);
  const first = parsed.content[0];
  assert.ok(first, 'the MCP tool must return a text result');
  const payload: unknown = JSON.parse(first.text);
  return { isError: parsed.isError, payload };
}

test('real retained-operation MCP build exposes scoped summary, native artifacts, full inspect, and role refusal', {
  skip: !jar, timeout: 240_000,
}, async () => {
  assert.ok(jar);
  const root = await mkdtemp(join(tmpdir(), 'sgd-retained-channels-'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: 'sgd-retained-channel-test', version: '1.0.0' });
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    const out = join(root, 'generated');
    const built = response(await client.callTool({ name: 'sgd_build', arguments: { project, jar, out } }));
    assert.notEqual(built.isError, true, JSON.stringify(built.payload));
    const summary = BuildSummarySchema.parse(built.payload);
    assert.equal(summary.operation, 'build');
    assert.equal(summary.verification.output, 'generated');
    assert.deepEqual(summary.verification.checks.find(check => check.kind === 'retained-operation'), {
      kind: 'retained-operation', role: 'model', scope: 'one-borrowed-synchronous-callback', payload: 'retained-on-all-return-paths',
    });
    assert.deepEqual(summary.limits, {
      applicationIntegration: 'not-established', persistence: 'not-established', externalEffects: 'not-established',
    });
    assert.ok(!('nodes' in summary.graph), 'default MCP response remains compact');
    for (const name of ['typescript/operation.ts', 'binding.json', 'verification.json', 'automaton.json']) {
      assert.ok(summary.output.artifacts.includes(name), `${name} must be published and listed`);
      await access(join(out, name));
    }
    assert.match(await readFile(join(out, 'typescript/operation.ts'), 'utf8'), /export function finalize/);
    const bound = z.object({ operation: z.object({ kind: z.literal('retained-operation'), failure: z.literal('ReportFailed') }) })
      .parse(JSON.parse(await readFile(join(out, 'binding.json'), 'utf8')));
    assert.equal(bound.operation.kind, 'retained-operation');
    const inspected = response(await client.callTool({ name: 'sgd_inspect', arguments: { ir: join(out, 'automaton.json') } }));
    assert.notEqual(inspected.isError, true, JSON.stringify(inspected.payload));
    const graph = FiniteGraphSchema.parse(inspected.payload);
    assert.deepEqual(graph, JSON.parse(await readFile(join(out, 'automaton.json'), 'utf8')));
    assert.ok(graph.nodes.length > 0, 'inspect still returns the complete IR');

    // Keep the real source and change only one role binding to an unsupported action.
    const badModel = join(root, 'bad-model');
    await mkdir(badModel);
    const original = MachineProjectSchema.parse(JSON.parse(await readFile(project, 'utf8')));
    assert.ok(original.binding.operation);
    await copyFile(join(dirname(project), original.spec), join(badModel, original.spec));
    await copyFile(join(dirname(project), original.config), join(badModel, original.config));
    const invalidProject = join(badModel, 'project.json');
    await writeFile(invalidProject, JSON.stringify({ ...original, binding: {
      ...original.binding, operation: { ...original.binding.operation, failure: 'MissingReportFailure' },
    } }));
    const invalidOut = join(root, 'refused');
    const rejected = response(await client.callTool({ name: 'sgd_build', arguments: { project: invalidProject, jar, out: invalidOut } }));
    assert.equal(rejected.isError, true);
    const failure = z.object({ error: z.string() }).parse(rejected.payload);
    assert.match(failure.error, /TLC207/);
    assert.equal(BuildSummarySchema.safeParse(rejected.payload).success, false);
    await assert.rejects(access(join(invalidOut, 'automaton.json')), { code: 'ENOENT' });
    await assert.rejects(access(join(invalidOut, 'typescript/operation.ts')), { code: 'ENOENT' });
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
