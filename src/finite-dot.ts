import { sha256 } from './dot.js';
import { FiniteGraphSchema, type ExactFiniteAutomaton, type FiniteValue } from './finite-types.js';
import { decodeTlcLabel, parseTlcDot } from './tlc-dot.js';

const order = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function scalar(value: string): FiniteValue {
  if (value === 'TRUE' || value === 'FALSE') return { kind: 'boolean', value: value === 'TRUE' };
  if (/^(?:0|-?[1-9][0-9]*)$/.test(value)) return { kind: 'integer', value };
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return { kind: 'string', value: parsed };
    } catch { /* Report the supported scalar profile below. */ }
  }
  throw new Error('TLC205: finite-owned variables must be strings, booleans, or exact decimal integers; compound values and model values are unsupported');
}

function valuation(label: string): Record<string, FiniteValue> {
  const entries = decodeTlcLabel(label).split('\n').map(line => {
    const match = /^(?:\/\\\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line.trim());
    const name = match?.[1];
    const value = match?.[2];
    if (!name || value === undefined) throw new Error('TLC205: expected a complete scalar assignment on each full state label line');
    if (name === '__proto__') throw new Error('TLC205: __proto__ is unsupported as a finite-owned variable name');
    return [name, scalar(value)] as const;
  }).sort(([a], [b]) => order(a, b));
  if (new Set(entries.map(([name]) => name)).size !== entries.length) throw new Error('TLC205: duplicate variable in a full state label');
  return Object.fromEntries(entries);
}

/** Keep every concrete valuation; a display projection must never become executable input. */
export function importFiniteDot(input: { dot: string; name: string }): ExactFiniteAutomaton {
  const raw = parseTlcDot(input.dot);
  const concrete = [...raw.nodes].map(([fingerprint, node]) => ({ fingerprint, initial: node.initial, values: valuation(node.label) }))
    .sort((a, b) => order(JSON.stringify(a.values), JSON.stringify(b.values)));
  const first = concrete[0];
  if (!first) throw new Error('TLC205: no concrete states');
  const variables = Object.entries(first.values).map(([name, value]) => ({ name, kind: value.kind }));
  const fingerprints = new Map(concrete.map((node, i) => [node.fingerprint, `s${i}`]));
  const resolve = (fingerprint: string): string => {
    const id = fingerprints.get(fingerprint);
    if (!id) throw new Error('TLC205: edge refers to an unlabeled fingerprint');
    return id;
  };
  const edges = raw.edges.map(edge => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(edge.event)) {
      throw new Error('TLC205: finite-owned-v1 requires named, unparameterized TLA+ actions; do not erase invocation arguments from DOT labels');
    }
    return { from: resolve(edge.from), event: edge.event, to: resolve(edge.to) };
  }).sort((a, b) => order(JSON.stringify(a), JSON.stringify(b)));
  const parsed = FiniteGraphSchema.safeParse({
    version: 1, kind: 'exact-finite', name: input.name, variables,
    nodes: concrete.map((node, i) => ({ id: `s${i}`, values: node.values })),
    initial: concrete.filter(node => node.initial).map(node => resolve(node.fingerprint)).sort(order),
    actions: [...new Set(edges.map(edge => edge.event))].sort(order), edges,
    source: { dotSha256: sha256(input.dot), stateCount: raw.nodes.size, edgeCount: raw.edges.length },
  });
  if (!parsed.success) {
    throw new Error(`TLC205: invalid full-state graph: ${parsed.error.issues.slice(0, 4).map(issue => issue.message).join('; ')}`);
  }
  return parsed.data;
}
