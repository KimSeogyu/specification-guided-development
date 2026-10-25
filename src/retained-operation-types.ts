import { z } from 'zod';

/** Role names map native operation observations to existing model actions. */
export const RetainedOperationSchema = z.object({
  kind: z.literal('retained-operation'),
  start: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  success: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  failure: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  retainedVariable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
}).strict();
export type RetainedOperation = z.infer<typeof RetainedOperationSchema>;
