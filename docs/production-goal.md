# Production goal

## Current objective

Develop Specification Guided Development into a production-grade toolkit for TypeScript 7 and Rust, delivered through independent Codex and Claude Code plugins. Demonstrate successful and sustainable adoption in [Parangsae](https://github.com/KimSeogyu/parangsae). Complete this goal when Parangsae can use the methodology for actual feature development, requirement changes, and defect fixes, while preserving its modeled contracts through generation, implementation, native verification, and CI.

The user selected Parangsae adoption and continued maintainability as the completion criterion. This criterion replaces the earlier requirement for broad independent-user validation. Public usability remains a product objective. Universal enthusiasm is an aspiration, not a release gate.

## Evidence required for completion

- Apply the tool to a meaningful Parangsae architecture and behavior boundary. Record the selected contract, authority owner, code bindings, supported source profile, and excluded behavior before implementation.
- Connect the model to the authoritative application state and permitted transition APIs. Deleting a declaration, writing state directly, changing an alias, or discarding a guard must not bypass the supported contract.
- Preserve the full semantics required by the selected contract. Do not use an existential projected edge as evidence that a guard holds for every concrete state.
- Run the complete agent workflow through the native plugin. Produce the TLA+ model, complete TLC verification, generate constraints, implement the application change, inspect Pele output, and pass the applicable native and CI checks.
- Exercise feature addition, a requirement change, and a defect fix in Parangsae. Regenerate constraints from the specification. Record missed violations, false positives, unsupported cases, intervention, verification cost, and maintenance work.
- Resolve material findings and repeat affected workflows. Demonstrate continued use without per-change exceptions, omitted files, manual edits to generated policy, or recurring manual rescue.
- Keep TypeScript 7 and Rust backends consistent with the supported contract. Publish reproducible plugin packages, installation instructions, diagnostics, scope statements, and verified release artifacts.
- Review the actual application changes and their evidence independently. Judge sustainability from the maintenance experience and remaining costs, not test counts or a green example alone.

Parangsae remains the pilot and its active development must be coordinated with its owning chat. This goal concerns software development and contract enforcement. Trading profitability and live-trading readiness are separate judgments.

## Current status

The public v0.1.0 preview supplies declaration and import checks, MCP, native plugin packages, and Pele rendering. Later source milestones add controlled TLC execution, full finite state owners, symbolic equality/copy owners, independent payload and provenance inputs, an original-action oracle, and checked model erasure. The [source-bound row profile](row-owned.md) now derives payload identity from supported Rust equality and retains complete rows. Native TypeScript 7 and Rust owners prepare complete values before committing their modeled transition. These changes do not update the older preview release artifacts.

The local Parangsae `codex/sgd-fact-merge` branch integrates generated owners for its four collector Fact types. Temporary Parquet tests exercise original-row retention, known Kline schema equivalence, unknown-schema separation, complete partition rollback, and conflict reporting. Local native checks pass. The source analyzer covers inventoried production libraries. TypeScript receives authenticated representation DTOs, whose validation does not reproduce Rust constructor preconditions. The partition fold remains handwritten, and the binding does not establish exclusive storage writers or persistence guarantees.

The compiler milestone merged in [SDK PR #4](https://github.com/KimSeogyu/specification-guided-development/pull/4) after Linux CI passed. [Parangsae draft PR #9](https://github.com/KimSeogyu/parangsae/pull/9) now pins that SDK and supplies a reproducible source/model/erasure entry point. Fresh-cache installation, regeneration, artifact-drift refusal, and independent application/architecture review have local evidence. Required-CI activation is an unapplied proposal awaiting human approval. The first draft passed [its existing required CI jobs](https://github.com/KimSeogyu/parangsae/actions/runs/40020720678). The new mandatory source/model check and actual maintenance cycles remain acceptance work. Rendered Pele QA found overlapping self-loop labels and zoom-in clamping; corrections are published in SDK PR #5 and the application pin has been upgraded without changing generated contracts. SDK PR #5 merged after [its final CI](https://github.com/KimSeogyu/specification-guided-development/actions/runs/40023076143) passed; the upgraded application also passed [existing CI](https://github.com/KimSeogyu/parangsae/actions/runs/40023126880).

A session-only Claude host trial is recorded. Codex host execution, permanent installation, and upgrade acceptance remain outstanding. Passing copied plugin-cache workflows does not complete those host checks. The [partition authority design](partition-authority-design.md) identifies the next implementation boundary. The production goal remains active and incomplete. Read the [verification record](verification.md) for the observed behavior, interventions, and limits.

The Goal card in the desktop app still contains the older wording because the available goal tools cannot edit an active objective. This document records the user's revised scope and governs the ongoing work.
