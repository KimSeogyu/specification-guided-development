import type { DomainBinding } from '../domain-types.js';
import { validateDomainBinding } from '../domain-validation.js';
import type { OwnedBackendInput } from '../finite-types.js';
import type { GeneratedFile } from '../types.js';
import { generateOwnedTypeScript } from './owned-typescript.js';

function literal(value: string): string { return JSON.stringify(value); }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

/** Generate one live domain owner whose injected ports cannot select completion actions. */
export function generateDomainTypeScript(input: OwnedBackendInput & { domain: DomainBinding }): GeneratedFile[] {
  const plan = validateDomainBinding({ automaton: input.automaton, domain: input.domain });
  const base = generateOwnedTypeScript(input);
  const name = input.className;
  const operations = [...plan.operations].sort((left, right) => compare(left.name, right.name));
  const ports = [...new Set(operations.map(operation => operation.port))].sort(compare);
  const portIndex = new Map(ports.map((port, index) => [port, index]));
  const generics = ports.flatMap((_, index) => [`Port${index}Input`, `Port${index}Output`]).join(', ');
  const authenticatedGenerics = ports.flatMap(() => ['never', 'unknown']).join(', ');
  const publicEvents = [...plan.publicEvents].sort(compare);
  const eventType = publicEvents.map(literal).join(' | ') || 'never';
  const portType = (index: number): string => `(input: Port${index}Input) => Port${index}Output | PromiseLike<Port${index}Output>`;
  const portDeclarations = ports.map((port, index) => `  readonly [${literal(port)}]: ${portType(index)};`).join('\n');
  const methodDeclarations = operations.map(operation => {
    const index = portIndex.get(operation.port);
    if (index === undefined) throw new Error('TLC208: domain operation references an unclassified port');
    return `  readonly [${literal(operation.name)}]: (input: Port${index}Input) => Promise<${name}OperationResult<Awaited<Port${index}Output>>>;`;
  }).join('\n');
  const capturePorts = ports.map((port, index) =>
    `  const port${index} = capturePort<Port${index}Input, Port${index}Output>(ports, ${literal(port)});`).join('\n');
  const methods = operations.map(operation => {
    const index = portIndex.get(operation.port);
    if (index === undefined) throw new Error('TLC208: domain operation references an unclassified port');
    return `    [${literal(operation.name)}]: Object.freeze((input: Port${index}Input): Promise<${name}OperationResult<Awaited<Port${index}Output>>> =>\n      invoke(${literal(operation.start)}, ${literal(operation.success)}, ${literal(operation.failure)}, port${index}, input)),`;
  }).join('\n');
  const source = `// Generated domain facade. Regenerate from the verified model and port binding.
// The graph owns admission and state; actual port fulfillment/rejection owns outcome selection.
import { create${name}, type ${name}Event, type ${name}Snapshot, type ${name}DispatchResult } from './internal/machine.js';

export type { ${name}Snapshot } from './internal/machine.js';
export type ${name}PublicEvent = ${eventType};
export type ${name}DomainDispatchResult =
  | { readonly ok: true; readonly event: ${name}PublicEvent; readonly before: ${name}Snapshot; readonly after: ${name}Snapshot }
  | Extract<${name}DispatchResult, { readonly ok: false }>;
type TransitionSuccess = Extract<${name}DispatchResult, { readonly ok: true }>;
type TransitionRejection = Extract<${name}DispatchResult, { readonly ok: false }>;
export type ${name}PortOutcome<Output> =
  | { readonly kind: 'success'; readonly value: Output }
  | { readonly kind: 'failure'; readonly error: unknown };
export type ${name}OperationResult<Output> =
  | { readonly kind: 'success'; readonly value: Output; readonly start: TransitionSuccess; readonly completion: TransitionSuccess }
  | { readonly kind: 'failure'; readonly error: unknown; readonly start: TransitionSuccess; readonly completion: TransitionSuccess }
  | { readonly kind: 'refused'; readonly reason: TransitionRejection['reason']; readonly state: ${name}Snapshot }
  | { readonly kind: 'completion-rejected'; readonly outcome: ${name}PortOutcome<Output>; readonly start: TransitionSuccess; readonly rejection: TransitionRejection };

export interface ${name}Ports<${generics}> {
${portDeclarations}
}
export interface ${name}Domain<${generics}> {
  readonly read: () => ${name}Snapshot;
  readonly send: (event: ${name}PublicEvent) => ${name}DomainDispatchResult;
${methodDeclarations}
}

const publicEvents = new Set<string>(${JSON.stringify(publicEvents)});
const members = new WeakSet<object>();
const maxOperationStartRevision = 18446744073709551613n;

/** Authenticate only this module's facades. This does not validate generic input/output schemas. */
export function is${name}Domain(value: unknown): value is ${name}Domain<${authenticatedGenerics}> {
  return typeof value === 'object' && value !== null && members.has(value);
}

function capturePort<Input, Output>(ports: object, name: string): (input: Input) => Output | PromiseLike<Output> {
  const descriptor = Object.getOwnPropertyDescriptor(ports, name);
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new TypeError('TLC208: domain port ' + name + ' must be an own function-valued data property');
  }
  const candidate: unknown = descriptor.value;
  if (typeof candidate !== 'function') {
    throw new TypeError('TLC208: domain port ' + name + ' must be a function');
  }
  // The callable shape is validated here. Generic argument/result types remain
  // the adapter's static contract; JavaScript cannot infer their domain schemas.
  return candidate as (input: Input) => Output | PromiseLike<Output>;
}

/** Start one distinct, memory-only live domain. Adapter functions are captured before owner creation. */
export function create${name}Domain<${generics}>(ports: ${name}Ports<${generics}>): ${name}Domain<${generics}> {
  if (typeof ports !== 'object' || ports === null || Array.isArray(ports)) {
    throw new TypeError('TLC208: domain ports must be an object with own function-valued data properties');
  }
${capturePorts}
  const machine = create${name}();
  const read = Object.freeze((): ${name}Snapshot => machine.read());
  const send = Object.freeze((event: ${name}PublicEvent): ${name}DomainDispatchResult => {
    if (typeof event !== 'string' || !publicEvents.has(event)) {
      return Object.freeze({ ok: false, reason: 'unknown-event', state: read() });
    }
    const result = machine.send(event);
    return result.ok ? Object.freeze({ ...result, event }) : result;
  });
  const invoke = async <Input, Output>(
    startEvent: ${name}Event, successEvent: ${name}Event, failureEvent: ${name}Event,
    port: (input: Input) => Output | PromiseLike<Output>, input: Input,
  ): Promise<${name}OperationResult<Awaited<Output>>> => {
    const state = read();
    // Reserve both the start and completion revisions before the adapter can run.
    if (BigInt(state.revision) > maxOperationStartRevision) {
      return Object.freeze({ kind: 'refused', reason: 'revision-exhausted', state });
    }
    const start = machine.send(startEvent);
    if (!start.ok) return Object.freeze({ kind: 'refused', reason: start.reason, state: start.state });
    let outcome: ${name}PortOutcome<Awaited<Output>>;
    // Only adapter invocation/await belongs in this catch. A transition failure
    // must never be reclassified as adapter rejection or cause a second completion.
    try {
      const value = await port(input);
      outcome = { kind: 'success', value };
    } catch (error: unknown) {
      outcome = { kind: 'failure', error };
    }
    outcome = Object.freeze(outcome);
    const completion = machine.send(outcome.kind === 'success' ? successEvent : failureEvent);
    if (!completion.ok) return Object.freeze({ kind: 'completion-rejected', outcome, start, rejection: completion });
    if (outcome.kind === 'success') {
      const result: ${name}OperationResult<Awaited<Output>> = { kind: 'success', value: outcome.value, start, completion };
      return Object.freeze(result);
    }
    const result: ${name}OperationResult<Awaited<Output>> = { kind: 'failure', error: outcome.error, start, completion };
    return Object.freeze(result);
  };
  const facade: ${name}Domain<${generics}> = Object.freeze({
    read,
    send,
${methods}
  });
  members.add(facade);
  return facade;
}
`;
  const portRows = operations.map(operation =>
    `| \`${operation.name}\` | \`${operation.port}\` | \`${operation.start}\` | \`${operation.success}\` | \`${operation.failure}\` |`).join('\n');
  const readme = `# Generated TypeScript domain

Import \`create${name}Domain\` and \`is${name}Domain\` from \`./dist/domain.js\`, or from the generated package's root export. Install dependencies with \`npm install\`, then run \`npm run build\`. TypeScript is pinned to 7.0.2.

Pass an object containing these named ports. Each port is an own, function-valued data property. Accessor and inherited properties are refused before the owner is created. Port functions are captured once. Later property replacement does not change an existing domain. Captured functions are invoked without a receiver, so \`this\` is \`undefined\`; bind an adapter explicitly if it needs a receiver.

| Operation method | Injected port | Start action | Fulfillment action | Rejection action |
| --- | --- | --- | --- | --- |
${portRows}

Each method takes one input and returns a Promise. Port-specific input and output types are inferred from the supplied functions. A port may return a value or a PromiseLike. Awaited fulfillment yields \`kind: 'success'\` with the original fulfilled value. A thrown value or rejected promise yields \`kind: 'failure'\` with the exact error, including \`undefined\`. The success or failure transition is selected from that actual outcome; it is never an input to the method.

A disabled start or insufficient revision capacity returns \`kind: 'refused'\` without calling the port. The start transition happens before the port runs. The validated graph allows only that operation's completion actions while it is pending, so ordinary events and competing operation starts cannot advance it. Exactly two revisions are reserved before admission. Under the validated graph and unchanged generated code, completion cannot fail due to admission or revision exhaustion. A defensive \`completion-rejected\` result preserves the observed outcome if that internal contract is violated.

\`read()\` returns a frozen snapshot. \`send(event)\` accepts only ordinary public model events. Operation start, success, and failure events are excluded from its TypeScript type and rejected at runtime even after a cast. The facade, methods, and result wrappers are frozen. The underlying owner is kept in a closure and its module is excluded from package subpath exports. Importing a private file to create another owner cannot modify the instance held by this facade.

\`is${name}Domain\` authenticates this loaded module's facades, excluding copies and proxies. It does not establish generic input/output schemas. Its type for an otherwise unknown facade uses \`never\` operation inputs until a caller supplies an independently justified type. Inputs, fulfilled values, and errors are opaque native values; they are not cloned, serialized, or deeply frozen.

The guarantee covers one memory-only live object in a trusted JavaScript realm with unchanged generated code. The model determines the finite transition policy. Binding fields map existing actions to domain methods and port names; they add no application policy. Input values do not automatically bind model variables or validate live business data.

Adapter fulfillment means the function fulfilled. It does not prove that a physical write, remote request, or other effect succeeded atomically or durably. Correct adapter behavior remains an explicit trust boundary. There is no persistence, restart recovery, application-wide ownership, cancellation, timeout, automatic retry, or progress guarantee. A port that never settles leaves the modeled operation pending. Each factory call creates another independent live domain.
`;
  return [
    ...base.filter(file => file.path === 'machine.ts').map(file => ({ ...file, path: 'internal/machine.ts' })),
    { path: 'domain.ts', content: source },
    { path: 'package.json', content: JSON.stringify({
      name: 'sgd-generated-domain', private: true, type: 'module',
      exports: { '.': { types: './dist/domain.d.ts', import: './dist/domain.js' } },
      scripts: { build: 'node node_modules/typescript/bin/tsc -p tsconfig.json' },
      devDependencies: { typescript: '7.0.2' },
    }, null, 2) + '\n' },
    { path: 'tsconfig.json', content: JSON.stringify({ compilerOptions: {
      target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
      declaration: true, noEmitOnError: true, outDir: 'dist', types: [],
    }, include: ['domain.ts', 'internal/machine.ts'] }, null, 2) + '\n' },
    { path: 'README.md', content: readme },
  ];
}
