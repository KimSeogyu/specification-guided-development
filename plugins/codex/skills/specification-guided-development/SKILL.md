---
name: specification-guided-development
description: Model architecture and behavior in TLA+. Compile TLC graphs into TypeScript or Rust linters and develop under those checks. Use when adopting or changing Specification Guided Development.
---

# Develop under checks compiled from TLA+

Use this workflow for specification-driven development with Specification Guided Development.
The model defines permitted behavior.
The compiler produces linter source code from the TLC automaton.
The agent implements application code under the generated checks.

Read [the modeling guide](references/modeling.md) before you create or change a model.
Read only the relevant examples in that guide.

## Establish the contract

1. Read the user's request and the project's current requirements.
2. Identify the architecture boundaries and the behavior that must remain true.
3. Identify observable states, actions, and failure cases.
4. Define a finite model scope and list the assumptions that make the model finite.
5. Separate the model's intended guarantees from the checks this compiler can generate.

Use TLA+ for application policy.
Use project JSON only to select files, code bindings, and language targets.
Do not duplicate allowed edges in project JSON.

Architecture models describe permitted dependencies between modules.
Behavior models describe permitted state changes and their action names.
Use separate projects when these models need different state projections or bindings.
Use an optional `parent` model and state to display containment.
Do not describe containment as a refinement proof.

The current compiler supports two bindings.
A transition binding checks three literal strings in a selected call or macro.
A dependency binding checks imports between mapped modules.
Do not claim that either binding verifies arbitrary business logic.

## Model and inspect

1. Write or update the TLA+ module and its TLC configuration.
2. Include the invariants that matter to the user's request.
3. Choose the state variable that the compiler will project.
4. Create project JSON that matches the supported schema.
5. Run TLC through `sgd_model` or the CLI `model` command.
6. Read the model-checking result before you compile the DOT graph.
7. Inspect the automaton through `sgd_inspect` or `inspect`.
8. Use `sgd_visualize` or `visualize` to review the graph with the user when useful.

Stop on a model error, an incomplete run, or an unsupported graph.
Fix the model or state the unsupported case.
Do not invent a successful TLC result.

Review the initial states, permitted edges, terminal states, and unexpected cycles.
Compare these results with the requested behavior.
A diagram helps review the graph.
A diagram does not check the implementation.

## Compile and implement

Use `sgd_compile` to compile an existing DOT graph.
Use `sgd_build` or the CLI `build` command to run TLC and compilation together.
Keep generated linter source separate from application source.
Use an empty directory for the first generation.
Preserve the generated `.sgd-generated.json` inventory.
Regeneration removes obsolete owned files when targets or profiles change.
Use `build --check` or `compile --check` to compare stable generated artifacts.
TLC logs and run receipts are excluded from byte comparisons.

For a transition binding, inspect the automaton's permitted edges before you edit application code.
Use the configured function name in TypeScript.
Use the configured function name in Rust when architecture checks cover the same file.
The transition-only profile also accepts the configured macro name.
The checked construct takes three literal strings in this order:

```text
source state, action name, target state
```

These constructs declare permitted edges.
They do not prove that runtime state follows the declared edges.
Test the actual implementation through its native tests.

For a dependency binding, map every relevant model state to application module paths.
Use an exact file path or a directory path.
A mapping for `src/handler` does not own `src/handler.ts` or `src/handler.rs`.
Run the generated checker with `--root PROJECT_ROOT FILE [FILE ...]`.
Include every source file that the contract covers.
Do not omit a source file to hide a violation.
Preserve the generated checker's supported import syntax.
The Rust profile rejects opaque macros, macro definitions, and custom attributes in checked files.
Keep support macros and native tests in separate files or crates, and report their exclusion from this syntax profile.

Implement the feature after the model and bindings describe the intended contract.
Run the generated linter after relevant changes.
Also run native type checks, builds, and tests.

The compiler repository builds and type-checks with TypeScript 7.0.2.
Generated checks use the same native version through `typescript/unstable/sync` and `typescript/unstable/ast`.
Keep the exact 7.0.2 pin while this integration uses those unstable APIs.
Do not silently replace the native API with an earlier compiler API.
If parser dependencies are unavailable, use the generated `typescript/package.json`.
Run `npm install --prefix OUT/typescript` within the user's authorized setup scope.

## Check the checks

Use at least one real permitted example and one forbidden example.
Change an edge or import in a temporary source file.
Check that the generated checker reports the forbidden construct and exits unsuccessfully.
Remove temporary files after the check.

A passing linter run covers only its supplied files and supported constructs.
Report that scope when you describe the result.

## Change a requirement

If code violates the model, first identify the cause.
The cause can be an implementation error, a model error, or a changed requirement.
Fix the cause that the evidence supports.

Do not weaken the model only to make existing code pass.
For a changed requirement, explain the affected invariant and the new expected behavior.
Update the model and regenerate the checks within the user's authorized scope.
Preserve unrelated requirements.

Do not edit generated linter code to change application policy.
Change the TLA+ source and regenerate.
If the compiler itself is wrong, fix the compiler and test that correction.

## Execution

Prefer this plugin's MCP tools when available.
Tool argument schemas are authoritative.
Use absolute project, JAR, graph, IR, and output paths in tool calls.

The plugin includes `scripts/run.mjs`.
For a CLI fallback, resolve that script from this skill's installed plugin directory.
Run `node /absolute/plugin/path/scripts/run.mjs <command>`.
Do not assume the plugin's source repository remains beside its installed cache.
Do not install packages or change global agent configuration as a hidden setup step.

If the runtime is missing, report the launcher's setup instruction.
The plugin runtime contains a native binary for its recorded platform and architecture.
If the host differs, use a matching archive or rebuild the plugin on that host.
Do not bypass the launcher's platform check.
Java and a user-selected `tla2tools.jar` are required for TLC.
Rust checks also require the Rust toolchain and their declared Cargo dependencies.

## Limits to preserve

TLC explores the selected finite model.
The compiler projects one nonempty TLA+ string state variable.
Other selected value types are unsupported.
A projected edge means that at least one explored concrete transition permits that edge.
Other state variables and their guards do not survive that projection.

For example, an approval edge observed when `balance >= amount` does not enforce that guard in application code.
Keep tests or runtime checks for the guard.
Do not describe a generated linter as a proof of full TLA+ refinement, liveness, transaction atomicity, or complete source coverage.
