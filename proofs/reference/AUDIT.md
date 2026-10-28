# Preservation proof scope

The reference method has a finite source language, executable compilers and
checkers, and independent operational semantics. A successful check must imply
the stated contract. The contract is not defined as checker success.

The reference-pipeline requirements below are satisfied within the declared
finite semantics. On 2026-10-28, all 23 modules passed a fresh isolated Lean
4.35.0 check. Independent review examined the new operational lowering,
trace, migration, and installation proofs. The native implementation boundaries
listed below remain outside these theorems.

## Requirements and evidence

| Requirement | Proof evidence | Scope or remaining work |
| --- | --- | --- |
| Supported specification semantics | `CompilerPipeline.Source`, `SourceStep`, `extracted_edges_exact` | Finite guards and updates. No verified parser from native TLA+ or SANY. |
| Correct compilation | `compile_success_accepts_iff_source_step`, `compile_success_rejects_iff_no_source_step` | Acceptance and refusal both match the source relation. |
| Unsupported and ambiguous inputs fail closed | `compile_success_iff_admitted_deterministic`, `unsupported_source_is_refused`, `ambiguous_source_is_refused` | Unsupported dead branches are refused too. Projected and unknown graph inputs cannot supply exact authority. |
| Reachable graph correspondence | `imported_graph_source_reachability_exact`, `GraphLintBridge.imported_contract_iff_source_conformance` | Exact on the reachable domain. No equality claim for unreachable source states. |
| Derived executable checker soundness | `SemanticConstraints.generated_constraints_iff_semantic_conformance` | Complete finite configuration enumeration establishes equivalence with the independent semantic contract. |
| Structural mediation | `StructuralLint.command_check_iff_authority_contract`, `checked_raw_trace_obeys_specification` | Raw writes and resets remain executable in raw semantics and are rejected by checking. |
| TypeScript reference generation and source checks | `LanguageProfiles.ts_authority_lookup_exact`, `ts_combined_constraints_iff_explicit_contract` | Finite control flow and immutable aliases. No native heap, async execution, FFI, or parser proof. |
| Rust reference generation and source checks | `RustProfile.generated_constraints_iff_source_contract`, `typescript_and_rust_generated_authorities_agree` | Scoped loans and reborrows in a closed finite subset. No native borrow-checker or Rust product claim. |
| Complete program state | `ProfileComposition.runtimeEnumeration`, `global_combined_lint_iff_explicit_contract` | Owner, every component PC, and environment PC are included. Every modeled actor is checked. Native module discovery is outside the proof. |
| Binding identity | `ts_static_check_exact`, `checkTSInstalled`, `imported_ts_execution_preserved`; `MixedProfiles.installed_rust_check_exact`, `imported_rust_execution_preserved` | Installation checks fix the intended program body, root binding, and authority behavior over every finite query. Reachable conformance alone is insufficient. |
| Fixed-epoch labeled observations | `CheckedTraces`, `GraphCheckedTraces`, `MixedCheckedTraces.accepted_mixed_graph_preserves_labeled_trace` | Source-generated and imported-graph-generated constraints preserve the actual whole-runtime label sequence, including mixed programs. |
| Approved development | `CertifiedPipeline.certified_profile_development_preserves_root_invariant` | Full-source compilation. Approval, adjacent refinement, and live-state migration are separate premises. |
| Reachable-graph development | `GraphDevelopment.checked_migration_is_admitted`, `graph_development_preserves_validated_root` | Checked. Target-domain membership accompanies commuting migration. Full-source adjacent refinement remains an explicit obligation. |
| Mixed TypeScript and Rust execution | `MixedProfiles.mixed_checker_exact`, `source_bound_mixed_development_preserves_root_invariant`; `MixedGraphDevelopment.source_bound_mixed_graph_development_preserves_root` | Raw operational lowering, whole-runtime checking, and source-bound development hold for full sources and reachable graphs. |
| Non-vacuity and necessary assumptions | Progress/refusal witnesses and counterexamples in each module | Mixed histories include execution, live edits, approved migration, and rejection. Counterexamples cover omitted state, bypasses, invalid migration, and unused wrong authority. |
| Isolated kernel verification | `scripts/check-reference-proofs.mjs` | The stable combined run passed with a fresh dependency cache, Lean 4.35.0, diagnostic rejection, and axiom checks. No `sorryAx` or unapproved axiom appeared. |

The verification command was `SGD_LEAN_BINARY=/absolute/path/to/lean npm run
proofs:check`. The repository's `npm run check` and `npm run build` also passed.
Those product checks are not evidence for the formal theorems. Changes in this
work are limited to reference proofs, their documentation, and their verifier's
module list.

## What preservation means

For a fixed epoch, every modeled execution step has the same accepted, rejected,
or internal observation in the specification. The owner invariant holds at every
reachable configuration. Structural checks additionally reject unsupported
instructions and bypasses even when unreachable.

Across approved revisions, the projected live state retains the root invariant.
The proof requires a refinement relation and a commuting migration. A reachable
graph also requires the migrated state to belong to the new reachable domain.
Approval alone proves none of these facts.

An independently intended application requirement still needs a faithful
interpretation in modeled state. Missing amounts, effects, identities, or data
cannot acquire guarantees from a proof about a smaller state. Finite-trace
safety does not establish fairness, termination, persistence, or effect atomicity.

These are reference-method proofs. They do not certify the released TypeScript
emitter, native parsers, TLC execution, or the experimental Bend compiler.
