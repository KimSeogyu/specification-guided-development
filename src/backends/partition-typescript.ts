import { validatePartitionPlan } from '../partition-composition.js';
import type { PartitionBackendInput, PartitionPlan } from '../partition-types.js';
import type { RowBindingPlan } from '../row-binding-types.js';
import type { GeneratedFile } from '../types.js';
import { generateOwnedTypeScript } from './owned-typescript.js';
import { generatePrivateRowTypeScript } from './row-typescript.js';

const quoted = (value: string): string => JSON.stringify(value);

function foldDefinition(plan: PartitionPlan, fact: RowBindingPlan['facts'][number], index: number): string {
  const family = plan.contract.families.find(candidate => candidate.name === fact.name);
  if (family === undefined) throw new Error(`PART301: missing family ${fact.name}`);
  const name = fact.name;
  const row = `${name}Row`;
  const closed = `${name}ClosedPartition`;
  const report = `${name}PartitionReport`;
  const key = family.key.map(field => `row[${quoted(field)}]`).join(', ');
  return `
export type ${report} =
  | { readonly kind: 'Write' | 'Noop'; readonly rows: readonly ${row}[]; readonly counts: PartitionCounts; readonly group: PartitionGroup | null }
  | { readonly kind: 'Refused'; readonly original: readonly ${row}[]; readonly conflicts: readonly ${name}Conflict[]; readonly counts: PartitionCounts; readonly group: PartitionGroup | null };
export interface ${name}Conflict { readonly stored: ${row}; readonly rejected: ${row} }
export interface ${closed} {
  readonly [closedBrand]: ${quoted(name)};
  readonly counts: PartitionCounts;
  readonly group: PartitionGroup | null;
  readonly intoReport: (this: ${closed}) => PartitionResult<${report}>;
}
interface ${name}ClosedState {
  readonly controller: PrivateControl;
  readonly report: ${report};
  consumed: boolean;
}
const closed${index} = new WeakMap<object, ${name}ClosedState>();
function key${name}(row: ${row}): readonly bigint[] { return [${key}]; }
function authenticate${name}(value: unknown): ${row} | undefined {
  return typeof value === 'object' && value !== null ? rows${index}.get(value)?.row : undefined;
}
/** Complete authenticated rows enter one private trial; this function grants no filesystem authority. */
export function fold${name}(input: { readonly baseline: readonly ${row}[]; readonly incoming: readonly ${row}[] }): PartitionResult<${closed}> {
  let baseline: readonly ${row}[];
  let incoming: readonly ${row}[];
  try {
    const batch = snapshotBatch(input);
    baseline = snapshotArray(batch.baseline, authenticate${name});
    incoming = snapshotArray(batch.incoming, authenticate${name});
  } catch (error) { return failed(error instanceof PartitionBoundaryError ? error.reason : 'invalid-batch'); }
  let group: PartitionGroup | null = null;
  for (const row of [...baseline, ...incoming]) {
    const time = row[${quoted(family.time)}];
    if (time < 0n) return failed('invalid-calendar');
    const observed = Object.freeze({ symbol: row[${quoted(family.symbol)}], dayIndex: time / 86_400_000_000n });
    if (group === null) group = observed;
    else if (group.symbol !== observed.symbol || group.dayIndex !== observed.dayIndex) return failed('wrong-group');
  }
  const controller = createPrivateControl();
  const owners = new Map<string, { readonly key: readonly bigint[]; readonly owner: ${name}Owner }>();
  // Baseline replay is private and uncounted. A later duplicate baseline key replaces its owner.
  for (const row of baseline) {
    const owner = create${name}Owner();
    const result = owner.write(row);
    if (!result.ok || result.effect !== 'Insert') return failed('row-rejected');
    const key = key${name}(row);
    owners.set(keyIdentity(key), { key, owner });
  }
  let inserted = 0n;
  let unchanged = 0n;
  const conflicts: ${name}Conflict[] = [];
  for (const row of incoming) {
    const key = key${name}(row);
    const identity = keyIdentity(key);
    let entry = owners.get(identity);
    if (entry === undefined) { entry = { key, owner: create${name}Owner() }; owners.set(identity, entry); }
    const before = entry.owner.read().stored;
    const result = entry.owner.write(row);
    if (!result.ok) return failed('row-rejected');
    const observed = controller.send(result.effect);
    if (!observed.ok) return failed('controller-rejected');
    switch (result.effect) {
      case 'Insert': if (inserted === maxCount) return failed('count-overflow'); inserted += 1n; break;
      case 'Same': if (unchanged === maxCount) return failed('count-overflow'); unchanged += 1n; break;
      case 'Clash':
        if (before === null) return failed('broken-binding');
        conflicts.push(Object.freeze({ stored: before, rejected: row }));
        break;
    }
  }
  const step = closeSteps.get(controller.read().nodeId);
  if (step === undefined) return failed('broken-binding');
  const closure = controller.send(step.event);
  if (!closure.ok || closure.after.nodeId !== step.next) return failed('controller-rejected');
  const counts = Object.freeze({ inserted: step.kind === 'Refused' ? 0n : inserted, unchanged });
  let report: ${report};
  switch (step.kind) {
    case 'Write': {
      const rows: ${row}[] = [];
      for (const entry of [...owners.values()].sort((left, right) => compareKeys(left.key, right.key))) {
        const row = entry.owner.read().stored;
        if (row === null) return failed('broken-binding');
        rows.push(row);
      }
      report = Object.freeze({ kind: 'Write', rows: Object.freeze(rows), counts, group });
      break;
    }
    case 'Noop': report = Object.freeze({ kind: 'Noop', rows: baseline, counts, group }); break;
    case 'Refused': report = Object.freeze({ kind: 'Refused', original: baseline, conflicts: Object.freeze(conflicts), counts, group }); break;
  }
  const intoReport = Object.freeze(function(this: unknown): PartitionResult<${report}> {
    if (typeof this !== 'object' || this === null) return failed('invalid-closed');
    const state = closed${index}.get(this);
    if (state === undefined) return failed('invalid-closed');
    if (state.consumed) return failed('already-consumed');
    const consume = consumeSteps.get(state.controller.read().nodeId);
    if (consume === undefined) return failed('broken-binding');
    const result = state.controller.send(consume.event);
    if (!result.ok || result.after.nodeId !== consume.next) return failed('controller-rejected');
    state.consumed = true;
    return succeeded(state.report);
  });
  const closed: ${closed} = Object.freeze<${closed}>({ [closedBrand]: ${quoted(name)}, counts, group, intoReport });
  closed${index}.set(closed, { controller, report, consumed: false });
  return succeeded(closed);
}
`;
}

/** Compile a closed data fold. No report is a persistence permission. */
export function generatePartitionTypeScript(input: PartitionBackendInput): GeneratedFile[] {
  const plan = validatePartitionPlan(input.plan);
  const controlName = `${input.className}Control`;
  const phases = new Map(plan.control.nodes.map(node => [node.id, node.values.phase]));
  const close = plan.control.nodes.flatMap(node => {
    if (node.values.phase?.kind !== 'string' || node.values.phase.value !== 'Open') return [];
    return plan.control.edges.filter(edge => edge.from === node.id && !['Insert', 'Same', 'Clash'].includes(edge.event)).map(edge => {
      const phase = phases.get(edge.to);
      const kind = phase?.kind === 'string' ? phase.value.replace(/^Ready/, '') : '';
      if (!['Write', 'Noop', 'Refused'].includes(kind)) throw new Error('PART301: close edge has no supported result');
      return `  [${quoted(node.id)}, { event: ${quoted(edge.event)}, next: ${quoted(edge.to)}, kind: ${quoted(kind)} }],`;
    });
  });
  const consume = plan.control.edges.filter(edge => {
    const phase = phases.get(edge.from);
    return phase?.kind === 'string' && ['ReadyWrite', 'ReadyNoop', 'ReadyRefused'].includes(phase.value);
  }).map(edge => `  [${quoted(edge.from)}, { event: ${quoted(edge.event)}, next: ${quoted(edge.to)} }],`);
  const imports = `import { create${controlName} as createPrivateControl, type ${controlName} as PrivateControl, type ${controlName}Event as ControlEvent, type ${controlName}NodeId as ControlNode } from './primitive-control.js';`;
  const declarations = `
const closedBrand: unique symbol = Symbol('sgd-closed-partition');
const maxCount = 18446744073709551615n;
export interface PartitionCounts { readonly inserted: bigint; readonly unchanged: bigint }
export interface PartitionGroup { readonly symbol: string; readonly dayIndex: bigint }
export type PartitionFailureReason = 'invalid-batch' | 'invalid-row' | 'invalid-calendar' | 'wrong-group' | 'broken-binding' | 'row-rejected' | 'controller-rejected' | 'count-overflow' | 'invalid-closed' | 'already-consumed';
export type PartitionResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: PartitionFailureReason };
function failed(reason: PartitionFailureReason): { readonly ok: false; readonly reason: PartitionFailureReason } { return Object.freeze({ ok: false, reason }); }
function succeeded<T>(value: T): { readonly ok: true; readonly value: T } { return Object.freeze({ ok: true, value }); }
class PartitionBoundaryError extends Error {
  constructor(readonly reason: 'invalid-batch' | 'invalid-row') { super(reason); }
}
function snapshotBatch(input: unknown): { readonly baseline: unknown; readonly incoming: unknown } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new PartitionBoundaryError('invalid-batch');
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 2 || !keys.includes('baseline') || !keys.includes('incoming')) throw new PartitionBoundaryError('invalid-batch');
  const baseline = Object.getOwnPropertyDescriptor(input, 'baseline');
  const incoming = Object.getOwnPropertyDescriptor(input, 'incoming');
  if (baseline === undefined || incoming === undefined || !('value' in baseline) || !('value' in incoming)) throw new PartitionBoundaryError('invalid-batch');
  return { baseline: baseline.value, incoming: incoming.value };
}
function snapshotArray<T>(input: unknown, authenticate: (value: unknown) => T | undefined): readonly T[] {
  if (!Array.isArray(input)) throw new PartitionBoundaryError('invalid-batch');
  const descriptor = Object.getOwnPropertyDescriptor(input, 'length');
  const length: unknown = descriptor?.value;
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > 4294967295) throw new PartitionBoundaryError('invalid-batch');
  const keys = Reflect.ownKeys(input);
  if (keys.length !== length + 1 || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) throw new PartitionBoundaryError('invalid-batch');
  const copy: T[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(input, index.toString());
    if (item === undefined || !('value' in item)) throw new PartitionBoundaryError('invalid-batch');
    const row = authenticate(item.value);
    if (row === undefined) throw new PartitionBoundaryError('invalid-row');
    copy.push(row);
  }
  return Object.freeze(copy);
}
function keyIdentity(key: readonly bigint[]): string { return key.map(value => part(integer64(value))).join(''); }
function compareKeys(left: readonly bigint[], right: readonly bigint[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]; const b = right[index];
    if (a === undefined || b === undefined) throw new Error('Corrupt generated partition key');
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}
const closeSteps = new Map<ControlNode, { readonly event: ControlEvent; readonly next: ControlNode; readonly kind: 'Write' | 'Noop' | 'Refused' }>([
${close.join('\n')}
]);
const consumeSteps = new Map<ControlNode, { readonly event: ControlEvent; readonly next: ControlNode }>([
${consume.join('\n')}
]);
`;
  const files = generatePrivateRowTypeScript({
    ...plan.row, className: input.className,
  }, { imports, declarations, fact: (fact, index) => foldDefinition(plan, fact, index) });
  const control = generateOwnedTypeScript({ automaton: plan.control, className: controlName }).find(file => file.path === 'machine.ts');
  if (control === undefined) throw new Error('PART301: finite control authority was not generated');
  return files.filter(file => file.path !== 'README.md').map(file => file.path === 'tsconfig.json' ? {
    ...file, content: file.content.replace('"primitive.ts"', '"primitive.ts", "primitive-control.ts"'),
  } : file).concat([
    { path: 'primitive-control.ts', content: control.content },
    { path: 'README.md', content: `# Generated closed partition data fold\n\nFrom this generated TypeScript directory, run \`npm install\` and \`npm run build\`. The private package pins TypeScript 7.0.2; import its row factories and fold functions from \`./dist/machine.js\`. Regenerate after changing original models or application sources.\n\nCreate authenticated complete rows with \`create<Fact>Row(data)\`, then call \`fold<Fact>({ baseline, incoming })\`. Successful results carry the frozen closed handle in \`value\`. Its single-use \`intoReport()\` returns a frozen unbound report in \`value\`. A report is data; it grants no path, writer, resource or persistence permission.\n\nRows must share one exact symbol and nonnegative UTC-microsecond day index. Arrays must be dense own-data arrays without accessors or extra properties. Forged, copied, cross-Fact or cross-module row tokens are refused. Baseline duplicate keys use the last complete row. Write rows use signed i64 tuple order. Noop and Refused retain the original baseline order and duplicates; Refused retains every complete conflict pair and reports inserted zero. Counts use checked u64 bigint arithmetic.\n\nThe row and aggregate authorities stay private to the fold. Close and consume steps come from the admitted complete finite graph. This protects one synchronous trial in a trusted JavaScript realm. It does not authenticate the baseline against disk, establish application-wide coverage, or prove arbitrary collections or persistence.\n` },
  ]);
}
