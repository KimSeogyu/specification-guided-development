# Specification Guided Development

Compile supported TLA+ models into state authorities and source checks for TypeScript 7 and Rust.
Use the bundled agent skills to model architecture and behavior, then develop with generated ownership and diagnostics.
The package name is `specification-guided-development` and the CLI name is `sgd`.
The source-checkout examples below invoke that CLI with `node dist/cli.js`.

```text
Requirements
  -> TLA+ model and TLC configuration
  -> TLC model checking and DOT state graph
  -> typed automaton
  -> generated TypeScript or Rust state authority / linter
  -> application integration and native verification
```

Specification Guided Development is an initial compiler for this workflow.
The [production goal](docs/production-goal.md) is successful and sustainable adoption in Parangsae.
Project v2 retains full concrete state and generates an owner that permits only modeled transitions.
Project v3 adds immutable data input and compiles a supported symbolic equality/copy relation from SANY, checked against original TLA+ actions with a finite input oracle.
Project v4 separates payload and provenance through independent data inputs and supports checked erasure to a higher-level symbolic model.
Project v5 derives a closed whole-row binding from supported Rust equality, wrappers, and getters, then generates actual row owners and portable TypeScript DTO owners.
Project v6 composes those rows with a finite aggregate controller and literal family projections to generate a closed partition data fold.
Project v1 projects one string variable and generates declaration or import diagnostics.
The [finite-owned guide](docs/finite-owned.md) describes the new source-checkout milestone; the published v0.1.0 archives contain the earlier diagnostic prototype.

## What works

The current source supports these profiles:

| Binding | TypeScript | Rust | Checked property |
| --- | --- | --- | --- |
| Closed partition fold (project v6) | Authenticated rows and a single-use frozen handle | Sealed Fact fold and consuming report | Complete row/control observations, counts and ordered conflicts produce an unbound report; storage authority remains separate |
| Whole rows (project v5) | Authenticated immutable DTOs with exact representations | Closed actual Fact types behind a private adapter | Source equality and retained metadata agree with the modeled payload/provenance relation; complete rows are prepared before commit |
| Independent data inputs (project v4) | Fixed-arity primitive inputs and closure-owned tagged state | Fixed-arity inputs and a separate private owner crate | Complete payload/provenance updates; checked enabled-input erasure between supported models |
| Symbolic data input (project v3) | Closure-owned tagged values | Separate private crate with owned string identities | Generated guards choose the action for the actual input; assignments retain their old-state/input origins |
| Finite owned state (project v2) | Closure-owned state with a frozen facade and snapshots | Separate crate with private authority state | Each successful dispatch follows the edge from the exact full current state |
| Transition | A configured function call with three string literals | A configured function call or macro with three string literals | The declared source state, action, and target state form a permitted edge |
| Dependency | Imports between mapped module paths | Imports between mapped module paths | The source module may directly depend on the target module |

The finite-owned profile preserves guards over all supported scalar variables in the explored graph.
Its boundary is one live object; persistent identity, recovery, effects, and application-wide coverage remain work toward the production goal.
Transition constructs in project v1 declare edges.
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
Build a full-state authority and inspect its guard states with Pele:

```sh
node dist/cli.js build --project examples/approval/project.json --jar "$TLA2TOOLS_JAR" --out .runtime/approval
node dist/cli.js visualize --ir .runtime/approval/automaton.json --out .runtime/approval/view
```

The generated TypeScript API is `createApprovalMachine().read()/send(event)`.
The Rust crate exports `ApprovalMachine::new/read/send(Event)`.
Both reject `Submit` until `Approve` changes the full concrete state.
Read [the finite-owned guide](docs/finite-owned.md) for native builds, integration, supported semantics, and limits.

For parameterized equality/copy rules, build the original fact-merge model:

```sh
node dist/cli.js build --project examples/fact-merge/project.json --jar "$TLA2TOOLS_JAR" --out .runtime/facts
node dist/cli.js visualize --ir .runtime/facts/automaton.json --ir .runtime/facts/symbolic-model.json --out .runtime/facts/view
```

The generated `FactMachine.send(input)` selects Insert, Same, or Clash from the model. After A, B, and C, it retains stored A and latest rejected C. Data identities are immutable strings, distinct from scalar model strings. Read [the symbolic-owned guide](docs/symbolic-owned.md) for the source grammar, finite versus symbolic verification, and the actual Parangsae integration still required.

When equal payloads can have different receipt or source metadata, use [independent data inputs](docs/product-inputs.md). The [fact-envelope example](examples/fact-envelope/README.md) models that metadata explicitly and checks its erasure to the original fact-merge contract with `sgd refine`. An erasure check covers the supplied symbolic programs; actual Fact encoding, native object ownership, and partition writes need application bindings.

For a generated collection fold, read [the v6 partition guide](docs/partition-fold.md). It checks complete row roles and the aggregate protocol, generates raw key projections from audited source codecs, and returns unbound data. Loaded-resource and writer authority remain required work.

For existing Rust rows, read [the whole-row binding guide](docs/row-owned.md). V5 analyzes actual source equality and the owned type closure, preserves metadata excluded or normalized by equality, and returns original model action IDs. Its library-source scope excludes all-target/feature coverage and storage authority. TypeScript DTOs preserve the audited representations; they do not infer every native constructor precondition.

For declaration diagnostics, build the included v1 order model:

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
`compile` accepts only project v1 diagnostics; it rejects executable authority generation.
The generated verification metadata records that distinction.
Use `build` when the result must include this tool's TLC completion evidence.

Each output directory has a `.sgd-generated.json` inventory of owned generated files.
Use an empty directory for the first generation.
The compiler refuses a nonempty directory without that inventory.
Regeneration removes obsolete owned checker source when targets or profiles change, including a model-only rerun.
Use `build --check` or `compile --check` to compare stable artifacts without updating them.
TLC logs and run receipts are not compared byte for byte.
Interrupted generation has [journaled process-termination recovery](docs/managed-output.md); `--check` does not repair incomplete outputs.

For a real Codex CLI session with fresh MCP generation and native checks, use the [manual host verification guide](docs/codex-host-verification.md). It requires an existing login and leaves global configuration unchanged. Plugin discovery and permanent installation have separate acceptance checks.

## Model architecture and behavior

The intended method starts before lint integration:

1. Translate the requested architecture and behavior into finite TLA+ models.
2. Check invariants and inspect the reachable state graph.
3. Select the supported profile and record the actual application state owner and code binding.
4. Generate a full-state authority for behavior, or diagnostics for declared edges and dependencies.
5. Integrate the generated owner and checks into the feature.
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
Project v3 uses SANY to compile supported input guards and simultaneous equality/copy updates. A separate TLC oracle checks every configured reachable state/input pair, while grammar-scoped symbolic orbits check equality patterns. This is not unrestricted TLA+ compilation or automatic application payload binding.
Project v4 applies that grammar to independent nominal domains. Its erasure checker preserves complete projected state, input admission, and action classification between supplied symbolic models. It does not attest application bindings or source provenance.
Project v2 preserves all supported scalar variables and dispatches from the owner's exact concrete node.
Its controlled build rejects unsupported reductions, overrides, compound state, and ambiguous executable choices.
The state owner does not automatically bind live input or database values, protect unrelated application state, prevent creation of another owner, or make external effects atomic.

Project v1 projects one nonempty TLA+ string variable from the reachable states.
An emitted diagnostic edge means that at least one explored concrete transition permits that edge.
Guards over discarded variables do not survive that projection.

For example, observing an `Approve` edge while `balance >= amount` does not generate a checker for that numeric guard.
The v1 application still needs the guard and tests for its behavior.
No profile proves full application refinement, liveness, transaction atomicity, or arbitrary runtime call paths.

Each profile rejects graph structures and values outside its documented subset.
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
