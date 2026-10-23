# Specification Guided Development

Compile a TLC state graph into linter source code for TypeScript and Rust.
Use the bundled agent skills to model architecture and behavior in TLA+, then develop under the generated checks.
The package name is `specification-guided-development` and the CLI name is `sgd`.
The source-checkout examples below invoke that CLI with `node dist/cli.js`.

```text
Requirements
  -> TLA+ model and TLC configuration
  -> TLC model checking and DOT state graph
  -> typed automaton
  -> generated TypeScript or Rust linter
  -> application development and source checks
```

Specification Guided Development is an initial compiler for this workflow.
The model supplies permitted edges.
A binding maps model names to a supported source construct.
The compiler emits the checker program for that model and language.

## What works

The first version supports two bindings in both languages:

| Binding | TypeScript | Rust | Checked property |
| --- | --- | --- | --- |
| Transition | A configured function call with three string literals | A configured function call or macro with three string literals | The declared source state, action, and target state form a permitted edge |
| Dependency | Imports between mapped module paths | Imports between mapped module paths | The source module may directly depend on the target module |

Transition constructs declare edges.
They do not verify that the application's runtime state follows those edges.
Dependency checks permit imports within the same mapped module and ignore action names.
Each checker covers the source files supplied to its command.
Read [the compiler contract](docs/compiler.md) for the supported profile and its limits.

## Run the compiler

Use Node.js 22 or later.
For a TLC run, also install Java and obtain `tla2tools.jar` from the [TLA+ tools project](https://github.com/tlaplus/tlaplus/releases).
The compiler does not download the JAR.
The optional `node scripts/fetch-tlc.mjs` helper explicitly downloads the pinned JAR to `.runtime/tla2tools.jar` and checks its integrity.

```sh
npm ci
npm run check
npm run build
```

Build and type checking use the pinned `typescript@7.0.2` compiler.
The npm scripts select that compiler directly instead of relying on the shared `tsc` executable.
Generated TypeScript checkers use the same native TypeScript 7.0.2 runtime through `typescript/unstable/sync` and `typescript/unstable/ast`.
These API paths are unstable, so the exact version pin is part of the supported contract.
The [TypeScript 7.0 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60) describes the absence of the stable legacy API.
This implementation explicitly uses the version-pinned unstable native API.

Set `TLA2TOOLS_JAR` to the absolute path of your JAR.
Build the included order model:

```sh
node dist/cli.js build \
  --project examples/order/project.json \
  --jar "$TLA2TOOLS_JAR" \
  --out .runtime/order
```

Inspect the compiled automaton:

```sh
node dist/cli.js inspect --ir .runtime/order/automaton.json
```

Generate a Pele visualization for review:

```sh
node dist/cli.js visualize --ir .runtime/order/automaton.json --out .runtime/order/visualization
```

Run the generated TypeScript checker against explicit source files:

```sh
node .runtime/order/typescript/checker.mjs --root /absolute/application/root path/to/orders.ts
```

If the checker cannot find its parser dependencies, install its emitted package dependencies:

```sh
npm install --prefix .runtime/order/typescript
```

The checker can also load that package from the application root or the current working directory.

Run the generated Rust checker:

```sh
cargo run --manifest-path .runtime/order/rust/Cargo.toml -- --root /absolute/application/root path/to/orders.rs
```

Cargo needs the generated crate's declared dependencies.
The Rust checker parses application source separately from the application's build.
Run native application builds and tests as well.

To compile a previously exported graph, use `compile`:

```sh
node dist/cli.js compile \
  --project examples/order/project.json \
  --dot path/to/model.dot \
  --out .runtime/imported-order
```

An imported DOT graph does not establish that TLC completed successfully.
The generated verification metadata records that distinction.
Use `build` when the result must include this tool's TLC completion evidence.

Each output directory has a `.sgd-generated.json` inventory of owned generated files.
Use an empty directory for the first generation.
The compiler refuses a nonempty directory without that inventory.
Regeneration removes obsolete owned checker source when targets or profiles change, including a model-only rerun.
Use `build --check` or `compile --check` to compare stable artifacts without updating them.
TLC logs and run receipts are not compared byte for byte.

## Model architecture and behavior

The intended method starts before lint integration:

1. Translate the requested architecture and behavior into finite TLA+ models.
2. Check invariants and inspect the reachable state graph.
3. Select a projection and bind its names to source constructs.
4. Compile the graph into language-specific linter code.
5. Implement the feature under those checks.
6. Check a forbidden example, then run native tests and builds.
7. Repeat the loop when a requirement changes.

Use a dependency model for module boundaries.
Use a behavior model for state changes.
Separate projects can share the same development workflow without forcing both concerns into one state variable.
The included [architecture model](examples/architecture/project.json) and [order model](examples/order/project.json) show the two bindings.
The order project declares `Architecture.Service` as its parent.
That link displays where the behavior model belongs without claiming formal refinement.

Build the architecture model and visualize both levels together:

```sh
node dist/cli.js build --project examples/architecture/project.json --jar "$TLA2TOOLS_JAR" --out .runtime/architecture
node dist/cli.js visualize --ir .runtime/architecture/automaton.json --ir .runtime/order/automaton.json --out .runtime/models
```

Open `.runtime/models/index.html` to select a model, zoom the graph, or filter transition rows.
Dashed links show model containment.

Read [the development method](docs/development-method.md) for modeling choices, change handling, and implementation freedom.

## Use an agent plugin

The repository contains independent native packages for Codex and Claude Code.
Each package includes its own modeling skill and local MCP configuration.
Packaging copies the compiled CLI and production dependencies into each plugin.
The installed package does not need a neighboring source checkout.
The runtime includes a native compiler binary and matches the host operating system and CPU architecture.
Prepare the plugin on the host that will run it, or use an archive built for that host platform and architecture.

Prepare both plugin directories after a build:

```sh
node plugins/package.mjs
```

For Codex, register this prepared checkout:

```sh
codex plugin marketplace add /absolute/path/to/specification-guided-development
```

Open the desktop plugin directory, select `specification-guided-development-codex`, and install `Specification Guided Development`.
Restart the app if the new local marketplace does not appear.
Invoke the `specification-guided-development` skill or ask the agent to use Specification Guided Development for modeling and development.

For Claude Code, register the same prepared checkout with its native installer:

```sh
claude plugin marketplace add /absolute/path/to/specification-guided-development
claude plugin install specification-guided-development@specification-guided-development-claude
```

Start a new session and invoke `/specification-guided-development:specification-guided-development`.

These commands install only the package for the selected agent.
No installer runs as part of the compiler or package preparation.
A source checkout requires the preparation steps above before its MCP server can run.
Cloning the Git marketplace alone does not create the runtime.
For independent distribution, run `node plugins/package.mjs --archive-out .runtime/plugin-packages`.
That command creates a complete archive for each native plugin, including its runtime.
Archive names end with the host platform and architecture, such as `-darwin-arm64.tar.gz`.
The launcher checks `runtime/runtime-platform.json` and rejects a runtime for another host.
An ordinary npm source package does not include these runtime dependencies.
See [plugin setup](docs/plugins.md) for cache checks and troubleshooting.

## Understand the guarantee

TLC explores a configured finite model.
The compiler projects one nonempty TLA+ string variable from the reachable states.
An emitted edge means that at least one explored concrete transition permits that edge.
Guards over discarded variables do not survive this projection.

For example, observing an `Approve` edge while `balance >= amount` does not generate a checker for that numeric guard.
The application still needs the guard and tests for its behavior.
The current bindings do not prove full refinement, liveness, transaction atomicity, or arbitrary runtime call paths.

The compiler rejects unsupported graph structures and ambiguous projections.
The generated checks reject unsupported syntax in constructs that their profiles inspect.
Read the reported file and syntax scope before treating a passing run as evidence.

## Develop Specification Guided Development

```sh
npm run check
npm run build
```

Run the complete example workflow with Java, the JAR, and Rust available:

```sh
npm run demo
```

The demo runs real TLC checks for both models, checks valid and forbidden TypeScript and Rust examples, and renders the combined graph.
Open [the generated offline viewer](examples/visualization/index.html) to inspect both model levels.

The [ingestion application example](examples/ingestion/contract.md) applies architecture and behavior checks to the same TypeScript 7 and Rust sources.
It includes multi-variable TLA+ models, native application tests, and forbidden source and model variants.
Run the complete workflow with `npm run verify:ingestion`.
Read [the verification record](docs/verification.md) for the tested scope and remaining limits.

The checks exercise valid and invalid source examples in both backends and plugin portability.
When `TLA2TOOLS_JAR` is set, the integration test also runs TLC.
Do not report an unavailable TLC run as a successful model check.

Specification Guided Development is licensed under [MIT](LICENSE).
