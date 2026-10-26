import { z } from 'zod';

const Identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const reservedNames = new Set([...Object.getOwnPropertyNames(Object.prototype),
  'read', 'send', 'then', 'prototype', 'toJSON']);
const MethodName = Identifier.refine(name => !reservedNames.has(name), 'Reserved domain method or port name');

/** Bind native port outcomes to existing model actions; these fields add no policy. */
export const DomainOperationSchema = z.object({
  name: MethodName,
  port: MethodName,
  start: Identifier,
  success: Identifier,
  failure: Identifier,
}).strict();
export const DomainBindingSchema = z.object({
  operations: z.array(DomainOperationSchema).min(1),
}).strict();
export type DomainOperation = z.infer<typeof DomainOperationSchema>;
export type DomainBinding = z.infer<typeof DomainBindingSchema>;
