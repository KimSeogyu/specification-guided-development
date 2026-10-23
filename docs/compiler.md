# Compiler contract

Specification Guided Development consumes a TLC DOT state graph and emits source checkers.
It also runs TLC when a project and a local TLA+ tools JAR are supplied.

## Project format

Project JSON uses version `1` and rejects unknown properties.
The following fields are required:

| Field | Meaning |
| --- | --- |
| `version` | The value `1` |
| `name` | A name that starts with a letter and contains letters, numbers, underscores, or hyphens |
| `spec` | The TLA+ module path, relative to the project JSON file |
| `config` | The TLC configuration path, relative to the project JSON file |
| `stateVariable` | The nonempty TLA+ string variable to project from each state |
| `targets` | A nonempty array containing `typescript`, `rust`, or both |
| `binding` | One supported mapping from model names to source constructs |

An example transition project is:

```json
{
  "version": 1,
  "name": "Order",
  "spec": "Order.tla",
  "config": "Order.cfg",
  "stateVariable": "state",
  "targets": ["typescript", "rust"],
  "binding": { "kind": "transition", "function": "transition" }
}
```

A dependency binding replaces `binding` with a module mapping:

```json
{
  "kind": "dependency",
  "modules": {
    "Handler": ["src/handler"],
    "Service": ["src/service"],
    "Gateway": ["src/gateway"]
  }
}
```

Each projected state requires a module mapping.
Module paths are relative to the application root used by the generated checker.
Paths cannot contain parent traversal.
The model supplies permitted edges.
Project JSON selects bindings and targets without repeating that policy.

The optional `parent` field contains `model` and `state` names.
It links a model to a state in a higher-level model for visualization.
That containment link does not establish formal refinement.

## Commands

The installed CLI is `sgd`.
In a source checkout, use `node dist/cli.js` with the same commands and options.

| Command | Required options | Result |
| --- | --- | --- |
| `model` | `--project`, `--jar`, `--out` | Runs TLC and writes its graph, automaton, binding, log, and completion evidence |
| `compile` | `--project`, `--dot`, `--out` | Compiles an existing graph and records that the graph's TLC completion is unverified |
| `build` | `--project`, `--jar`, `--out` | Runs TLC and emits the generated checkers |
| `inspect` | `--ir` | Reads the automaton for inspection |
| `visualize` | `--ir`, `--out` | Produces a Pele visualization of the automaton |
| `mcp` | None | Serves the compiler tools over standard input and output |

The `build` and `compile` commands also accept `--check`.
That option checks the owned output inventory and stable generated artifacts.
It fails on a missing or changed stable artifact or a changed output set.
TLC logs and run receipts contain variable execution data and are not compared byte for byte.
The `visualize` command accepts repeated `--ir` options to show several models together.

The MCP server exposes `sgd_model`, `sgd_build`, `sgd_compile`, `sgd_inspect`, and `sgd_visualize`.
Model and build calls accept `project`, `jar`, and `out` paths.
Compile calls accept `project`, `dot`, and `out` paths.
Inspect calls accept one `ir` path.
Visualize calls accept an `ir` array and an `out` path.
Use absolute paths in MCP calls because the server can run from the installed plugin cache.

## Generated files

Compilation writes `automaton.json`, `binding.json`, and `verification.json`.
A TLC run also writes `model.dot` and `tlc.log`.
The `model` command omits checker source.

The TypeScript target writes `typescript/checker.mjs`.
It also writes `typescript/package.json` with its parser dependencies.
The Rust target writes a standalone checker crate with `rust/Cargo.toml` and `rust/src/main.rs`.
The compiler emits checker source for the selected model.
It does not emit application implementations.

Both generated checker commands require `--root PROJECT_ROOT FILE [FILE ...]`.
Relative input files resolve from `PROJECT_ROOT`.
Input files must remain inside that root.
The TypeScript checker needs the parser dependencies declared in its emitted `package.json`.
Use `npm install --prefix OUT/typescript` to install the emitted checker's dependencies when needed.

The repository builds and type-checks with `typescript@7.0.2`.
Its npm scripts invoke `node node_modules/typescript/bin/tsc` explicitly.
The generated checker uses that same native compiler through `typescript/unstable/sync` and `typescript/unstable/ast`.
The native API provides the AST and resolved module symbols used by the supported source checks.
These entry points are unstable, so the emitted package pins `typescript` to exactly `7.0.2`.
The [TypeScript 7.0 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60) distinguishes the unavailable stable legacy API.
The generated checker does not claim that its native API is stable or that source checks replace application type checking.
The native API terminates its child process on close and can write `context canceled` to stderr during shutdown.
Read the checker's JSON diagnostics and exit status to determine the result.

Visualization writes `index.html`, `structure.svg`, `structure.mmd`, and `models.json`.
The HTML viewer supports model selection, zoom, and transition-row filtering.
The viewer uses the local Pele renderer output and needs no network connection.

## Output ownership

The output directory contains `.sgd-generated.json`, which inventories the files the compiler owns.
The first generation accepts an empty directory and refuses a nonempty unmanaged directory.
Later generations update owned files and remove obsolete owned files.
They refuse to overwrite an existing file that the previous inventory does not own.
This removal includes checkers for removed targets and checker source left by a switch to model-only output.

The compiler does not use the inventory as a list of application source files to check.
Supply application source files explicitly to the generated checker.
Keep application source outside the generated output directory.
Use a separate output directory for each concurrent build.
An exclusive `.sgd-output.lock` prevents mixed output from concurrent writers.
If a process is killed, use a new directory until the stale lock can be removed after confirming that no writer remains.

## Transition binding

The configured `function` identifies a TypeScript function call and a Rust function call or macro.
The construct has three string literals in the order `from`, `event`, `to`.
For example:

```typescript
transition("Open", "Submit", "Submitted");
```

```rust
transition("Open", "Submit", "Submitted");
```

The Rust transition-only profile also accepts `transition!("Open", "Submit", "Submitted")`.
Use function calls when the same Rust source must pass dependency checks, which reject opaque macros.
The checker compares the declared triple with a projected automaton edge.
It does not establish that the declaration controls runtime state or invokes the correct handler.
Unsupported forms of the checked construct produce diagnostics.
Unrelated source constructs do not acquire transition semantics automatically.

## Dependency binding

A model state identifies a mapped module.
An observed edge permits a direct dependency between the source and target modules.
Action names do not affect this binding.
Dependencies within one mapped module are permitted.

The generated checker checks its supported import syntax in explicitly supplied files.
Unsupported or unresolved constructs within that profile produce diagnostics.
The binding does not infer runtime call order or detect a separately reimplemented capability.

The TypeScript profile resolves internal imports through TypeScript module resolution, including configured path aliases.
Node builtins and external packages remain outside the internal module boundary.
An unresolved bare package name also remains outside that boundary.
This profile does not enforce external SDK ownership.

The Rust profile checks supported `use` and `mod` declarations without full Rust name resolution.
It rejects opaque macros and procedural attributes in checked files.
Unresolved bare names remain external to its module boundary.
Use explicit `crate`, `self`, or `super` qualification for local dependencies that the profile requires.

## Checker diagnostics

Both backends write JSON diagnostics with `ruleId`, `file`, `line`, `column`, and `message`.
The initial rules are:

| Rule | Meaning |
| --- | --- |
| `TLC001` | A declared transition is absent from the automaton |
| `TLC002` | The source construct, syntax, input, or resolution is unsupported |
| `TLC003` | A direct dependency is absent from the permitted module edges |

The checker exits with `0` for a passing run, `1` for violations, or `2` for invalid input or source syntax.

## Projection semantics

The automaton contains states, initial states, and labeled transitions.
Its source metadata describes the imported DOT graph.

The compiler selects one nonempty TLA+ string variable from each concrete TLC state.
The importer rejects numeric values, Boolean values, model values, and compound values in that position.
This restriction prevents different TLA+ values from collapsing into the same source string.
Several concrete states can share the same projected value.
An emitted edge exists when at least one explored concrete transition has that projected source, action, and target.

The edge is therefore an existential result over the explored model.
The edge does not assert that the action is permitted for every concrete state with that projected value.
Conditions over other variables are lost.
Finite model bounds, TLC completion, and source coverage remain separate facts.

## Verification boundaries

A successful `build` requires a successful TLC run under the supplied configuration.
The build evidence concerns the finite model.
An imported graph receives different verification metadata because DOT alone cannot establish completion.

A generated checker result concerns the supplied source files and the supported binding profile.
The current compiler does not prove implementation refinement, liveness, or transaction atomicity.
It does not enforce arbitrary guards from a TLA+ Action.
Native tests and runtime enforcement remain necessary for those properties.
