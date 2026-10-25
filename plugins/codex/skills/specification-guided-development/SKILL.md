---
name: specification-guided-development
description: Model structure and behavior in TLA+. Diagnose failures through owning contracts and bindings. Generate state owners or TypeScript and Rust source diagnostics when adopting or changing Specification Guided Development.
---

# Develop from checked structural contracts

## Check the running runtime once

At the first use of this skill in a conversation, call `sgd_update_status` if that tool is available.
Use `{ "host": "codex", "channel": "alpha" }`.
The alpha channel includes alpha releases and stable promotions.
Continue the user's work regardless of the result.
If the tool is absent, continue without claiming that the runtime is current.
Do not repeat the check for each model command or retry an unknown result automatically.

For `update-available`, mention the newer version and release page once.
State whether metadata lists a matching archive for the running platform.
Archive metadata does not verify archive contents or an installed plugin.
The result describes the running SGD runtime, not installed plugin inventory or the desktop app version.
Recommend the host's documented update mechanism when its configured source can fetch new releases.
A local directory marketplace cannot fetch a newer release archive by itself.
This check does not authorize an installation or a host setting change.
Handle a separately requested update under the user's existing authorization.
Do not create a background update job as part of this check.

## Establish the root structure

Read the request, accepted requirements, and root structure before feature implementation.
Establish missing top-level contracts before implementing the feature.
Represent required ownership, responsibility, time, information, and resource lifecycles as state in TLA+.
Follow those responsibilities from the root into lower-level models and application bindings.

For a change, derive the affected model closure from that root.
Include enclosing acceptance properties, participating actors, input origins, resources, and code bindings.
Do not select a convenient leaf model while omitting its enclosing responsibilities.
Record the available checked evidence for each relation between models.
Treat missing structure and unsupported enforcement as coverage gaps.
Do not dismiss an obligation because the current profile cannot check it.

Retain every state distinction required by an accepted property.
Record the assumptions and finite bounds that make the abstraction valid.
Choose algorithms, data structures, and internal organization within that contract and its assumptions.
Do not enumerate unrelated implementation details in TLA+.

When a `contract-system` root exists, read [the contract comparison guide](references/contracts.md).
Use `sgd_check_contracts` for the supported v3/v4 model comparison.
Keep required contracts outside that profile visible as unsupported obligations.
Do not remove a required contract or property to obtain a passing result.
A supplied-baseline comparison does not establish independent acceptance or native application authority.

## Select the modeling profile

Read the relevant profile in [the modeling guide](references/modeling.md) before you create or change a model.
Select the profile that matches the required guarantee.
For a closed partition data fold, read [the v6 composition guide](references/partition-fold.md).
For checked native row reconstruction, read [the codec recipe guide](references/codec-recipes.md).
The codec helper checks source and constructors and returns no storage authority.
Project v6 `partition-fold` composes checked complete-row and finite-control models with source-checked literal family projections.
Project v5 `row-owned` derives a complete-row binding from supported native Rust Fact sources and explicit payload/provenance state.
Project v4 `symbolic-owned` generates equality/copy behavior with two or three independent inputs and explicit provenance state.
Project v3 `symbolic-owned` generates equality/copy behavior over immutable string input.
Project v2 `finite-owned` generates state control for named, unparameterized model events.
For one synchronous fallible operation that must retain its actual payload, use the optional [retained-operation binding](references/retained-operation.md). Connect the generated owning result to the real application return boundary.
Project v1 generates diagnostics for declared transition triples or mapped imports.

## Select the contract

Read the user's request and the project's current requirements.
Record the selected model, its invariants, its finite bounds, and the application code that uses the generated artifacts.
Identify the actual state owner before you claim that the model controls runtime behavior.

Use TLA+ for application policy.
Use project JSON for model paths, language targets, and supported bindings.
Do not duplicate allowed edges in project JSON.

For data-bound equality/copy actions, select v3 for one input or v4 for two or three independent inputs.
Record how application payloads become immutable opaque Unicode string identities.
The adapter must preserve application equality, including any excluded metadata fields.
The generated API does not accept arbitrary objects or a custom equality callback.
Use distinct named domains for v4 inputs, with one binder per domain and pairwise disjoint configured TLC atoms.
Model associated provenance as explicit state and input when its preservation is part of the contract.
Assignment origins alone do not prove the behavior of omitted metadata.

For actual owned application rows, select v5 when the Rust source and model fit its supported profiles.
Use the application manifest, definition module, accessible Fact paths, and explicit excluded metadata fields.
The analyzer derives payload fields and finite equivalence classes from native Eq.
Do not write a second equality predicate or accept caller-supplied payload/provenance identities.
Every source field must be classified.
The Rust adapter admits only the audited concrete types through its sealed bound.
The TypeScript output is a portable DTO representation of that Rust schema, not a TypeScript source binding or Rust constructor validator.

For fixed finite state with unparameterized actions, select v2 `finite-owned`.
Keep every modeled variable in the exact automaton.
The compiler checks source semantics for reachable parameterized actions because TLC DOT can erase action arguments.
Do not infer that an action is unparameterized from its DOT label alone.

For module dependencies or literal transition declarations, select the corresponding v1 binding.
Use separate projects for architecture diagnostics and state ownership.
An optional v1 `parent` link displays containment in Pele.
Containment does not establish formal refinement.

Do not replace a generated owner with handwritten state or a parallel mutable copy.
A matching declaration beside an independent state assignment does not enforce the model.

## Diagnose before changing consumer code

Start with structural diagnosis before choosing a local repair.
An implementation bug violates the intended contract under sufficient coverage and enforcement.
A structural bug concerns missing or incorrect state, ownership, responsibility, time, information, lifecycle, composition, or enforcement.

1. Record the affected requirement and concrete failure or counterexample.
2. For new behavior, record the required outcome and forbidden paths.
3. Locate the owning model and enclosing acceptance properties in the root structure.
4. Check coverage of the required state, participants, paths, and lifecycle boundaries.
5. Check whether the model permits the forbidden path.
6. Inspect the actual binding, artifact freshness, and enforcement on the application path.

Missing ownership, state, lifecycle, composition, or coverage requires a structural repair.
If the model permits the forbidden path, repair the structure or specification.
If the model forbids that path, investigate the actual binding and enforcement before changing consumer logic.
A missing, stale, bypassed, or incomplete binding is an enforcement gap.
Permit a local implementation repair only after establishing the intended contract, sufficient coverage, and actual enforcement.
A caller's diagnosis label does not establish those facts.

Unsupported analyzer syntax does not establish a consumer defect.
Record the rejected construct, unsupported semantics, and resulting coverage gap.
Extend the supported profile or report that gap within the authorized scope.
Do not change consumer behavior merely to satisfy an analyzer.
Do not omit participating files or accept unknown constructs.

Repair the responsible structure before adding a local workaround.
Do not add an independent mutable copy of protected state or a handwritten policy table beside generated authority.
Do not weaken an invariant or change an expected oracle to make the implementation pass.
Do not edit generated policy code.

## Model and review

1. Write the TLA+ module and its TLC configuration.
2. Include the invariants and failure behavior required by the contract.
3. Create project JSON for the selected profile.
4. Run `sgd_model` to check the configured finite instance without generating language code. For v6, run this on its referenced row and control projects.
5. Read the TLC result and inspect the exported automaton with `sgd_inspect`.
6. Use `sgd_visualize` for a Pele diagram when a graph helps review the behavior.

For v3, v4, and v5, model-only output contains the finite witness and lowered `symbolic-model.json`.
Model-only mode does not run the input oracle or orbit validation and does not generate an owner.
Use `sgd_build` before claiming executable validation.
V5 model-only generation does not analyze native source and records no row binding.
Finite configured model values alone do not prove a property for arbitrary runtime input.

Stop on a model error, incomplete exploration, or unsupported construct.
Fix the cause or report the unsupported case.
Do not invent a successful TLC result.
Review the initial states, guarded actions, terminal states, and unexpected cycles against the user's requirement.
A diagram does not check application behavior.

## Build and integrate a generated owner

Use `sgd_build` with v2, v3, v4, v5, or v6.
The controlled runner verifies the pinned JAR and isolates the model source closure before exploration.
`sgd_compile` rejects these executable profiles because imported DOT cannot establish executable provenance or parameter policy.

For v3 and v4, executable generation uses strict SANY semantic XML and a completed finite TLC witness.
The build compares the lowered relation with an independent TLC oracle for each reachable configured state/input pair.
It also validates equality/copy orbits, configured invariants, supported square-action properties, and the deadlock setting.
The orbit result applies only to the accepted grammar over immutable string identities.
Do not describe this as a proof for arbitrary TLA+ operators or application objects.
For v4, the oracle covers every configured input tuple and the orbit checker uses separate domain renamings.
V5 adds the source-derived field/codec plan and checks complete row-copy origins.
Encoding, cloning, and row-binding checks finish before consuming a prepared primitive transition.
Mixed payload/provenance copy origins fail instead of assembling a row from unrelated sources.

Use an empty directory for the first generation.
Keep the generated `.sgd-generated.json` inventory.
Read the generated target's README for its package name and build commands.
Preserve the generated source boundary when integrating the package.
Use a separate model-review output directory if you need to keep an existing generated owner during `sgd_model`.
Regeneration removes obsolete owned files, including executable artifacts omitted by model-only mode.

For TypeScript, use `create<ClassName>()` and `read()`.
The owner keeps state in a closure and returns frozen copies.
If a boundary accepts an owner as input, use `is<ClassName>()` to authenticate the live object.
A TypeScript interface alone accepts structurally equivalent objects.
The authenticator recognizes only owners created by the same loaded generated module instance.

For Rust, keep the generated library as a separate Cargo dependency.
Use `<ClassName>::new()` and `read()` through that dependency.
The separate crate keeps the actual state private.
Use safe Rust in the calling application.
Do not add mutable state access, arbitrary-state constructors, or restore paths.

Check the effective consuming Cargo graph after connecting the generated path dependency.
Keep configured workspace member paths distinct from Cargo's resolved members.
Metadata for the generated crate alone does not establish compatible consumer placement.
Resolve placement failures through the binding or producer contract.
Do not patch generated Cargo manifests to conceal them.

For v3, submit data through TypeScript `send(input: string)` or Rust `send(input: &str)`.
Generated guards choose the action.
The caller cannot choose `Same` or `Clash` as a policy decision.
Sending the text `Same` submits that text as data.
Literal model strings and tagged data atoms remain distinct even when both contain `none`.
All simultaneous updates read the old state.
Use the receipt's `updates` to inspect the source of every assignment instead of reconstructing policy from an action name.

For v4, call `send(first, second)` or `send(first, second, third)` with primitive string arguments.
Both native targets use the ordered `inputs` in `symbolic-model.json`.
Named input origins identify the exact parameter copied by an update.
The same text in different input domains denotes different data atoms.
Preserve every variable when checking square-action stuttering, including provenance.

For v5 Rust, include the generated adapter as a private application module beside a separate primitive authority dependency.
Pass an actual audited Fact to `FactOwner::<Fact>::write(row)`.
For v5 TypeScript, call `create<Fact>Row(completeFields)` and pass its authenticated frozen token to `create<Fact>Owner().write(row)`.
Use bigint for the complete signed i64 representation.
Retain application parsing and native constructor preconditions separately, especially Qty/Amount positivity and Symbol validation.
The caller cannot supply q/p, Same/Clash, an open Eq wrapper, or a forged row token.
Preserve exact source action IDs in generated results and native exhaustive matches.
Do not configure an outcome-label permutation.
An action name alone does not prove its business role; retain erasure and native integration behavior checks.

For an explicit high-level/low-level erasure, use `sgd_refine` with both symbolic IR files and the variable, input, and action binding.
The check preserves enabled-input decisions, action classification, and complete projected successors under the admitted grammar.
It checks supplied IR and does not attest original TLC provenance or application integration.
Keep the separate build receipts and rerun erasure after either model changes.

For ordinary v2, call TypeScript `send(event)` or Rust `send(Event)` with a generated named event. For a retained-operation binding, call `finalize(payload, writer)` instead. The generated boundary selects the outcome from the actual callback result.
The owner follows the exact full-node/action edge.
The underlying finite event dispatch has no data parameters or automatic connection to database fields. The retained-operation boundary separately retains the native payload supplied to `finalize`.

Handle rejection without changing application state to the requested target.
Each factory call creates a new independent object at Init.
Record how the application creates and retains those objects.
Persistent entity history and reset prevention require a separate contract.

## Generate v1 source diagnostics

Use `sgd_build` for TLC and generation together.
Use `sgd_compile` only for v1 diagnostics from existing DOT.
Treat that imported graph as unverified.

A transition binding checks a selected call or macro with three literal strings in this order:

```text
source state, action name, target state
```

These declarations do not control actual runtime state.
The transition-only Rust profile accepts the configured macro name.
When dependency checks cover the same file, use the configured function name instead.

For a dependency binding, map the relevant model states to application files or directories.
A mapping for `src/handler` does not include `src/handler.ts` or `src/handler.rs`.
Run the generated checker with `--root PROJECT_ROOT FILE [FILE ...]` and include every file covered by the contract.
Do not omit files to hide violations.
The Rust dependency profile rejects opaque macros, macro definitions, and custom attributes in checked files.
Keep support macros and native tests in separate files or crates, and report those exclusions.

## Verify the integration

Run native type checks, builds, and behavior tests after integration.
For generated owners, test rejection where the contract permits disabled input and confirm that state and revision stay unchanged.
Check that application code cannot directly replace the protected state.

Preserve the original counterexample and check that the repair excludes it.
Add a regression for the failure class across relevant participants, orderings, repeated operations, and lifecycle boundaries.
Check an independent higher-level acceptance property from the root structure.
Derive expected results from the accepted requirement rather than generated output or the implementation under test.
A passing example or paired implementation agreement does not establish that property.

For the v3 fact-merge example, submit one value twice and then a different value.
Expect `Insert`, `Same`, and `Clash`, with the original stored value preserved after the clash.
Also submit `none` as actual data and inspect every receipt's simultaneous assignment origins.
Test the actual payload adapter, especially metadata exclusions and equality preservation.
A model-derived example does not prove adoption by an existing application such as Parangsae.

For the v4 fact-envelope model, submit A@r1, B@r2, B@r3, and A@r4.
Expect stored A@r1 and latest rejected B@r3, including a fresh provenance for the repeated rejected B.
Test the actual payload adapter and the source paths that create owners and commit partitions.

For v5, inspect `row-binding-plan.json` against the actual source fields, getter chains, native equality, and metadata exclusions.
For Parangsae Kline, verify schemas 1 and 2 compare equal while preserving the first raw schema and received time.
Verify unknown schema differences and strict fields still conflict.
Test source changes through regeneration and `build --check`, including an omitted field and direct generated-code mutation.

For the v2 approval example, reject `Submit` before `Approve`, then accept `Approve` followed by `Submit`.
The initial and approved concrete states both have `phase = "New"`.
Checking only `phase` loses the approval distinction.

For v1 diagnostics, use a real permitted source construct and a forbidden source construct.
Confirm that the forbidden construct produces a diagnostic and a failing exit status.
Use temporary files for negative checks, then remove them.
Report the supplied files and supported constructs covered by the check.

Preserve exact TypeScript 7.0.2 for builds and native syntax analysis.
The v1 TypeScript checker uses `typescript/unstable/sync` and `typescript/unstable/ast`.
If dependencies are missing, use the generated `typescript/package.json` within the user's authorized setup scope.
Do not replace these APIs with an earlier compiler API.

## Change a requirement

Apply the structural diagnosis before editing the contract.
Keep a requirement change distinct from a repair under the accepted requirement.
For a requirement change, state the affected invariant, payload equality contract, and expected behavior where relevant.
Update TLA+ and regenerate within the authorized scope.
V3 and v4 source changes must pass the finite witness, input oracle, and orbit validation again before executable generation.
V5 also reanalyzes the native source and revalidates its read identities before publication.
Rust output uses the fixed rustfmt 2021 style profile and checked output bytes.
The informational formatter version is not an installation pin.
Do not weaken the model only to make existing code pass.
Do not edit generated code to change application policy.
Preserve the accepted oracle during a repair.
Record an authorized requirement change and its new acceptance property separately.

Use `build --check` to detect stale stable artifacts.
V1 also supports `compile --check`.
The compiler checks stable provenance fields but excludes TLC log bytes and volatile run details from byte comparisons.
Use the declared producer for canonical generated bytes and freshness.
Check those bytes with the actual consumer's formatter configuration.
Resolve a formatting disagreement through artifact ownership and configuration.
Do not manually format generated code, skip formatting, or suppress freshness to obtain a passing result.
Custom consumer formatting configurations require separate compatibility evidence.

## Execute through the native plugin

Prefer this plugin's MCP tools.
Tool argument schemas are authoritative.
Use absolute project, JAR, graph, IR, and output paths.

For a CLI fallback, resolve `scripts/run.mjs` from this skill's installed plugin directory.
Run `node /absolute/plugin/path/scripts/run.mjs <command>`.
Do not assume that the source repository remains beside the installed plugin cache.
If the runtime is missing, follow the launcher's setup instruction within the authorized scope.

Use the archive for the host's platform and architecture, or rebuild on that host.
Do not bypass the launcher's platform check.
TLC requires Java and the pinned `tla2tools.jar`.
Rust artifacts require the Rust toolchain and their declared Cargo dependencies.
Source-checkout v5 setup prepares its Rust analyzer through Cargo.
Prepared plugins include a host-native analyzer binary and do not require the source checkout beside the cache.
V5 Rust generation also requires rustfmt.
Keep Codex and Claude Code installations independent.
Do not change global agent configuration as a hidden setup or test step.

## Report the actual boundary

Report the requirement, owning structure, diagnosis, repair, and supporting evidence.
Distinguish model checks, generated enforcement, native binding, composition, scheduling, and persistence.
Report unsupported and uncovered obligations separately.
The root-structure and diagnosis steps above are workflow requirements.
Current tools do not check complete application contract closure or mechanically authorize a local repair.
A green leaf model does not establish its enclosing properties or application coverage.

Generated owners protect one live object in a trusted JavaScript realm or a safe Rust caller.
Trust the generated source, its dependencies, and the platform primitives.
V3 and v4 protect equality/copy over immutable string identities under their supported grammars.
Actual payload encoding and its relation to application fields require explicit integration evidence.
V5 checks the admitted production Rust library/type closure and retains complete owned rows.
Its source profile trusts unshadowed standard Rust facilities and declared genuine default-registry serde/clap derives.
Unknown aliases, macros, source overrides, conditional bound items, and unsupported representations fail.
It does not establish every Cargo target/feature, TypeScript source coverage, filesystem authority, partition folding, or exclusive writers.
V6 adds a generated closed fold with private row/control observations, checked counters, full conflict pairs, and a consumed unbound data report.
It checks internal symbol/day consistency, not the selected physical resource or writer.
Do not describe the report as storage permission or completed source and sink coverage.
V2 retains finite scalar state and its observed action guards within the explored scope.
V1 projections discard other variables and their guards.

Persistent identity, restart, restore, database effects, effect atomicity, liveness, and complete application coverage require separate contracts.
A successful native build does not prove those properties, Parangsae adoption, or production readiness.
Explicit erasure establishes only the checked relation between supplied supported IR models.
It does not establish full application refinement or a persistence contract.
