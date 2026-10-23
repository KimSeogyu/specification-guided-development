import { z } from 'zod';

function isUnicodeScalarString(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}

const ScalarStringSchema = z.string().refine(isUnicodeScalarString, 'Strings must contain valid Unicode scalar values');
const LabelSchema = z.string().min(1).refine(isUnicodeScalarString, 'Labels must contain valid Unicode scalar values').refine(value => !/[\u0000-\u001f\u007f-\u009f]/u.test(value), 'Labels must not contain control characters');
const VariableNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .refine(value => value !== '__proto__', '__proto__ is unsupported as a finite-owned variable name');
const NodeIdSchema = z.string().regex(/^s[0-9]+$/);

export const FiniteValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('string'), value: ScalarStringSchema }).strict(),
  z.object({ kind: z.literal('boolean'), value: z.boolean() }).strict(),
  z.object({ kind: z.literal('integer'), value: z.string().regex(/^(?:0|-?[1-9][0-9]*)$/) }).strict(),
]);
export type FiniteValue = z.infer<typeof FiniteValueSchema>;

// Zod records drop an own __proto__ key. Reject it before parsing so no graph
// valuation can be silently changed by that library behavior.
const ConcreteValuesSchema = z.unknown().superRefine((value, context) => {
  if (typeof value === 'object' && value !== null && Object.hasOwn(value, '__proto__')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '__proto__ is unsupported as a concrete variable key' });
  }
}).pipe(z.record(z.string(), FiniteValueSchema));
export const FiniteNodeSchema = z.object({ id: NodeIdSchema, values: ConcreteValuesSchema }).strict();
export const FiniteEdgeSchema = z.object({ from: NodeIdSchema, event: LabelSchema, to: NodeIdSchema }).strict();

/** Exact scalar finite IR. TLC import applies a narrower named-action profile.
 * Known actions with no enabled edge and duplicate identical edges are valid.
 * Several initial nodes and nondeterminism can be represented, but not executed.
 */
export const FiniteGraphSchema = z.object({
  version: z.literal(1),
  kind: z.literal('exact-finite'),
  name: LabelSchema,
  variables: z.array(z.object({ name: VariableNameSchema, kind: z.enum(['string', 'boolean', 'integer']) }).strict()).min(1),
  nodes: z.array(FiniteNodeSchema).min(1),
  initial: z.array(NodeIdSchema).min(1),
  actions: z.array(LabelSchema),
  edges: z.array(FiniteEdgeSchema),
  source: z.object({ dotSha256: z.string().regex(/^[a-f0-9]{64}$/), stateCount: z.number().int().positive(), edgeCount: z.number().int().nonnegative() }).strict(),
}).strict().superRefine((graph, context) => {
  const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  const ids = new Set(graph.nodes.map(node => node.id));
  const variables = new Map(graph.variables.map(variable => [variable.name, variable.kind]));
  const actions = new Set(graph.actions);
  if (ids.size !== graph.nodes.length) issue('Duplicate node identity');
  if (variables.size !== graph.variables.length) issue('Duplicate variable identity');
  if (actions.size !== graph.actions.length) issue('Duplicate action identity');
  if (new Set(graph.initial).size !== graph.initial.length) issue('Duplicate initial node identity');
  if (graph.source.stateCount !== graph.nodes.length) issue('Source stateCount does not match concrete nodes');
  if (graph.source.edgeCount !== graph.edges.length) issue('Source edgeCount does not match raw concrete edges');
  if (graph.initial.some(id => !ids.has(id)) || graph.edges.some(edge => !ids.has(edge.from) || !ids.has(edge.to) || !actions.has(edge.event))) {
    issue('Unknown graph identity');
  }
  const valuationKeys = new Set<string>();
  const names = [...variables.keys()].sort();
  for (const node of graph.nodes) {
    if (Object.keys(node.values).length !== variables.size || Object.entries(node.values).some(([name, value]) => variables.get(name) !== value.kind)) {
      issue(`Concrete valuation for ${node.id} does not match its variable schema`);
    }
    const key = JSON.stringify(names.map(name => {
      const value = node.values[name];
      return value === undefined ? null : [name, value.kind, value.value];
    }));
    if (valuationKeys.has(key)) issue(`Duplicate equivalent concrete valuation at ${node.id}`);
    valuationKeys.add(key);
  }
  const successors = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const targets = successors.get(edge.from);
    if (targets === undefined) successors.set(edge.from, [edge.to]);
    else targets.push(edge.to);
  }
  const reachable = new Set(graph.initial);
  const pending = [...graph.initial];
  for (let index = 0; index < pending.length; index++) {
    const node = pending[index];
    if (node === undefined) continue;
    for (const target of successors.get(node) ?? []) {
      if (!reachable.has(target)) { reachable.add(target); pending.push(target); }
    }
  }
  const unreachable = graph.nodes.find(node => !reachable.has(node.id));
  if (unreachable !== undefined) issue(`Unreachable concrete node ${unreachable.id}`);
});
export type ExactFiniteAutomaton = z.infer<typeof FiniteGraphSchema>;

export const MachineProjectSchema = z.object({
  version: z.literal(2),
  profile: z.literal('finite-owned'),
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  spec: z.string().min(1),
  config: z.string().min(1),
  targets: z.array(z.enum(['typescript', 'rust'])).min(1),
  binding: z.object({ className: z.string().regex(/^[A-Z][A-Za-z0-9]*$/) }).strict(),
}).strict();
export type MachineProject = z.infer<typeof MachineProjectSchema>;

export interface OwnedBackendInput {
  automaton: ExactFiniteAutomaton;
  className: string;
}

/** Validate even direct backend calls; a typed argument is not provenance proof. */
export function validateExecutableGraph(input: unknown): ExactFiniteAutomaton {
  const parsed = FiniteGraphSchema.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.issues.slice(0, 8).map(issue => `${issue.path.join('.') || 'graph'}: ${issue.message}`).join('; ');
    throw new Error(`TLC204: invalid exact finite graph: ${details}`);
  }
  const graph = parsed.data;
  if (graph.actions.length === 0) throw new Error('TLC204: finite-owned authority requires at least one named action');
  if (graph.initial.length !== 1) throw new Error('TLC204: finite-owned currently requires exactly one initial state');
  const successors = new Map<string, string>();
  for (const edge of graph.edges) {
    const key = JSON.stringify([edge.from, edge.event]);
    const previous = successors.get(key);
    if (previous !== undefined && previous !== edge.to) throw new Error('TLC204: ambiguous action successors require an explicit supported choice contract');
    successors.set(key, edge.to);
  }
  return graph;
}
