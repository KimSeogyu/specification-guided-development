# Generate a finite state authority

Use the `finite-owned` profile when the application must obtain its modeled state from generated code. This profile preserves every supported variable in the TLC graph. It generates a TypeScript 7 authority or a separate Rust authority crate. The older project v1 bindings generate declaration and import diagnostics; they do not own application state.

This is a development milestone toward [sustainable Parangsae adoption](production-goal.md). It is available in the source checkout. The published v0.1.0 archives contain the earlier diagnostic prototype.

## Run the example

Use Node.js 22 or later, Java 17, and Cargo for the Rust example. From the repository root:

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
  "targets": ["typescript", "rust"],
  "binding": { "className": "ApprovalMachine" }
}
```

`build` verifies the model before generating authority. `compile --dot` rejects this profile because imported DOT does not establish a complete model check. `model` exports the verified IR without language artifacts; it can retain multiple initial states or nondeterministic successors for inspection. Executable generation requires one initial state and one successor per state and action.

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

The boundary assumes a trusted JavaScript realm and unchanged generated module. Replacing platform intrinsics or editing the generated implementation is outside that boundary.

## Rust

Keep the generated crate as a separate dependency. Its generated `README.md` gives the exact Cargo package name and a dependency alias. A consumer uses that alias:

```rust
#![forbid(unsafe_code)]
use authority::{ApprovalMachine, Event};

let mut machine = ApprovalMachine::new();
assert!(machine.send(Event::Submit).is_err());
machine.send(Event::Approve).unwrap();
machine.send(Event::Submit).unwrap();
let snapshot = machine.read();
```

The authority has private node and revision fields. It exposes no mutable state reference, raw-state constructor, `Clone`, `Deserialize`, or restore API. Snapshots are owned copies and may be edited without changing the authority. The generated crate forbids unsafe code. Its contract requires safe Rust callers; a crate attribute cannot forbid unsafe code in another crate. Project-wide caller validation remains future work.

The event enum preserves each original model label through `Event::model_name()`. `Event::from_model_name` rejects unknown labels. Dispatch returns a success receipt or an error that includes an unchanged snapshot. Snapshot JSON has the same fields and tagged scalar values as the TypeScript output.

## Supported model and execution profile

- All root state variables must have a stable scalar kind across reachable states: string, Boolean, or integer. Empty strings are allowed. Sets, sequences, records, functions, model values, and mixed variable kinds are rejected. Variable names must be ASCII TLA+ identifiers; `__proto__` is excluded. Strings must contain valid Unicode scalar values.
- DOT labels must contain the complete scalar valuation. Canonical node IDs depend on full valuations, not TLC fingerprint ordering. Duplicate equivalent valuations, missing endpoints, unreachable nodes, and inconsistent source counts are rejected.
- Executable actions must have named, unparameterized ASCII identifier labels. Invocation arguments are never erased. At least one action must occur in the graph. Events absent from every explored edge are absent from the generated event vocabulary.
- Executable generation requires exactly one initial node and a deterministic successor for each enabled node/action pair. It rejects ambiguous choices instead of selecting a successor. Identical repeated edges retain their raw graph count.
- Local modules must be regular `.tla` files in the root module's directory. SANY discovers the `EXTENDS` and `INSTANCE` closure inside an isolated copy. External module paths, symlinks, standard-module shadows, and names that could load pinned native overrides are rejected.
- The supported standard-module closure is `Naturals`, `Integers`, `Sequences`, and `FiniteSets`. Other modules are rejected, including `Bags`, which imports `TLC` in the pinned tools. This avoids accepting stateful or random TLC operators as a complete action relation.
- Configuration supports `SPECIFICATION`, or `INIT` and `NEXT`; invariants and properties; `CHECK_DEADLOCK`; and constant `=` assignments of strings, Booleans, nonnegative integers, or homogeneous finite sets of those values. Model-level negative integers are supported when TLC can evaluate them. Configuration operator overrides, graph reductions, constraints, `VIEW`, `ALIAS`, and alternate execution modes are rejected.
- The runner requires the pinned JAR, one worker, fixed fingerprint/seed settings, full `dot,actionlabels` output, a completed model check, and an empty work queue. It isolates the JVM home and module sources, refuses inherited JVM/TLA overrides, and rejects input edits during verification. It removes temporary snapshots after success or failure.

`verification.json` links the project configuration, root and dependency module bytes, TLC configuration, pinned JAR, DOT, and execution mode. `modelRevision` in runtime snapshots identifies the source DOT, not the entire specification text. Use the receipt for source provenance. `build --check` reruns TLC and compares owned artifacts and stable receipt fields.

## Exact guarantee and remaining work

For each generated live owner, its initial node is the configured initial node. Each successful dispatch follows an edge from its actual current concrete node. A rejected dispatch leaves node and revision unchanged. The generated source contains no alternate state setter. The finite graph and model-check result remain subject to TLC's evaluation and fingerprinting behavior.

This is a safety contract for one live object. It does not establish fairness or progress. The factory may create another object at Init. There is no persistent business identity, reset prevention, recovery, restore, transaction, or external-effect contract. No application callback runs during a state commit.

Application binding is still required. Events take no data parameters, and Init is fixed. Model values do not automatically track live database values or input data. An application can maintain unrelated parallel state or call an effect outside the generated owner. This milestone does not discover all project files or prove that all application behavior uses the owner. The next milestone must connect Parangsae's actual authority and effect entry points, enforce source coverage, and define persistence and recovery where the selected boundary needs them. Dashed high-level/low-level visualization links remain structural links, not formal refinement proofs.

## Verify the milestone

Build errors use these stable categories:

| ID | Meaning |
| --- | --- |
| `TLC201` | Unsupported TLC configuration |
| `TLC202` | Unsupported tool, environment, or runner setting |
| `TLC203` | Invalid or changed model/project inputs |
| `TLC204` | Failed model check or unsupported executable graph |
| `TLC205` | Invalid or unsupported full-state DOT |
| `TLC206` | Unverified DOT cannot generate authority |

Runtime rejections use `disabled` and `revision-exhausted` in both languages. TypeScript also reports `unknown-event`; Rust rejects unknown labels before constructing an event.

```sh
TLA2TOOLS_JAR="$PWD/.runtime/tla2tools.jar" npm run check
npm run build
```

The tests execute native TypeScript 7 and Cargo consumers, compare every reachable fixture state/action decision with the graph, reject direct state construction and writes, exercise runtime snapshot/reflection attempts, and check overflow rejection. A real TLC integration test compares TypeScript and Rust snapshot traces and changes the TLA+ submission requirement, then regenerates and verifies the changed native behavior. Runner tests exercise configuration rejection, dependency closure, source changes, failure, timeout, and temporary-snapshot cleanup.

The current production goal remains incomplete until the Parangsae application and maintenance workflow meet its acceptance criteria.
