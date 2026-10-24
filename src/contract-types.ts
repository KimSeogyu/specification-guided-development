import { z } from 'zod';
import { recordSchema } from './schema-record.js';
import { SymbolicErasureBindingSchema } from './symbolic-refinement.js';

const Identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).refine(value => value !== '__proto__');
const Location = z.string().min(1);
export const ContractScopeSchema = z.enum(['model-composition', 'application']);

export const ContractRelationSchema = z.object({
  id: Identifier, kind: z.literal('enabled-input-erasure'), upper: Identifier, lower: Identifier,
  variables: SymbolicErasureBindingSchema.shape.variables,
  inputs: SymbolicErasureBindingSchema.shape.inputs,
  actions: SymbolicErasureBindingSchema.shape.actions,
}).strict();
export type ContractRelation = z.infer<typeof ContractRelationSchema>;

export const NativeContractObligationSchema = z.object({
  id: Identifier,
  kind: z.enum(['native-owner', 'observation-origin', 'resource-authority', 'source-closure', 'scheduling', 'persistence']),
  owner: Identifier, role: Identifier,
}).strict();
export type NativeContractObligation = z.infer<typeof NativeContractObligationSchema>;

/** Required TLA declarations. These values establish no semantic or native evidence. */
export const ContractDeclarationsSchema = z.object({
  version: z.literal(1), scope: ContractScopeSchema,
  contracts: z.array(Identifier).min(1).max(128),
  relations: z.array(ContractRelationSchema).max(256),
  native: z.array(NativeContractObligationSchema).max(256),
}).strict().superRefine((declarations, context) => {
  const issue = (message: string): void => context.addIssue({ code: 'custom', message });
  const contracts = new Set(declarations.contracts);
  if (contracts.size !== declarations.contracts.length) issue('Contract identities must be unique');
  if (new Set(declarations.relations.map(relation => relation.id)).size !== declarations.relations.length) issue('Relation identities must be unique');
  if (new Set(declarations.native.map(obligation => obligation.id)).size !== declarations.native.length) issue('Native obligation identities must be unique');
  for (const relation of declarations.relations) {
    if (!contracts.has(relation.upper) || !contracts.has(relation.lower)) issue(`Relation ${relation.id} references an undeclared contract`);
  }
  for (const obligation of declarations.native) {
    if (!contracts.has(obligation.owner)) issue(`Native obligation ${obligation.id} references an undeclared owner`);
  }
});
export type ContractDeclarations = z.infer<typeof ContractDeclarationsSchema>;

export const ContractModelReferencesSchema = recordSchema(Identifier, z.object({ project: Location }).strict());
export const ContractProjectSchema = z.object({
  version: z.literal(1), profile: z.literal('contract-system'),
  root: z.object({ spec: Location, operator: Identifier }).strict(),
  models: ContractModelReferencesSchema, bindings: Location,
}).strict();
export type ContractProject = z.infer<typeof ContractProjectSchema>;

export const ContractNativeSelectorSchema = z.object({
  language: z.enum(['typescript', 'rust']), file: Location, symbol: Location,
}).strict();
export const ContractBindingsSchema = z.object({
  version: z.literal(1), bindings: recordSchema(Identifier, ContractNativeSelectorSchema),
}).strict();
export type ContractBindings = z.infer<typeof ContractBindingsSchema>;

export type ContractObligation =
  | { kind: 'model-verification'; contract: string }
  | { kind: 'baseline-properties'; contract: string }
  | { kind: 'baseline-behavior'; contract: string }
  | { kind: 'enabled-input-erasure'; relation: ContractRelation }
  | { kind: 'native'; declaration: NativeContractObligation }
  | { kind: 'application-coverage'; scope: 'application' };

export type ContractClosureFinding =
  | { kind: 'missing-contract'; contract: string }
  | { kind: 'missing-obligation'; obligation: 'relation' | 'native'; id: string }
  | { kind: 'changed-obligation'; obligation: 'relation' | 'native'; id: string }
  | { kind: 'changed-scope'; expected: ContractDeclarations['scope']; actual: ContractDeclarations['scope'] }
  | { kind: 'missing-model-reference'; contract: string }
  | { kind: 'extra-model-reference'; contract: string }
  | { kind: 'extra-binding'; id: string }
  | { kind: 'missing-binding'; id: string; owner: string; role: string }
  | { kind: 'unsupported'; obligation: 'native' | 'application-coverage'; id: string; detail: string };

export interface ContractClosure {
  kind: 'required-contract-obligations';
  scope: ContractDeclarations['scope'];
  obligations: ContractObligation[];
  findings: ContractClosureFinding[];
  semanticVerification: 'not-performed';
  sourceProvenance: 'not-established';
  independentlySelectedBaseline: 'not-established';
}
