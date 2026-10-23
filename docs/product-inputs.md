# Independent data inputs

Project v4 `symbolic-owned` compiles actions with two or three independent opaque inputs. Each input belongs to a distinct named domain. The generated owner preserves all model variables, including payload-associated provenance.

The [fact-envelope example](../examples/fact-envelope/README.md) stores the first payload with its first provenance. Conflicting writes replace the latest rejected payload and provenance together. Equal writes preserve both stored and rejected values. This source milestone adds compiler support. Actual Parangsae ownership, partition commits, source coverage, and maintenance validation remain required by [the production goal](production-goal.md).

## Project and source profile

The new project version selects the product-input profile explicitly:

```json
{
	"version": 4,
	"profile": "symbolic-owned",
	"name": "FactWriteEnvelope",
	"spec": "FactWriteEnvelope.tla",
	"config": "FactWriteEnvelope.cfg",
	"targets": ["typescript", "rust"],
	"binding": { "className": "FactEnvelopeMachine" }
}
```

Project v3 keeps its single-input profile, IR v1, native API, and receipt shape. It rejects a product-input model. Project v4 emits IR v2 with ordered `inputs`, a separate `next`, and named input expressions such as `{"kind":"input","parameter":"provenance"}`.

The accepted `Next` quantifier binds two or three scalar inputs over independent named constant domains:

```tla
Next ==
	\E v \in Values, provenance \in Receipts:
		\/ Insert(v, provenance)
		\/ Same(v, provenance)
		\/ Clash(v, provenance)
```

Each action receives the complete binder list directly. Domain-dependent ranges, repeated domains, and multiple inputs from one domain are outside this profile. The remaining scalar, guard, update, helper, and temporal restrictions follow [the symbolic-owned profile](symbolic-owned.md).

Each configured domain contains at least two distinct untyped TLC model values. Configured domains must be pairwise disjoint. For example, `{v1, v2}` and `{p1, p2}` are valid. `{v1, v2}` and `{v2, p1}` overlap and fail generation. An untyped TLC atom has one identity even when two constants contain it.

Runtime domains are disjoint namespaces of immutable Unicode string identities. The string `"same"` supplied to `Values` differs from `"same"` supplied to `Receipts`. Both differ from a scalar TLA+ string `"same"`. Equality and domain membership preserve these tags. The compiler rejects typed TLC model values and unsupported semantics instead of treating them as a new nominal type.

## Generated native API

Native argument order follows the ordered `inputs` in `symbolic-model.json`. The example declares `v` first and `provenance` second. Each argument is a primitive string. The caller supplies no action classification, equality callback, or mutable payload object.

```ts
import { createFactEnvelopeMachine } from './dist/machine.js';

const facts = createFactEnvelopeMachine();
facts.send('A', 'r1'); // Insert
facts.send('B', 'r2'); // Clash
facts.send('B', 'r3'); // Clash; latest rejected provenance becomes r3
facts.send('A', 'r4'); // Same; all model values remain unchanged
const snapshot = facts.read();
```

The Rust owner exposes the same argument order:

```rust
#![forbid(unsafe_code)]
use authority::FactEnvelopeMachine;

let mut facts = FactEnvelopeMachine::new();
facts.send("A", "r1").unwrap();
facts.send("B", "r2").unwrap();
facts.send("B", "r3").unwrap();
facts.send("A", "r4").unwrap();
let snapshot = facts.read();
```

The final values retain `stored=A`, `storedProvenance=r1`, `rejected=B`, and `rejectedProvenance=r3`. Snapshots and receipts contain every model variable. Update origins distinguish `v` from `provenance`. Both owners use the same private-state, checked-revision, and immutable-snapshot contract as the single-input profile.

The reference interpreter and orbit artifacts represent an input tuple as a named record, for example `{"v":"A","provenance":"r1"}`. This record is an artifact representation. The native public API uses primitive arguments.

## Verification and artifacts

Controlled SANY and TLC verification precede semantic lowering. The orbit checker renames atoms separately within each domain. For each state, it checks the Cartesian product of that domain's retained atoms and one fresh atom. One binder per domain makes each tuple a representative of the supported equality cases. This argument requires the accepted equality-and-copy grammar and disjoint domains. It is not a proof for arbitrary TLA+.

The independent finite oracle calls the original actions with every configured input tuple. It compares action dispatch, disabled decisions, and complete next valuations with the lowered relation. The finite TLC result remains a check of the configured instance.

The profile permits at most 12 state variables and 10,000 reachable symbolic orbits. Orbit checking and erasure each stop after 250,000 attempted input cases. The finite oracle also rejects a configured state/input product above 250,000 cases. Reaching a limit fails verification without publishing partial success.

Square action properties use their complete source variable tuple. A provenance-only change is a state change when provenance belongs to that tuple. The compiler cannot discard provenance before it decides whether `UNCHANGED vars` applies.

The generated artifact set follows the single-input profile. `automaton.json` uses witness v2 and retains every domain's configured atoms. `symbolic-model.json` uses IR v2. `orbit-proof.json` and `input-verification.json` retain complete input tuples. The stable `runtimeDomain` receipt field records the ordered input bindings and each domain's finite witness atoms. `build --check` checks this complete metadata as well as the source, IR, and native code.

The shared controlled runner records `profile: "symbolic-owned-v1"`. That field identifies the runner and exporter contract. Product-input receipts separately record `symbolicIrVersion: 2` and `inputProfile: "disjoint-input-product-v1"` to identify the lowering grammar. Single-input receipts retain their previous shape.

The Pele symbolic view labels each input with its parameter and domain. Its state captions retain every variable. Local orbit names such as `a0` can occur in different domains and can change after state normalization. The finite witness view retains the original configured atoms. Neither view turns a containment link into a refinement proof.

## Explicit model erasure

The `refine` CLI and `sgd_refine` MCP tool check supplied symbolic IR against an explicit binding. The fact-envelope binding maps each abstract variable and input to a declared concrete variable and input. It maps every concrete action bijectively to an abstract action:

```json
{
	"version": 1,
	"variables": { "phase": "phase", "stored": "stored", "rejected": "rejected" },
	"inputs": { "v": "v" },
	"actions": { "Insert": "Insert", "Same": "Same", "Clash": "Clash" }
}
```

For every concrete orbit and representative input tuple, the checker compares enabled or disabled decisions, action classification, and the complete projected successor. Extra provenance guards cannot silently disable an abstract input. Each model checks its own invariants and square action properties against its complete state. The initial projection must also match.

`refinement.json` identifies both semantic programs and the binding. Its scope is the accepted equality-and-copy grammar. `refine --check` detects changes to this managed evidence. The check does not rerun TLC or attest that supplied IR came from particular source files. Fresh build receipts provide that separate source and tool provenance. The example README contains the [build and erasure commands](../examples/fact-envelope/README.md#check-the-original-payload-contract).

## Application binding remains separate

A provenance identity can encode receipt time and raw source schema. The model does not define that encoding or recover an application object from an arbitrary identity. A production adapter must preserve the application's payload equality relation and copy the associated owned values under the modeled updates.

For Parangsae, the pending [Kline schema-equivalence change](https://github.com/KimSeogyu/parangsae/pull/5) treats only source schema 1 and 2 as equivalent payloads. It preserves the original stored receipt and raw schema. Other schemas remain distinct. A raw all-field encoding would break equal reingest. An encoding that drops raw provenance from storage would also break the contract.

The existing fact-merge model excludes provenance. An explicit erasure check can establish a relation between the two supported models. It does not establish the adapter, the actual Fact equality binding, partition rollback, file transactions, restart behavior, or exclusive writers. Those claims require application evidence. This compiler example has no Parangsae data migration or application-code adoption.
