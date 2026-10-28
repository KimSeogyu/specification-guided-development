# Model the contract that the application uses

## Own data-bound equality/copy behavior with v3

Select project v3 `symbolic-owned` for actions that compare and copy one opaque input value.
The public API accepts actual immutable Unicode string identities.
Generated guards choose the model action, rather than accepting a caller-selected action name.

This profile supports one bounded input domain and 1–12 root state variables.
Use one scalar input binder in `Next` and pass that input directly to each named action.
Configure the finite witness domain with at least two distinct TLC model values.
Use scalar literals or scalar sets for other configured constants.
The grammar supports equality, inequality, scalar-set membership, input-domain membership, and Boolean predicates.
Each action assigns or leaves unchanged every variable exactly once.
Assignment values can be scalar literals, the input, or values copied from the old state.
All assignments take effect simultaneously.

Init assigns scalar literals to every state variable.
Runtime values distinguish scalar strings, booleans, exact decimal integers, and domain-tagged data atoms.
A model string `"none"` and input data whose text is `none` are different values.
The runtime uses exact string equality without Unicode normalization.
The TypeScript API rejects unpaired surrogate code units.

The compiler reads strict SANY semantic XML and rejects unsupported executable operators or incomplete updates.
Top-level assumptions, module instances, and proofs are outside this source profile.
Arithmetic, object fields, hashing, arbitrary collections, custom equality callbacks, and multiple input domains are unsupported.
Configured properties are limited to supported square-action safety properties such as `[][P]_vars`.
This grammar does not establish liveness or fairness.

The fact-merge example stores the first input, leaves the slot unchanged for equal input, and records a different input without replacing the stored value:

```tla
------------------------------ MODULE ManifestWrite ------------------------------

EXTENDS Integers

CONSTANTS Values

VARIABLES phase, stored, rejected

vars == <<phase, stored, rejected>>

Init ==
  /\ phase = "absent"
  /\ stored = "none"
  /\ rejected = "none"

Insert(v) ==
  /\ phase = "absent"
  /\ v \in Values
  /\ phase' = "present"
  /\ stored' = v
  /\ rejected' = "none"

Same(v) ==
  /\ phase \in {"present", "conflict"}
  /\ v = stored
  /\ UNCHANGED vars

Clash(v) ==
  /\ phase \in {"present", "conflict"}
  /\ v \in Values
  /\ v # stored
  /\ phase' = "conflict"
  /\ rejected' = v
  /\ UNCHANGED stored

Next ==
  \E v \in Values:
    \/ Insert(v)
    \/ Same(v)
    \/ Clash(v)

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ phase \in {"absent", "present", "conflict"}
  /\ (phase = "absent") <=> (stored = "none")
  /\ phase = "conflict" => (rejected \in Values /\ rejected # stored)
  /\ phase = "present" => rejected = "none"
  /\ phase = "absent" => rejected = "none"
  /\ stored = "none" \/ stored \in Values

ConflictKeepsStored ==
  phase = "conflict" => stored \in Values

StoredStable ==
  [][stored # "none" => stored' = stored]_vars

=============================================================================
```

The finite TLC instance uses model-value atoms, not string literals:

```text
SPECIFICATION Spec
CONSTANT Values = {v1, v2}

INVARIANT TypeOK
INVARIANT ConflictKeepsStored
PROPERTY StoredStable
```

The witness importer represents these atoms as domain-tagged data values.
The atoms are separate from scalar strings with the same spelling.
This finite configuration checks the configured instance.
Two configured atoms alone do not prove behavior for arbitrary runtime values.

The project selects semantic compilation and the generated owner name:

```json
{
  "version": 3,
  "profile": "symbolic-owned",
  "name": "ManifestWrite",
  "spec": "ManifestWrite.tla",
  "config": "ManifestWrite.cfg",
  "targets": ["typescript"],
  "binding": {
    "className": "FactMachine"
  }
}
```

Run `sgd_model` for finite model review without generating an owner.
For v3, its output includes `automaton.json` as a `symbolic-witness`, `semantic.xml`, and lowered `symbolic-model.json`.
`verification.json` records `generation: "model-only"` and no orbit result.
Model-only mode does not run the independent input oracle or validate all equality/copy orbits.

Run `sgd_build` to generate executable artifacts.
The executable build requires these separate checks:

1. A controlled, completed TLC run over the configured finite model and source snapshot.
2. Semantic lowering from strict SANY XML into the supported symbolic grammar.
3. An independent TLC oracle over every reachable configured state/input pair, using the original TLA+ action bodies.
4. Equality/copy orbit validation over existing data identities and one fresh identity, with the configured invariants, supported action properties, and deadlock setting.

The pinned TLC DOT action labels omit argument identities.
Never infer parameter guards or caller permissions from those labels alone.
The independent input oracle compares the selected action and complete successor with the lowered relation.
Executable output includes `input-verification.json`, `input-oracle.dot`, and `orbit-proof.json` in addition to the finite witness and symbolic IR.

The orbit result relies on the accepted equality/copy grammar, where consistent atom renaming preserves behavior.
It covers immutable string identities under that grammar.
It is not an arbitrary-domain TLC proof for unrestricted TLA+ or application objects.
The compiler respects configured `CHECK_DEADLOCK`, invariants, and supported square-action properties.
Do not disable a check merely to hide an unexpected behavior.

Use absolute paths in MCP arguments.
The equivalent CLI build is:

```sh
node /absolute/plugin/path/scripts/run.mjs build --project /app/model/project.json --jar /tools/tla2tools.jar --out /app/generated
```

Build the generated TypeScript package:

```sh
npm install --prefix /app/generated/typescript
npm run build --prefix /app/generated/typescript
```

Submit input data through the generated owner:

```typescript
import { createFactMachine } from "./generated/typescript/dist/machine.js";

const fact = createFactMachine();
const inserted = fact.send("none");
if (!inserted.ok || inserted.action !== "Insert") throw new Error("Expected Insert");
const same = fact.send("none");
if (!same.ok || same.action !== "Same") throw new Error("Expected Same");
const clash = fact.send("different");
if (!clash.ok || clash.action !== "Clash") throw new Error("Expected Clash");
const stored = clash.after.values.stored;
if (stored.kind !== "data" || stored.value !== "none") throw new Error("Stored data changed");
const origin = clash.updates.stored;
if (origin?.kind !== "state" || origin.variable !== "stored") throw new Error("Expected old-state copy");
```

A call such as `fact.send("Same")` submits the text `Same` as data.
The API has no caller action selector.
Each successful receipt exposes `action`, `before`, `after`, and `updates` for every simultaneous assignment.
Origins identify a literal, input, or old-state variable.
Use all assignments when integrating the behavior, rather than hardcoding a mutation from the action name.
A successful `Same` leaves model values unchanged and still increments the owner's revision.

TypeScript protects state in a closure and returns frozen copies.
A rejected input preserves both state and revision.
The API does not expose a custom equality callback, arbitrary object input, raw-state constructor, or restore method.

Before applying this API to application payloads, define an explicit adapter to immutable string identity.
Prove or test that the encoding preserves the application's equality contract.
If equality excludes metadata such as `received_ts`, encode only the fields that define identity and verify that exclusion.
Do not assume that serializing an arbitrary object preserves the required equality.
Connect the generated owner to the real state path instead of maintaining a parallel handwritten implementation.
The fact-merge model names a Parangsae operation, but this example alone does not establish actual Parangsae adoption.

Each factory still creates a separate live object at Init.
Persistent entity identity, reset prevention, restart, and database or filesystem effects require separate contracts.
A receipt does not make an external effect atomic.

## Own payload and provenance with v4

Select project v4 `symbolic-owned` for two or three independent opaque inputs.
Keep one scalar binder per distinct named domain.
Configure each domain with at least two untyped TLC model atoms.
The configured domain sets must be pairwise disjoint.
`Values = {v1, v2}` and `Receipts = {p1, p2}` are separate domains.
An atom reused in both sets is one TLC value and fails the product-input profile.
Runtime domains are separate namespaces, so identical text in two domains denotes different tagged atoms.

For payload-associated provenance, add explicit state to the single-input model above.
The essential source relation is:

```tla
VARIABLES phase, stored, rejected, storedProvenance, rejectedProvenance
vars == <<phase, stored, rejected, storedProvenance, rejectedProvenance>>

Init ==
  /\ phase = "absent"
  /\ stored = "none"
  /\ rejected = "none"
  /\ storedProvenance = "none"
  /\ rejectedProvenance = "none"

Insert(v, provenance) ==
  /\ phase = "absent"
  /\ v \in Values
  /\ provenance \in Receipts
  /\ phase' = "present"
  /\ stored' = v
  /\ storedProvenance' = provenance
  /\ rejected' = "none"
  /\ rejectedProvenance' = "none"

Same(v, provenance) ==
  /\ phase \in {"present", "conflict"}
  /\ v = stored
  /\ provenance \in Receipts
  /\ UNCHANGED vars

Clash(v, provenance) ==
  /\ phase \in {"present", "conflict"}
  /\ v \in Values
  /\ v # stored
  /\ provenance \in Receipts
  /\ phase' = "conflict"
  /\ rejected' = v
  /\ rejectedProvenance' = provenance
  /\ UNCHANGED <<stored, storedProvenance>>

Next ==
  \E v \in Values, provenance \in Receipts:
    \/ Insert(v, provenance)
    \/ Same(v, provenance)
    \/ Clash(v, provenance)

Spec == Init /\ [][Next]_vars

ProvenanceStable ==
  [][stored # "none" => storedProvenance' = storedProvenance]_vars
```

Declare `CONSTANTS Values, Receipts` in the module and configure both sets.
Retain `StoredStable` and the payload type invariant from the single-input model.
Extend the type invariant so present stored payloads require stored provenance in `Receipts`.
Conflict states require rejected provenance in `Receipts`.
Absent stored payloads and non-conflict rejected payloads require their provenance sentinel `"none"`.
Include every variable in `vars`.
A provenance-only write changes the full state and cannot use the square-action stutter exception.

Use a project with `"version": 4`, `"profile": "symbolic-owned"`, and the model's paths and generated class name.
V4 emits symbolic IR version 2 with ordered `inputs`, a separate `next`, and named input origins.
V3 uses the single-input IR and rejects this arity.
Both profiles reject dependent ranges, opaque-domain enumeration, arithmetic, unsupported temporal properties, and incomplete simultaneous assignments.
V4 also rejects repeated domains and more than three binders.

Run `sgd_build` before claiming executable validation.
The finite oracle calls the original actions with every configured input tuple.
The orbit checker considers the Cartesian product of retained atoms and one fresh atom per domain.
It renames each domain independently.
The receipt records every domain and its finite witness atoms.
`profile: "symbolic-owned-v1"` identifies the shared controlled runner.
`symbolicIrVersion: 2` and `inputProfile: "disjoint-input-product-v1"` identify the v4 lowering grammar.

Both native targets take primitive arguments in the order of `inputs`.
For inputs `v` and `provenance`, TypeScript uses `send("A", "r1")`.
Neither API accepts a map, object, callback, or caller-selected action.
The reference interpreter's input record is an artifact representation, not the native method signature.
Every receipt includes all payload and provenance variables before and after the action.
An input assignment origin includes its `parameter`.

Verify A@r1, B@r2, B@r3, and A@r4.
The final state keeps stored A@r1 and rejected B@r3.
The second B must update rejected provenance even though the rejected payload identity is unchanged.
The final A must preserve the original receipt and latest rejected pair.

For an explicit relation to the original payload model, call `sgd_refine` with absolute paths in `abstract`, `concrete`, and `binding`.
The binding maps abstract variables and inputs to concrete names and concrete actions to abstract actions:

```json
{
  "version": 1,
  "variables": { "phase": "phase", "stored": "stored", "rejected": "rejected" },
  "inputs": { "v": "v" },
  "actions": { "Insert": "Insert", "Same": "Same", "Clash": "Clash" }
}
```

The check compares initial projection, every enabled or disabled input class, observable actions, and full projected successors.
It checks the supplied IR under the accepted grammar.
Keep the separate source-build receipts because erasure does not rerun TLC or attest original source provenance.
The MCP tool is read-only and returns evidence.
The CLI can write managed evidence:

```sh
node /absolute/plugin/path/scripts/run.mjs refine --abstract /app/high/symbolic-model.json --concrete /app/low/symbolic-model.json --binding /app/erasure.json --out /app/erasure-evidence
node /absolute/plugin/path/scripts/run.mjs refine --abstract /app/high/symbolic-model.json --concrete /app/low/symbolic-model.json --binding /app/erasure.json --out /app/erasure-evidence --check
```

Use a separate evidence output directory so refinement generation does not replace an owned executable artifact set.
Rerun the build and erasure checks when either model changes.
An extra provenance guard that disables an otherwise enabled payload write must fail erasure.

An actual Fact adapter remains required.
It must encode the real equality contract, retain owned payload and provenance, and control the application's actual write path.
Parangsae's pending Kline contract treats only source schema 1 and 2 as equivalent payloads while preserving the first raw schema and receipt.
Other schema values stay distinct.
Raw all-field equality and ignored provenance both change that contract.
The model example and supplied-IR erasure do not establish partition rollback, persisted loading, exclusive writers, file transactions, or completed Parangsae adoption.

## Own a finite state machine

Use project v2 `finite-owned` when the generated API must control actual modeled state.
The compiler retains every supported state variable in an `exact-finite` automaton.
A node contains a complete concrete valuation, rather than one selected string variable.

The executable profile has these limits:

- Each variable has one scalar type across all nodes: string, boolean, or exact decimal integer.
- TLC finds exactly one initial concrete state.
- Actions are named, unparameterized TLA+ operators. The compiler checks reachable action semantics in SANY XML, not only DOT labels.
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
  "targets": ["typescript"],
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
Do not use `sgd_compile` for v2, v3, or v4.
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

The owner exposes full copied snapshots through `read()`.
Snapshot values use tagged string, boolean, or integer values.
Integer values and the checked u64 revision serialize as decimal strings.
A successful send returns the before and after snapshots.
A named self-loop such as terminal `Wait` is a public successful event and increments revision.
Here terminal means that lifecycle state no longer changes.
It does not mean that every send is rejected.
A rejected send preserves both the current state and revision.
The TypeScript snapshot and API facade are frozen.
The owner does not expose restore or arbitrary-state construction.

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
The model supplies allowed edges, and the binding selects a TypeScript function name:

```json
{
  "version": 1,
  "name": "submission",
  "spec": "Submission.tla",
  "config": "Submission.cfg",
  "stateVariable": "state",
  "targets": ["typescript"],
  "parent": { "model": "architecture", "state": "Service" },
  "binding": { "kind": "transition", "function": "transition" }
}
```

The corresponding source constructs declare an edge:

```typescript
transition("Draft", "Submit", "Submitted");
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
  "targets": ["typescript"],
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
For v3 and v4, `sgd_build` also reruns semantic lowering, the finite input oracle, and equality/copy orbit validation.
Rerun application adapter checks when payload encoding or equality changes.
Check both the permitted behavior and the expected rejection in the actual application integration.
Keep the generated output inventory so regeneration can remove obsolete owned files.
Model-only generation removes executable artifacts previously owned by the same output directory.
Use a separate output directory for model review when you need to retain an existing generated package.
Use `build --check` to compare stable artifacts and stable provenance fields without replacing files.
V1 diagnostic projects also support `compile --check`.
TLC log bytes and volatile run details are outside the byte comparison.

Preserve the exact TypeScript 7.0.2 pin.
Read the generated package's README before native compilation or checker invocation.
Use a native plugin archive that matches the host platform and architecture.
A source checkout is not required beside an installed plugin cache.
Keep native Codex and Claude Code installations independent, and leave global agent configuration unchanged during verification.
