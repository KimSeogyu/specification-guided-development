# Parangsae fact-merge integration design

Status: application integration design, 2026-10-24 KST. The [v4 typed-input compiler](product-inputs.md), both native generators, and the model projection checks are implemented and locally verified in the current SGD work. Current v3 remains a separate single-input profile. The actual Fact adapter, persisted-row ownership, and partition commit integration below are still unimplemented. No Parangsae source, data, branch, or configuration was changed during this audit.

## Decision

Use a lower-level TLA+ contract that carries payload identity and provenance separately, plus a closed, checked Rust Fact adapter. Mechanically check the projection from that contract to the existing `ManifestWrite` relation. Then connect private per-key ownership to a private partition commit plan. Do not authorize Parquet writes from a public receipt or `MergeOutcome.committed` Boolean.

A string owner with a handwritten `Same`/`Clash` classifier would leave the application guard outside generated authority. A generic `T: Eq + Clone` wrapper would also leave equality and alias safety outside the supported profile. Neither is sufficient for this pilot.

| Alternative | Assessment |
| --- | --- |
| Checked application envelope contract with current one-input v3 | Can preserve complete rows through explicitly defined origin-based copying, provided a closed adapter and its lifting laws are checked. It is an additional concrete semantics contract, not a theorem of the existing TLA+ model. Metadata retention rules would still need an independent authority and maintenance checks. Useful for a conditional prototype; insufficient to claim modeled metadata. |
| Lower-level payload/provenance TLA+ plus checked adapter | Makes retention and replacement decisions explicit model state, supports an erasure relation, and changes native policy through regeneration. Requires the typed-input compiler extension and source binding. Recommended because it addresses the actual metadata gap rather than keeping that policy in Rust. |

## Observed source and pending changes

The audit read Parangsae's current `AGENTS.md`, `specs/tla/ManifestWrite.tla/.cfg`, `manifest.rs`, `store.rs`, all four Fact definitions and their equality implementations, core value types, the architecture policy/scanner, CI, integrity scenarios, and pipeline properties. Paths in this section are relative to Parangsae.

| Source | Existing contract that integration must preserve |
| --- | --- |
| `crates/collector/src/manifest.rs::merge_fact` | Insert the first complete value; equal input changes nothing; a conflict keeps the first value and replaces the latest rejected value. |
| `manifest.rs::merge_rows` | Work on a trial map. Any conflict returns the complete original partition, resets inserted count to zero, and keeps every encountered conflict report. Unchanged count still includes equal inputs in a refused trial. |
| `crates/collector/src/vision/rows.rs` | `KlineFact`, `FundingFact`, `MetricsFact`, and `BookFact` exclude `received_ts` from equality. Other fields include event/availability times; Metrics includes `available_lag_verified`. |
| `crates/collector/src/store.rs::commit_merge` | A refused partition appends conflict reports and never invokes the partition writer. An accepted partition is written only when it inserted a row. |
| `store.rs::write_batch` | Writes `.partial`, closes the writer, then renames. This is not an fsync or cross-file transaction guarantee. |
| `spec/arch/ArchitecturePolicy.tla` | Current owned fields are sim ledger fields; collector-wide `fs_write` admission does not establish this new fact/commit boundary. |

The owning chat identified overlapping open draft PRs. Their diffs were read; none was merged or modified by this audit:

- [PR #5](https://github.com/KimSeogyu/parangsae/pull/5) makes **only** known headerless/headed kline schemas 1 and 2 equal. Unknown schema differences remain conflicts. Equal reingest preserves original Parquet bytes, `received_ts`, and raw source schema. A projection that simply includes raw schema or simply excludes schema is wrong for this pending contract.
- [PR #3](https://github.com/KimSeogyu/parangsae/pull/3) records archive materialization coverage **before** Parquet writes so interrupted writes remain visible. Legacy unknown coverage stays conservative.
- [PR #6](https://github.com/KimSeogyu/parangsae/pull/6), based on #3, extends funding coverage to requested calendar dates, including expected empty dates, and checks missing, changed, and surplus persisted rows.

Select an independent pilot base with the owner after inspecting these PRs' current state. Do not transplant their changes or assume `main` describes the final pending contract. Preserve archive coverage ordering and verification behavior; `ManifestLog` archive bookkeeping is a different resource from the per-key `ManifestWrite` machine.

## Concrete Fact binding

Let `q(row)` be a collision-free encoding of the Fact's payload equivalence class. Let `p(row)` encode the provenance excluded or normalized by that equivalence. The necessary law is:

```text
q(a) = q(b)  iff  a == b under the selected native Fact equality
```

For the currently audited main, `p` includes `received_ts`. With PR #5, Kline provenance also retains the exact raw `schema_version`; `q` maps schemas 1 and 2 to one known class and preserves every unknown schema as a distinct value. This normalization applies only to Kline. Funding, Metrics, and Book retain their current strict schema equality.

Generate a closed adapter for the four concrete Fact types. Read the native equality implementation and resolve its fields/constants; derive the projection rather than copying its business predicate into a YAML action table. The accepted Rust grammar must cover the actual conjunctions and PR #5's finite symmetric schema-equivalence case. Verify that the finite normalization is an equivalence relation. Reject unsupported equality syntax, unresolved constants, unknown field types, conditional implementations, or unclassified fields. An added Fact field must receive an explicit payload/provenance classification before the build can pass.

Use a tagged, length-delimited exact encoding of supported strings, signed integers, Booleans, enum variants, and audited newtype representations. A hash alone cannot establish equality. Do not use an all-field serializer, lossy numeric conversion, `Debug`, or arbitrary callbacks. Audit and track the representation/getter/derived-Eq closure for `Symbol`, `UtcMicros`, timestamp wrappers, `Qty`, `Amount`, `Ratio`, and `TickDomain`. New or changed wrapper implementations invalidate the binding. Support the known timestamp macro explicitly; do not silently skip macro-generated types.

Move complete owned rows into the adapter. No `Rc<RefCell<_>>`, shared mutable fields, caller-supplied equality, or caller-selected action is admitted. Return copied observations rather than mutable authority state. Preserve the complete original row, including excluded fields, rather than reconstructing it from the normalized key.

## Metadata model and refinement

The original TLA+ model explicitly excludes `received_ts`. Assignment origins alone cannot prove its preservation: two equal payload keys may carry different receipt times or raw schemas.

Add a separate lower-level model, proposed `specs/tla/FactWriteEnvelope.tla`, with independent opaque domains `Values` and `Receipts`. `Receipts` represents complete immutable provenance, including the raw source schema when required; its name does not restrict it to a timestamp. Its complete state is:

```text
phase, stored, storedProvenance, rejected, rejectedProvenance
```

Use two scalar parameters, avoiding records or a pre-enumerated tuple domain:

```tla
Next ==
  \E v \in Values, provenance \in Receipts:
    \/ Insert(v, provenance)
    \/ Same(v, provenance)
    \/ Clash(v, provenance)
```

The parameters have separate semantic identities and domain types. Native callers supply both immutable components through the generated typed input API; they never supply an action name. The actual Fact adapter computes both components from the same moved row, so a caller cannot pair one row's payload with another row's receipt. Equal receipt atoms may accompany unequal payload atoms; this must not imply row equality.

Require pairwise disjoint configured atom sets. Untyped TLC model values have global identity: a shared `v1` in both finite domains is the same TLC value, whereas this runtime profile uses nominal domain tags. Overlap would change cross-domain equality and membership, so it must fail lowering rather than being relabeled. Each domain's independent runtime namespace is an explicit interpretation contract. Equal Unicode strings supplied to `Values` and `Receipts` denote different atoms. Typed TLC model values are outside this profile.

`Insert(v, p)` copies both input components into stored state. `Same(v, p)` keeps all five variables unchanged. `Clash(v, p)` preserves both stored components and copies both input components into rejected state. Initial absent components use tagged scalar sentinels, distinct from either opaque domain. Thus the first receipt/source provenance survives repeated and conflicting inputs, and each conflict reports the latest rejected complete row.

The implemented v4 profile supplies independently typed opaque input components, domain checks, source lowering, native fixed-arity inputs, and an original-action TLC oracle over the configured input product. For this two-domain case, orbit inputs are the Cartesian product of each domain's retained atoms plus one fresh atom. Preserve sharing among fields in the same domain. A later profile that allows multiple input parameters from one domain needs all equality partitions among fresh inputs, rather than mapping every fresh parameter to one atom. V4 bounds the full exploration and refuses partial success; current v3 rejects this model. This compiler work does not establish the concrete Fact binding or partition relation. Do not label a two-value graph as an arbitrary-product proof.

Define `alpha` by dropping the two provenance variables and projecting input onto `v`. Match `phase`, `stored`, and `rejected` exactly, including scalar/data sentinel tags. A relational checker must verify initial states and every admitted lower-level transition against the checked `ManifestWrite` IR, including disabled/ambiguous decisions and stutters. The initial adapter maps Insert→Insert, Same→Same, and Clash→Clash; any renamed-action mapping must be explicit and bijective for observable dispatch. A matching state edge with a different action is insufficient.

Require every abstract admitted input decision to have the corresponding concrete decision for all admitted provenance classes; checking only a few emitted edges is insufficient. Same is an explicit successful action whose modeled state stutters. Implicit square-action stutters do not create an accepted input receipt. Generated owners currently increment their runtime revision for successful Same as well as changing actions; revision is receipt bookkeeping, erased by `alpha`, not a recovered persisted TLA+ variable. Verify rejection leaves native state and revision unchanged. Keep the checker and its limits in the receipt. Bounded TLC, the supported-grammar orbit argument, and native implementation tests remain distinct evidence.

The adapter's own refinement law additionally relates each retained native row to both `q(row)` and `p(row)`. Validate this relation after generated steps before producing a commit plan. The native owner applies complete input/old-state assignments atomically and exposes no arbitrary row constructor or mutable snapshot. A failure cannot publish a half-updated native envelope. Add the same profile to TypeScript 7 so this product feature does not create a Rust-only semantic fork.

## Restore and partition ownership

Load canonical persisted rows through the existing typed Parquet readers. Construct fresh per-key owners by replaying one admitted original row through `Insert`, preserving that row's actual receipt/source fields. This establishes the retained-row relation; it does not recover historical revision numbers or conflict phases that were never persisted. Do not add a general `restore(snapshot)` or public `from_parts`.

The current loader fold silently replaces duplicate existing keys in a `BTreeMap`. Establish and test the persisted unique-key precondition before replay. If invalid persisted duplicates must become errors, record that as an explicit behavior change with the owner; do not silently convert last-wins loading into first-wins loading. Validate partition dataset, symbol, day, and key admission through concrete readers before creating an authority. Do not use caller-provided paths or a public empty owner as permission to overwrite existing storage.

A private `PartitionTrial` owns the original rows, trial per-key owners, observations, and conflict reports. Only its own call to an owner can advance aggregate state; public serializable receipts are observations and cannot be submitted as evidence. No production caller receives `&mut Slot`, a setter, a caller-classified event, or a forgeable committed flag.

Define the aggregate control contract explicitly: observe generated Insert/Same/Clash results; retain refusal after the first conflict; close once; and produce either a consumed write plan or a refusal with conflict reports. Preserve every conflict pair encountered, including conflicts against a row inserted earlier in the same trial. A refusal keeps the entire original partition even when other new keys were accepted provisionally. Accepted equal-only trials issue no partition-write plan.

The partition sink consumes a non-Clone plan bound to the selected partition and its loaded baseline. Its factory is private to the verified trial implementation. The raw Parquet writers remain private and have one checked authority path. Check caller aliases/re-exports and all Cargo targets; reject unclassified sink calls, omitted modules, macro/dynamic indirection outside the accepted profile, and stale generated/binding state. Rust privacy protects external consumers; source coverage is still required for code inside the trusted sink module. Current collector-wide filesystem permission does not provide this check.

This composition needs its own high-level control model and checked relation to the per-key results. If the implementation uses a host map/vector fold, document and verify that fold as an additional compiler/runtime contract. A finite control model does not prove arbitrary collection contents or all filesystem effects by itself. One conflict-free per-key receipt never implies partition authorization.

Keep the existing conflict-log-before-return behavior and `.partial` replacement path. Preserve #3/#6's archive-coverage-before-write protocol. A log append can fail, and a multi-day ingest can partly finish; report these existing failure boundaries. Do not claim multi-file crash atomicity, multiple-writer safety, durable authority identity, or trading readiness. Tests use fresh temporary directories, never the running collector or downloaded datasets.

## Proposed source changes

| Repository | Concrete changes |
| --- | --- |
| SGD | Extend `symbolic-types.ts`, `symbolic-lower.ts`, `symbolic-semantics.ts`, `symbolic-witness.ts`, `symbolic-tlc.ts`, and both symbolic backends for the explicit typed-input profile; preserve v3 refusals. Add a checked model-refinement artifact and native Fact binding/coverage generator rather than a handwritten event adapter. Extend compiler receipts and both native plugin workflows. |
| Parangsae models | Keep `ManifestWrite.tla` as the abstract relation. Add `FactWriteEnvelope.tla/.cfg`, a binding/project file, and a partition control contract. Include payload/provenance/refinement links in generated evidence and Pele. |
| Parangsae ownership | Add a separate generated authority crate and a private collector integration module. Replace production `merge_fact`/public `Slot` mutation and public `MergeOutcome` authorization; remove duplicate handwritten merge policy once callers migrate. Use real Fact rows rather than string fixtures. |
| Parangsae storage | Migrate `merge_rows`, `upsert_by_day`, and `commit_merge` to the private trial/consumed-plan path. Keep file format, native equality, raw source provenance, count semantics, archive coverage, and public collector CLI behavior. |
| Parangsae checks | Extend `cargo xtask spec inspect/generate/enforce` or an equally mandatory existing entry point to verify the complete new binding and sink closure. Update architecture policy for the new crate/dependency/capability. Do not hand-edit generated policy JSON. |

The proposed paths are implementation targets, not files claimed to exist. First prepare the new profile and adapter in SGD with the exact selected Parangsae source fixture. Then make one independently owned Parangsae branch from the owner-selected base. A shadow comparison can aid migration, but leaving a generated sidecar beside the authoritative handwritten merge does not finish adoption.

## Acceptance and maintenance evidence

- Compare native complete rows, including every excluded/normalized field, for A(received 1), B(2), C(3), A(4). Stored A/1 remains; latest rejected is C/3; Same preserves the existing conflict state. Repeat with all four real Fact types.
- For Kline PR #5 semantics, exercise schemas 1→2 and 2→1 with receipt changes, preserving the first raw schema and file bytes. Every unknown-schema difference and every value/time/interval/domain change must remain a conflict. For other Fact types, preserve strict schema comparison and Metrics' availability flag.
- Demonstrate direct mutation, raw construction/restore, submitted forged receipts, omitted declarations/modules, aliases to sink functions, reset owners, and unauthorized write plans fail at the appropriate native or binding gate. Verify failures identify the required fix.
- In a real temporary Parquet partition, combine a new key with a conflict on another key. Assert zero inserted count, complete original rows and bytes after reload, and correct conflict reports. Cover a new-key conflict in an initially empty partition, equal-only no-write, conflict logging failure, and persisted-load validation.
- Retain the existing proptest, Gherkin, and collector pipeline properties and the #3/#5/#6 regressions. Run model generation/staleness checks and independently reviewed source-coverage mutations. Mutations must expose stored overwrite, rejected retention, reversed equality, lost receipt/source schema, forged commit, and write-on-refusal errors.
- Exercise a source-only model requirement change through regeneration and both native targets, but distinguish this compiler experiment from actual Parangsae maintenance. Select the real feature, requirement change, and defect fix with the owner; do not invent business requirements or count pre-existing PR work as this integration's accomplishment. Record interventions, missed violations, false positives, review effort, and maintenance costs.

Run Parangsae's required fmt, Clippy, workspace/cucumber/proptest tests, TLC/Kani, and architecture checks for the actual final branch. A passing toy adapter, a bounded result, or green compilation does not close this milestone.

## Review and approval boundary

Coordinate the pilot base and file ownership with the owning chat before edits; it currently has overlapping collector drafts. Run `cargo xtask spec inspect` before in-repo changes and `spec enforce` before push, as required by Parangsae.

Changes to `spec/arch/*.tla` and `xtask/**` require Ops/Release review. New model/spec and root workspace paths also have Ops/Release ownership under the current policy. Prepare concrete reviewable code and evidence before requesting required review. Do not weaken checks, add an `allow`, or bypass ownership to make the branch pass.

Parangsae explicitly requires human approval for changes to required CI checks or branch protection, force-push, deletion of stored market data, secrets, and live-trading/order-submission gates. None is authorized by this design. Prepare any necessary CI activation as a reviewable final change before asking; make no data migration or live-data modification. Ordinary isolated implementation and read-only validation can proceed within the existing authorized pilot scope.
