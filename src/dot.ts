import { createHash } from 'node:crypto';
import { parse, type ASTNode } from '@ts-graphviz/ast';
import type { Automaton, Transition } from './types.js';

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

function attributes(node: ASTNode): Map<string, string> {
  const result = new Map<string, string>();
  for (const child of node.children) {
    if (child.type === 'Attribute') result.set(child.key.value, child.value.value);
  }
  return result;
}

function stateValue(label: string, variable: string): string {
  let decoded = '';
  for (let index = 0; index < label.length; index++) {
    const current = label[index];
    const next = label[index + 1];
    if (current === '\\' && next === '\\') { decoded += '\\'; index++; }
    else if (current === '\\' && (next === 'n' || next === 'l' || next === 'r')) { decoded += '\n'; index++; }
    else decoded += current;
  }
  const lines = decoded.split('\n');
  const matches = lines.map(line => line.trim().replace(/^\/\\\s*/, ''))
    .filter(line => line.startsWith(`${variable} = `));
  const [match] = matches;
  if (matches.length !== 1 || !match) throw new Error(`TLC101: expected one scalar variable ${variable} in node label`);
  const value = match.slice(variable.length + 3).trim();
  if (value.startsWith('"')) {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'string' && parsed.length > 0) return parsed;
  }
  throw new Error(`TLC101: unsupported value for ${variable}. The initial projection profile requires a nonempty string.`);
}

const order = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export function importDot(input: { dot: string; name: string; stateVariable: string }): Automaton {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.stateVariable)) throw new Error('TLC101: invalid state variable');
  const ast = parse(input.dot);
  const graphs = ast.children.filter(node => node.type === 'Graph');
  const [graph] = graphs;
  if (graphs.length !== 1 || !graph?.directed) throw new Error('TLC101: expected one directed TLC graph');
  const nodes = new Map<string, string>();
  const initialIds = new Set<string>();
  const edges: { from: string; event: string; to: string }[] = [];
  function visit(node: ASTNode): void {
    if (node.type === 'Node') {
      const attrs = attributes(node);
      const label = attrs.get('label');
      if (label !== undefined) {
        const value = stateValue(label, input.stateVariable);
        const previous = nodes.get(node.id.value);
        if (previous !== undefined && previous !== value) throw new Error('TLC101: conflicting labels for one node');
        nodes.set(node.id.value, value);
        if (attrs.get('style')?.split(',').map(s => s.trim()).includes('filled')) initialIds.add(node.id.value);
      }
    } else if (node.type === 'Edge') {
      const [from, to] = node.targets;
      const event = attributes(node).get('label');
      if (node.targets.length !== 2 || from.type !== 'NodeRef' || to.type !== 'NodeRef') {
        throw new Error('TLC101: unsupported edge group or edge chain');
      }
      if (!event || /[\r\n]/.test(event)) throw new Error('TLC101: missing action label. Export with -dump dot,actionlabels.');
      edges.push({ from: from.id.value, event, to: to.id.value });
    } else if (node.type === 'Graph' || node.type === 'Subgraph') {
      for (const child of node.children) visit(child);
    }
  }
  visit(graph);
  if (nodes.size === 0 || initialIds.size === 0) throw new Error('TLC101: graph has no labeled initial state');
  const transitions = new Map<string, Transition>();
  for (const edge of edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (from === undefined || to === undefined) throw new Error('TLC101: edge refers to a node without a state label');
    const transition = { from, event: edge.event, to };
    transitions.set(JSON.stringify(transition), transition);
  }
  return {
    version: 1, name: input.name, stateVariable: input.stateVariable,
    states: [...new Set(nodes.values())].sort(order),
    initialStates: [...new Set([...initialIds].map(id => {
      const value = nodes.get(id);
      if (value === undefined) throw new Error('TLC101: initial state is undefined');
      return value;
    }))].sort(order),
    transitions: [...transitions.values()].sort((a, b) => order(JSON.stringify(a), JSON.stringify(b))),
    source: { dotSha256: sha256(input.dot), stateCount: nodes.size, edgeCount: edges.length },
  };
}
