import { z } from 'zod';
import { recordSchema } from './schema-record.js';
import { FiniteValueSchema, type FiniteValue } from './finite-types.js';
import { sha256 } from './dot.js';

const Identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).refine(name => name !== '__proto__');
const UnicodeString = z.string().refine(value => ![...value].some(character => {
  const code = character.codePointAt(0);
  return code !== undefined && code >= 0xd800 && code <= 0xdfff;
}), 'Expected Unicode scalar values');
export const SymbolicValueSchema = z.union([
  FiniteValueSchema,
  z.object({ kind: z.literal('data'), domain: Identifier, value: UnicodeString }).strict(),
]);
export type SymbolicValue = z.infer<typeof SymbolicValueSchema>;

export const SymbolicExpressionSchema = z.union([
  z.object({ kind: z.literal('literal'), value: FiniteValueSchema }).strict(),
  z.object({ kind: z.literal('state'), variable: Identifier }).strict(),
  z.object({ kind: z.literal('next-state'), variable: Identifier }).strict(),
  z.object({ kind: z.literal('input') }).strict(),
  z.object({ kind: z.literal('input'), parameter: Identifier }).strict(),
]);
export type SymbolicExpression = z.infer<typeof SymbolicExpressionSchema>;
export type SymbolicGuard =
  | { kind: 'boolean'; value: boolean }
  | { kind: 'equal' | 'not-equal'; left: SymbolicExpression; right: SymbolicExpression }
  | { kind: 'member'; value: SymbolicExpression; elements: FiniteValue[] }
  | { kind: 'in-domain'; value: SymbolicExpression; domain: string }
  | { kind: 'and' | 'or'; terms: SymbolicGuard[] }
  | { kind: 'not'; term: SymbolicGuard }
  | { kind: 'implies' | 'equivalent'; left: SymbolicGuard; right: SymbolicGuard };
export const SymbolicGuardSchema: z.ZodType<SymbolicGuard> = z.lazy(() => z.union([
  z.object({ kind: z.literal('boolean'), value: z.boolean() }).strict(),
  z.object({ kind: z.enum(['equal', 'not-equal']), left: SymbolicExpressionSchema, right: SymbolicExpressionSchema }).strict(),
  z.object({ kind: z.literal('member'), value: SymbolicExpressionSchema, elements: z.array(FiniteValueSchema) }).strict(),
  z.object({ kind: z.literal('in-domain'), value: SymbolicExpressionSchema, domain: Identifier }).strict(),
  z.object({ kind: z.enum(['and', 'or']), terms: z.array(SymbolicGuardSchema) }).strict(),
  z.object({ kind: z.literal('not'), term: SymbolicGuardSchema }).strict(),
  z.object({ kind: z.enum(['implies', 'equivalent']), left: SymbolicGuardSchema, right: SymbolicGuardSchema }).strict(),
]));
const SourceSchema = z.object({ module: z.string(), beginLine: z.number().int().positive(), beginColumn: z.number().int().positive(), endLine: z.number().int().positive(), endColumn: z.number().int().positive() }).strict();
const SymbolicProgramHead = {
  kind: z.literal('symbolic-owned'), name: Identifier,
  checkDeadlock: z.boolean(),
  variables: z.array(Identifier).min(1),
};
const SymbolicProgramTail = {
  initial: recordSchema(Identifier, FiniteValueSchema),
  branches: z.array(z.object({
    action: Identifier, guard: SymbolicGuardSchema, updates: recordSchema(Identifier, SymbolicExpressionSchema),
    source: SourceSchema.nullable(),
  }).strict()).min(1),
  invariants: z.array(z.object({ name: Identifier, predicate: SymbolicGuardSchema }).strict()),
  actionProperties: z.array(z.object({ kind: z.literal('square-action'), name: Identifier, predicate: SymbolicGuardSchema }).strict()),
  source: z.object({ semanticSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
};
export const SymbolicModelV1Schema = z.object({
  version: z.literal(1), ...SymbolicProgramHead,
  input: z.object({ parameter: Identifier, domain: Identifier, next: Identifier }).strict(),
  ...SymbolicProgramTail,
}).strict();
export const SymbolicModelV2Schema = z.object({
  version: z.literal(2), ...SymbolicProgramHead,
  inputs: z.array(z.object({ parameter: Identifier, domain: Identifier }).strict()).min(2).max(3),
  next: Identifier,
  ...SymbolicProgramTail,
}).strict();
export const OpaqueSymbolicInputSchema = z.object({ kind: z.literal('opaque'), parameter: Identifier, domain: Identifier }).strict();
export const FiniteSymbolicInputSchema = z.object({
  kind: z.literal('finite'), parameter: Identifier, domain: Identifier,
  values: z.array(FiniteValueSchema).min(1).max(64),
}).strict();
export const SymbolicInputDefinitionSchema = z.discriminatedUnion('kind', [OpaqueSymbolicInputSchema, FiniteSymbolicInputSchema]);
export type SymbolicInputDefinition = z.infer<typeof SymbolicInputDefinitionSchema>;
export const SymbolicModelV3Schema = z.object({
  version: z.literal(3), ...SymbolicProgramHead,
  inputs: z.array(SymbolicInputDefinitionSchema).min(2).max(3),
  next: Identifier,
  ...SymbolicProgramTail,
}).strict();
export const SymbolicModelSchema = z.discriminatedUnion('version', [SymbolicModelV1Schema, SymbolicModelV2Schema, SymbolicModelV3Schema]);
export type SymbolicModelV1 = z.infer<typeof SymbolicModelV1Schema>;
export type SymbolicModelV2 = z.infer<typeof SymbolicModelV2Schema>;
export type SymbolicModelV3 = z.infer<typeof SymbolicModelV3Schema>;
export type SymbolicModel = z.infer<typeof SymbolicModelSchema>;
export type SymbolicProgram = Omit<SymbolicModelV1, 'source'> | Omit<SymbolicModelV2, 'source'> | Omit<SymbolicModelV3, 'source'>;
export type SymbolicInputFrameValue = string | FiniteValue;
export type SymbolicInput = string | Readonly<Record<string, SymbolicInputFrameValue>>;
export function symbolicInputs(model: SymbolicModel): readonly { parameter: string; domain: string }[] {
  if (model.version === 1) return [{ parameter: model.input.parameter, domain: model.input.domain }];
  return model.version === 2 ? model.inputs : model.inputs.map(({ parameter, domain }) => ({ parameter, domain }));
}
export function symbolicInputDefinitions(model: SymbolicModel): readonly SymbolicInputDefinition[] {
  return model.version === 3 ? model.inputs : symbolicInputs(model).map((input): SymbolicInputDefinition => ({ kind: 'opaque', ...input }));
}
export function symbolicFiniteValueKey(value: FiniteValue): string { return JSON.stringify([value.kind, value.value]); }
export function symbolicNext(model: SymbolicModel): string { return model.version === 1 ? model.input.next : model.next; }

export const SymbolicProjectSchema = z.object({
  version: z.literal(3), profile: z.literal('symbolic-owned'), name: Identifier,
  spec: z.string().min(1), config: z.string().min(1),
  targets: z.array(z.literal('typescript')).min(1),
  binding: z.object({ className: z.string().regex(/^[A-Z][A-Za-z0-9]*$/) }).strict(),
}).strict();
export const ProductSymbolicProjectSchema = SymbolicProjectSchema.extend({ version: z.literal(4) }).strict();
export type SymbolicProject = z.infer<typeof SymbolicProjectSchema> | z.infer<typeof ProductSymbolicProjectSchema>;
export interface SymbolicBackendInput { model: SymbolicModel; className: string }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function semanticIdentity(program: SymbolicProgram): string { return sha256(JSON.stringify(canonical(program))); }

export function guardExpressions(guard: SymbolicGuard): SymbolicExpression[] {
  switch (guard.kind) {
    case 'boolean': return [];
    case 'equal': case 'not-equal': return [guard.left, guard.right];
    case 'member': case 'in-domain': return [guard.value];
    case 'and': case 'or': return guard.terms.flatMap(guardExpressions);
    case 'not': return guardExpressions(guard.term);
    case 'implies': case 'equivalent': return [...guardExpressions(guard.left), ...guardExpressions(guard.right)];
  }
}

export function validateSymbolicModel(input: unknown): SymbolicModel {
  const parsed = SymbolicModelSchema.safeParse(input);
  if (!parsed.success) throw new Error(`TLC301: invalid symbolic IR: ${parsed.error.issues.slice(0, 5).map(issue => issue.message).join('; ')}`);
  const model = parsed.data;
  const inputs = symbolicInputDefinitions(model);
  const parameters = new Set(inputs.map(input => input.parameter));
  const domains = new Set(inputs.map(input => input.domain));
  if (parameters.size !== inputs.length || domains.size !== inputs.length) throw new Error('TLC301: symbolic inputs require distinct parameter names and distinct domains');
  const opaqueDomains = new Set(inputs.filter(input => input.kind === 'opaque').map(input => input.domain));
  if (model.version === 3) {
    if (!inputs.some(input => input.kind === 'opaque') || !inputs.some(input => input.kind === 'finite')) throw new Error('TLC301: mixed input IR requires both opaque and finite inputs');
    for (const input of inputs) if (input.kind === 'finite') {
      const keys = input.values.map(symbolicFiniteValueKey);
      if (new Set(input.values.map(value => value.kind)).size !== 1 || new Set(keys).size !== keys.length) throw new Error('TLC301: finite input requires distinct values of one scalar kind');
      if (keys.some((key, index) => index > 0 && key <= (keys[index - 1] ?? key))) throw new Error('TLC301: finite input values must use canonical scalar order');
    }
  }
  const variables = new Set(model.variables);
  if (variables.size !== model.variables.length || model.variables.length > 12) throw new Error('TLC301: symbolic-owned requires 1–12 distinct variables');
  const exactKeys = (record: object): boolean => Object.keys(record).length === variables.size && Object.keys(record).every(name => variables.has(name));
  if (!exactKeys(model.initial)) throw new Error('TLC301: Init must assign every root variable exactly once');
  function checkExpression(expression: SymbolicExpression, nextAllowed: boolean, inputAllowed: boolean): void {
    if ((expression.kind === 'state' || expression.kind === 'next-state') && !variables.has(expression.variable)) throw new Error('TLC301: unknown symbolic state variable');
    if (expression.kind === 'next-state' && !nextAllowed) throw new Error('TLC301: primed expressions are unsupported in executable guards and assignment values');
    if (expression.kind === 'input' && !inputAllowed) throw new Error('TLC301: input is unavailable in an invariant or action property');
    if (expression.kind === 'input') {
      if (model.version === 1 && 'parameter' in expression) throw new Error('TLC301: version 1 input expressions cannot name a parameter');
      if (model.version !== 1 && (!('parameter' in expression) || !parameters.has(expression.parameter))) throw new Error(`TLC301: version ${model.version} input expressions must name a declared parameter`);
    }
  }
  function checkGuard(guard: SymbolicGuard, nextAllowed: boolean, inputAllowed: boolean): void {
    for (const expression of guardExpressions(guard)) checkExpression(expression, nextAllowed, inputAllowed);
    if (guard.kind === 'in-domain' && !opaqueDomains.has(guard.domain)) throw new Error('TLC301: unknown symbolic data domain');
    if (guard.kind === 'member' && new Set(guard.elements.map(element => element.kind)).size > 1) throw new Error('TLC301: finite literal sets require one scalar kind');
    if (guard.kind === 'and' || guard.kind === 'or') guard.terms.forEach(term => checkGuard(term, nextAllowed, inputAllowed));
    if (guard.kind === 'not') checkGuard(guard.term, nextAllowed, inputAllowed);
    if (guard.kind === 'implies' || guard.kind === 'equivalent') { checkGuard(guard.left, nextAllowed, inputAllowed); checkGuard(guard.right, nextAllowed, inputAllowed); }
  }
  for (const branch of model.branches) {
    if (!exactKeys(branch.updates)) throw new Error(`TLC301: ${branch.action} must assign or UNCHANGED every root variable`);
    checkGuard(branch.guard, false, true);
    Object.values(branch.updates).forEach(expression => checkExpression(expression, false, true));
  }
  for (const invariant of model.invariants) checkGuard(invariant.predicate, false, false);
  for (const property of model.actionProperties) checkGuard(property.predicate, true, false);
  if (new Set(model.invariants.map(item => item.name)).size !== model.invariants.length || new Set(model.actionProperties.map(item => item.name)).size !== model.actionProperties.length) throw new Error('TLC301: symbolic property names must be unique');
  const { source: _source, ...program } = model;
  if (semanticIdentity(program) !== model.source.semanticSha256) throw new Error('TLC301: symbolic semantic identity does not match the program');
  return model;
}

export function symbolicModel(program: Omit<SymbolicModelV1, 'source'>): SymbolicModelV1;
export function symbolicModel(program: Omit<SymbolicModelV2, 'source'>): SymbolicModelV2;
export function symbolicModel(program: Omit<SymbolicModelV3, 'source'>): SymbolicModelV3;
export function symbolicModel(program: SymbolicProgram): SymbolicModel;
export function symbolicModel(program: SymbolicProgram): SymbolicModel {
  return validateSymbolicModel({ ...program, source: { semanticSha256: semanticIdentity(program) } });
}
