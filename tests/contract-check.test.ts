import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { compareContractProjects, ContractComparisonError, ContractVerificationError } from '../src/contract-check.js';

import { contractDeclaration as declaration, contractProjectFixture as fixture } from './fixtures/contract-projects.js';

const jar = process.env.TLA2TOOLS_JAR ? resolve(process.env.TLA2TOOLS_JAR) : undefined;
test('real root comparison checks baseline behavior and current composition without claiming independent acceptance', { skip: !jar, timeout: 240_000 }, async () => {
  assert.ok(jar);
  const data = await fixture();
  try {
    const result = await compareContractProjects({ ...data.args, jar });
    assert.equal(result.kind, 'controlled-contract-comparison');
    assert.equal(result.scope, 'model-composition-only');
    assert.equal(result.preservationGate, 'not-established');
    assert.equal(result.independentlySelectedBaseline, 'not-established');
    assert.equal(result.metadata.baseline.scope, 'literal-metadata-wrapper');
    assert.equal(result.metadata.candidate.scope, 'literal-metadata-wrapper');
    assert.deepEqual(result.acceptance.map(value => value.contract).sort(), ['Envelope', 'Payload']);
    assert.deepEqual(result.composition.map(value => value.relation), ['PayloadErasure']);
    for (const item of result.acceptance) {
      assert.ok(item.evidence.properties.invariants.length > 0);
      assert.ok(item.evidence.behavior.checkedCases > 0);
    }
    assert.ok(result.composition[0]?.evidence.checkedCases);
    assert.equal(await readFile(join(data.candidate, 'SystemContracts.tla'), 'utf8'), declaration);
    const config = join(data.candidate, 'payload', 'ManifestWrite.cfg');
    const original = await readFile(config, 'utf8');
    assert.ok(original.includes('PROPERTY StoredStable'));
    await writeFile(config, original.replace('PROPERTY StoredStable', ''));
    await assert.rejects(compareContractProjects({ ...data.args, jar }), error => error instanceof ContractVerificationError &&
      error.diagnostic.owner === 'Payload' && error.diagnostic.stage === 'baseline' && error.message.includes('StoredStable'));
  } finally { await rm(data.root, { recursive: true, force: true }); }
});

test('real root comparison rejects a baseline selector that has no declared obligation', { skip: !jar, timeout: 120_000 }, async () => {
  assert.ok(jar);
  const data = await fixture();
  try {
    await writeFile(join(data.baseline, 'bindings.json'), JSON.stringify({ version: 1, bindings: {
      Undeclared: { language: 'rust', file: 'src/store.rs', symbol: 'Store' },
    } }));
    await assert.rejects(compareContractProjects({ ...data.args, jar }), error => error instanceof ContractComparisonError &&
      error.source === 'baseline' && error.findings.some(finding => finding.kind === 'extra-binding' && finding.id === 'Undeclared'));
  } finally { await rm(data.root, { recursive: true, force: true }); }
});

test('real root comparison refuses required native authority even when both leaf projects remain valid', { skip: !jar, timeout: 120_000 }, async () => {
  assert.ok(jar);
  const data = await fixture();
  try {
    const required = declaration.replace('native |-> <<>>', 'native |-> <<[id |-> "Writer", kind |-> "resource-authority", owner |-> "Envelope", role |-> "Store"]>>');
    await writeFile(join(data.baseline, 'SystemContracts.tla'), required);
    await writeFile(join(data.candidate, 'SystemContracts.tla'), required);
    await assert.rejects(compareContractProjects({ ...data.args, jar }), error => error instanceof ContractComparisonError &&
      error.findings.some(finding => finding.kind === 'missing-binding' && finding.id === 'Writer'));
    await writeFile(join(data.candidate, 'bindings.json'), JSON.stringify({ version: 1, bindings: {
      Writer: { language: 'rust', file: 'src/store.rs', symbol: 'Store' },
    } }));
    await assert.rejects(compareContractProjects({ ...data.args, jar }), error => error instanceof ContractComparisonError &&
      error.findings.some(finding => finding.kind === 'unsupported' && finding.id === 'Writer'));
  } finally { await rm(data.root, { recursive: true, force: true }); }
});
