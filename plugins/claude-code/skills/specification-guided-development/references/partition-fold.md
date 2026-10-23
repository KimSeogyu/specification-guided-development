# Generate a closed partition data fold

Select project v6 `partition-fold` when a batch fold must own row transitions and aggregate observations. Its output is ordinary unbound data. Loaded-resource authentication, exclusive writers, additional Cargo targets, and alternate filesystem routes need a separate contract.

## Inputs

Reference a v5 `row-owned` project and a v2 `finite-owned` project. Both must use controlled model sources. The row project and composition must bind the same application. Use this project shape:

```json
{
  "version": 6, "profile": "partition-fold", "name": "FactPartition",
  "application": "../..", "targets": ["typescript", "rust"],
  "models": {
    "row": { "project": "fact-write.json" },
    "control": { "project": "partition-control.json" },
    "families": { "spec": "PartitionFamilies.tla", "operator": "PartitionFamilies" }
  },
  "binding": { "className": "FactPartitionMachine", "rustCrateMode": "workspace" }
}
```

Paths are relative to the project file. Use `workspace` when the generated crate belongs to the application's Cargo workspace. Use `standalone` only for a genuinely separate crate.

The row model must use exactly phase and two complete stored/rejected pairs. Its phases are absent, present, and conflict. Insert installs the complete input; Same preserves the complete state; Clash preserves the first stored row and installs the complete rejected input. Every admitted input must select exactly one action. The compiler checks these roles across supported equality/copy orbits, not action names alone.

The control uses phase, hasInserted, and hasConflict. Its phases are Open, ReadyWrite, ReadyNoop, ReadyRefused, and Consumed. Its actions are Insert, Same, Clash, CloseWrite, CloseNoop, CloseRefused, ConsumeWrite, ConsumeNoop, and ConsumeRefused. Open admits every observation. Insert and conflict history remain sticky. Exactly one close matches the flags; each ready state admits one matching consume; Consumed admits no explicit action.

Configure TypeOK, CloseAdmission, CloseChoice, NoInputAfterClose, SingleConsumption, ConflictSticky, InsertSticky, and NoReopen. Disable terminal deadlock checking. The initial source profile requires the supported SANY expressions, including enabled-close availability and temporal sticky/no-reopen expressions. A name whose definition is TRUE is refused. Start from the bundled [PartitionControl.tla](PartitionControl.tla) and [PartitionControl.cfg](PartitionControl.cfg). Copy them into the original model directory and reference them with a v2 project. Do not replace their obligations with weaker properties.

Define one literal metadata operator in a separate original module:

```tla
---- MODULE PartitionFamilies ----
PartitionFamilies ==
 [version |-> 1, calendar |-> "utc-micros-nonnegative-day-v1",
  families |->
   [FundingFact |->
    [key |-> <<"funding_time">>, symbol |-> "symbol",
     time |-> "funding_time", datasets |-> {"funding-rate"}]]]
====
```

Every audited Fact needs exactly one family with the same name. Select one to three distinct ordered raw i64 payload key fields. Select an exact string payload for symbol and an i64 payload for time. The analyzer supplies original getter chains. Dataset names must be safe lowercase hyphen-separated components and distinct across all families. Imports, helpers, assumptions, variables, computed metadata, unknown members, repeated key fields, and normalized key fields fail.

## Build and integrate

Use `sgd_build` with the composition. Imported DOT and `sgd_model` on v6 are refused. Use referenced row/control projects for model-only inspection. The compiler verifies both models and original sources before one managed output publication. Keep original models and bindings outside generated output.

During v5 migration, reuse the current controlled output root. Keep the original include hook and generated Cargo dependency. Do not add a second active legacy owner or exclude the whole generated directory from original-source analysis.

Rust privately includes adapter.rs and imports the primitive crate as sgd_fact_authority. Call `fold_partition(baseline, incoming)?.into_report()?`. Its sealed bound admits only the audited Facts. TypeScript creates authenticated rows with `create<Fact>Row(data)`, calls `fold<Fact>({ baseline, incoming })`, then calls the successful value's `intoReport()` once. Both calls return `{ ok: true, value }` or `{ ok: false, reason }` in TypeScript. Read the generated README for exact types.

No key callback, public observation, receipt submission, live controller, raw closed-result constructor, or restore API enters the fold. Do not recreate these as application wrappers.

## Verify and report

Every nonempty baseline and incoming row must share an exact symbol and nonnegative microsecond day index. The calendar divides i64 microseconds by 86,400,000,000. Baseline duplicates retain last-wins semantics for Write. Noop and Refused retain the original baseline order and duplicates. Refused preserves every complete conflict pair, includes unchanged observations, and reports inserted zero. Repeated successful stutters remain observations. Write sorts keys using signed i64 tuple order, independently of identity strings.

Exercise provisional insertion followed by conflict, repeated identical conflict, equal-only input, empty input, duplicate baseline keys, signed composite keys, complete metadata retention, invalid groups, forged tokens, and single consumption. Run native checks and regeneration with `--check`. Use Pele with automaton.json and symbolic-model.json to inspect full control and row relations. A diagram displays model evidence; it does not establish loaded-resource or persistence guarantees.

Record the source scope, unsupported cases, intervention, and storage gap. A generated data fold does not complete sustainable application adoption. Preserve existing Parangsae coverage-before-write and conflict-log behavior during later storage integration.
