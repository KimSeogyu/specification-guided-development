# Closed partition data folds

Project v6 `partition-fold` generates one closed collection operation from a checked v5 complete-row model, a checked v2 finite controller, and literal TLA+ family metadata. TypeScript 7 and Rust share the same plan. This source milestone produces **unbound data reports**. It does not authorize a filesystem writer or authenticate a baseline loaded from disk.

## Configure the composition

```json
{
  "version": 6,
  "profile": "partition-fold",
  "name": "FactPartition",
  "application": "../..",
  "targets": ["typescript", "rust"],
  "models": {
    "row": { "project": "fact-write.json" },
    "control": { "project": "partition-control.json" },
    "families": { "spec": "PartitionFamilies.tla", "operator": "PartitionFamilies" }
  },
  "binding": { "className": "FactPartitionMachine", "rustCrateMode": "workspace" }
}
```

Paths are relative to this project. The row project must use v5 and bind the same application. The control project must use v2. Its initial source profile is the exact [partition-control model](../examples/partition-control/model.tla), including all configured admission and temporal obligations. Equivalent formulas outside the admitted SANY expression grammar require a profile extension. A property named `ConflictSticky` whose expression is `TRUE` is refused.

Write a separate metadata module with one zero-argument literal definition. A one-Fact application can use:

```tla
---- MODULE PartitionFamilies ----
PartitionFamilies ==
  [version |-> 1,
   calendar |-> "utc-micros-nonnegative-day-v1",
   families |->
     [FundingFact |->
       [key |-> <<"funding_time">>,
        symbol |-> "symbol",
        time |-> "funding_time",
        datasets |-> {"funding-rate"}]]]
====
```

Every audited Fact must have exactly one family with the same name. Keys contain one to three distinct ordered raw i64 payload fields. The time field is an exact i64 payload; the symbol is an exact string payload. The source analyzer supplies getter chains. Normalized fields, callbacks, JSON source overrides, imports, helpers, variables, assumptions, computed values, unknown record members, and overlapping or unsafe dataset names are refused.

The calendar admits nonnegative i64 microseconds and computes `dayIndex = time / 86_400_000_000`. It imposes no year-9999 cutoff. Every baseline and incoming row must have the same exact symbol and day index. This checks consistency within the supplied data. Dataset metadata identifies the family vocabulary; this unbound operation accepts no dataset, path, reader, or writer argument.

## Build and inspect

```sh
node dist/cli.js build --project /app/spec/sgd/partition.json --jar /tools/tla2tools.jar --out /app/spec/sgd/generated/fact-write
node dist/cli.js build --project /app/spec/sgd/partition.json --jar /tools/tla2tools.jar --out /app/spec/sgd/generated/fact-write --check
node dist/cli.js visualize --ir /app/spec/sgd/generated/fact-write/automaton.json --ir /app/spec/sgd/generated/fact-write/symbolic-model.json --out /app/.runtime/partition-view
```

`sgd_build` in either native plugin uses the same pipeline. Imported DOT cannot generate v6 authority. For model-only inspection, run the referenced row/control projects; `sgd_model` on a v6 composition is explicitly refused.

Both controlled models, the row source plan, the original-action oracle, the metadata, and the complete composition are compiled in memory. The compiler rechecks original inputs and publishes one owned inventory. It does not invoke public builds in nested output directories or trust old receipts. `partition-plan.json` retains the checked relation and projection schema; `models/row` and `models/control` retain their evidence. The top-level receipt records `storageAuthority: false`.

Keep the existing v5 output root during migration. The source gate excludes only the controlled Rust adapter, primitive library, and manifest. The inlined control module adds no directory-wide source exclusion. Regeneration removes obsolete inventory-owned v5 files; original include hooks and Cargo manifests remain checked inputs.

## Use the generated operation

Rust includes `adapter.rs` privately and imports the separate primitive crate under `sgd_fact_authority`:

```rust
let closed = adapter::fold_partition(baseline, incoming)?;
let report = closed.into_report()?;
match report {
    adapter::UnboundPartitionReport::Write { rows, counts, .. } => inspect(rows, counts),
    adapter::UnboundPartitionReport::Noop { rows, counts, .. } => inspect(rows, counts),
    adapter::UnboundPartitionReport::Refused { original, conflicts, counts, .. } =>
        inspect_refusal(original, conflicts, counts),
}
```

The bound is sealed to the audited Facts. Callers cannot choose a key, equality relation, controller event, receipt, or closed-result constructor. `into_report(self)` consumes the Rust value and returns a fallible result.

TypeScript uses frozen authenticated complete rows and a single-use handle:

```ts
const row = createFundingFactRow(rawFields);
const folded = foldFundingFact({ baseline, incoming: [row] });
if (!folded.ok) throw new Error(folded.reason);
const consumed = folded.value.intoReport();
if (!consumed.ok) throw new Error(consumed.reason);
inspect(consumed.value);
```

Arrays must contain dense own data entries. Accessors, holes, extra properties, copied/forged/cross-Fact tokens, and foreign module tokens fail before the private trial. Counts are checked u64 values (`bigint` in TypeScript). The DTO profile retains its v5 representation scope; it does not reproduce Rust constructor preconditions.

## Runtime contract and limits

Baseline replay uses a fresh row owner for each row and keeps the last owner for a duplicate key. Replay does not count as an incoming observation. Every incoming row performs its private row transition and delivers that exact action to the private aggregate controller. Successful Same and repeated Clash stutters still count as observations.

- **Write:** complete trial rows in signed i64 tuple order, with insertion and unchanged counts.
- **Noop:** exact original baseline order and duplicates; no normalization of the original data.
- **Refused:** exact original baseline, every complete stored/rejected pair in encounter order, inserted zero, and the complete unchanged count. Provisional insertions do not escape.

Any row, grouping, counter, control, close, or consume failure returns no successful report. The whole private trial is discarded. The collection runtime is generated and tested; the finite controller does not prove arbitrary maps, batch lengths, counters, ordering, or persistence.

The following required work is [loaded-resource and source/sink authority](partition-authority-design.md): bind the selected dataset/symbol/day, actual load, baseline, and writer; close aliases, additional targets, and alternative mutation routes. Ordinary application code consuming an unbound report remains outside that storage guarantee. Native v6 parity alone does not complete [sustainable Parangsae adoption](production-goal.md).
