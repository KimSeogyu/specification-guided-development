import { z } from 'zod';
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

export const SymbolicExpressionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: FiniteValueSchema }).strict(),
  z.object({ kind: z.literal('state'), variable: Identifier }).strict(),
  z.object({ kind: z.literal('next-state'), variable: Identifier }).strict(),
  z.object({ kind: z.literal('input') }).strict(),
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
export const SymbolicModelSchema = z.object({
  version: z.literal(1), kind: z.literal('symbolic-owned'), name: Identifier,
  checkDeadlock: z.boolean(),
  variables: z.array(Identifier).min(1),
  input: z.object({ parameter: Identifier, domain: Identifier, next: Identifier }).strict(),
  initial: z.record(Identifier, FiniteValueSchema),
  branches: z.array(z.object({
    action: Identifier, guard: SymbolicGuardSchema, updates: z.record(Identifier, SymbolicExpressionSchema),
    source: SourceSchema.nullable(),
  }).strict()).min(1),
  invariants: z.array(z.object({ name: Identifier, predicate: SymbolicGuardSchema }).strict()),
  actionProperties: z.array(z.object({ kind: z.literal('square-action'), name: Identifier, predicate: SymbolicGuardSchema }).strict()),
  source: z.object({ semanticSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
}).strict();
export type SymbolicModel = z.infer<typeof SymbolicModelSchema>;

export const SymbolicProjectSchema = z.object({
  version: z.literal(3), profile: z.literal('symbolic-owned'), name: Identifier,
  spec: z.string().min(1), config: z.string().min(1),
  targets: z.array(z.enum(['typescript', 'rust'])).min(1),
  binding: z.object({ className: z.string().regex(/^[A-Z][A-Za-z0-9]*$/) }).strict(),
}).strict();
export type SymbolicProject = z.infer<typeof SymbolicProjectSchema>;
export interface SymbolicBackendInput { model: SymbolicModel; className: string }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function semanticIdentity(program: Omit<SymbolicModel, 'source'>): string { return sha256(JSON.stringify(canonical(program))); }

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
  const variables = new Set(model.variables);
  if (variables.size !== model.variables.length || model.variables.length > 12) throw new Error('TLC301: symbolic-owned requires 1–12 distinct variables');
  const exactKeys = (record: object): boolean => Object.keys(record).length === variables.size && Object.keys(record).every(name => variables.has(name));
  if (!exactKeys(model.initial)) throw new Error('TLC301: Init must assign every root variable exactly once');
  function checkExpression(expression: SymbolicExpression, nextAllowed: boolean, inputAllowed: boolean): void {
    if ((expression.kind === 'state' || expression.kind === 'next-state') && !variables.has(expression.variable)) throw new Error('TLC301: unknown symbolic state variable');
    if (expression.kind === 'next-state' && !nextAllowed) throw new Error('TLC301: primed expressions are unsupported in executable guards and assignment values');
    if (expression.kind === 'input' && !inputAllowed) throw new Error('TLC301: input is unavailable in an invariant or action property');
  }
  function checkGuard(guard: SymbolicGuard, nextAllowed: boolean, inputAllowed: boolean): void {
    for (const expression of guardExpressions(guard)) checkExpression(expression, nextAllowed, inputAllowed);
    if (guard.kind === 'in-domain' && guard.domain !== model.input.domain) throw new Error('TLC301: unknown symbolic data domain');
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
  const { source: _source, ...program } = model;
  if (semanticIdentity(program) !== model.source.semanticSha256) throw new Error('TLC301: symbolic semantic identity does not match the program');
  return model;
}

export function symbolicModel(program: Omit<SymbolicModel, 'source'>): SymbolicModel {
  return validateSymbolicModel({ ...program, source: { semanticSha256: semanticIdentity(program) } });
}
