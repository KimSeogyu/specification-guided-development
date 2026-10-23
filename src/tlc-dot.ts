import { parse, type ASTNode } from '@ts-graphviz/ast';

export interface RawTlcGraph {
  nodes: Map<string, { label: string; initial: boolean }>;
  edges: { from: string; event: string; to: string }[];
}

function attributes(node: ASTNode): Map<string, string> {
  const result = new Map<string, string>();
  for (const child of node.children) {
    if (child.type !== 'Attribute') continue;
    const key = child.key.value;
    const value = child.value.value;
    if (result.has(key) && result.get(key) !== value) throw new Error('TLC205: conflicting DOT attributes');
    result.set(key, value);
  }
  return result;
}

/** The AST has decoded escaped quotes, but retains DOT backslashes. Decode those once. */
export function decodeTlcLabel(label: string): string {
  let decoded = '';
  for (let index = 0; index < label.length; index++) {
    const current = label[index];
    const next = label[index + 1];
    if (current === '\\' && next === '\\') { decoded += '\\'; index++; }
    else if (current === '\\' && (next === 'n' || next === 'l' || next === 'r')) { decoded += '\n'; index++; }
    else decoded += current;
  }
  return decoded;
}

/** Read raw statements rather than a Graphviz graph object: strict DOT can repeat endpoints with different actions. */
export function parseTlcDot(dot: string): RawTlcGraph {
  const ast = (() => {
    try { return parse(dot); }
    catch (error) { throw new Error('TLC205: malformed DOT; supply a complete action-labeled TLC graph', { cause: error }); }
  })();
  const graphs = ast.children.filter(node => node.type === 'Graph');
  const [graph] = graphs;
  if (graphs.length !== 1 || !graph?.directed) throw new Error('TLC205: expected one directed TLC graph');
  const nodes = new Map<string, { label: string; initial: boolean }>();
  const declared = new Set<string>();
  const initial = new Set<string>();
  const edges: RawTlcGraph['edges'] = [];
  function visit(node: ASTNode): void {
    if (node.type === 'Node') {
      declared.add(node.id.value);
      const attrs = attributes(node);
      if (attrs.get('style')?.split(',').map(style => style.trim()).includes('filled')) initial.add(node.id.value);
      const label = attrs.get('label');
      if (label === undefined) return;
      const previous = nodes.get(node.id.value);
      if (previous && previous.label !== label) throw new Error('TLC205: one fingerprint has conflicting full state labels');
      nodes.set(node.id.value, { label, initial: false });
    } else if (node.type === 'Edge') {
      const [from, to] = node.targets;
      if (node.targets.length !== 2 || from?.type !== 'NodeRef' || to?.type !== 'NodeRef') {
        throw new Error('TLC205: edge chains and groups are unsupported');
      }
      const event = attributes(node).get('label');
      if (!event) throw new Error('TLC205: every edge requires an action label; export with -dump dot,actionlabels');
      edges.push({ from: from.id.value, event: decodeTlcLabel(event), to: to.id.value });
    } else if (node.type === 'Graph' || node.type === 'Subgraph') {
      for (const child of node.children) visit(child);
    } else if (node.type === 'AttributeList' && (node.kind === 'Node' || node.kind === 'Edge')) {
      throw new Error('TLC205: inherited node and edge attributes are unsupported');
    }
  }
  visit(graph);
  if (!nodes.size || !initial.size) throw new Error('TLC205: graph has no labeled initial state');
  for (const id of declared) if (!nodes.has(id)) throw new Error('TLC205: declared fingerprint has no full state label');
  for (const id of initial) {
    const node = nodes.get(id);
    if (!node) throw new Error('TLC205: initial fingerprint has no full state label');
    node.initial = true;
  }
  for (const edge of edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) throw new Error('TLC205: edge fingerprint has no full state label');
  }
  return { nodes, edges };
}
