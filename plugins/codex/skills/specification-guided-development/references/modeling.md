# Model architecture and behavior

This guide describes the Specification Guided Development modeling profile.
Use a finite model with a scalar string variable for the selected state.
Keep action names stable because transition bindings use those names.

## Start with the behavior

Write a short contract before the TLA+ module.
Name the operation, its permitted starting states, and its observable result.
List failures that must leave the state unchanged.
Include concurrency or retry behavior when the requirement depends on either.

Model enough state to test the required invariant.
Use finite constants for quantities, actors, and resources.
State the chosen bounds when you report the result.

This small model describes a submission flow:

```tla
---- MODULE Submission ----
VARIABLE state

Init == state = "Draft"

Submit ==
  /\ state = "Draft"
  /\ state' = "Submitted"

Approve ==
  /\ state = "Submitted"
  /\ state' = "Approved"

Wait ==
  /\ state = "Approved"
  /\ UNCHANGED state

Next == Submit \/ Approve \/ Wait

Spec == Init /\ [][Next]_state

TypeOK == state \in {"Draft", "Submitted", "Approved"}
====
```

The TLC configuration selects the specification and its invariant:

```text
SPECIFICATION Spec
INVARIANT TypeOK
```

The terminal `Wait` action makes the final state explicit.
Do not disable deadlock checks only to hide an unexpected terminal state.

The transition project selects the state variable and a source construct:

```json
{
  "version": 1,
  "name": "submission",
  "spec": "Submission.tla",
  "config": "Submission.cfg",
  "stateVariable": "state",
  "targets": ["typescript", "rust"],
  "parent": { "model": "architecture", "state": "Service" },
  "binding": {
    "kind": "transition",
    "function": "transition"
  }
}
```

The source constructs describe edges:

```typescript
transition("Draft", "Submit", "Submitted");
transition("Submitted", "Approve", "Approved");
```

```rust
transition!("Draft", "Submit", "Submitted");
transition!("Submitted", "Approve", "Approved");
```

The following edge is forbidden:

```text
Draft, Approve, Approved
```

The generated checker compares these literal triples with the projected automaton.
Your application still needs runtime state storage, guard checks, and actual behavior tests.
A permitted declaration can accompany an incorrect implementation.

The optional `parent` field links this model to `architecture.Service`.
Visualize both automata to display that containment.
The link does not establish formal refinement.

## Model architecture with the dependency binding

Treat model states as module names.
Treat an observed edge as a permitted direct dependency.
For example, a path through model states `Api`, `Service`, and `Store` permits those adjacent dependencies.
An `Api` to `Store` import fails unless the graph also contains that edge.

Use a separate project with this binding:

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

The binding maps names to relative module paths.
The model supplies allowed edges.
The dependency checker ignores action names.
Imports within one mapped module are permitted.

A dependency edge does not require an application to call both modules at runtime.
A runtime workflow needs a behavior model and implementation checks that cover its execution.
Keep unsupported imports visible instead of silently expanding the claimed coverage.

## Review projection loss

Suppose the full model has `state`, `balance`, and `amount`.
An action permits approval only when `balance >= amount`.
TLC can establish that the finite model obeys the invariant.

If the compiler projects only `state`, the emitted approval edge combines concrete states.
The edge means that approval is possible for some explored balance and amount.
The generated edge check cannot recover the discarded guard.

Choose one of these responses:

- Keep the guard in application code and test the boundary cases.
- Include the relevant distinction in the selected string state.
- Describe the guard as outside the generated check's guarantee.

Adding a state distinction increases the graph size.
Do not hide a large or incomplete exploration by using a smaller model without explaining the changed scope.

## Use the development loop

1. Model a user-visible requirement.
2. Check the finite model with TLC.
3. Inspect and visualize the projected graph.
4. Compile fresh linter source.
5. Implement the feature under the generated checks.
6. Run the linter and native tests.
7. Demonstrate that a forbidden example fails.

When the requirement changes, repeat the loop.
A stale graph or edited generated checker breaks the link to the model.

Preserve the generated output inventory during this loop.
Use an empty output directory before the first generation.
The compiler removes obsolete owned files after target or profile changes.
Use `--check` to detect stale stable artifacts without replacing them.
TLC logs and run receipts are outside the byte comparison.

The repository uses TypeScript 7.0.2 for builds and type checks.
The generated TypeScript checker uses the same native compiler through its unstable sync and AST APIs.
The exact 7.0.2 version pin is required for this integration.
The generated TypeScript checker's emitted `package.json` declares its parser dependencies.
If needed, install those dependencies with `npm install --prefix OUT/typescript`.
Native plugin archives also include the host platform and architecture in their names.
Use a matching archive or package a source checkout on the destination host.
