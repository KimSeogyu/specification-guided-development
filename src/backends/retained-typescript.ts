import { generateOwnedTypeScript } from './owned-typescript.js';
import { validateRetainedOperation, type RetainedOperationInput } from '../retained-operation.js';
import type { GeneratedFile } from '../types.js';

/** Keep the exact payload alongside the observed outcome of one synchronous operation. */
export function generateRetainedTypeScript(input: RetainedOperationInput): GeneratedFile[] {
  validateRetainedOperation(input);
  const files = generateOwnedTypeScript(input);
  const name = input.className;
  const operation = input.operation;
  const source = `// Generated retained operation. Regenerate from the verified TLA+ model.
import { create${name}, type ${name}DispatchResult, type ${name}Snapshot } from './machine.js';

export type OperationResult<R, E> =
  | { readonly ok: true; readonly value: R }
  | { readonly ok: false; readonly error: E };
export type OperationObservation<R, E> =
  | { readonly kind: 'returned'; readonly outcome: OperationResult<R, E> }
  | { readonly kind: 'threw'; readonly error: unknown }
  | { readonly kind: 'invalid-result'; readonly returned: unknown };
export type TransitionRejection = Extract<${name}DispatchResult, { readonly ok: false }>;
export type FinalizationStatus<R, E> =
  | { readonly kind: 'refused'; readonly rejection: TransitionRejection }
  | { readonly kind: 'completed'; readonly observation: OperationObservation<R, E> }
  | { readonly kind: 'transition-rejected'; readonly observation: OperationObservation<R, E>; readonly rejection: TransitionRejection };
export interface Finalized<T, R, E> {
  readonly payload: () => Readonly<T>;
  readonly status: () => FinalizationStatus<R, E>;
  readonly snapshot: () => ${name}Snapshot;
}

const members = new WeakSet<object>();
/** Authentication covers this loaded module's results, not caller-supplied payload contents. */
export function isFinalized(value: unknown): value is Finalized<unknown, unknown, unknown> {
  return typeof value === 'object' && value !== null && members.has(value);
}

function capture<T, R, E>(payload: T, writer: (payload: Readonly<T>) => OperationResult<R, E>): OperationObservation<R, E> {
  try {
    const returned: unknown = writer(payload);
    if (typeof returned !== 'object' || returned === null) return Object.freeze({ kind: 'invalid-result', returned });
    const prototype = Object.getPrototypeOf(returned);
    if (prototype !== Object.prototype && prototype !== null) return Object.freeze({ kind: 'invalid-result', returned });
    const keys = Reflect.ownKeys(returned);
    const ok = Object.getOwnPropertyDescriptor(returned, 'ok');
    if (ok === undefined || !('value' in ok) || typeof ok.value !== 'boolean') {
      return Object.freeze({ kind: 'invalid-result', returned });
    }
    const key = ok.value ? 'value' : 'error';
    if (keys.length !== 2 || !keys.includes('ok') || !keys.includes(key)) return Object.freeze({ kind: 'invalid-result', returned });
    const item = Object.getOwnPropertyDescriptor(returned, key);
    if (item === undefined || !('value' in item)) return Object.freeze({ kind: 'invalid-result', returned });
    // Generic values are opaque: the callback's static signature supplies R and E.
    // Descriptor reads admit data properties only and never invoke result getters.
    const value: unknown = item.value;
    const outcome: OperationResult<R, E> = ok.value
      ? Object.freeze({ ok: true, value: value as R })
      : Object.freeze({ ok: false, error: value as E });
    return Object.freeze({ kind: 'returned', outcome });
  } catch (error: unknown) {
    return Object.freeze({ kind: 'threw', error });
  }
}

/** One synchronous attempt. Both normal outcomes and callback failures retain the same payload. */
export function finalize<T, R, E>(payload: T, writer: (payload: Readonly<T>) => OperationResult<R, E>): Finalized<T, R, E> {
  const machine = create${name}();
  const started = machine.send(${JSON.stringify(operation.start)});
  let status: FinalizationStatus<R, E>;
  if (!started.ok) {
    status = Object.freeze({ kind: 'refused', rejection: started });
  } else {
    const observation = capture(payload, writer);
    const success = observation.kind === 'returned' && observation.outcome.ok;
    const completed = machine.send(success ? ${JSON.stringify(operation.success)} : ${JSON.stringify(operation.failure)});
    status = completed.ok
      ? Object.freeze({ kind: 'completed', observation })
      : Object.freeze({ kind: 'transition-rejected', observation, rejection: completed });
  }
  const state = machine.read();
  const result: Finalized<T, R, E> = Object.freeze({
    payload: Object.freeze(() => payload),
    status: Object.freeze(() => status),
    snapshot: Object.freeze(() => state),
  });
  members.add(result);
  return result;
}
`;
  return [
    ...files.map(file => {
      if (file.path === 'tsconfig.json') {
        return { ...file, content: JSON.stringify({ compilerOptions: {
          target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
          noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
          declaration: true, noEmitOnError: true, outDir: 'dist', types: [],
        }, include: ['machine.ts', 'operation.ts'] }, null, 2) + '\n' };
      }
      if (file.path === 'README.md') return { ...file, content: `# Generated retained operation\n\nImport \`finalize\` and \`isFinalized\` from \`./dist/operation.js\`. Call \`finalize(payload, writer)\` with a synchronous writer that returns \`{ok: true, value}\` or \`{ok: false, error}\`. The initial model action admits the attempt. The wrapper derives the completion action from the actual callback result. Refusal invokes no callback. Success, failure, a thrown callback, and an invalid result all return the same payload reference alongside separate status and the complete model snapshot. No automatic retry occurs.\n\nThe facade and status discriminants are frozen. Result getters are not invoked. Payload, error, and success values are opaque and retain their identities. A callback receives a shallow readonly view. This does not prevent aliases, nested writes, interior mutation, or changes made by the callback itself. This wrapper does not freeze, clone, serialize, or validate domain payloads.\n\nAsync callbacks are unsupported. The wrapper does not await promises or establish cancellation of asynchronous effects. A promise is an invalid callback result; callers must not start asynchronous work. The private underlying machine belongs to this finalization. Importing the separately emitted machine can create unrelated owners, but cannot access this instance. A trusted JavaScript realm with unchanged intrinsics is required. Caller truthfulness about writer success, crash durability, deliberate disposal, process exit, application coverage, and enclosing-model refinement remain outside this guarantee.\n\nTypeScript is pinned to 7.0.2. Run \`npm install\` and \`npm run build\`.\n` };
      return file;
    }),
    { path: 'operation.ts', content: source },
  ];
}
