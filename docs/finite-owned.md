# Generate a finite state authority

Use the `finite-owned` profile when the application must obtain its modeled state from generated code. This profile preserves every supported variable in the TLC graph. It generates a TypeScript 7 authority. The older project v1 bindings generate declaration and import diagnostics; they do not own application state.

## Run the example

Use Node.js 22 or later and Java 17. From the repository root:

```sh
npm ci
node scripts/fetch-tlc.mjs
export TLA2TOOLS_JAR="$PWD/.runtime/tla2tools.jar"
npm run build
node dist/cli.js build --project examples/approval/project.json --jar "$TLA2TOOLS_JAR" --out .runtime/approval
node dist/cli.js inspect --ir .runtime/approval/automaton.json
node dist/cli.js visualize --ir .runtime/approval/automaton.json --out .runtime/approval/view
```

The helper explicitly downloads the pinned JAR. The compiler does not download tools. Open `.runtime/approval/view/index.html` to inspect the full concrete states with Pele.

The model contains two states with `phase = "New"`: one has `approved = FALSE`, and the other has `approved = TRUE`. `Submit` is disabled in the first state. `Approve` changes the Boolean without changing the phase. The generated authority keeps these states separate.

The project file selects the executable profile:

```json
{
  "version": 2,
  "profile": "finite-owned",
  "name": "Approval",
  "spec": "Approval.tla",
  "config": "Approval.cfg",
  "targets": ["typescript"],
  "binding": { "className": "ApprovalMachine" }
}
```

`build` verifies the model before generating authority. `compile --dot` rejects this profile because imported DOT does not establish a complete model check. `model` exports the verified IR without language artifacts; it can retain multiple initial states or nondeterministic successors for inspection. Executable generation requires one initial state and one successor per state and action.

## Actual payload retention

For a synchronous fallible operation that must return its original payload, use the optional [retained-operation binding](retained-operation.md). It generates a private payload boundary whose callback outcome selects the model transition. The ordinary named-event API below applies when neither an operation nor a domain binding is configured.

For a TypeScript domain with injected asynchronous ports, use the [domain binding](domain-code.md). It generates named methods that admit a modeled start before calling a port and choose completion from actual fulfillment or rejection. This profile additionally requires Lean 4.35.0 to check the finite port protocol before publication. It cannot be combined with a retained-operation binding.

## TypeScript

Build the generated module:

```sh
npm install --prefix .runtime/approval/typescript
npm run build --prefix .runtime/approval/typescript
```

Use the generated owner as the source of modeled state:

```ts
import { createApprovalMachine, isApprovalMachine } from './dist/machine.js';

const machine = createApprovalMachine();
if (!isApprovalMachine(machine)) throw new Error('Expected the generated owner');

machine.send('Submit');  // { ok: false, reason: 'disabled', state: ... }
machine.send('Approve'); // { ok: true, event: 'Approve', before: ..., after: ... }
machine.send('Submit');  // { ok: true, event: 'Submit', before: ..., after: ... }
const state = machine.read();
```

The current node and revision live in a closure. The facade, its methods, results, and copied snapshots are frozen. Casts, property writes, and edits to a snapshot cannot replace the owner state. The module authenticates its own facades through a private `WeakSet`; a structural copy or Proxy is not a member. Consumers that accept owners from elsewhere must use this authenticator. A TypeScript interface alone is not authentication.

`send` is synchronous. It accepts no callback. Unknown or disabled events return a rejection without changing node or revision. A successful event increments a checked u64 revision, including a modeled self-loop. Reaching the maximum revision causes rejection. Integer model values and revisions use decimal strings without conversion through JavaScript `Number`.

The example's terminal `Wait` is an explicit public self-loop. It succeeds and increments revision while leaving all model variables unchanged. Terminal describes the end of lifecycle state changes, not rejection of every event.

The boundary assumes a trusted JavaScript realm and unchanged generated module. Replacing platform intrinsics or editing the generated implementation is outside that boundary.

## Supported model and execution profile

- All root state variables must have a stable scalar kind across reachable states: string, Boolean, or integer. Empty strings are allowed. Sets, sequences, records, functions, model values, and mixed variable kinds are rejected. Variable names must be ASCII TLA+ identifiers; `__proto__` is excluded. Strings must contain valid Unicode scalar values.
- DOT labels must contain the complete scalar valuation. Canonical node IDs depend on full valuations, not TLC fingerprint ordering. Duplicate equivalent valuations, missing endpoints, unreachable nodes, and inconsistent source counts are rejected.
- Executable actions must be named and unparameterized. The pinned TLC emits action names without arguments, so a simple DOT label does not establish source arity. The controlled build follows SANY definition references and rejects reachable parameterized action applications, including pure helpers applied at action level. State-level predicate helpers remain supported. At least one action must occur in the graph. Events absent from every explored edge are absent from the generated event vocabulary. Use [symbolic-owned](symbolic-owned.md) for supported data parameters.
- Executable generation requires exactly one initial node and a deterministic successor for each enabled node/action pair. It rejects ambiguous choices instead of selecting a successor. Identical repeated edges retain their raw graph count.
- Local modules must be regular `.tla` files in the root module's directory. SANY discovers the `EXTENDS` and `INSTANCE` closure inside an isolated copy. External module paths, symlinks, standard-module shadows, and names that could load pinned native overrides are rejected. Exactly the already verified JAR supplied as `input.jar` may be beside the model; other Java artifacts remain rejected.
- The supported standard-module closure is `Naturals`, `Integers`, `Sequences`, and `FiniteSets`. Other modules are rejected, including `Bags`, which imports `TLC` in the pinned tools. This avoids accepting stateful or random TLC operators as a complete action relation.
- Configuration supports `SPECIFICATION`, or `INIT` and `NEXT`; invariants and properties; `CHECK_DEADLOCK`; and constant `=` assignments of strings, Booleans, nonnegative integers, or homogeneous finite sets of those values. Model-level negative integers are supported when TLC can evaluate them. Configuration operator overrides, graph reductions, constraints, `VIEW`, `ALIAS`, and alternate execution modes are rejected.
- The runner requires the pinned JAR, one worker, fixed fingerprint/seed settings, full `dot,actionlabels` output, a completed model check, and an empty work queue. It isolates the JVM home and module sources, refuses inherited JVM/TLA overrides, and rejects input edits during verification. It removes temporary snapshots after success or failure.

`verification.json` links the project configuration, root and dependency module bytes, TLC configuration, pinned JAR, DOT, and execution mode. `modelRevision` in runtime snapshots identifies the source DOT, not the entire specification text. Use the receipt for source provenance. `build --check` reruns TLC and compares owned artifacts and stable receipt fields.

## Exact guarantee and remaining work

For each generated live owner, its initial node is the configured initial node. Each successful dispatch follows an edge from its actual current concrete node. A rejected dispatch leaves node and revision unchanged. The generated source contains no alternate state setter. The finite graph and model-check result remain subject to TLC's evaluation and fingerprinting behavior.

This is a safety contract for one live object. It does not establish fairness or progress. The factory may create another object at Init. There is no persistent business identity, reset prevention, recovery, restore, transaction, or external-effect contract. No application callback runs during a state commit.

Application binding is still required. Events take no data parameters, and Init is fixed. Model values do not automatically track live database values or input data. An application can maintain unrelated parallel state or call an effect outside the generated owner. This profile does not discover all project files or prove that all application behavior uses the owner. Dashed high-level/low-level visualization links remain structural links, not formal refinement proofs.

## Verification

Build errors use these stable categories:

| ID | Meaning |
| --- | --- |
| `TLC201` | Unsupported TLC configuration |
| `TLC202` | Unsupported tool, environment, or runner setting |
| `TLC203` | Invalid or changed model/project inputs |
| `TLC204` | Failed model check or unsupported executable graph |
| `TLC205` | Invalid or unsupported full-state DOT |
| `TLC206` | Unverified DOT cannot generate authority |

Runtime rejections use `disabled`, `revision-exhausted`, and `unknown-event`.

```sh
TLA2TOOLS_JAR="$PWD/.runtime/tla2tools.jar" npm run check
npm run build
```

Native tests exercise generated TypeScript dispatch, snapshots, privacy, and revision exhaustion. Controlled TLC tests check source changes, configuration rejection, and regeneration.
