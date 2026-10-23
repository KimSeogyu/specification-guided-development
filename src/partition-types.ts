import { z } from 'zod';
import { FiniteGraphSchema } from './finite-types.js';
import { RowBindingPlanSchema, RowBindingSchema } from './row-binding-types.js';
import { SymbolicModelV2Schema } from './symbolic-types.js';

const Identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).refine(value => value !== '__proto__');
const ClassName = z.string().regex(/^[A-Z][A-Za-z0-9]*$/);
const Reference = z.object({ project: z.string().min(1) }).strict();

export const PartitionProjectSchema = z.object({
  version: z.literal(6), profile: z.literal('partition-fold'), name: Identifier,
  application: z.string().min(1), targets: z.array(z.enum(['typescript', 'rust'])).min(1),
  models: z.object({
    row: Reference, control: Reference,
    families: z.object({ spec: z.string().min(1), operator: Identifier }).strict(),
  }).strict(),
  binding: z.object({
    className: ClassName,
    rustCrateMode: z.enum(['standalone', 'workspace']).default('standalone'),
  }).strict(),
}).strict();
export type PartitionProject = z.infer<typeof PartitionProjectSchema>;

export const PartitionContractSchema = z.object({
  version: z.literal(1), calendar: z.literal('utc-micros-nonnegative-day-v1'),
  families: z.array(z.object({
    name: Identifier, key: z.array(Identifier).min(1).max(3), symbol: Identifier, time: Identifier,
    datasets: z.array(z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)).min(1),
  }).strict()).min(1),
}).strict().superRefine((contract, context) => {
  const issue = (message: string): void => context.addIssue({ code: z.ZodIssueCode.custom, message });
  if (new Set(contract.families.map(family => family.name)).size !== contract.families.length) issue('Family names must be distinct');
  const datasets = contract.families.flatMap(family => family.datasets);
  if (new Set(datasets).size !== datasets.length) issue('Dataset names must be distinct across families');
  for (const family of contract.families) {
    if (new Set(family.key).size !== family.key.length) issue('Key fields must be distinct');
  }
});
export type PartitionContract = z.infer<typeof PartitionContractSchema>;
export type PartitionFamily = PartitionContract['families'][number];

/** A checked data-fold plan. This discriminant grants no filesystem authority. */
export const PartitionPlanSchema = z.object({
  version: z.literal(1), kind: z.literal('closed-partition-fold'),
  runtimeProfile: z.literal('unbound-partition-v1'),
  contract: PartitionContractSchema,
  row: z.object({ model: SymbolicModelV2Schema, binding: RowBindingSchema, plan: RowBindingPlanSchema }).strict(),
  control: FiniteGraphSchema,
}).strict();
export type PartitionPlan = z.infer<typeof PartitionPlanSchema>;
export interface PartitionBackendInput {
  plan: PartitionPlan;
  className: string;
  rustCrateMode: 'standalone' | 'workspace';
}
