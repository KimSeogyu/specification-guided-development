import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FiniteSymbolicInputSchema } from '../src/symbolic-types.js';

function finiteInput(values: unknown) {
  return { kind: 'finite', parameter: 'event', domain: 'Events', values };
}

test('finite input refuses oversized vocabularies before reading invalid scalar values', () => {
  let reads = 0;
  const value = Object.freeze({ kind: 'integer', get value() { reads += 1; return 0; } });
  const descriptor = Object.getOwnPropertyDescriptor(value, 'value');
  const values = Object.freeze(Array.from({ length: 4096 }, () => value));
  const input = finiteInput(values);
  const result = FiniteSymbolicInputSchema.safeParse(input);

  assert.equal(result.success, false);
  if (result.success) return;
  assert.deepEqual(result.error.issues.map(issue => ({ code: issue.code, path: issue.path })), [
    { code: 'too_big', path: ['values'] },
  ]);
  assert.equal(reads, 0);
  assert.deepEqual(input, finiteInput(values));
  assert.equal(input.values, values);
  assert.equal(values.length, 4096);
  assert.ok(values.every(item => item === value));
  assert.deepEqual(Object.getOwnPropertyDescriptor(value, 'value'), descriptor);
});

test('finite input preserves vocabulary boundaries and validates scalars within the bound', () => {
  const values = Array.from({ length: 64 }, (_, index) => ({ kind: 'integer', value: String(index) }));
  assert.deepEqual(FiniteSymbolicInputSchema.parse(finiteInput(values)), finiteInput(values));
  assert.deepEqual(FiniteSymbolicInputSchema.parse(finiteInput(values.slice(0, 1))), finiteInput(values.slice(0, 1)));

  const empty = FiniteSymbolicInputSchema.safeParse(finiteInput([]));
  assert.equal(empty.success, false);
  if (!empty.success) assert.ok(empty.error.issues.some(issue => issue.code === 'too_small' && issue.path.join('.') === 'values'));

  let reads = 0;
  const invalid = { kind: 'integer', get value() { reads += 1; return 0; } };
  const malformed = FiniteSymbolicInputSchema.safeParse(finiteInput([invalid]));
  assert.equal(malformed.success, false);
  if (!malformed.success) assert.ok(malformed.error.issues.some(issue => issue.code === 'invalid_type' && issue.path.join('.') === 'values.0.value'));
  assert.equal(reads, 1);
});
