# Source-bound complete rows

Project v5 `row-owned` connects supported Rust Fact definitions to a checked payload-and-provenance model. The compiler derives identity encodings from native equality and generates an owner that retains complete owned rows. Callers provide a row, not an equality decision, identity pair, or action name.

The Rust adapter binds actual audited application types. TypeScript 7 receives a portable DTO schema derived from those Rust types. The TypeScript output is not a TypeScript source-AST binding and does not reproduce Rust constructor validation.

This is a source milestone toward [the Parangsae production goal](production-goal.md). Parangsae integration runs on an independent branch based on the pending Kline schema contract. Collector tests and source-bound generation are evidence of that integration. Full CI acceptance, source/effect coverage, and sustainable feature, requirement-change, and defect-fix cycles remain required.

## Project configuration

The following project layout places `fact-write.json` under an application's `spec/sgd` directory:

```json
{
	"version": 5,
	"profile": "row-owned",
	"name": "FactWriteEnvelope",
	"spec": "../../specs/tla/FactWriteEnvelope.tla",
	"config": "../../specs/tla/FactWriteEnvelope.cfg",
	"application": "../..",
	"targets": ["typescript", "rust"],
	"binding": {
		"className": "FactEnvelopeMachine",
		"rustCrateMode": "workspace",
		"row": {
			"version": 1,
			"profile": "rust-whole-row-v1",
			"source": {
				"manifest": "crates/collector/Cargo.toml",
				"module": "crate::vision::rows",
				"facts": [
					{ "name": "KlineFact", "rustPath": "crate::vision::KlineFact", "metadata": ["received_ts"] },
					{ "name": "FundingFact", "rustPath": "crate::vision::FundingFact", "metadata": ["received_ts"] },
					{ "name": "MetricsFact", "rustPath": "crate::vision::MetricsFact", "metadata": ["received_ts"] },
					{ "name": "BookFact", "rustPath": "crate::vision::BookFact", "metadata": ["received_ts"] }
				]
			},
			"model": {
				"payloadInput": "v",
				"provenanceInput": "provenance",
				"pairs": [
					{ "name": "stored", "payload": "stored", "provenance": "storedProvenance" },
					{ "name": "rejected", "payload": "rejected", "provenance": "rejectedProvenance" }
				]
			}
		}
	}
}
```

`application`, `spec`, and `config` are relative to the project file. The source manifest is relative to the application root. `rustPath` names the accessible application re-export. The source module identifies the definitions to analyze.

The binding maps inputs and complete-row state roles. TLA+ supplies guards, assignments, and the exact observable action identities. Generated `WriteEffect` values preserve source IDs such as `Insert`, `Same`, and `Clash`. The configuration cannot relabel them through an `outcomes` table. Legacy outcome mappings fail schema validation before model execution.

An action ID is structural identity, not proof of its business role. A source action rename forces an exhaustive native application match to change. Erasure checks and native integration behavior checks still establish the intended meaning. `rustCrateMode: "workspace"` omits a nested `[workspace]` from the generated authority manifest. `"standalone"` retains a standalone generated crate. Workspace membership and architecture-policy admission remain application changes.

The normal CLI pipeline is:

```sh
node /absolute/plugin/path/scripts/run.mjs build --project /app/spec/sgd/fact-write.json --jar /tools/tla2tools.jar --out /app/spec/sgd/generated/fact-write
node /absolute/plugin/path/scripts/run.mjs build --project /app/spec/sgd/fact-write.json --jar /tools/tla2tools.jar --out /app/spec/sgd/generated/fact-write --check
```

`sgd_build` provides the same source-bound build through either native plugin. Imported DOT fails with `TLC206`. Model-only generation exports the model, removes obsolete owned executable artifacts, and records `rowBinding: null`. It does not analyze Rust source or establish a row binding.

## Native equality and exact encoding

The source analyzer derives the payload projection from `PartialEq::eq`. Explicit metadata fields must be omitted by that native predicate. Every declared field must enter payload, provenance, or both. A new field omitted from both Eq and metadata fails with `TLC305`.

The supported Kline predicate gives only raw schemas 1 and 2 one equivalence class. The analyzer derives that finite class from the native symmetric `matches!` clause and resolved constants. Other schema values remain distinct. Schema normalization affects payload identity while the exact raw schema also enters provenance. Receipt time enters provenance and remains outside payload equality.

For admitted source types, the intended binding law is `q(a) = q(b)` exactly when the checked native Eq considers `a` and `b` equal. Complete row identity retains the fields lost or normalized by `q` through `p`. The owner stores the actual complete row rather than reconstructing it from a normalized key.

Encoding uses a fixed header and ordered, typed, length-delimited components. Strings and enum variants use exact UTF-8. Signed i64 and u32 use exact big-endian bytes. Booleans use one byte. Payload finite classes use their minimum member, while provenance retains the raw value. Neither a hash, `Debug`, all-field serialization, Unicode normalization, nor a JavaScript `Number` conversion defines equality.

## Rust source profile

The analyzer parses Rust AST with `syn`. It follows the production library modules, Cargo path dependencies, imports, and re-exports needed by the audited source inventory. It checks ordinary Eq conjunctions, finite u32 equivalence clauses, immutable primitive fields, unit enums, and owned one-field wrappers with exact getters. The timestamp macro support validates and parses its template expansion. A type name alone is not a codec guarantee.

The source profile rejects unsupported equality, unclassified fields, shared mutable values, custom Clone or Drop, ambiguous namespaces, conditional bound items, unsafe getter assumptions, and opaque implementation-producing macros. Macro input token blocks cannot hide nonlocal implementations. A consuming wrapper getter requires derived Copy. Qualified or shadowed `matches!` cannot supply a finite quotient.

Literal test and Kani configurations are outside this production-library profile. Unknown source constructs fail instead of disappearing from the binding. The profile does not establish coverage of every Cargo target, feature, build script, procedural macro, or filesystem effect.

Standard Rust traits and macros are trusted only after namespace checks. Unrelated default-registry serde and clap derives are trusted dependencies. Local paths, git, custom registries, patch/replace declarations, and excluded generated dependencies cannot supply that trust. Local `.cargo/config` files are hashed and permit only `[alias]`. Global Cargo configuration, registry/cache contents, genuine registry dependencies, the toolchain, and the platform remain trusted environment assumptions. The [analyzer reference](../tools/rust-bindings/README.md) defines its exact limits.

## Complete-row ownership and commit

The source model uses two distinct input domains and four paired state variables, as in [the product-input profile](product-inputs.md). Each output row pair must copy a complete incoming row, a complete old stored/rejected row, or both initial sentinels. Mixed payload/provenance origins fail the row binding even if the underlying symbolic grammar accepts the expressions.

The Rust output includes a private application adapter and a separate primitive authority crate. The adapter's sealed bound admits only the analyzed concrete Fact types. `FactOwner<T>` does not admit an arbitrary `T: Eq`. In the private application module, its API uses actual owned values:

```rust
use adapter::FactOwner;
use crate::vision::KlineFact;

let mut owner = FactOwner::<KlineFact>::new();
let effect = owner.write(incoming_row)?;
let stored = owner.stored();
let state = owner.read();
```

Encoding, cloning, origin-based row selection, source action identification, and binding checks finish before the owner consumes a private prepared transition. The pending token belongs to the borrowed primitive owner and cannot be forged or applied to another owner. After commit, audited owned row fields move into place without application callbacks. Rejection preserves modeled state and retained rows.

TypeScript exposes one authenticated row factory and owner factory per analyzed Fact:

```ts
import { createKlineFactRow, createKlineFactOwner } from './dist/machine.js';

const row = createKlineFactRow(completeRawFields);
const owner = createKlineFactOwner();
const result = owner.write(row);
const observation = owner.read();
```

i64 fields use bigint, u32 uses integer Number within range, and enum fields use the admitted variant names. The factory copies every raw field into a frozen token and refuses accessors. The owner authenticates the token for its Fact type. A structural copy or caller-supplied identity pair cannot enter the owner.

The portable DTO validates this representation. Its i64 fields admit the complete signed range, including values that a native Qty or Amount constructor would reject. Equality and encoding parity apply to values admitted by the native types. The DTO does not enforce `Symbol::new`, Qty/Amount constructor checks, exchange parsing, or application admission rules. It also does not analyze a TypeScript application's source. Actual TypeScript source bindings require a separate profile.

## Artifacts and regeneration

`row-binding-plan.json` records every native field, codec getter chain, payload/provenance classification, finite class, and source identity. `verification.json` records `generation: "whole-row-authority"`, the source profile and production-library scope, linked source identities, and formatter provenance. The compiler revalidates source bytes after analysis and before output publication.

All Rust output uses the common [artifact contract](artifact-contract.md) with the explicit `rustfmt-2021-v1` configuration. The stable receipt records that profile and configuration identity. `formatterVersion` is informational and does not pin an installation. `build --check` still checks the actual generated Rust bytes. An adapter included in an application requires a compatible consumer formatter profile. A source checkout needs Cargo to prepare its analyzer fallback. Prepared native plugins bundle `runtime/bin/sgd-rust-bindings` for the host. Rust output also requires rustfmt. Building or testing the generated Rust crate requires Cargo and its declared dependencies.

Generated adapter and authority source files are checked outputs, not inputs to their own source binding. The compiler excludes only its controlled output paths. Original module hooks, manifests, and local Cargo configuration remain source inputs. Bound types cannot resolve through that exclusion. This allows a source Eq change to regenerate in one invocation without an old generated file causing an endless staleness loop.

`build --check` reruns the source, model, oracle, binding, and native generation checks. It refuses changed stable artifacts and provenance. Editing generated code cannot change the model contract. A refused source binding publishes no partial replacement.

## Application guarantees remain separate

A successful source-bound owner establishes the supported live-object relation. A public receipt is an observation, not filesystem permission. The binding does not prove partition aggregation, baseline validation, exclusive writers, conflict-log/file atomicity, crash durability, persisted history, or reset prevention.

Parangsae keeps an entire original partition when any incoming key conflicts. That aggregate contract and the actual writer call paths require their own evidence. Collector-wide filesystem permission is insufficient. Existing archive coverage-before-write semantics must remain intact. A passing fixture, generated owner, collector test, or source plan alone does not complete sustainable Parangsae adoption.
