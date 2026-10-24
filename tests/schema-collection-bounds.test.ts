import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RowBindingSchema } from '../src/row-binding-types.js';
import { FiniteSymbolicInputSchema } from '../src/symbolic-types.js';

function rowBinding(pairs: unknown) {
  return {
    version: 1, profile: 'rust-whole-row-v1',
    source: { manifest: 'Cargo.toml', module: 'crate', facts: [{ name: 'Fact', rustPath: 'crate::Fact', metadata: ['source'] }] },
    model: { payloadInput: 'payload', provenanceInput: 'metadata', pairs },
  };
}

function finiteInput(values: unknown) {
  return { kind: 'finite', parameter: 'event', domain: 'Events', values };
}

test('whole-row binding refuses oversized pair lists before reading invalid children', () => {
  let reads = 0;
  const pair = Object.freeze({ get name() { reads += 1; return 0; }, payload: 0, provenance: 0 });
  const descriptor = Object.getOwnPropertyDescriptor(pair, 'name');
  const pairs = Object.freeze(Array.from({ length: 4096 }, () => pair));
  const input = rowBinding(pairs);
  const result = RowBindingSchema.safeParse(input);

  assert.equal(result.success, false);
  if (result.success) return;
  assert.deepEqual(result.error.issues.map(issue => ({ code: issue.code, path: issue.path })), [
    { code: 'too_big', path: ['model', 'pairs'] },
  ]);
  assert.equal(reads, 0);
  assert.deepEqual(input, rowBinding(pairs));
  assert.equal(input.model.pairs, pairs);
  assert.equal(pairs.length, 4096);
  assert.ok(pairs.every(value => value === pair));
  assert.deepEqual(Object.getOwnPropertyDescriptor(pair, 'name'), descriptor);
});

test('whole-row binding preserves the exact pair count and validates children within the bound', () => {
  const selected = { name: 'selected', payload: 'selectedPayload', provenance: 'selectedMetadata' };
  const pairs = [
    selected,
    { name: 'prepared', payload: 'preparedPayload', provenance: 'preparedMetadata' },
  ];
  assert.deepEqual(RowBindingSchema.parse(rowBinding(pairs)), rowBinding(pairs));

  const short = RowBindingSchema.safeParse(rowBinding(pairs.slice(0, 1)));
  assert.equal(short.success, false);
  if (!short.success) assert.ok(short.error.issues.some(issue => issue.code === 'too_small' && issue.path.join('.') === 'model.pairs'));

  let reads = 0;
  const invalid = { get name() { reads += 1; return 0; }, payload: 'preparedPayload', provenance: 'preparedMetadata' };
  const malformed = RowBindingSchema.safeParse(rowBinding([selected, invalid]));
  assert.equal(malformed.success, false);
  if (!malformed.success) assert.ok(malformed.error.issues.some(issue => issue.code === 'invalid_type' && issue.path.join('.') === 'model.pairs.1.name'));
  assert.equal(reads, 1);
});

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
