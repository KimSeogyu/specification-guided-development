import { z } from 'zod';

const Identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).refine(value => value !== '__proto__');
const RustPath = z.string().regex(/^crate(?:::[A-Za-z_][A-Za-z0-9_]*)*$/);
const RelativePath = z.string().min(1).refine(value => !value.startsWith('/') && !value.includes('\\') && !value.split('/').some(part => part === '..' || part === '' || part === '.'));
const GetterChain = z.array(Identifier).max(4);
export const RowCodecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('i64'), getters: GetterChain }).strict(),
  z.object({ kind: z.literal('u32'), getters: GetterChain }).strict(),
  z.object({ kind: z.literal('bool'), getters: GetterChain }).strict(),
  z.object({ kind: z.literal('string'), getters: GetterChain }).strict(),
  z.object({ kind: z.literal('enum'), getters: GetterChain, rustPath: RustPath, variants: z.array(Identifier).min(1) }).strict(),
]);
export type RowCodec = z.infer<typeof RowCodecSchema>;
export const RowBindingSchema = z.object({
  version: z.literal(1), profile: z.literal('rust-whole-row-v1'),
  source: z.object({
    manifest: RelativePath, module: RustPath,
    facts: z.array(z.object({ name: Identifier, rustPath: RustPath, metadata: z.array(Identifier).min(1) }).strict()).min(1),
  }).strict(),
  model: z.object({
    payloadInput: Identifier, provenanceInput: Identifier,
    pairs: z.array(z.object({ name: Identifier, payload: Identifier, provenance: Identifier }).strict()).length(2),
  }).strict(),
}).strict();
export type RowBinding = z.infer<typeof RowBindingSchema>;

export const RowBindingPlanSchema = z.object({
  version: z.literal(1), profile: z.literal('rust-whole-row-v1'), crateName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/),
  sources: z.array(z.object({ path: RelativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1),
  facts: z.array(z.object({
    name: Identifier, rustPath: RustPath,
    fields: z.array(z.object({
      name: Identifier, rustType: z.string().min(1), codec: RowCodecSchema,
      payload: z.boolean(), provenance: z.boolean(),
      classes: z.array(z.array(z.number().int().min(0).max(4294967295)).min(2)).optional(),
    }).strict()).min(1),
  }).strict()).min(1),
}).strict().superRefine((plan, context) => {
  const issue = (message: string): void => context.addIssue({ code: z.ZodIssueCode.custom, message });
  if (new Set(plan.sources.map(source => source.path)).size !== plan.sources.length) issue('Source paths must be unique');
  if (new Set(plan.facts.map(fact => fact.name)).size !== plan.facts.length || new Set(plan.facts.map(fact => fact.rustPath)).size !== plan.facts.length) issue('Fact types must be distinct');
  for (const fact of plan.facts) {
    if (new Set(fact.fields.map(field => field.name)).size !== fact.fields.length) issue('Field names must be unique');
    for (const field of fact.fields) {
      if (!field.payload && !field.provenance) issue('Every field must belong to payload or provenance');
      if (field.classes) {
        if (field.codec.kind !== 'u32' || !field.payload || !field.provenance || field.classes.length === 0) issue('A finite quotient must preserve the raw u32 field in provenance');
        const values = field.classes.flat();
        if (new Set(values).size !== values.length) issue('Finite quotient classes must be disjoint and contain distinct values');
      }
      if (field.codec.kind === 'enum' && new Set(field.codec.variants).size !== field.codec.variants.length) issue('Enum variants must be distinct');
    }
  }
});
export type RowBindingPlan = z.infer<typeof RowBindingPlanSchema>;

export const RowProjectSchema = z.object({
  version: z.literal(5), profile: z.literal('row-owned'), name: Identifier,
  spec: z.string().min(1), config: z.string().min(1), application: z.string().min(1),
  targets: z.array(z.enum(['typescript', 'rust'])).min(1),
  binding: z.object({
    className: z.string().regex(/^[A-Z][A-Za-z0-9]*$/), row: RowBindingSchema,
    rustCrateMode: z.enum(['standalone', 'workspace']).default('standalone'),
  }).strict(),
}).strict();
export type RowProject = z.infer<typeof RowProjectSchema>;
