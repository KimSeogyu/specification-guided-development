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

The Parangsae `codex/sgd-fact-merge` draft now uses the generated v6 closed fold for all four collector Fact types. It removes the handwritten row map, action classification, counts, and caller lookup-key/day callbacks. Temporary Parquet tests preserve original rows, known Kline schema equivalence, unknown-schema separation, whole-partition refusal, and every conflict observation. New baseline symbol/day regressions fail against the prior committed implementation with a fresh Cargo target and pass with the generated fold. Native workspace, Gherkin, property, Clippy, formatting, architecture-policy, installed-SDK source/model/erasure, and committed-range checks pass locally. The source analyzer still has its admitted production-library scope. TypeScript DTOs do not reproduce Rust constructor preconditions. Physical paths, loading, writer and log dispatch remain ordinary unbound application code.

The pinned SDK workflow provides locked installation, source/model/composition freshness, payload erasure, exact TypeScript 7 checks, and fresh Pele views without rewriting tracked output during verification. Earlier row-binding and viewer milestones are retained in the [verification record](verification.md). Required-CI activation remains a concrete unapplied proposal awaiting the already-requested human approval. Existing application CI does not run that new source/model gate.

[SDK PR #8](https://github.com/KimSeogyu/specification-guided-development/pull/8) merged the [closed partition data fold](partition-fold.md) after its final Linux CI passed. The actual [Parangsae draft PR #9](https://github.com/KimSeogyu/parangsae/pull/9) pins that source and carries the application migration; its [existing remote CI](https://github.com/KimSeogyu/parangsae/actions/runs/40034930344) passed the closed-fold revision, including the existing Kani arithmetic job. That workflow still does not run the new source/model gate. The required-CI activation proposal remains unapplied. The following implementation must bind the selected resource and actual writer, classify raw/history/manifest/log namespaces, and cover admitted additional targets and aliases. The checked data fold is not a fallback completion for those requirements.

Session-only Claude and real Codex host trials are recorded. The [repeatable Codex host verifier](codex-host-verification.md) freshly generated, inspected, visualized and checked supplied LedgerFact models through actual MCP calls, then ran native Rust and TypeScript checks. Its corrected real run passed with ordinary user execpolicy rules active. It uses explicit per-session MCP wiring and documented per-tool approvals. Plugin-manifest discovery, permanent installation, upgrade acceptance, and native model authoring from a new requirement remain outstanding. Passing a copied cache or manually wired session does not complete those checks. The [partition authority design](partition-authority-design.md) identifies the next implementation boundary. The production goal remains active and incomplete. Read the [verification record](verification.md) for the observed behavior, interventions, and limits.

The Goal card in the desktop app still contains the older wording because the available goal tools cannot edit an active objective. This document records the user's revised scope and governs the ongoing work.
