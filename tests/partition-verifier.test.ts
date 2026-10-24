import assert from 'node:assert/strict';
import test from 'node:test';
import { assertModelRefusal } from '../examples/partition-control/verify-result.mjs';
import { TlcFailureDiagnosticSchema, TlcFailureError, type TlcFailure } from '../src/tlc-failure.js';

const invariant: TlcFailure = { kind: 'invariant_violation', phase: 'tlc', invariant: 'CloseChoice', evidence: { kind: 'pinned-tlc-message', code: 2110 } };
const actionProperty: TlcFailure = { kind: 'action_property_violation', phase: 'tlc', property: 'ConflictSticky', evidence: { kind: 'pinned-tlc-message', code: 2112 } };
const parse = (value: unknown) => TlcFailureDiagnosticSchema.parse(value);
function result(failure: TlcFailure) {
  const error = new TlcFailureError('TLC204: finite model check failed\n@!@!@STARTMSG 2110:1 @!@!@\nInvariant CloseChoice is violated.\n@!@!@ENDMSG 2110 @!@!@', failure);
  return { status: 2, signal: null, error: undefined, stdout: '', stderr: JSON.stringify({ error: error.message, diagnostic: error.diagnostic }) };
}

test('partition mutations require the exact shared invariant or action-property identity', () => {
  for (const expected of [invariant, actionProperty]) {
    assert.deepEqual(assertModelRefusal(result(expected), expected, parse).failure, expected);
  }
  for (const failure of [
    { ...invariant, invariant: 'Other' }, actionProperty,
    { kind: 'unknown', phase: 'tlc' },
    { kind: 'timeout', phase: 'tlc', evidence: { kind: 'owned-deadline' } },
    { kind: 'parse_error', phase: 'sany', evidence: { kind: 'sany-error-summary', stage: 'syntax' } },
  ] satisfies TlcFailure[]) {
    assert.throws(() => assertModelRefusal(result(failure), invariant, parse));
  }
  assert.throws(() => assertModelRefusal(result({ ...actionProperty, property: 'Other' }), actionProperty, parse));
  assert.throws(() => assertModelRefusal(result(invariant), actionProperty, parse));
});

test('partition verifier rejects unrelated process failures and malformed or missing diagnostics', () => {
  const valid = result(invariant);
  for (const changed of [
    { ...valid, status: 0 }, { ...valid, status: 1 }, { ...valid, status: 12 }, { ...valid, status: null },
    { ...valid, signal: 'SIGKILL' }, { ...valid, error: new Error('spawn failure') }, { ...valid, stdout: '{}' },
    { ...valid, stderr: 'Error: Invariant CloseChoice is violated.' },
    { ...valid, stderr: JSON.stringify({ error: 'TLC204: Invariant CloseChoice is violated.' }) },
    { ...valid, stderr: JSON.stringify({ error: 'TLC102: Invariant CloseChoice is violated.', diagnostic: new TlcFailureError('', invariant).diagnostic }) },
    { ...valid, stderr: JSON.stringify({ error: 'TLC204: Invariant CloseChoice is violated.', diagnostic: { schema: 'sgd-tlc-failure-v1', failure: invariant } }) },
  ]) assert.throws(() => assertModelRefusal(changed, invariant, parse));
});
