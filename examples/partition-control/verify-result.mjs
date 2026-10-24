import assert from 'node:assert/strict';

// Use the running SDK's diagnostic schema. This verifier does not parse TLC console output.
export function assertModelRefusal(result, expected, parseDiagnostic) {
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(result.error, undefined, `Compiler process failed: ${result.error?.message ?? ''}\n${output}`);
  assert.equal(result.signal, null, `Compiler process was interrupted: ${result.signal}\n${output}`);
  assert.equal(result.status, 2, `Expected a checked compiler refusal.\n${output}`);
  assert.equal(result.stdout, '', `A refused compiler invocation wrote success output.\n${output}`);
  const response = JSON.parse(result.stderr);
  assert.equal(typeof response.error, 'string');
  assert.match(response.error, /^TLC204:/, `Failure was not the model-check gate.\n${output}`);
  const diagnostic = parseDiagnostic(response.diagnostic);
  assert.deepEqual(diagnostic.failure, expected, `The intended property did not expose the mutation.\n${output}`);
  return diagnostic;
}
