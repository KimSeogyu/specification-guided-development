# Rust whole-row source analyzer

This tool derives payload equality and owned-value codecs from a supported Rust library source closure. It emits the `RowBindingPlan` consumed by SGD. It does not classify an application input as an action, generate a manual transition table, or attest project-wide storage coverage.

```sh
cargo build --locked --release --manifest-path tools/rust-bindings/Cargo.toml
tools/rust-bindings/target/release/sgd-rust-bindings --root /app --binding /tmp/row-binding.json
```

`CARGO_TARGET_DIR` changes the executable location. A successful command prints one JSON plan to stdout. Failure prints an actionable `TLC305` JSON diagnostic to stderr and exits with code 2. No application build, macro execution, network request, or application file write occurs during analysis.

## Source and equality profile

The analyzer parses Rust with `syn` and Cargo manifests with `toml_edit`. It reads each source once, follows local path dependencies and ordinary library modules, resolves the selected Fact module and re-exports, and returns every read relative path and SHA-256 digest. The caller must revalidate those source identities before publishing generation results.

The selected Facts are public, non-generic structs of supported owned fields. Their ordinary `PartialEq::eq` is a conjunction of matching `self.field == other.field` comparisons. Omitted fields must appear in the explicit metadata list. Every declared field must be classified. A source-only field addition cannot disappear from generation.

The finite quotient extension accepts an equality term followed by an unqualified, unshadowed standard `matches!` over the same field pair. Literal and resolved `u32` constants are supported. The analyzer checks the supplied relation's symmetry and transitivity. It does not complete missing native equality cases. A normalized field remains in payload and its exact raw value also enters provenance.

Codecs cover `i64`, `u32`, `bool`, owned UTF-8 strings, unit enums, and checked one-field owned wrappers. Primitive and standard trait names must resolve without shadowing. Wrappers require standard derived equality and cloning, plus a public no-argument getter that returns the exact representation. A consuming getter requires the wrapper to derive `Copy`. Getter chains are limited to four methods. No generic collection, reference field, shared mutable value, callback, custom Clone, custom Drop, or inherent clone is accepted for a bound value.

The timestamp macro support validates a local one-rule `macro_rules` template with identifier and literal parameters. It substitutes tokens and parses the expanded tuple struct and inherent/Display implementations as AST. The codec validator then checks the actual expanded representation and getter. Acceptance does not depend on the macro's spelling.

## Production library inventory

The analyzer inventories ordinary production library modules and local dependencies. Literal test and Kani conditions, including conditions that are provably false when both flags are false, are outside that production scope. A selected Fact hidden behind those conditions is absent and fails binding. Conditional bound definitions, aliases, fields, getters, or implementations fail.

Opaque item-producing macros anywhere in the inventoried production libraries fail. Expression macros are limited to unshadowed standard macros. Their nested input token trees cannot contain `impl` or unknown macro calls. This prevents sibling modules and standard macro input blocks from hiding nonlocal Drop implementations. Explicit Drop implementations and nested impl items also fail. Unknown explicit trait identities cannot be ignored as unrelated traits.

Standard derives are resolved without local shadowing. Default-registry `serde` and `clap` derives on unrelated inventory items are trusted dependencies, not expanded by this analyzer. Their dependency package names and default-registry declarations must match. Local paths, excluded generated dependencies, git, custom registries, and patch/replace overrides cannot supply this trust. Unknown procedural attributes and derives fail.

The analyzer reads and hashes `.cargo/config` or `.cargo/config.toml` along each selected crate's ancestry up to the application root. Only `[alias]` configuration is supported. Local source, registry, environment, and build overrides fail. Both configuration names at one location also fail as ambiguous. The global Cargo configuration, registry/cache contents, toolchain, genuine default-registry dependencies, and platform are a trusted environment boundary. The analyzer does not attest them. This inventory is not an all-Cargo-target, all-feature, test-mode, build-script, or arbitrary procedural-macro verifier.

Source paths must remain inside the application root. Symlink source files, ambiguous module layouts, conditional imports, extern-crate declarations, and glob imports fail. Sources are limited to 512 files, 4 MiB per file, and module depth 32. Finite quotient classes use at most 64 participating `u32` values.

## Generated output exclusion

The parent compiler can pass `--generated-root OUT` for its controlled owned output directory. The only excluded paths are `OUT/rust/adapter.rs`, `OUT/rust/src/lib.rs`, and `OUT/rust/Cargo.toml`. The output may not exist yet. Existing ancestors are normalized before checking containment, including macOS temporary-directory aliases.

An excluded module hook must be private, unconditional, and free of `macro_use`. Excluded generated dependencies cannot supply source codecs. A selected bound type or helper resolving into excluded output fails. Other source paths inside the output directory fail instead of being silently skipped. Original manifests and module hooks remain source identities.

The parent must verify the output ownership inventory and generated bytes separately. This exclusion prevents old generated adapter/owner bytes from becoming their own source inputs and causing regeneration loops. The source plan does not attest the excluded files.

## Verification

```sh
cargo test --locked --manifest-path tools/rust-bindings/Cargo.toml
```

The tests use public Parangsae Fact and core implementations, pending Kline schema equivalence, and source mutations. They cover omitted fields, changed equality, getter/macro representation drift, shared mutable fields, finite equivalence laws, primitive and standard namespace shadowing, hidden Drop implementations, consuming getters, conditional source, symlinks, and generated-output bootstrap. The fixture's reduced workspace and the actual application source analysis remain distinct evidence.

## Closed source-scope mode

The separate `source-scope` command checks every target discovered by Cargo against a small unconditional Rust language:

```sh
sgd-rust-bindings source-scope --root /app
```

The library entry point is `analyze_source_scope(root)`. A successful command prints a `rust-source-scope-v1` report. Its scope is `all-discovered-targets-unconditional-closed-source`, and `storageAuthority` is always `false`. Failure prints a `TLC308` diagnostic with `storageAuthority:false` and exits with code 2. The existing row-binding command, JSON plan, and production-library scope are unchanged.

The command runs real `cargo metadata --offline --locked --format-version 1` after local configuration and manifest checks. It requires an existing `Cargo.lock`, exact workspace member paths, and explicit local path dependencies inside the selected workspace root. It records each library, binary, integration test, example, and bench with its package identity and separate `crate::` namespace. Own-library imports and renamed dependencies resolve to the corresponding library target. A custom dependency library name currently requires an explicit renamed dependency alias. Other custom-name mappings fail closed.

Source identities contain UTF-8 file name components joined with `/`, independent of the host's native path separator. Native Windows separators are supported. Literal backslashes in POSIX file names remain unsupported. Cargo input paths use portable forward slashes. Source files and their parent components must remain inside the selected root without symlinks.

The first profile refuses registry dependencies, workspace member globs, inherited dependencies, nonempty feature declarations, target-dependent dependencies, build scripts, procedural macros, local toolchain overrides, and unknown Cargo target kinds. Local Cargo configuration supports only `[alias]`. It rejects ambiguous configuration names and build, environment, source, and registry overrides before invoking Cargo. The inherited environment, global and above-root Cargo configuration, toolchain, cache, and platform are trusted prerequisites. This command does not attest or change those prerequisites.

The admitted source language contains ordinary modules, explicit imports and reexports, safe nongeneric free functions, primitive scalar data, tuples, arrays, immutable references, and immutable local function aliases. Calls resolve to actual local function identities. Every loaded function body and import is checked, including unused private functions. A local function named `write` can pass. A function value that resolves through a reexport to `std::fs::write` fails with that qualified identity. All standard or foreign APIs lack pure summaries in this profile. Known filesystem, IO, process, network, and platform references receive an effect classification and fail.

The checker refuses receiver and trait dispatch, custom types and lifecycle code, generic callbacks, escaping function values, macros, unknown attributes, mutable bindings, closures, unsafe code, and unsupported expressions. It rejects every documentation attribute, doc comment, `cfg`, `cfg_attr`, and test attribute instead of silently excluding that source. Rustdoc can compile fenced or indented documentation code into executables that Cargo metadata does not enumerate, so this profile refuses documentation input entirely. Ordinary non-doc comments remain supported. Target kinds are recorded; conditional and feature views are not evaluated. Toolchain-generated test and bench harness code is outside user-source analysis. Standard prelude behavior, builtin operators, panic behavior, and runtime behavior remain part of the trusted toolchain boundary. Primitive shape checks are not a general Rust typechecker or a compilation result.

Before returning success, the command repeats safe Cargo discovery and verifies captured source, manifest, lockfile, and configuration bytes. It also rechecks absent configuration and alternative module paths. An added automatic binary or ambiguous module layout changes the result even when earlier source files remain unchanged. No generated directory or file is excluded in this mode. These checks detect ordinary edits across analysis phases. They do not create an atomic filesystem snapshot.

This mode produces source evidence only. It does not admit current Parangsae codecs, derive loaded-resource identity, grant a filesystem namespace, or generate storage authority. Unsupported source fails instead of returning partial workspace success.
