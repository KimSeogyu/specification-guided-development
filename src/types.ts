import { z } from 'zod';
import { recordSchema } from './schema-record.js';

export const TransitionSchema = z.object({ from: z.string(), event: z.string(), to: z.string() }).strict();
export type Transition = z.infer<typeof TransitionSchema>;

export const AutomatonSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  stateVariable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  states: z.array(z.string().min(1)).min(1),
  initialStates: z.array(z.string().min(1)).min(1),
  parent: z.object({ model: z.string().min(1), state: z.string().min(1) }).strict().optional(),
  transitions: z.array(TransitionSchema),
  source: z.object({ dotSha256: z.string(), stateCount: z.number().int(), edgeCount: z.number().int() }).strict(),
}).strict().superRefine((model, context) => {
  const states = new Set(model.states);
  if (states.size !== model.states.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate projected state' });
  if (model.initialStates.some(state => !states.has(state))) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unknown initial state' });
  if (model.transitions.some(edge => !states.has(edge.from) || !states.has(edge.to))) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Transition references an unknown state' });
});
export type Automaton = z.infer<typeof AutomatonSchema>;

const TransitionBindingSchema = z.object({
  kind: z.literal('transition'),
  function: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('transition'),
}).strict();
const DependencyBindingSchema = z.object({
  kind: z.literal('dependency'),
  modules: recordSchema(z.string(), z.array(z.string().min(1)).min(1)),
}).strict();
export const BindingSchema = z.discriminatedUnion('kind', [TransitionBindingSchema, DependencyBindingSchema]);
export type Binding = z.infer<typeof BindingSchema>;

export const ProjectSchema = z.object({
  version: z.literal(1),
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  spec: z.string().min(1),
  config: z.string().min(1),
  stateVariable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  targets: z.array(z.enum(['typescript', 'rust'])).min(1),
  parent: z.object({ model: z.string().min(1), state: z.string().min(1) }).strict().optional(),
  binding: BindingSchema,
}).strict();
export type Project = z.infer<typeof ProjectSchema>;
export type Target = Project['targets'][number];
export interface GeneratedFile { path: string; content: string; volatile?: boolean; stableJsonKeys?: string[] }
export interface BackendInput { automaton: Automaton; binding: Binding }
export interface Diagnostic { ruleId: string; file: string; line: number; column: number; message: string }
