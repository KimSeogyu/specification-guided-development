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

The public v0.1.0 preview supplies declaration and import checks, MCP, native plugin packages, and Pele rendering. The source now includes controlled TLC execution, full finite state owners, and a symbolic equality/copy compiler with immutable data input, native TypeScript 7/Rust owners, and an independent finite input oracle. Read the [finite-owned](finite-owned.md) and [symbolic-owned](symbolic-owned.md) contracts. Actual Parangsae payload/authority/effect bindings, persistence where needed, project-wide coverage, native installed-agent workflow, and sustainable maintenance evidence remain outstanding. The production goal remains active and incomplete.

The Goal card in the desktop app still contains the older wording because the available goal tools cannot edit an active objective. This document records the user's revised scope and governs the ongoing work.
