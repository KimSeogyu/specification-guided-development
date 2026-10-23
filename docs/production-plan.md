# Production implementation plan

The user-selected completion criterion is [successful and sustainable Parangsae adoption](production-goal.md).
Recent goal work added and independently reviewed v5 source-bound complete rows, then integrated generated owners into the actual Parangsae collector on a separate branch. Native behavior, copied plugin-cache checks, and [successful v5 Linux CI](https://github.com/KimSeogyu/specification-guided-development/actions/runs/40019410080) provide concrete progress. Sustainable application adoption remains pending.

## Milestones

1. **Preserve semantics and own actual state.** Add a distinct exact finite automaton IR, controlled TLC execution, and generated state authorities for TypeScript 7 and Rust. Preserve every supported concrete variable. Enforce guards with exact current-node adjacency. Keep the projected diagnostic IR separate.
2. **Connect application authority and coverage.** Bind actual Parangsae resources and effect entry points to generated owners. Discover the supported project source closure automatically. Fail on omitted, unmapped, unsupported, or stale code. Define how model hierarchy carries a checked relation.
3. **Apply and maintain in Parangsae.** Coordinate with its owner chat. Select a real boundary before integration. Exercise feature addition, a requirement change, and a defect fix through generation and CI. Record missed violations, false positives, interventions, maintenance work, and remaining costs.
4. **Verify native plugin operation and release lifecycle.** Run real installed-agent development loops. Verify platform packages, installation, upgrade, rollback, diagnostics, and Pele against the supported product contract.

## First verifiable unit

The model has `phase` and `approved` variables. Both `phase = "New", approved = FALSE` and `phase = "New", approved = TRUE` are reachable. `Submit` is enabled only in the latter state. A private generated owner must refuse Submit before Approve and accept Approve then Submit without application transition declarations.

The first executable profile supports scalar TLA+ strings, Booleans, and exact integers, one initial state, named unparameterized actions, and one successor per concrete state and action. Unsupported values, ambiguous actions, projected traces, reduced or constrained graph configurations, and unverified imported DOT cannot produce executable authority artifacts.

This unit establishes a per-live-object finite transition contract. It does not establish persistent entity identity, safe restart, effect atomicity, liveness, or general application refinement. Those remain required design and pilot work where relevant.

## Current evidence

The first unit now has native TypeScript 7 and Rust implementations, a real two-variable TLC example, and cross-language snapshot-trace comparison. A requirement change to the TLA+ submission rule produces a changed native result after regeneration. Generated code rejects direct state access; runtime TypeScript casts, reflection, and snapshot edits cannot replace the closure-owned state. The exact IR validates complete typed valuations and graph closure.

The controlled runner checks the complete flat local module closure and the supported pure standard modules in an isolated snapshot. It rejects reductions, Java overrides, inherited JVM/TLA settings, incomplete runs, and input changes. Verification receipts include the project binding as well as model sources. Independent review reproduced and closed a project-configuration race, and separated model-only visualization from executable determinism restrictions.

This is progress on milestone 1. Parangsae integration and repeated real maintenance remain outstanding; the production goal stays active. Packaged-cache verification and a source-workflow agent trial do not count as real installed-agent acceptance.

## Parangsae boundary audit and next unit

A read-only audit of the live Parangsae source identified collector fact merging as the smaller meaningful first pilot. `specs/tla/ManifestWrite.tla` models `Insert(v)`, `Same(v)`, and `Clash(v)`. `crates/collector/src/manifest.rs::merge_fact` is used by `merge_rows`, then `crates/collector/src/store.rs::upsert_by_day` and `commit_merge`. Existing property tests and integrity scenarios require the original payload to survive a conflict. The application uses actual payload equality and previously persisted data.

The current finite-owned profile cannot faithfully replace this boundary: the specification uses model values and parameterized input, while the implementation accepts arbitrary payloads. Encoding two fixture payloads as two string events would not prove actual application adoption. Letting a caller select Same or Clash would delegate the guard to that caller. Define supported input/value semantics and make generated code evaluate the relevant equality and update relation before integrating this pilot. Trusted existing-state loading and partition commit remain explicit additional boundaries.

Execution order lifecycle is a later candidate. Its live `OrderProgress` and `OrderBook::apply` already manage private state, payload-bearing validated events, quantities, restart checkpoints, and halt effects. Its TLA+ model contains records, functions, sequences, and authority evidence outside the current executable profile. Replacing only the phase would discard required guards.

The next unit must compare concrete graph parameterization with symbolic action compilation, define the exact guarantee for actual payloads, and exercise valid, repeated, and conflicting data against the existing native contract. Coordinate the selected independent branch with the owning Parangsae chat before modifying its active collector or execution work. Leave stored market data and the running collector untouched.

## Parameterized action compiler unit

The next compiler unit now uses a distinct v3 [symbolic-owned profile](symbolic-owned.md). Independent alternatives showed that the pinned DOT omits action arguments and that two payload atoms cannot identify every update law. The compiler therefore lowers the original SANY action relation, preserving outer input admission, guards, complete simultaneous assignments, and assignment origins. DOT remains finite evidence, not the source of a guessed generic policy.

The native TypeScript 7 and Rust owners accept immutable Unicode string identities and choose the source action internally. They preserve data/sentinel tags and keep the original stored identity while updating the latest rejected identity. The independent TLC input oracle calls original model actions for every configured reachable state/input pair. Equality/copy orbits separately cover existing-atom and fresh-atom input classes under the admitted grammar. A source requirement change that resolves conflict on repeated original input changes both native outputs through regeneration.

Independent review corrected square-action stuttering, omitted root/inherited assumptions, action-level applications of parameterized pure helpers, mixed scalar comparison errors, typed model-value admission, and deadlocks outside the configured finite atom set. The source profile and review regressions retain those boundaries. Actual Parangsae TLA+ source files can be checked with their explicitly selected co-located pinned JAR; generated output stays outside Parangsae.

This is compiler progress, not completed application adoption. The next application unit must bind actual Fact equality and metadata to the generated relation, preserve per-partition rollback and first-received values, replace duplicate handwritten policy, and close unauthorized construction/write paths. Persistent identity, restore, crash durability, and execution order handling remain separately scoped work. Keep the actual required-check and architecture-review rules from the Parangsae repository when preparing its integration.

Assignment origins are useful integration information, not a proof about metadata omitted from the TLA+ value. If equality excludes received time, copying an equal input and keeping an old value can be equivalent in the abstract relation while changing concrete metadata. The pilot must define and verify that extra contract, or add a lower-level model and a checked abstraction relation. Do not silently promote update syntax into a metadata guarantee.

## Payload and provenance integration unit

The live pilot audit and owner coordination identified overlapping collector drafts. Parangsae PR #5 treats only known Kline source schemas 1 and 2 as equivalent payloads while retaining the original raw schema and receipt. PR #3 records archive coverage before materialized writes; PR #6 builds on that coverage for funding verification. Preserve these contracts and coordinate the eventual pilot base. Main alone does not describe the pending equality requirement.

The source now adds project v4 with two or three independent inputs over pairwise disjoint nominal domains. `FactWriteEnvelope` models original and latest-rejected payload/provenance separately. Its complete-state action properties preserve first provenance. A checked enabled-input erasure compares the full projected state, accepted/disabled decisions, and observable actions with the original ManifestWrite IR. Native TypeScript 7 and Rust keep fixed primitive argument arity. The original-action TLC oracle compares the entire configured input product. Read the [integration design](pilot-fact-merge-design.md) for alternatives, concrete source targets, and review boundaries.

This removes the compiler gap for independent payload/provenance identities. It does not alone bind actual Fact objects. Architecture/xtask changes need the repository's Ops/Release review, and required-CI changes need human approval.

## Actual whole-row pilot unit

Project v5 now derives exact payload/provenance encodings from the supported Rust equality and owned representation closure. It rejects unclassified fields, unsupported lifecycle behavior, unresolved macros, overlapping finite quotient classes, and mixed row-copy origins. Both native targets stage complete rows before committing symbolic state. Rust binds the actual four Fact types; TypeScript uses authenticated immutable representation DTOs. Native constructor preconditions, all-target/feature coverage, and storage permission remain separate contracts.

The independent Parangsae `codex/sgd-fact-merge` worktree starts from pending PR #5. Its production fold now uses generated FactOwner and removes handwritten Stored/Slot/merge_fact dispatch. Private consumed MergeOutcome preserves original partition rollback, every conflict report, unchanged counts, and no write on equal-only/refused trials. Existing archive bookkeeping is unchanged. Actual temporary Parquet, workspace/Gherkin/Clippy, architecture, existing Kani, installed-SDK regeneration, and committed-range ownership checks have local evidence. The first draft passed the existing [application CI](https://github.com/KimSeogyu/parangsae/actions/runs/40020720678); that workflow does not yet run the new source/model gate.

Independent integration review found a manual outcome-mapping defect: swapping Same/Clash classifications could approve a conflicted trial. V5 removes that mapping and exposes source action IDs directly, so operator renames require native caller adaptation. Independent source review also retained fixes for shadowed standard macros/traits and hidden custom Drop implementations. A formatter-version-only receipt drift was corrected while retaining strict generated-byte/profile/config checks. Record these interventions as maintenance evidence rather than an unattended-success claim.

The compiler milestone merged in [SDK PR #4](https://github.com/KimSeogyu/specification-guided-development/pull/4). [Parangsae draft PR #9](https://github.com/KimSeogyu/parangsae/pull/9) pins the SDK and supplies a fresh source/model/erasure entry point. Fresh-cache installation with SSH disabled and artifact-drift refusal passed. Native implementation and architecture review found no concrete regression. The required-CI activation remains an unapplied reviewable patch pending human approval. The first draft passed existing application CI. Required source/model CI and actual maintenance cycles remain acceptance work. Rendered Pele QA found self-loop label overlap and zoom-in clamping; SDK PR #5 corrects those defects. A pinned application upgrade passed default verification without changing generated contracts; the SDK correction and upgraded application passed their existing remote CI. The new required source/model check is still awaiting activation approval.

The next authority unit is the planned [generated partition fold and resource-bound session](partition-authority-design.md). It replaces the handwritten aggregate decision with a closed batch operation and a finite controller for conflicts, insertions, and closing. Only the generated fold can deliver actual per-key outcomes. The design keeps successful stutter observations, native counts, every conflict pair, and whole-partition rollback. It states the separate collection-runtime contract, fixed source keys, loaded baseline, writer authority, and source-coverage obligations. None of those new partition APIs is implemented yet. Preserve duplicate-baseline behavior until an explicit validation change is reviewed. Exercise actual feature, requirement, and defect maintenance cycles. Stored market data and trading gates remain untouched. The production goal is incomplete.

## Design alternatives and decision

Independent design reviews compared full concrete graph execution, symbolic Action compilation through SANY, and a TLC runtime oracle. Full concrete execution preserves the existing TLC-to-graph pipeline and avoids reconstructing lost guards. It is the first implementation profile. Symbolic SANY compilation remains necessary when a Parangsae contract requires application domains outside the executable finite graph. A runtime Java oracle is not the default application path.

Generated TypeScript authority keeps its node in a closure or ECMAScript private field and exposes frozen copied data. Rust authority lives in a separate generated crate with private state and no mutable state references, Clone, or public deserialization. Dispatch is synchronous and invokes no application callbacks. Public arbitrary restore is excluded because it permits valid-looking state jumps and rollback. Persistence and recovery require their own trusted owner and modeled protocol.

## Acceptance for this unit

- Preserve both concrete New states and the guarded Submit edge.
- Exhaustively compare generated dispatch decisions with the concrete graph on reachable states and actions.
- Native TypeScript 7 and Cargo builds reject direct protected-state construction and writes.
- Runtime TypeScript reflection, casts, snapshot mutation, and method replacement do not alter the private authority.
- Invalid dispatch preserves state and revision.
- Removing annotation-style transition calls does not remove protection.
- Changing the TLA+ model changes generated behavior through regeneration.
- Model checking and generation refuse the unsupported finite-owned configurations.
- Record the live-object boundary and retain the broader production goal as incomplete.
