import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { buildProject } from '../src/compiler.js';
import { createServer } from '../src/mcp.js';
import { TlcFailureDiagnosticSchema, TlcFailureError } from '../src/tlc-failure.js';

const jar = process.env.TLA2TOOLS_JAR ? resolve(process.env.TLA2TOOLS_JAR) : undefined;
const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const ResponseSchema = z.object({ error: z.string(), diagnostic: TlcFailureDiagnosticSchema }).strict();
const PlainResponseSchema = z.object({ error: z.string() }).strict();
const model = String.raw`---- MODULE FailureChannels ----
VARIABLE phase
Init == phase = "New"
Advance == /\ phase = "New" /\ phase' = "Done"
Wait == /\ phase = "Done" /\ UNCHANGED phase
Next == Advance \/ Wait
Spec == Init /\ [][Next]_phase
====
`;

async function fixture(root: string): Promise<string> {
  await writeFile(join(root, 'FailureChannels.tla'), model);
  await writeFile(join(root, 'FailureChannels.cfg'), 'SPECIFICATION Spec\n');
  const project = join(root, 'project.json');
  await writeFile(project, JSON.stringify({ version: 2, profile: 'finite-owned', name: 'FailureChannels', spec: 'FailureChannels.tla',
    config: 'FailureChannels.cfg', targets: ['typescript'], binding: { className: 'FailureMachine' } }));
  return project;
}

async function cliFailure(command: string, project: string, out: string, env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  assert.ok(jar);
  try {
    await execute(process.execPath, ['--import', 'tsx', cli, command, '--project', project, '--jar', jar, '--out', out], { env });
  } catch (error) {
    assert.ok(error instanceof Error && 'code' in error && 'stdout' in error && 'stderr' in error);
    assert.equal(error.code, 2);
    assert.equal(error.stdout, '');
    return JSON.parse(String(error.stderr));
  }
  assert.fail('The CLI must preserve its nonzero failure exit.');
}

function toolFailure(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  assert.equal(result.isError, true);
  assert.ok(Array.isArray(result.content) && result.content.length === 1);
  const [content] = result.content;
  assert.ok(content && content.type === 'text' && typeof content.text === 'string');
  return JSON.parse(content.text);
}

test('CLI and MCP preserve genuine spawn failure as unknown without starting Java', { skip: !jar }, async () => {
  assert.ok(jar);
  const root = await mkdtemp(join(tmpdir(), 'sgd-failure-channels-'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: 'sgd-failure-test', version: '1.0.0' });
  const originalPath = process.env.PATH;
  try {
    const project = await fixture(root);
    const emptyPath = join(root, 'empty-bin'); await mkdir(emptyPath);
    const env = { ...process.env, PATH: emptyPath };
    const input = { project, jar, out: join(root, 'generated') };
    // The real execFile call cannot find Java. No replacement executable supplies model evidence.
    process.env.PATH = emptyPath;
    let expected: z.infer<typeof ResponseSchema> | undefined;
    await assert.rejects(buildProject(input), error => {
      assert.ok(error instanceof TlcFailureError);
      assert.ok(error.cause instanceof Error && 'code' in error.cause);
      assert.equal(error.cause.code, 'ENOENT');
      expected = ResponseSchema.parse({ error: error.message, diagnostic: error.diagnostic });
      return true;
    });
    assert.ok(expected);
    assert.deepEqual(expected.diagnostic.failure, { kind: 'unknown', phase: 'sany' });
    assert.equal(expected.diagnostic.counterexample.status, 'not-retained');
    assert.match(expected.diagnostic.nextAction, /not classified/);
    assert.equal(JSON.stringify(expected).includes('tracePath'), false);
    await server.connect(serverTransport); await client.connect(clientTransport);
    for (const command of ['build', 'model']) {
      assert.deepEqual(ResponseSchema.parse(await cliFailure(command, project, input.out, env)), expected);
      for (const detail of ['summary', 'full']) {
        assert.deepEqual(ResponseSchema.parse(toolFailure(await client.callTool({ name: `sgd_${command}`, arguments: { ...input, detail } }))), expected);
      }
    }
    await assert.rejects(access(input.out), { code: 'ENOENT' });

    await writeFile(project, JSON.stringify({ version: 1, name: 'FailureChannels', spec: 'FailureChannels.tla', config: 'FailureChannels.cfg',
      stateVariable: 'phase', targets: ['typescript'], binding: { kind: 'transition', function: 'transition' } }));
    const legacyCli = PlainResponseSchema.parse(await cliFailure('build', project, input.out, env));
    const legacyMcp = PlainResponseSchema.parse(toolFailure(await client.callTool({ name: 'sgd_build', arguments: input })));
    assert.match(legacyCli.error, /^TLC102:/);
    assert.deepEqual(legacyMcp, legacyCli);
    await assert.rejects(access(input.out), { code: 'ENOENT' });
    assert.equal(await readFile(join(root, 'FailureChannels.tla'), 'utf8'), model);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await client.close(); await server.close(); await rm(root, { recursive: true, force: true });
  }
});

test('real CLI and MCP retain typed invariant and parsing failures without publishing authority', { skip: !jar }, async () => {
  assert.ok(jar);
  const root = await mkdtemp(join(tmpdir(), 'sgd-real-failure-channels-'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: 'sgd-real-failure-test', version: '1.0.0' });
  try {
    const project = await fixture(root);
    const out = join(root, 'generated');
    await server.connect(serverTransport); await client.connect(clientTransport);
    for (const [source, config, failure] of [
      [model.replace('====', 'Safe == phase = "Done"\n===='), 'SPECIFICATION Spec\nINVARIANT Safe\n',
        { kind: 'invariant_violation', phase: 'tlc', invariant: 'Safe', evidence: { kind: 'pinned-tlc-message', code: 2107 } }],
      [model.replace('====', 'Safe == phase = "New"\n===='), 'SPECIFICATION Spec\nINVARIANT Safe\n',
        { kind: 'invariant_violation', phase: 'tlc', invariant: 'Safe', evidence: { kind: 'pinned-tlc-message', code: 2110 } }],
      [model.replace('Init ==', 'Init == )'), 'SPECIFICATION Spec\n',
        { kind: 'parse_error', phase: 'sany', evidence: { kind: 'sany-error-summary', stage: 'syntax' } }],
      [model.replace('Init == phase = "New"', 'Init == phase = UndefinedName'), 'SPECIFICATION Spec\n',
        { kind: 'parse_error', phase: 'sany', evidence: { kind: 'sany-error-summary', stage: 'semantic' } }],
    ] satisfies [string, string, z.infer<typeof TlcFailureDiagnosticSchema>['failure']][]) {
      await writeFile(join(root, 'FailureChannels.tla'), source);
      await writeFile(join(root, 'FailureChannels.cfg'), config);
      const cliResponse = ResponseSchema.parse(await cliFailure('build', project, out));
      const mcpResponse = ResponseSchema.parse(toolFailure(await client.callTool({ name: 'sgd_build', arguments: { project, jar, out } })));
      assert.match(cliResponse.error, /^TLC204:/);
      assert.match(mcpResponse.error, /^TLC204:/);
      assert.deepEqual(cliResponse.diagnostic.failure, failure);
      assert.deepEqual(mcpResponse.diagnostic, cliResponse.diagnostic);
      assert.equal(cliResponse.diagnostic.counterexample.status, 'not-retained');
      assert.equal(JSON.stringify(cliResponse.diagnostic).includes('tracePath'), false);
      await assert.rejects(access(out), { code: 'ENOENT' });
    }
  } finally { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
