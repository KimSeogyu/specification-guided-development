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
