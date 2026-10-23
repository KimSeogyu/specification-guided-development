---
name: specification-guided-development
description: Model architecture and behavior in TLA+. Generate state owners or TypeScript and Rust source diagnostics from checked models. Use when adopting or changing Specification Guided Development.
---

# Develop from a checked TLA+ model

Read the relevant profile in [the modeling guide](references/modeling.md) before you create or change a model.
Select the profile that matches the required guarantee.
Project v3 `symbolic-owned` generates equality/copy behavior over immutable string input.
Project v2 `finite-owned` generates a state owner with named events and no data parameters.
Project v1 generates diagnostics for declared transition triples or mapped imports.

## Select the contract

Read the user's request and the project's current requirements.
Record the selected model, its invariants, its finite bounds, and the application code that uses the generated artifacts.
Identify the actual state owner before you claim that the model controls runtime behavior.

Use TLA+ for application policy.
Use project JSON for model paths, language targets, and supported bindings.
Do not duplicate allowed edges in project JSON.

For data-bound equality/copy actions, select v3 `symbolic-owned` when the model fits its supported grammar.
Record how application payloads become immutable opaque Unicode string identities.
The adapter must preserve application equality, including any excluded metadata fields.
The generated API does not accept arbitrary objects or a custom equality callback.

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

## Model and review

1. Write the TLA+ module and its TLC configuration.
2. Include the invariants and failure behavior required by the contract.
3. Create project JSON for the selected profile.
4. Run `sgd_model` to check the configured finite instance without generating language code.
5. Read the TLC result and inspect the exported automaton with `sgd_inspect`.
6. Use `sgd_visualize` for a Pele diagram when a graph helps review the behavior.

For v3, model-only output contains the finite witness and lowered `symbolic-model.json`.
Model-only mode does not run the input oracle or orbit validation and does not generate an owner.
Use `sgd_build` before claiming executable validation.
Finite configured model values alone do not prove a property for arbitrary runtime input.

Stop on a model error, incomplete exploration, or unsupported construct.
Fix the cause or report the unsupported case.
Do not invent a successful TLC result.
Review the initial states, guarded actions, terminal states, and unexpected cycles against the user's requirement.
A diagram does not check application behavior.

## Build and integrate a generated owner

Use `sgd_build` with v2 or v3.
The controlled runner verifies the pinned JAR and isolates the model source closure before exploration.
`sgd_compile` rejects both profiles because imported DOT cannot establish executable provenance or parameter policy.

For v3, executable generation uses strict SANY semantic XML and a completed finite TLC witness.
The build compares the lowered relation with an independent TLC oracle for each reachable configured state/input pair.
It also validates equality/copy orbits, configured invariants, supported square-action properties, and the deadlock setting.
The orbit result applies only to the accepted grammar over immutable string identities.
Do not describe this as a proof for arbitrary TLA+ operators or application objects.

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

For v3, submit data through TypeScript `send(input: string)` or Rust `send(input: &str)`.
Generated guards choose the action.
The caller cannot choose `Same` or `Clash` as a policy decision.
Sending the text `Same` submits that text as data.
Literal model strings and tagged data atoms remain distinct even when both contain `none`.
All simultaneous updates read the old state.
Use the receipt's `updates` to inspect the source of every assignment instead of reconstructing policy from an action name.

For v2, call TypeScript `send(event)` or Rust `send(Event)` with a generated named event.
The owner follows the exact full-node/action edge.
This API has no data parameters or automatic connection to database fields.

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

For the v3 fact-merge example, submit one value twice and then a different value.
Expect `Insert`, `Same`, and `Clash`, with the original stored value preserved after the clash.
Also submit `none` as actual data and inspect every receipt's simultaneous assignment origins.
Test the actual payload adapter, especially metadata exclusions and equality preservation.
A model-derived example does not prove adoption by an existing application such as Parangsae.

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

Distinguish an implementation error, a model error, and a changed requirement before editing the contract.
For a requirement change, state the affected invariant, payload equality contract, and expected behavior where relevant.
Update TLA+ and regenerate within the authorized scope.
V3 source changes must pass the finite witness, input oracle, and orbit validation again before executable generation.
Do not weaken the model only to make existing code pass.
Do not edit generated code to change application policy.

Use `build --check` to detect stale stable artifacts.
V1 also supports `compile --check`.
The compiler checks stable provenance fields but excludes TLC log bytes and volatile run details from byte comparisons.

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
Keep Codex and Claude Code installations independent.
Do not change global agent configuration as a hidden setup or test step.

## Report the actual boundary

Generated owners protect one live object in a trusted JavaScript realm or a safe Rust caller.
Trust the generated source, its dependencies, and the platform primitives.
V3 protects equality/copy over immutable string identities under its supported grammar.
Actual payload encoding and its relation to application fields require explicit integration evidence.
V2 retains finite scalar state and its observed action guards within the explored scope.
V1 projections discard other variables and their guards.

Persistent identity, restart, restore, database effects, effect atomicity, liveness, and complete application coverage require separate contracts.
A successful native build does not prove those properties, Parangsae adoption, or production readiness.
No profile establishes full application refinement or formal hierarchy refinement.
