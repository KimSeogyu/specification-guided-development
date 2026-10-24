import { z } from 'zod';

const RecordInput = z.unknown().superRefine((value, context) => {
  if (typeof value === 'object' && value !== null) {
    if (Object.hasOwn(value, '__proto__')) {
      context.addIssue({ code: 'custom', message: '__proto__ is unsupported as a record key' });
    }
    for (const key in value) {
      if (!Object.hasOwn(value, key)) {
        context.addIssue({ code: 'custom', message: 'Inherited enumerable record keys are unsupported' });
        break;
      }
    }
  }
});

/** Refuse keys Zod would omit before validating the record's key schema. */
export function recordSchema<Value extends z.ZodType>(key: z.ZodString, value: Value) {
  return RecordInput.pipe(z.record(key, value));
}
