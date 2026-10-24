import { z } from 'zod';
import { recordSchema } from './schema-record.js';
import { RowBindingPlanSchema } from './row-binding-types.js';
import type { GeneratedFile } from './types.js';

const Names = z.array(z.string());
const Change = z.enum(['added', 'removed', 'changed']);
const InventoryStatus = z.enum(['compared', 'previous-unavailable']);
const Origin = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('application-source'), artifact: z.string(), field: z.string(), status: InventoryStatus,
    changes: z.array(z.object({ path: z.string(), change: Change }).strict()) }).strict(),
  z.object({ kind: z.literal('model-module'), artifact: z.string(), field: z.string(), status: InventoryStatus,
    changes: z.array(z.object({ name: z.string(), change: Change }).strict()) }).strict(),
]);
const Difference = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inventory'), added: Names, removed: Names }).strict(),
  z.object({ kind: z.literal('missing'), path: z.string() }).strict(),
  z.object({ kind: z.literal('content'), path: z.string() }).strict(),
  z.object({ kind: z.literal('receipt'), path: z.string(), fields: Names }).strict(),
  z.object({ kind: z.literal('invalid-receipt'), path: z.string() }).strict(),
]);
export const StaleOutputDiagnosticSchema = z.object({
  schema: z.literal('sgd-stale-output-v1'), code: z.literal('TLC104'),
  differences: z.array(Difference).min(1), sourceInventories: z.array(Origin),
  generatedSources: z.object({
    status: z.enum(['unchanged', 'changed', 'incomplete', 'not-generated']),
    unchanged: Names, changed: Names, missing: Names, added: Names, removed: Names,
  }).strict(),
  nextAction: z.literal('Review the differences, then explicitly rerun generation without --check. No generated files were updated.'),
}).strict();
export type StaleOutputDiagnostic = z.infer<typeof StaleOutputDiagnosticSchema>;
type OutputDifference = z.infer<typeof Difference>;
type SourceInventory = z.infer<typeof Origin>;
type CheckedFile = { file: GeneratedFile; current: Buffer | null };
const Record = recordSchema(z.string(), z.unknown());
const Sources = RowBindingPlanSchema.shape.sources.superRefine((sources, context) => {
  if (new Set(sources.map(source => source.path)).size !== sources.length) context.addIssue({ code: 'custom', message: 'Duplicate source path' });
});
const Modules = z.array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*\.tla$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1)
  .superRefine((modules, context) => {
    if (new Set(modules.map(module => module.name)).size !== modules.length) context.addIssue({ code: 'custom', message: 'Duplicate module name' });
  });

function parseRecord(bytes: Buffer): z.infer<typeof Record> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const parsed = Record.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
function at(value: unknown, fields: string[]): unknown {
  let result = value;
  for (const field of fields) {
    const record = Record.safeParse(result);
    if (!record.success) return undefined;
    result = record.data[field];
  }
  return result;
}
function changes(before: Map<string, string>, after: Map<string, string>): { identifier: string; change: z.infer<typeof Change> }[] {
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((identifier): { identifier: string; change: z.infer<typeof Change> }[] => {
    if (!before.has(identifier)) return [{ identifier, change: 'added' }];
    if (!after.has(identifier)) return [{ identifier, change: 'removed' }];
    return before.get(identifier) === after.get(identifier) ? [] : [{ identifier, change: 'changed' }];
  });
}

/** Inspect only inventories emitted by known row plans and controlled receipts.
 * These recorded paths are labels. Diagnostics never read files through them.
 */
function origins({ file, current }: CheckedFile): SourceInventory[] {
  const expected = parseRecord(Buffer.from(file.content));
  if (!expected) return [];
  const actual = current === null ? null : parseRecord(current);
  const result: SourceInventory[] = [];
  function selected(fields: string[]): boolean { return file.stableJsonKeys === undefined || (fields[0] !== undefined && file.stableJsonKeys.includes(fields[0])); }
  function sources(fields: string[], previousEnvelopeValid: boolean): void {
    if (!selected(fields)) return;
    const next = Sources.safeParse(at(expected, fields));
    if (!next.success) return;
    const previous = Sources.safeParse(previousEnvelopeValid ? at(actual, fields) : undefined);
    result.push({ kind: 'application-source', artifact: file.path, field: `/${fields.join('/')}`,
      status: previous.success ? 'compared' : 'previous-unavailable',
      changes: previous.success ? changes(new Map(previous.data.map(source => [source.path, source.sha256])), new Map(next.data.map(source => [source.path, source.sha256])))
        .map(({ identifier, change }) => ({ path: identifier, change })) : [] });
  }
  function modules(fields: string[], previousEnvelopeValid: boolean): void {
    if (!selected(fields)) return;
    const next = Modules.safeParse(at(expected, fields));
    if (!next.success) return;
    const previous = Modules.safeParse(previousEnvelopeValid ? at(actual, fields) : undefined);
    result.push({ kind: 'model-module', artifact: file.path, field: `/${fields.join('/')}`,
      status: previous.success ? 'compared' : 'previous-unavailable',
      changes: previous.success ? changes(new Map(previous.data.map(module => [module.name, module.sha256])), new Map(next.data.map(module => [module.name, module.sha256])))
        .map(({ identifier, change }) => ({ name: identifier, change })) : [] });
  }
  if (RowBindingPlanSchema.safeParse(expected).success) {
    sources(['sources'], RowBindingPlanSchema.safeParse(actual).success);
  } else if (expected.kind === 'closed-partition-fold') {
    const next = RowBindingPlanSchema.safeParse(at(expected, ['row', 'plan']));
    if (next.success) sources(['row', 'plan', 'sources'], actual?.kind === expected.kind && RowBindingPlanSchema.safeParse(at(actual, ['row', 'plan'])).success);
  } else if (expected.generation === 'whole-row-authority') {
    sources(['rowBinding', 'sources'], actual?.kind === expected.kind && actual?.profile === expected.profile &&
      actual?.generation === expected.generation && at(actual, ['rowBinding', 'profile']) === 'rust-whole-row-v1');
  } else if (expected.kind === 'controlled-partition-fold') {
    sources(['source'], actual?.kind === expected.kind);
    modules(['control', 'moduleClosure'], actual?.kind === expected.kind);
    modules(['metadata', 'moduleClosure'], actual?.kind === expected.kind);
  }
  if (expected.kind === 'tlc-finite-completed' || expected.kind === 'tlc-symbolic-completed') {
    modules(['moduleClosure'], actual?.kind === expected.kind && actual.profile === expected.profile);
  }
  return result;
}

function firstMessage(difference: OutputDifference): string {
  switch (difference.kind) {
    case 'inventory': return 'generated output set changed';
    case 'missing': return `missing generated file ${difference.path}`;
    case 'content': return `stale generated file ${difference.path}`;
    case 'receipt': return `stale receipt field ${difference.fields[0]} in ${difference.path}`;
    case 'invalid-receipt': return `invalid generated receipt ${difference.path}`;
  }
}
export class StaleOutputError extends Error {
  readonly code = 'TLC104';
  constructor(readonly diagnostic: StaleOutputDiagnostic) {
    const first = diagnostic.differences[0];
    const sourceChanges = diagnostic.sourceInventories.flatMap(origin => origin.kind === 'application-source' ? origin.changes.map(change => change.path) : []);
    super(`TLC104: ${first ? firstMessage(first) : 'generated output is stale'}.` +
      (sourceChanges.length ? ` Recorded application sources changed: ${[...new Set(sourceChanges)].sort().join(', ')}.` : '') +
      ` Generated source bytes: ${diagnostic.generatedSources.status}. ${diagnostic.nextAction}`);
    this.name = 'StaleOutputError';
  }
}

/** Compare the current output against artifacts already generated by this call.
 * Source byte equality is not semantic equivalence or permission to refresh receipts.
 */
export function checkGeneratedOutput({ previous, files }: { previous: string[]; files: CheckedFile[] }): void {
  const wanted = files.map(({ file }) => file.path).sort();
  const before = new Set(previous);
  const after = new Set(wanted);
  const added = wanted.filter(path => !before.has(path));
  const removed = [...before].filter(path => !after.has(path)).sort();
  const differences: OutputDifference[] = added.length || removed.length ? [{ kind: 'inventory', added, removed }] : [];
  const changedFiles = new Set<string>();
  const generatedSources: StaleOutputDiagnostic['generatedSources'] = { status: 'not-generated', unchanged: [], changed: [], missing: [], added: [], removed: [] };
  const sourceFile = (path: string): boolean => /\.(?:rs|tsx?|[cm]?js)$/.test(path);
  generatedSources.added = added.filter(sourceFile);
  generatedSources.removed = removed.filter(sourceFile);
  for (const checked of files) {
    const { file, current } = checked;
    const equal = current !== null && current.equals(Buffer.from(file.content));
    if (sourceFile(file.path)) {
      if (current === null) generatedSources.missing.push(file.path);
      else (equal ? generatedSources.unchanged : generatedSources.changed).push(file.path);
    }
    const start = differences.length;
    if (current === null) differences.push({ kind: 'missing', path: file.path });
    else {
      if (file.stableJsonKeys) {
        const actual = parseRecord(current);
        const expected = Record.parse(JSON.parse(file.content));
        if (actual === null) differences.push({ kind: 'invalid-receipt', path: file.path });
        else {
          const fields = file.stableJsonKeys.filter(key => JSON.stringify(actual[key]) !== JSON.stringify(expected[key]));
          if (fields.length) differences.push({ kind: 'receipt', path: file.path, fields });
        }
      }
      if (!file.volatile && !equal) differences.push({ kind: 'content', path: file.path });
    }
    if (differences.length !== start) changedFiles.add(file.path);
  }
  if (!differences.length) return;
  for (const key of ['unchanged', 'changed', 'missing', 'added', 'removed'] satisfies (keyof Omit<typeof generatedSources, 'status'>)[]) generatedSources[key].sort();
  generatedSources.status = generatedSources.missing.length ? 'incomplete'
    : generatedSources.changed.length || generatedSources.added.length || generatedSources.removed.length ? 'changed'
    : generatedSources.unchanged.length ? 'unchanged' : 'not-generated';
  throw new StaleOutputError(StaleOutputDiagnosticSchema.parse({
    schema: 'sgd-stale-output-v1', code: 'TLC104', differences,
    sourceInventories: files.filter(({ file }) => changedFiles.has(file.path)).flatMap(origins), generatedSources,
    nextAction: 'Review the differences, then explicitly rerun generation without --check. No generated files were updated.',
  }));
}
