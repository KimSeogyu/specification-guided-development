import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createServer } from '../src/mcp.js';
import { contractDeclaration, contractProjectFixture } from './fixtures/contract-projects.js';

const execute = promisify(execFile);
const cli = resolve('src/cli.ts');
const jar = process.env.TLA2TOOLS_JAR ? resolve(process.env.TLA2TOOLS_JAR) : undefined;
const Summary = z.object({
  schema: z.literal('sgd-contract-comparison-summary-v1'),
  scope: z.literal('model-composition-only'),
  preservationGate: z.literal('not-established'), independentlySelectedBaseline: z.literal('not-established'),
  operation: z.enum(['generate', 'check']),
  verification: z.object({ invocation: z.literal('completed'), freshInvocationLogRetained: z.boolean() }),
  evidence: z.object({ index: z.string(), logs: z.object({ freshness: z.enum(['current-invocation', 'retained-output']) }) }),
});
function toolResult(value: unknown) {
  const result = z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.literal('text'), text: z.string() })) }).parse(value);
  const first = result.content[0]; assert.ok(first);
  const payload: unknown = JSON.parse(first.text);
  return { isError: result.isError, payload };
}

test('contract command rejects authority flags and MCP rejects relative paths before reading inputs', async () => {
  const data = await contractProjectFixture();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(); const client = new Client({ name: 'contract-arguments', version: '1.0.0' });
  await server.connect(serverTransport);
  try {
    const out = join(data.root, 'must-not-exist');
    await assert.rejects(execute(process.execPath, ['--import', 'tsx', cli, 'check-contracts', '--approved', 'true']), error =>
      error instanceof Error && 'code' in error && error.code === 2 && 'stderr' in error && String(error.stderr).includes('Unknown option --approved'));
    await client.connect(clientTransport);
    const tool = (await client.listTools()).tools.find(tool => tool.name === 'sgd_check_contracts');
    assert.ok(tool);
    assert.deepEqual([...(tool.inputSchema.required ?? [])].sort(), ['baseline', 'jar', 'out', 'project']);
    for (const args of [
      { project: 'relative.json', baseline: data.args.baseline, jar: '/absent.jar', out },
      { ...data.args, jar: '/absent.jar', out, approved: true },
    ]) {
      const result = await client.callTool({ name: 'sgd_check_contracts', arguments: args });
      assert.equal(result.isError, true);
      assert.doesNotMatch(JSON.stringify(result.content), /ENOENT/);
      await assert.rejects(access(out), { code: 'ENOENT' });
    }
  } finally { await client.close(); await server.close(); await rm(data.root, { recursive: true, force: true }); }
});

test('real CLI generation and MCP check preserve scoped evidence and retained logs; failed checks repair nothing', { skip: !jar, timeout: 240_000 }, async () => {
  assert.ok(jar);
  const data = await contractProjectFixture();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(); const client = new Client({ name: 'contract-evidence', version: '1.0.0' });
  await server.connect(serverTransport);
  try {
    const out = join(data.root, 'output');
    const args = ['--import', 'tsx', cli, 'check-contracts', '--project', data.args.project, '--baseline', data.args.baseline, '--jar', jar, '--out', out];
    const generated = await execute(process.execPath, args, { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    const summary = Summary.parse(JSON.parse(generated.stdout));
    assert.equal(summary.operation, 'generate');
    assert.equal(summary.evidence.logs.freshness, 'current-invocation');
    assert.equal(summary.verification.freshInvocationLogRetained, true);
    await access(summary.evidence.index);
    const index = z.object({ contracts: z.array(z.object({ source: z.enum(['baseline', 'candidate']), id: z.string(), path: z.string() })) }).parse(JSON.parse(await readFile(summary.evidence.index, 'utf8')));
    const payload = index.contracts.find(entry => entry.source === 'candidate' && entry.id === 'Payload');
    assert.ok(payload);
    const log = join(out, dirname(payload.path), 'tlc.log');
    const originalLog = await readFile(log);
    await utimes(log, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
    const before = await stat(log);
    await client.connect(clientTransport);
    const checked = toolResult(await client.callTool({ name: 'sgd_check_contracts', arguments: { ...data.args, jar, out, check: true } }));
    assert.notEqual(checked.isError, true, JSON.stringify(checked.payload));
    const checkSummary = Summary.parse(checked.payload);
    assert.equal(checkSummary.operation, 'check');
    assert.equal(checkSummary.evidence.logs.freshness, 'retained-output');
    assert.equal(checkSummary.verification.freshInvocationLogRetained, false);
    assert.deepEqual(await readFile(log), originalLog);
    assert.equal((await stat(log)).mtimeMs, before.mtimeMs);
    const report = join(out, 'comparison.json');
    const edited = (await readFile(report, 'utf8')) + '\n';
    await writeFile(report, edited);
    await assert.rejects(execute(process.execPath, [...args, '--check'], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }), error =>
      error instanceof Error && 'code' in error && error.code === 2 && 'stderr' in error && String(error.stderr).includes('sgd-stale-output-v1'));
    assert.equal(await readFile(report, 'utf8'), edited);
    await writeFile(join(data.candidate, 'SystemContracts.tla'), contractDeclaration.replace('native |-> <<>>',
      'native |-> <<[id |-> "Writer", kind |-> "resource-authority", owner |-> "Envelope", role |-> "Store"]>>'));
    const refused = toolResult(await client.callTool({ name: 'sgd_check_contracts', arguments: { ...data.args, jar, out } }));
    assert.equal(refused.isError, true);
    const error = z.object({ diagnostic: z.object({ schema: z.literal('sgd-contract-failure-v1'), ruleId: z.literal('TLC312'),
      findings: z.array(z.object({ kind: z.string() })) }) }).parse(refused.payload);
    assert.ok(error.diagnostic.findings.some(finding => finding.kind === 'missing-binding'));
    assert.equal(await readFile(report, 'utf8'), edited);
  } finally { await client.close(); await server.close(); await rm(data.root, { recursive: true, force: true }); }
});
