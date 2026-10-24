# Native Funding codec fixture

This fixture preserves the real Parangsae `FundingFact`, native value wrappers, Symbol validator, and timestamp macro. The five copied implementation files match the Parangsae pilot source inspected on 2026-10-24. The manifests and module entry points form a reduced workspace with local dependencies. They do not represent the complete application or its Cargo dependency graph.

`codec-binding.json` selects the proposed `rust-codec-recipe-v1` source profile. `funding_codec.rs` contains two complete row recipes and a literal descriptor. Each descriptor tuple maps a physical column name to its native field. The scalar type follows the wire field and the audited native recipe.

`sgd_wire.rs` is an explicitly labeled compiler-wire bootstrap for this fixture. It contains owned data only. This checked-in copy is neither a compiler receipt nor a File handle, writer, or storage permission.

## Physical column contract

The descriptor and both leaf functions preserve the nine columns in Parangsae's existing Funding writer and named-column reader.

| Physical column | Wire scalar | Native field |
| --- | --- | --- |
| `symbol` | `String` | `symbol` |
| `raw_calc_time_us` | `i64` | `raw_calc_time` |
| `funding_time_us` | `i64` | `funding_time` |
| `interval_hours` | `i64` | `interval_hours` |
| `rate_ticks` | `i64` | `rate` |
| `event_ts_us` | `i64` | `event_ts` |
| `available_ts_us` | `i64` | `available_ts` |
| `received_ts_us` | `i64` | `received_ts` |
| `schema_version` | `u32` | `schema_version` |

The encoder copies the Symbol string and uses the real native getter chains. The decoder uses the real Symbol validator and exact wrapper constructors. It propagates the concrete `SymbolError` without a Display callback or error conversion.

The codec preserves signed rates, exact interval values, raw schema values, and the original receipt. It does not impose CSV ingestion's eight-hour interval or schema version 3. Native Funding equality omits `received_ts`; the persistence recipe retains that field independently.

## Native observations

Run the reduced workspace's native tests from the SDK root:

```sh
cargo test --offline --locked --manifest-path tests/fixtures/rust-codec-recipe/parangsae/Cargo.toml --target-dir /tmp/sgd-codec-recipe-fixture-target
```

The codec tests compare each physical wire field against distinct literal values in both directions. They also exercise the complete native integer ranges, values beyond JavaScript's exact Number range, raw schemas, interval values outside CSV admission, Symbol errors, and receipt preservation despite native equality.

These are leaf-codec observations. No Arrow array, RecordBatch, Parquet file, selected-resource owner, or filesystem effect is exercised here. Extra or reordered physical columns, null/type errors, scale metadata, native IO outcomes, and application-wide source coverage need separate integration evidence.

## Source refusal corpus

`mutations.json` lists independent source mutations and their required refusal behavior. Each case applies to a fresh copy. A `replace-once` operation requires exactly one original match. A `create-absent-file` operation requires an absent destination.

Cases marked `before-analysis` require the actual new analyzer to refuse the mutated source. Cases marked `after-capture` require the original checked capture's final recheck to refuse a changed input inventory. Target rediscovery proves freshness, not effect analysis of every discovered target.

The corpus includes safe Rust constructor writes, same-scalar clock swaps, paired inverse swaps, lost receipt or raw schema, changed Symbol validation, new fields, unused writers, function values, Display conversion, custom Drop, and conditional bodies. Native round-trip success alone cannot establish the physical column relation or these refusal outcomes. Analyzer mutation runners must not compile or execute the mutated applications.
