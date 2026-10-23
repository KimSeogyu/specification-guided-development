# Production implementation plan

The user-selected completion criterion is [successful and sustainable Parangsae adoption](production-goal.md).
The previous goal turn changed that authoritative scope and informed the Parangsae owner chat. It was progress.

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
