# Native codec recipes

The separate `rust-codec-recipe-v1` profile checks complete native row encoding and reconstruction. It adds constructor analysis to the existing source-bound row representation. It does not generate a resource owner or attest a loaded file, writer, archive, or complete application effect scope.

## Binding and commands

The [Funding binding](../tests/fixtures/rust-codec-recipe/codec-binding.json) names one native Fact, its explicit metadata, a codec module, two leaf functions, a plain wire type, and a literal column descriptor. It supplies no callback, purity annotation, baseline, trusted writer, or permission list.

The source-checkout command is:

```sh
cargo run --locked --manifest-path tools/rust-bindings/Cargo.toml -- codec-recipe \
	--root tests/fixtures/rust-codec-recipe/parangsae \
	--binding tests/fixtures/rust-codec-recipe/codec-binding.json
```

The native library exposes `analyze_codec_recipe(root, binding_path)`. Its `CheckedCodecRecipe` contains a private input capture and a serialized report. `report()` borrows the report. `recheck()` repeats safe discovery and verifies captured bytes and absent paths. Serialized JSON cannot restore this object.

The TypeScript 7 library exposes `analyzeCodecRecipe({ application, binding })` and `recheckCodecRecipe({ report })`. The first call validates the binding value and invokes the native helper. The second accepts the exact analysis-created report object, rechecks the original application root, and repeats the complete native analysis. It compares semantic, source, absence, and discovery evidence. A copied or parsed report cannot restore that private context. The binding value is captured by the API. A future project compiler must separately retain and recheck its original project and binding files.

Prepared Codex and Claude Code packages contain the same native helper and TypeScript library. Their existing `sgd` project versions remain 1–6. There is no new project schema or MCP tool for this source evidence.

## Checked source

The selected codec and wire modules require separate ordinary source files. The checker parses their complete captured text, including code that a production-library inventory would otherwise omit under test conditions. Unsupported items, unused helper bodies, conditional definitions, callbacks, and attributes fail. Both leaves have one parameter and one complete result expression.

The literal descriptor is an array of `(physical_column, native_field)` pairs. Each column, native field, and wire field occurs exactly once. The wire contains only public owned `String`, `i64`, or `u32` fields. Its module contains its single plain struct. The encoder copies every original field through the audited getter chain. The decoder constructs every original field from the corresponding wire scalar and checked constructor.

Constructor analysis checks actual resolved types, signatures, complete bodies, and lifecycle constraints. Supported recipes are exact scalar identity, one-field tuple wrapping, and the current ASCII Symbol validation algorithm. The Symbol recipe checks the empty and 32-byte limits, uppercase-or-digit predicate, exact error variants, and standard owned string copy. It does not trust a function named `new`. Expanded timestamp constructors undergo the same body and type checks. Unknown method dispatch, trait or value shadowing, custom lifecycle behavior, and unsupported constructors fail.

Native equality and storage representation remain distinct. Funding persists all nine fields, including the original `received_ts` omitted by native Eq. Signed rates, original interval and schema integers, and exact timestamp values survive. The recipe does not impose CSV ingestion rules on stored values.

The descriptor states the current source format. A coordinated change to the descriptor and both leaves can describe a different format. The source recipe alone does not prove compatibility with existing Parquet files. The [native fixture](../tests/fixtures/rust-codec-recipe/parangsae/crates/collector/src/funding_codec_tests.rs) compares physical fields independently so paired encoder and decoder mistakes cannot hide in a round trip. Actual Parquet compatibility remains part of the resource integration.

## Captured input and discovery

The new route shares bounded read, path, and absence checks with the closed source-scope machinery. It records module alternatives, local configuration, manifests, lockfile, source bytes, and discovered local target roots. The binding JSON has a separate 1 MiB capture and can live outside the application. Source files retain the 4 MiB per-file, 512-file, and 32 MiB total limits. Cargo metadata output is bounded separately.

Before `cargo metadata --offline --locked`, preflight refuses unsupported local configuration, build scripts, toolchain overrides, dependency overrides, and ambiguous paths. Local feature graphs, optional dependencies, target-dependent declarations, and local procedural targets are outside this first discovery profile. Genuine default-registry identities are matched against the lockfile. Registry content, foreign build scripts and procedural dependencies, global configuration, the toolchain, and the platform remain named trusted prerequisites. Analysis does not build or execute the application.

The discovery report has `scope: "discovered-targets-only"`. Its feature view is Cargo's unfiltered metadata inventory union. It is not an exact compiler host and target unit graph. The checked Fact library is tied to its actual Cargo package, target name, crate name, and source path. Other target bodies and filesystem sinks have not passed effect analysis merely because Cargo listed them.

Final recheck repeats preflight and metadata discovery and verifies every captured byte and absence probe. This detects ordinary changes across analysis phases. It does not create an atomic filesystem snapshot or attest the trusted environment.

The new captured route does not reuse the old generated-output exclusions. The current Parangsae generated modules still need a controlled expected-source overlay before this profile can feed resource generation. A generated directory name or caller-supplied trusted path cannot provide that evidence.

## Report and limits

The immutable report contains complete native fields, column mappings, resolved constructor identities, source and binding identities, absent inputs, selected library identity, and discovery evidence. Its scope is `selected-codec-and-native-constructor-closure`, and `storageAuthority` is always `false`. Failure uses diagnostic `TLC309`, preserves the failing source location where available, and exits the native CLI with code 2.

The old v5 row schema, result, command, and production-library scope remain unchanged. The registry-free `rust-source-scope-v1` contract is also unchanged. The new profile is a prerequisite for the actual Funding resource unit. A compiler-owned Arrow normalization bridge, selected File ownership, one replacement invocation, coverage composition, all-target effect admission, and TypeScript storage parity remain required by the [production goal](production-goal.md).
