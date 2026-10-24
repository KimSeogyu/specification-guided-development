# Verification

The initial implementation was exercised on macOS arm64 with Node.js 24, TypeScript 7.0.2, Java 17, and Rust 1.92.
The same checks, ingestion workflow, and isolated plugin verification also passed in GitHub Actions on Linux x64.
The finite-owned milestone also passed [its separate Linux CI run](https://github.com/KimSeogyu/specification-guided-development/actions/runs/39996215994). Later milestones retain their own local and CI evidence in the associated pull request.

## Finite-owned milestone

The source now includes real pinned-TLC tests for full-variable state preservation, isolated dependency closure, rejected reductions/overrides, changed-source rejection, and complete verification receipts. Native TypeScript 7 and Cargo consumers exercise generated owners without declaration-style transition calls. Tests compare all reachable fixture state/action decisions with the graph, reject private-state writes and construction, and verify snapshot independence and revision exhaustion.

A real TLC integration test compares both languages' complete snapshot traces. It changes the TLA+ submission requirement, checks that the old output is stale, regenerates, and verifies the changed native behavior. Model-only generation can render multiple initial states, nondeterministic edges, and terminal graphs; executable generation refuses unsupported choices. A concurrent project JSON edit is rejected before output creation.

Read [the finite-owned contract](finite-owned.md) for the actual trust boundary. These checks establish per-live-object finite safety. They do not establish persistent identity, effect atomicity, all application call paths, or completed Parangsae adoption.

An independent agent followed the revised Codex skill through the source plugin launcher to create a new four-state job model and native TypeScript/Rust consumers. Both retained the two Ready guard states, rejected Run before Validate, accepted the intended lifecycle, and preserved state/revision after rejections. The trial needed a consumer tsconfig rootDir adjustment and a local SVG rendering adjustment; it required no generated policy edit. It exposed an unclear terminal self-loop description, now corrected in both modeling guides. Browser interaction and actual installed agent hosts were outside that trial.

Both prepared native plugin packages also pass the MCP workflow from independent copied caches, including full-state generation, packaged TypeScript 7 compilation, runtime tamper checks, Pele, and imported-authority rejection. These cache tests do not establish installed-host operation.

## Symbolic input milestone

The source adds pinned semantic XML parsing and a v3 equality/copy relation compiler. The configured finite witness and an independent observer module compare original TLA+ actions with every reachable state/input pair. The orbit check separately validates the admitted data-independent relation, invariants, square action properties, ambiguity, scalar comparison semantics, and configured deadlock policy.

Native TypeScript and Rust consumers agree on complete receipts for A→B→C→A, including assignment origins, original stored A, latest rejected C, and the distinction between data `none` and scalar string `none`. A requirement change to Same resolves the conflict after receiving the original stored value, preserves the existing invariants, and changes both languages after regeneration. Stable generation, edited-artifact refusal, imported-DOT refusal, model-only cleanup, and both Pele scopes are exercised.

Independent adversarial tests use real TLC to expose and retain checks for ignored assumptions, lost square-action stuttering, action-level pure-helper applications, typed model values, scalar type errors hidden by a two-atom fixture, and deadlock that appears only with three distinct atoms. These tests and the orbit argument do not constitute a machine-checked correctness proof for the compiler.

The actual Parangsae `ManifestWrite.tla` and configuration were also compiled directly with their own co-located pinned JAR, writing only SGD scratch output. This confirms model compatibility. It does not establish application integration or authorize operational data writes.

The full symbolic milestone also passed [Linux CI](https://github.com/KimSeogyu/specification-guided-development/actions/runs/40003962674), including native tests, the prior ingestion application, and both prepared plugin-cache workflows.

## Independent payload and provenance

Project v4 preserves independently tagged payload and provenance inputs. Real SANY/TLC tests check two and three bounded binders, UID substitution, pairwise domain disjointness, and refusal of repeated domains, typed atoms, dependent ranges, or missing/misordered action arguments. The original-action oracle checks the complete configured input product and catches incorrect metadata assignments and extra provenance guards.

Native TypeScript 7 and Rust consumers compare complete before/after receipts, named input origins, first provenance, latest rejected provenance, malformed input rejection, state privacy, snapshot independence, and requirement-change regeneration. Repeated rejected payload B with a new receipt replaces the latest rejected provenance; repeating the original payload preserves the complete state. Identical Unicode text in distinct nominal domains remains distinct. Independent generator comparison confirms that the single-input native artifacts remain unchanged.

The new `refine` CLI and `sgd_refine` MCP compare the initial projection and every concrete equality/copy input class with the abstract program. They check enabledness, action classification, and every projected next variable. Adversarial checks cover provenance-dependent admission, wrong assignments, collapsed action mappings, and metadata-only changes that must not receive the concrete square-stutter exception. An independent review additionally exercised hidden registers whose atom labels differ from projected registers. Metadata laws still require explicit concrete properties; erasing a field cannot establish its preservation.

This is compiler and model-composition evidence. It does not establish actual Fact encoding, Parangsae code adoption, partition authority, exclusive writers, persistence, or sustainable maintenance. Supplied IR erasure also does not attest original-source TLC provenance. The [pilot design](pilot-fact-merge-design.md) records the actual source contracts and pending collector PR dependencies.

Both prepared native plugins also completed the v4 workflow from independent copied caches: original source checking, complete finite input tuples, packaged TypeScript 7 receipts, `sgd_refine`, Pele domain/provenance labels, tamper checks, and imported-DOT refusal. These tests preserve the distinction between a copied package cache and an actual installed agent host.

## Source-bound complete rows

Project v5 derives payload identity from supported Rust Fact equality and derives provenance from excluded or normalized fields. The analyzer checks every declared field, wrapper representation, getter, and supported finite equivalence class. The native consumers retain complete rows, including first receipt time and exact raw schema. TypeScript uses authenticated immutable DTOs derived from the Rust representation. Its representation checks do not reproduce native constructor preconditions. Parity applies to values admitted by the native types.

The generated Rust adapter admits only the analyzed Fact types through a sealed bound. It prepares encodings, complete row copies, source action identity, and binding checks before committing the borrowed owner's transition. TypeScript preparations are immutable, single-use, and bound to their owner and revision. Native tests check dropped and failed preparations, stale commits, private state, forged rows, mixed copy origins, and unchanged state after rejection. Requirement changes regenerate both targets. Changes to actual Rust equality also change the generated TypeScript behavior. Read [the row contract](row-owned.md) and [the analyzer profile](../tools/rust-bindings/README.md) for the admitted source language and environment assumptions.

Independent review required material corrections. A locally shadowed qualified `matches!` could invent the wrong equality quotient. A sibling macro could hide a custom Drop implementation and introduce a callback after commit. The analyzer now rejects those constructs, related trait and primitive shadowing, and nonlocal implementations hidden in macro input. Native reproductions and source-mutation regressions retain the findings. Integration review also showed that a configurable Same/Clash outcome map could approve a conflicted partition. V5 removes that map, rejects legacy `outcomes` configuration, and preserves exact TLA+ action IDs in the native enum. An action rename now requires the application's exhaustive match to change. Source action identity still needs application behavior evidence for its business meaning.

Generation records source identities and rechecks them before publication. Controlled output exclusions allow regeneration without making old generated bytes their own inputs. `build --check` refuses source drift, altered stable provenance, and edited generated bytes. Rust formatting uses an explicit profile and configuration. A formatter-version-only mismatch no longer rejects identical output. These checks cover safe regeneration and supported source bindings, not arbitrary application logic.

The final local `npm run check`, `npm run build`, `npm run plugins:package`, and real-TLC `npm run plugins:verify` completed after the action-map removal. Both isolated copied plugin caches exercised v5 with their bundled Rust analyzer, packaged TypeScript 7.0.2, full payload/provenance behavior, the original-action input oracle, supplied-IR erasure, Pele, and refusal cases. The local evidence files were `.runtime/row-final-check.log`, `.runtime/row-final-package.log`, and `.runtime/row-final-plugin-verify.log`. Runtime logs are disposable. The reproducible tests are `tests/prepared-owners.test.ts`, `tests/row-backends.test.ts`, `tests/row-compiler.test.ts`, `tools/rust-bindings/tests/analyzer.rs`, and `scripts/verify-plugins.mjs`.

The v5 milestone also passed [Linux CI](https://github.com/KimSeogyu/specification-guided-development/actions/runs/40019410080) and merged in [SDK PR #4](https://github.com/KimSeogyu/specification-guided-development/pull/4). That result verifies the SDK's configured workflow. It does not establish remote Parangsae CI, installed-agent acceptance, the planned partition authority, or sustainable application maintenance. A released v5 package remains pending.

## Earlier Parangsae row integration

This section records the earlier v5 integration in [Parangsae PR #9](https://github.com/KimSeogyu/parangsae/pull/9), stacked on Kline schema PR #5. The collector's `manifest.rs` used generated FactOwner for KlineFact, FundingFact, MetricsFact, and BookFact, removing the handwritten per-key Stored/Slot/merge_fact dispatcher. Its private, consumed MergeOutcome retained the partition decision and storage callbacks. V6 subsequently removed that handwritten fold and result type; the current closed-fold and required-CI evidence is recorded below. The downloaded-object manifest remained separate from both implementations.

Fresh temporary Parquet tests verify both directions of schema 1/2 equality while retaining first raw schema, first receipt, and file bytes. Unknown Kline schemas remain equal only to the identical raw value. Tests also exercise all four Fact families, rollback of provisional new keys after any conflict, every rejected pair, unchanged counts, and a conflict-log failure without partition replacement. Repeating the identical rejected row still emits a separate conflict observation when the modeled full state stutters. The Gherkin scenario exercises a new key, two conflicts, and an equal row in one refused partition trial.

The local full workspace test and Clippy runs passed before the final direct-action enum migration. After that migration, affected collector tests, Gherkin, workspace Clippy with denied warnings, and formatting passed again. ArchitecturePolicy passed SANY and TLC. `xtask spec generate --check` and current-source `spec enforce` passed. Existing Kani core and instrument harnesses passed. Those harnesses do not verify generated Fact ownership. Logs were stored in the application's `.runtime/fact-workspace-tests.log`, `fact-direct-action-tests.log`, `fact-direct-action-clippy.log`, `fact-direct-action-fmt.log`, `fact-spec-validate.log`, `fact-spec-generate.log`, `fact-spec-enforce.log`, and `fact-kani.log`. The initial spec-inspection command needed its required symbol argument; subsequent collector and xtask inspections completed. No live collector, trading operation, or stored market-data write was part of these checks.

The final installed-SDK artifacts passed the complete workspace tests, formatting, and committed-range policy enforcement. Independent implementation and architecture review found no concrete regression. The application now pins the verified SDK commit and supplies `spec/sgd/verify.mjs`. A fresh task-local npm cache with SSH disabled installed successfully. Installed-SDK regeneration and read-only verification passed for actual source binding, both models, erasure, TypeScript 7, and Pele rendering. An edited generated owner failed with `TLC104`; restoration passed without changing managed artifacts. These checks replace the earlier adjacent-checkout-only workflow.

At that milestone the first draft passed [existing application CI](https://github.com/KimSeogyu/parangsae/actions/runs/40020720678), while required-CI activation was still an unapplied proposal. Those earlier jobs did not execute the new source/model/erasure entry point. Rendered Chrome inspection also found overlapping self-loop labels and zoom-in clamping. A viewer correction and pinned upgrade passed local and remote checks. Later sections record the subsequent approved required-CI activation. No readiness or completed-adoption claim follows from the earlier integration.

The earlier generated contract governed each live per-key owner; its surrounding handwritten fold was replaced by v6. Duplicate baseline keys retain the loader's last-wins Write behavior. Exclusive writer coverage, physical resource identity, conflict-log/file atomicity, and crash persistence remain separate obligations. The current source inventory covers production libraries, not every Cargo target, feature, test, build script, or procedural macro. Actual feature, requirement-change, and defect-fix maintenance cycles remain necessary for sustainable Parangsae adoption.

## Actual Claude Code host trial

Claude Code 2.1.304 loaded the prepared Claude plugin through session-only `--plugin-dir`, invoked its native Skill, and used the bundled MCP for model checking, generation, inspection, and Pele. The agent wrote a new `OriginalSlot` model with a Boolean control variable and a different action vocabulary, then built strict TypeScript 7.0.2 and separate Rust consumers. Both produced Store→Reject→Reject→Keep for A→B→C→A, preserved original A and latest rejected C, and checked complete snapshots, revision, assignment origins, and data/sentinel separation. The parent read the model and consumers and independently reran both native programs; complete traces agreed.

The trial required a correction. The first process was stopped after a scratch shell heredoc fell outside the harness allowlist; the agent had adapted with file tools and already completed model generation. An unnecessary offline Node typings install also lacked a cached dependency. A bounded continuation used file tools for writes and a strict consumer without Node typings, completed both native runs and packaged `build --check`, and exited successfully. These interventions remain part of the [sanitized trial record](native-trials/claude-code-2026-10-24.json), not a claim of unattended first-run success.

This was an actual Claude host operation with session-only plugin loading. It did not test permanent marketplace installation, Codex agent execution, or Parangsae application adoption. Existing native credentials were used only by the official CLI; no credentials were copied and no global agent configuration was changed. Raw host logs, prompts, and account metadata are excluded from the public record.

## Reproduce

```sh
npm ci
node scripts/fetch-tlc.mjs
TLA2TOOLS_JAR=.runtime/tla2tools.jar npm run check
npm run demo
npm run verify:ingestion
npm run plugins:package
npm run plugins:verify
```

Source builds of the row analyzer require Cargo. Rust row generation requires rustfmt. Prepared native plugin packages bundle their host's analyzer executable. The row tests exercise real native consumers in both languages.

`npm run check` includes a real TLC integration test when `TLA2TOOLS_JAR` is set.
The CI workflow sets that variable.
Without it, that integration test is skipped and must not be reported as completed.

## Application workflow

An independent agent used the packaged skill to create the ingestion example from behavioral and architectural requirements.
The behavior model contains a string state and a validation-history Boolean.
The architecture model includes a previous-module variable and an explicit Composition module for crate registration.

The same business source files pass both generated checkers in TypeScript and Rust.
A direct Received-to-Stored declaration fails with `TLC001`.
A nonliteral declaration fails with `TLC002`.
A Handler-to-Storage import fails with `TLC003`.
Both intentionally faulty model variants fail their TLC invariants before generation.
Native application tests exercise transition guards and terminal states.

The workflow exposed defects that the original examples did not exercise.
The importer now decodes escaped TLC conjunction prefixes in multi-variable labels.
Rust function-call declarations allow architecture and behavior checks to compose without opaque macro exceptions.

## Compiler and package checks

Backend tests execute generated checkers on permitted, forbidden, and unsupported source forms.
They cover aliases, raw Rust identifiers, conditional TypeScript import resolution, and explicit file ownership.
Frontend tests reject incomplete graphs, stale generated source, unowned-file replacement, and concurrent output writers.
The model receipt's stable fields are checked independently of temporary execution paths.

`npm run plugins:verify` copies each prepared plugin into an isolated cache outside the source checkout.
It starts a real stdio MCP connection and runs model checking, inspection, a generated native TypeScript check, and Pele rendering.
Native Claude Code manifest validation is a separate check.
The workflow does not install either plugin into the user's account or change global agent settings.

## Limits

The linter checks the supplied files and supported source profiles.
Transition declarations do not prove that arbitrary function bodies preserve the model.
The declaration-checking diagnostic graph projects one string variable and loses guards over other variables. Executable finite, symbolic, and row profiles have separate contracts and verification scopes.
Containment links in the viewer are not refinement proofs.
Native TypeScript API entry points are unstable and pinned to 7.0.2.
Prepared plugin archives contain platform-specific native binaries and reject a different host.

## Closed partition fold and interrupted publication

The v6 source composes complete row orbit roles, the full finite aggregate graph, and literal SANY family metadata. Native TypeScript 7 and Rust behavior checks cover first metadata retention, last-wins baseline duplicates, exact original Noop/Refused rows, provisional insertion rollback, repeated stutter conflicts, signed key ordering, internal symbol/day checks, and single consumption. Native compile/runtime attempts cannot submit observations or receipts, construct or restore a closed result, reuse a consumed result, or supply an arbitrary Fact implementation. Rust primitive and consumer Clippy use warnings as errors. Default v5 generated bytes remain compatible.

Real SANY/TLC checks reject each required control obligation independently replaced by TRUE, even though the unchanged finite action graph still passes its separate laws. Literal metadata rejects helpers, imports, assumptions, unsupported fields/calendars, overlapping datasets, and unsupported keys. Compiler integration checks original-source freshness and managed publication separately. Read the [v6 guide](partition-fold.md) for the exact source profile and unbound-report limit. The following record covers the actual Parangsae v6 migration. Resource/writer authority, all-target source and sink coverage, native host lifecycle, and sustainable maintenance remain incomplete.

Managed output now journals before/after bytes before per-file publication. Actual SIGKILL tests cover interrupted first creation and upgrade, live owner refusal, concurrent recovery, read-only managed-file checks, and preservation of changed/unrelated files. Independent review reproduced and corrected a literal-backslash parent-symlink escape and a parent-permission regression. Read the [recovery scope](managed-output.md); early incomplete owner metadata remains manual, and arbitrary-reader snapshots and power-loss durability are not established.

An independent agent used only a copied Codex plugin, its skill/references, and a new LedgerFact application. It authored the models and metadata, generated and integrated both targets, ran native refusal/metadata/signed-key checks, checked output drift, and inspected both Pele views. One agent-authored negative probe incorrectly sent a branded token to the raw-row factory and was corrected after the factory refused it. The trial also found missing package/build instructions in the v6 generated READMEs; those instructions were added. This is a copied-cache skill trial, not a permanent installed-host or Parangsae adoption result. Normal toolchain caches may have been used; no global agent configuration was changed.

The Parangsae v6 migration replaced its handwritten partition fold with v6 generation from its installed pinned SDK. Read its `spec/sgd/README.md` for the current commands and native evidence. Both malformed loaded-group regressions failed against the prior committed code in a fresh isolated target because it accepted insertion; the new implementation refuses them without replacing Parquet or logging a conflict. Complete workspace checks and committed-range architecture enforcement passed locally. The [closed-fold revision's earlier remote CI](https://github.com/KimSeogyu/parangsae/actions/runs/40034930344) also passed, including its existing Kani arithmetic job. Native source review preserved ObjectManifest, ManifestLog, physical codecs and log formatting. Count conversion and cross-day totals are checked before that partition's IO. Physical resource identity and exclusive writers remain unbound.

After the user's explicit approval on 2026-10-24, Parangsae draft PR #9 applied the proposed readonly source/model verifier inside the existing required `spec-arch` job. Fresh locked installation and verification passed locally with Node.js 24, preserving every tracked generated artifact. Its [final remote CI](https://github.com/KimSeogyu/parangsae/actions/runs/40043103911) passed SDK installation, the new Fact source/model/erasure verifier, existing architecture enforcement, and all other jobs including Kani and gate. The obsolete proposal patch was removed. This change did not merge the draft or provide storage authority.

A real installed Codex CLI also completed a fresh session-only MCP workflow on LedgerFact. Actual JSONL records show successful build, both IR inspections, Pele generation and `check:true`, followed by Rust and TypeScript 7.0.2 behavior checks on the fresh output. The first exploratory attempt stopped when MCP writes required approval under approval-never. A per-invocation correction approved the build and visualization tool names and restricted the server's tool list. The verifier checks observed argument paths afterward; these settings do not confine arguments. Global configuration, authentication and tool read-only annotations stayed unchanged. This proves manually configured native MCP/skill execution. Plugin discovery, permanent installation and upgrade/rollback remain separate acceptance work.

The [repeatable native host verifier](codex-host-verification.md) subsequently passed with ordinary user execpolicy rules active. It copies original LedgerFact models and source with no generated output, requires the exact successful MCP sequence, compares complete native rows and conflict pairs, and checks that the original fixture and copied runtime remain unchanged. Its first run retained a failed result because repeated context reads exceeded the initial protocol rule. The correction permits only identical read helpers, retains the single native check and all action-order checks, and rejects orphan completion events. The corrected fresh run passed. A later preflight review reproduced evidence output inside an original input through a symlink alias. Physical ancestor resolution now refuses that location before directory creation; filesystem tests cover the correction without an agent invocation. Account-free protocol and path checks are part of `npm run check`; the authenticated native workflow remains manual. The fixture supplies its models, so this run does not establish model authoring from a new requirement or permanent plugin installation.


## Mixed input compiler and abstract resource protocol

The compiler API now lowers named opaque and finite inputs together into symbolic IR version 3. Real controlled SANY/TLC and original-action oracle runs cover string, Boolean, and integer choices, disabled tuples, complete successors, and agreement with the original DOT relation. Native TypeScript 7 and Rust fixtures compare complete traces with the interpreter. They exercise exact scalar values, preparation reuse, invalid inputs, privacy, and Unicode controls. Generated Rust consumers pass Clippy with warnings denied. Legacy project versions and IR versions 1 and 2 retain their existing profiles.

The eleven-role resource fixture has separate controlled source, lowering, relation, and Pele checks. Replacing each required configured predicate with `TRUE` still permits generic checking when its guards remain safe, but the resource checker refuses the missing obligation. Removing the Load identity guard and weakening Affinity produces a declared relation that generic lowering and the original-action oracle faithfully accept. The resource checker rejects that unsafe relation. Required expressions are checked in the admitted normalized form, independently of property and action names.

The full local check ran with the real TLC JAR and no skipped tests. Ingestion, partition counterexamples, packaging, and both isolated copied-plugin workflows also passed. Independent core, native-backend, law-checker, and documentation reviews found and corrected a Rust Unicode source-encoding defect and inaccurate provenance/status wording. See the [resource protocol reference](resource-protocol.md) for the exact profile and API. These results establish abstract compiler behavior. Actual selected file loading, private writer ownership, archive coverage, all-target source coverage, and sustainable Parangsae maintenance remain required.


## Schema validation dependency

The SDK now pins Zod 4.6.6 and uses its current schema API. The [reviewed advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) affects earlier versions. The [maintainer fix](https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd) checks collection size limits before validating elements. Regression tests use the actual whole-row pair list and finite-input vocabulary schemas: oversized lists fail at the collection limit without reading their invalid children. Valid boundary values and invalid elements within the bound retain their expected behavior.

Independent migration review found that Zod 4 silently drops an own `__proto__` record key before checking the key schema. Shared record parsing now refuses that key before parsing. It also refuses inherited enumerable keys rather than silently omitting them. Ordinary own `constructor`, `prototype`, and `toString` keys and null-prototype records remain supported where the enclosing schema permits them. Public model, erasure, witness, and dependency-binding regressions check that unsupported keys cannot disappear during validation. This is an input-preservation correction, not evidence of an application writer bypass or prototype pollution.

The MCP schema checks cover required paths, the optional `check: false` default, invalid argument refusal before output creation, ordinary generation, and readonly stale-output refusal. Prepared Codex and Claude Code runtimes resolve the same patched package. Older published archives and applications pinned to an earlier SDK source do not change with this repository lock.

The collection fix applies to schemas with upper-size bounds. It does not bound arbitrary input file sizes, unbounded record or graph collections, recursive guards, or total validation memory. Those require a separate input-budget design. Exact TLA/native integer values remain decimal strings. Numeric counters use safe JavaScript integers under Zod 4.


## Main integration and dependency maintenance

The reviewed v6 migration and approved required verifier merged through [Parangsae PR #9](https://github.com/KimSeogyu/parangsae/pull/9). Its final integration CI ran all existing jobs successfully, including the new readonly verifier, architecture TLC, separate TLC and Kani jobs, native workspace tests, and gate. Coverage and funding empty-date contracts were preserved during integration; native generated code retained its existing bytes while source inventories and derived receipts were refreshed.

[Parangsae PR #11](https://github.com/KimSeogyu/parangsae/pull/11) subsequently updated only the SDK source pin and matching dependency lock to use patched Zod 4.6.6. Fresh Node.js 24 locked installation, actual source/model/composition/erasure checks, TypeScript 7.0.2 no-emission builds, Pele, and application-locked MCP negotiation passed locally. Architecture inspection and normal and committed-range enforcement passed. Independent dependency review found no other package additions, removals, or version drift. No tracked model or generated artifact changed.

The [maintenance CI](https://github.com/KimSeogyu/parangsae/actions/runs/40047606677) passed SDK installation, readonly verification, and architecture enforcement inside `spec-arch`, plus native workspace tests, Clippy, formatting, cucumber, and gate. The unchanged change filters skipped the separate `tla` and `kani` jobs. Controlled Fact/Manifest and architecture TLC still ran inside `spec-arch`. The PR merged normally through the active strict gate and linear-history rules. This is dependency maintenance, not a new business-model authoring trial or completed adoption.

## Closed Rust source scope

The native helper now exposes a separate `source-scope --root APP` operation and `analyze_source_scope` API. It captures actual Cargo targets and dependencies after local configuration/manifest preflight, audits the supported source, then repeats discovery and source checks before returning. The old v5 row-binding path remains separate. This mode has no generated-file exclusions or caller-supplied target/effect permission list.

Independent native probes compiled their fixtures only to establish valid Rust. Direct, reexported, aliased, unused-private, and UFCS writers and an added automatic binary are refused. Pure local function aliases and supported ordinary paths pass. Required capture/recheck cases cover changed source, new targets/configuration and ambiguous module paths. A reviewer found executable doctest text outside the ordinary item/body walk; the first profile now refuses all doc attributes and doc comments. Ordinary comments remain supported.

The [native reference](../tools/rust-bindings/README.md#closed-source-scope-mode) defines its deliberately small unconditional language, local-only dependency profile, path/size limits and trusted host/toolchain boundary. Current Parangsae types, registry dependencies and codecs are unsupported by this new mode. Its successful report always has `storageAuthority:false`; it is neither an application compilation result nor selected-file/writer authority.

## Observed Write results

The [observed Write profile](resource-protocol.md#observed-write-outcomes) adds a separate twelve-role binding and validator. It retains the existing eleven-role API and relation. Controlled source builds and the original-action oracle preserve successful replacement, failure before replacement invocation, uncertain failure, and failure after a confirmed replacement. The last case keeps `Failed`, `Replaced`, and one confirmed replacement. Zero after an uncertain result does not claim an unchanged file.

Source-law tests replace required predicates with `TRUE`, remove difficult outcome branches, change resources, and omit outcomes for one load origin or coverage state. The validator refuses these cases through complete source obligations and accepted and disabled orbit relations. Coherent event renaming remains supported. An abstract event's name cannot establish its native meaning.

Generated TypeScript 7 and Rust consumers produce the same complete receipts as the interpreter for both coverage compositions. A native consumer writes real selected files, observes failure before invocation, and successfully renames another file before a later missing-metadata error. It compares both file bytes and final observations and refuses another abstract attempt. The consumer supplies these observations itself. It does not establish generated IO ownership, a source gate, or actual Funding Parquet authority.

Independent review corrected loss of the original Zod object schema API, widened inferred return types, changed legacy diagnostics, and wording that overstated recognition of a native uncertain error. Separate version 2 entry points preserve the original schema object and version 1 return type. A real TypeScript 7 compilation checks those APIs. Its first invocation omitted TypeScript 7's required `--ignoreConfig` flag for explicit file arguments. Adding that flag corrected the test runner without changing compiler behavior.
