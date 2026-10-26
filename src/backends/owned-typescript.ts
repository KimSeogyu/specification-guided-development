import { validateExecutableGraph, type OwnedBackendInput, type FiniteValue } from '../finite-types.js';
import type { GeneratedFile } from '../types.js';

function literal(value: string): string { return JSON.stringify(value); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function frozenValue(value: FiniteValue): string {
  return `Object.freeze(${JSON.stringify(value)})`;
}

/** Generate a per-live-object authority from a verified, exact finite graph. */
export function generateOwnedTypeScript(input: OwnedBackendInput): GeneratedFile[] {
  const graph = validateExecutableGraph(input.automaton);
  if (!/^[A-Z][A-Za-z0-9]*$/.test(input.className)) throw new Error('TLC204: className must be an uppercase TypeScript identifier');
  const name = input.className;
  const variables = [...graph.variables].sort((a, b) => compare(a.name, b.name));
  const nodes = [...graph.nodes].sort((a, b) => compare(a.id, b.id));
  const actions = [...graph.actions].sort(compare);
  const initial = graph.initial[0];
  if (initial === undefined) throw new Error('TLC204: finite-owned requires an initial state');
  const nodeEntries = nodes.map(node => `  [${literal(node.id)}, Object.freeze({\n${variables.map(variable => {
    const value = node.values[variable.name];
    if (value === undefined) throw new Error(`TLC204: missing concrete value for ${variable.name}`);
    return `    [${literal(variable.name)}]: ${frozenValue(value)},`;
  }).join('\n')}\n  })],`).join('\n');
  const edgeEntries = nodes.map(node => {
    const edges = [...new Map(graph.edges.filter(edge => edge.from === node.id).map(edge => [edge.event, edge.to])).entries()]
      .sort(([a], [b]) => compare(a, b));
    return `  [${literal(node.id)}, new Map<string, ${name}NodeId>([${edges.map(([event, to]) => `[${literal(event)}, ${literal(to)}]`).join(', ')}])],`;
  }).join('\n');
  const copies = variables.map(variable => `      [${literal(variable.name)}]: Object.freeze({ ...values[${literal(variable.name)}] }),`).join('\n');
  const source = `// Generated finite-owned authority. Regenerate from the verified TLA+ model; do not edit.
// Scope: one live object, exact finite graph, synchronous dispatch, trusted JavaScript realm.
export type ${name}FiniteValue =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'integer'; readonly value: string };
export type ${name}Event = ${actions.map(literal).join(' | ')};
export type ${name}NodeId = ${nodes.map(node => literal(node.id)).join(' | ')};
export interface ${name}Values {
${variables.map(variable => `  readonly [${literal(variable.name)}]: Extract<${name}FiniteValue, { readonly kind: ${literal(variable.kind)} }>;`).join('\n')}
}
export interface ${name}Snapshot {
  readonly model: ${literal(graph.name)};
  readonly modelRevision: ${literal(graph.source.dotSha256)};
  readonly nodeId: ${name}NodeId;
  readonly revision: string;
  readonly values: ${name}Values;
}
export type ${name}DispatchResult =
  | { readonly ok: true; readonly event: ${name}Event; readonly before: ${name}Snapshot; readonly after: ${name}Snapshot }
  | { readonly ok: false; readonly reason: 'disabled' | 'unknown-event' | 'revision-exhausted'; readonly state: ${name}Snapshot };
export interface ${name} {
  readonly read: () => ${name}Snapshot;
  readonly send: (event: ${name}Event) => ${name}DispatchResult;
}

const nodes = new Map<${name}NodeId, ${name}Values>([
${nodeEntries}
]);
const transitions = new Map<${name}NodeId, globalThis.Map<string, ${name}NodeId>>([
${edgeEntries}
]);
const events = new Set<string>(${JSON.stringify(actions)});
const members = new WeakSet<object>();
const maxRevision = 18446744073709551615n;

function snapshot(nodeId: ${name}NodeId, revision: bigint): ${name}Snapshot {
  const values = nodes.get(nodeId);
  if (values === undefined) throw new Error('Corrupt generated finite-owned graph');
  return Object.freeze({
    model: ${literal(graph.name)},
    modelRevision: ${literal(graph.source.dotSha256)},
    nodeId,
    revision: revision.toString(),
    values: Object.freeze({
${copies}
    }),
  });
}

/** Recognize only facades created by this loaded module instance. Proxies and copies are not owners. */
export function is${name}(value: unknown): value is ${name} {
  return typeof value === 'object' && value !== null && members.has(value);
}

/** Start a new live object. Persistent identity, restart, restore and effects require a separate contract. */
export function create${name}(): ${name} {
  let nodeId: ${name}NodeId = ${literal(initial)};
  let revision = 0n;
  const read = Object.freeze((): ${name}Snapshot => snapshot(nodeId, revision));
  const send = Object.freeze((event: ${name}Event): ${name}DispatchResult => {
    if (typeof event !== 'string' || !events.has(event)) {
      return Object.freeze({ ok: false, reason: 'unknown-event', state: read() });
    }
    const successor = transitions.get(nodeId)?.get(event);
    if (successor === undefined) return Object.freeze({ ok: false, reason: 'disabled', state: read() });
    if (revision === maxRevision) return Object.freeze({ ok: false, reason: 'revision-exhausted', state: read() });
    const before = read();
    const nextRevision = revision + 1n;
    const after = snapshot(successor, nextRevision);
    const result: ${name}DispatchResult = Object.freeze({ ok: true, event, before, after });
    nodeId = successor;
    revision = nextRevision;
    return result;
  });
  const facade: ${name} = Object.freeze({ read, send });
  members.add(facade);
  return facade;
}
`;
  return [
    { path: 'machine.ts', content: source },
    { path: 'package.json', content: JSON.stringify({
      name: 'sgd-generated-finite-owner', private: true, type: 'module',
      scripts: { build: 'node node_modules/typescript/bin/tsc -p tsconfig.json' }, devDependencies: { typescript: '7.0.2' },
    }, null, 2) + '\n' },
    { path: 'tsconfig.json', content: JSON.stringify({ compilerOptions: {
      target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
      declaration: true, noEmitOnError: true, outDir: 'dist', types: [],
    }, include: ['machine.ts'] }, null, 2) + '\n' },
    { path: 'README.md', content: `# Generated finite-owned TypeScript authority\n\nInstall dependencies with \`npm install\`, then run \`npm run build\`. TypeScript is pinned to 7.0.2. Import \`create${name}\` and \`is${name}\` from \`./dist/machine.js\`. Call \`read()\` for a frozen copied snapshot, and \`send(event)\` for a frozen success or rejection. Only a permitted edge from the exact current concrete node can advance state. A rejection preserves both state and revision. Integer values and the u64 revision use decimal strings without JavaScript Number conversion.\n\nThe \`modelRevision\` identifies the source DOT. The factory creates a new live object at the model's initial state. Snapshots cannot restore or replace authority. \`is${name}\` authenticates only objects created by this loaded module instance; a structurally equivalent object or Proxy is not an owner.\n\nThis contract protects one live object in a trusted JavaScript realm. It does not establish persistent entity identity, safe restart or restore, effect atomicity, liveness, application-wide coverage, or behavior outside this finite graph. Creating another object is allowed. Treat the generated module and JavaScript intrinsics as trusted; changing generated source or replacing platform intrinsics is outside this boundary.\n` },
  ];
}
