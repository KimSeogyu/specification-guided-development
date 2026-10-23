# Model the contract that the application uses

## Own a finite state machine

Use project v2 `finite-owned` when the generated API must control actual modeled state.
The compiler retains every supported state variable in an `exact-finite` automaton.
A node contains a complete concrete valuation, rather than one selected string variable.

The executable profile has these limits:

- Each variable has one scalar type across all nodes: string, boolean, or exact decimal integer.
- TLC finds exactly one initial concrete state.
- Action labels are named, unparameterized TLA+ operators.
- Each concrete node and action has at most one distinct successor.
- Compound values, model values, parameterized action labels, and nondeterministic successors are unsupported.
- Configuration reductions, transformed labels, and operator overrides are unsupported.

Keep local model modules in one flat directory with regular, non-symlink `.tla` files.
The runner discovers the local closure through SANY, checks copied sources, and explores that isolated snapshot.
Do not place Java override artifacts in the model directory.
The supported pinned standard modules are `Naturals`, `Integers`, `Sequences`, and `FiniteSets`.
If a model exceeds this profile, report the limitation instead of projecting away the unsupported state.

Write a short application contract before the model.
Name the state owner, permitted actions, observed results, failure behavior, and finite bounds.
State which application operations use the generated owner.
Concurrency, persistence, and external effects need their own explicit contracts.

This approval model preserves a guard that a phase-only projection loses:

```tla
---- MODULE Approval ----
VARIABLES phase, approved
vars == <<phase, approved>>

Init == /\ phase = "New"
        /\ approved = FALSE

Approve == /\ phase = "New"
           /\ ~approved
           /\ approved' = TRUE
           /\ UNCHANGED phase

Submit == /\ phase = "New"
          /\ approved
          /\ phase' = "Submitted"
          /\ UNCHANGED approved

Wait == /\ phase = "Submitted"
        /\ UNCHANGED vars

Next == Approve \/ Submit \/ Wait
Spec == Init /\ [][Next]_vars

TypeOK == /\ phase \in {"New", "Submitted"}
          /\ approved \in BOOLEAN
ApprovedBeforeSubmission == phase = "Submitted" => approved
====
```

The TLC configuration selects both invariants:

```text
SPECIFICATION Spec
INVARIANTS TypeOK ApprovedBeforeSubmission
```

The executable project selects language targets and the generated type name:

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

Call `sgd_build` with absolute paths to the project, pinned JAR, and output directory.
The equivalent CLI command is:

```sh
node /absolute/plugin/path/scripts/run.mjs build --project /app/model/project.json --jar /tools/tla2tools.jar --out /app/generated
```

Inspect `/app/generated/automaton.json` to review all concrete variables.
The generated `verification.json` records the completed finite run and its source closure.
Do not use `sgd_compile` for v2.
That tool rejects imported DOT as a source of executable authority.

Build the generated TypeScript package before importing its JavaScript:

```sh
npm install --prefix /app/generated/typescript
npm run build --prefix /app/generated/typescript
```

Use the generated owner in application code:

```typescript
import { createApprovalMachine } from "./generated/typescript/dist/machine.js";

const approval = createApprovalMachine();
const rejected = approval.send("Submit");
if (rejected.ok) throw new Error("Submit must require approval");
if (rejected.reason !== "disabled") throw new Error("Unexpected rejection");
const approved = approval.send("Approve");
if (!approved.ok) throw new Error("Approve must succeed at Init");
const submitted = approval.send("Submit");
if (!submitted.ok) throw new Error("Submit must succeed after approval");
```

For Rust, read the generated README for the crate name and add that crate as a path dependency.
Keep the generated library separate from application modules.
Use `ApprovalMachine::new()` and `send(Event)` through that dependency.
`Event::from_model_name` maps exact model action names to typed events.

Both targets expose full copied snapshots through `read()`.
Snapshot values use tagged string, boolean, or integer values.
Integer values and the checked u64 revision serialize as decimal strings.
A successful send returns the before and after snapshots.
A rejected send preserves both the current state and revision.
The TypeScript snapshot and API facade are frozen.
The Rust owner has private fields and returns owned snapshot copies.
Neither target exposes restore or arbitrary-state construction.

The API accepts named events without data parameters.
The generated state begins at Init and changes only through concrete graph edges.
A finite modeled balance does not automatically track a live database balance.
Describe any external data relationship and its checks separately.

The factory still creates a new independent object at Init each time.
Define persistent business identity and restart behavior separately before using the API for a stored entity.
An action receipt does not make a database write or external request atomic.
Do not copy values into a second mutable state object and describe that object as protected by the generated owner.

## Check declared edges with v1

Use project v1 for literal transition diagnostics.
Select a nonempty scalar string state variable for projection.
The model supplies allowed edges, and the binding selects a call or macro name:

```json
{
  "version": 1,
  "name": "submission",
  "spec": "Submission.tla",
  "config": "Submission.cfg",
  "stateVariable": "state",
  "targets": ["typescript", "rust"],
  "parent": { "model": "architecture", "state": "Service" },
  "binding": { "kind": "transition", "function": "transition" }
}
```

The corresponding source constructs declare an edge:

```typescript
transition("Draft", "Submit", "Submitted");
```

```rust
transition!("Draft", "Submit", "Submitted");
```

The checker compares those literal triples with the projected graph.
The declarations do not own runtime state storage or guards.
A permitted declaration can accompany an incorrect direct state assignment.

Suppose the full model has `state`, `balance`, and `amount`.
If approval requires `balance >= amount`, a projection of `state` retains an approval edge for some explored values.
That edge does not enforce the discarded balance guard.
Use finite-owned when the full modeled scalar state fits its executable profile.
Otherwise preserve the limitation and test application guards explicitly.

The optional v1 `parent` links the model to `architecture.Service` for display in Pele.
The link does not establish formal refinement.

## Check module dependencies with v1

Treat model states as module names and observed edges as permitted direct imports.
A path through `Api`, `Service`, and `Store` permits adjacent dependencies.
An `Api` to `Store` import needs its own edge.
Use this binding in a separate v1 architecture project:

```json
{
  "version": 1,
  "name": "architecture",
  "spec": "Architecture.tla",
  "config": "Architecture.cfg",
  "stateVariable": "module",
  "targets": ["typescript", "rust"],
  "binding": {
    "kind": "dependency",
    "modules": {
      "Api": ["src/api"],
      "Service": ["src/service"],
      "Store": ["src/store"]
    }
  }
}
```

The binding maps model names to relative application paths.
The TLA+ model supplies allowed edges.
The dependency checker ignores action names and permits imports within one mapped module.
A permitted import does not establish runtime execution order.
Record the supplied files and syntax exclusions when reporting coverage.

## Regenerate after a requirement change

Update the model and rerun TLC before generating artifacts for a changed requirement.
Check both the permitted behavior and the expected rejection in the actual application integration.
Keep the generated output inventory so regeneration can remove obsolete owned files.
Use `build --check` to compare stable artifacts and stable provenance fields without replacing files.
V1 diagnostic projects also support `compile --check`.
TLC log bytes and volatile run details are outside the byte comparison.

Preserve the exact TypeScript 7.0.2 pin.
Read the generated package's README before native compilation or checker invocation.
Use a native plugin archive that matches the host platform and architecture.
A source checkout is not required beside an installed plugin cache.
Keep native Codex and Claude Code installations independent, and leave global agent configuration unchanged during verification.
