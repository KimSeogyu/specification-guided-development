# Partition authority after complete-row ownership

Status: v6 now has a source implementation of the [closed partition data fold](partition-fold.md). Its complete-row and control instances remain private and its consumed result is explicitly unbound data. The resource-bound session and sink-coverage checks below remain planned. Parangsae draft PR #9 now uses the generated v6 fold. Its physical resource/writer consumption and complete source/sink closure remain required work.

## Decision and alternatives

Generate a closed batch fold that owns the per-key owners and a finite aggregate controller. Only that fold can observe row outcomes, accumulate counts and complete conflict pairs, close the trial, and create its private result. Bind that result to the loaded partition before giving it a storage entry point.

| Alternative | Assessment |
| --- | --- |
| A public controller beside the handwritten fold | Reject. A caller can omit, duplicate, replay, or substitute an observation. A genuine receipt from another key or trial cannot authorize a partition. |
| An AST checker for the handwritten fold | Possible, but requires a source profile for loops, map operations, callbacks, counters, aliases, and control flow. Writer and source coverage still need separate checks. Refactors can change the accepted grammar without changing the business behavior. |
| A generated closed fold with a private controller | Recommended. The compiler generates the only observation path and the result constructor. The application supplies admitted complete rows through one consuming batch operation. The collection runtime remains an explicit compiler contract. |

The earlier v5 integration exposed the gap in two places. Parangsae's former `crates/collector/src/manifest.rs::merge_rows` accepted an arbitrary key callback and interpreted each `WriteEffect` in Rust. Its private `MergeOutcome::commit` accepted storage callbacks. V6 removes that fold and result type; ordinary `store::upsert_by_day` now consumes an unbound generated report and still selects physical IO. The former `crates/collector/src/store.rs::commit_merge` supplied the path, dataset, symbol, and writer independently of the loaded baseline. V6 removes that helper but still leaves physical selection in the ordinary storage consumer. Private fields and a consuming method prevent some forgery, but do not authenticate that resource.

## Finite aggregate control

The standalone [control model](../examples/partition-control/model.tla) now has a [finite-owned project](../examples/partition-control/project.json) and [TLC configuration](../examples/partition-control/model.cfg). V6 checks the complete composition and generates the closed collection fold. Its unbound report grants no storage permission. The model uses only scalar state and named, unparameterized actions.

| State or action | Contract |
| --- | --- |
| `phase` | `Open`, `ReadyWrite`, `ReadyNoop`, `ReadyRefused`, or `Consumed` |
| `hasInserted`, `hasConflict` | Boolean flags; conflict remains sticky |
| `Insert`, `Same`, `Clash` | Admit observations only while open; preserve every successful stutter observation |
| `CloseWrite` | Requires insertion and no conflict |
| `CloseNoop` | Requires no insertion and no conflict |
| `CloseRefused` | Requires a conflict, including after provisional insertion |
| `ConsumeWrite`, `ConsumeNoop`, `ConsumeRefused` | Admit one consumption from the corresponding ready state |

The actual configuration checks `TypeOK`, `CloseAdmission`, `CloseChoice`, `NoInputAfterClose`, `SingleConsumption`, `ConflictSticky`, `InsertSticky`, and `NoReopen`. Terminal deadlock checking is explicitly disabled. Real TLC rejected ambiguous or missing close choices, a refusal that produced a write, cleared insertion or refusal history, reopening, repeated consumption, and input after closing. Review first reproduced that missing close availability and cleared insertion history passed the weaker initial property set; `CloseChoice` and `InsertSticky` close those omissions without changing the actions or `Next`. Generated TypeScript 7 and Rust consumers agreed on a short accepted/rejected trace, including successful `Same` and repeated `Clash` stutters. Read the [example's verification instructions](../examples/partition-control/README.md) to rerun the model checks.

These are standalone finite-control results. A caller can still fabricate observations for that standalone machine. Only the closed composition can authenticate its own observations; no controller sidecar has been added to Parangsae.

The terminal state has no enabled explicit action. Disabling deadlock checking admits that terminal state. It does not add a successful runtime event. The square-action stutter in `Spec` also does not mint an input observation or a write permission.

`Same` is a successful full-state stutter. Repeated `Clash` also stutters once `hasConflict` is true. The fold must still count every accepted `Same` and append every complete conflict pair. It cannot infer observations from state changes or deduplicate conflict reports.

Closing has exactly one enabled action in each reachable open state. Generated closing logic selects that action from the checked controller relation. The application does not select a closing action or submit a Boolean. V6 consumption produces an unbound report. The planned storage-bound consumption records one effect attempt. It does not establish successful persistence, fsync, or crash recovery.

## Composition with per-key outcomes

The generated adapter contains both authorities. It uses the exact source action IDs `Insert`, `Same`, and `Clash` in both models. There is no configurable outcome table or public `observe(WriteEffect)` method. An action rename or vocabulary mismatch requires an explicit profile change rather than a caller-provided relabeling.

The composition gate checks the following obligations before generation:

- The complete admitted row-action vocabulary matches the aggregate observation vocabulary.
- Every row action has one enabled aggregate successor in every reachable open control state.
- Row observations are disabled after closing. Closing and consumption remain deterministic.
- The configured model checks include the stated admission and temporal properties.
- The generated fold delivers exactly the action produced by its own row operation. External receipts cannot enter that path.

Matching action names establishes structural identity. V6 also checks every supported row input/orbit against the complete Insert, Same, and Clash roles. It checks every finite valuation and explicit edge against the aggregate protocol, and admits the required source obligations by their resolved SANY expressions. Native behavior checks cover the collection runtime. Public v5 receipts and `WriteEffect` values remain observations. Their existence grants no storage permission.

Pele should show the complete controller states beside the existing envelope model. Link an aggregate observation to its exact row action. Keep those links distinct from a checked refinement relation. This composition differs from the enabled-input erasure already provided for symbolic programs.

## Closed batch interface and failure boundary

V6 generates a consuming data operation with these available interfaces:

```rust
struct ClosedPartition<T: PartitionFact> { /* private fields */ }
fn fold_partition<T: PartitionFact>(baseline: Vec<T>, incoming: Vec<T>)
    -> Result<ClosedPartition<T>, PartitionError>;
impl<T: PartitionFact> ClosedPartition<T> {
    fn into_report(self) -> Result<UnboundPartitionReport<T>, PartitionError>;
}
```

This sketch omits generated private supertrait details. Read the [v6 guide](partition-fold.md) for actual integration. The operation accepts ordinary baseline data, checks its internal grouping, and returns no resource or writer permission. A trusted loaded-partition factory is still required for the storage interface below.

Preparation owns the trial map, original rows, counts, and ordered conflict pairs. It processes the whole batch and closes the controller before returning the private closed value. Any row-binding error, disabled transition, revision exhaustion, count overflow, invalid grouping, or invalid close discards the entire private trial. A fallible consumption follows the unique matching edge and produces an unbound report. No effect callback enters either step.

This batch boundary permits an individual private row transition to precede aggregate dispatch. An aggregate failure drops both private authorities and returns no closed value. It does not claim the internal pair of steps is atomic or resumable. An incremental API that preserves the trial after an error would require a different combined-commit contract.

## Generated collection runtime

The finite control model contains no collection or numeric counts. The generated fold has this separately reviewed runtime contract:

- Replay admitted complete baseline rows into fresh owners before processing incoming rows. Baseline replay does not set `hasInserted` or increment incoming counts.
- Use one owner per generated key. Preserve complete retained rows and their provenance through the checked row adapter.
- Increment the incoming inserted count for each `Insert` and the unchanged count for each `Same`. Use checked native counters.
- Append the stored and rejected complete rows for every `Clash`, including conflicts against a row inserted earlier in the same batch.
- After any conflict, retain the entire original partition and report inserted count zero. Preserve unchanged count and all encountered conflict pairs.
- For an accepted equal-only or empty batch, issue no partition write. For an accepted batch with insertions, write the complete trial rows once.

The existing loader uses last-wins behavior for duplicate baseline keys. Preserve and test that behavior in this unit. A later unique-key validation rule needs an explicit behavior-change decision. Do not silently replace last-wins with first-wins or refusal.

The generated runtime, its source-to-output checks, and native behavior tests are additional evidence. A finite-control TLC result does not prove arbitrary map contents, arbitrary batch lengths, counter arithmetic, ordering, or filesystem behavior. A stronger proof needs an explicit collection relation and a separate proof of the fold.

## Fixed keys and resource authority

Generate the actual key functions from checked immutable source fields and getters. The current pilot keys are Kline `open_time`, Funding `funding_time`, Metrics `create_time`, and Book `timestamp` with `percentage`. Their codecs use the existing exact scalar representations. An arbitrary `key_of` callback, custom `Ord`, or generic user-provided key is outside this first profile.

The same source contract must identify symbol and day extraction, the admitted dataset for each Fact family, and the concrete reader and writer. A changed getter, conditional definition, unresolved alias, unsupported macro, stale binding, or changed source inventory must fail generation. Key selection is not inferred from payload equality.

The application-facing interface then binds the prepared result to the selected resource:

```rust
struct LoadedPartition<'store, T: PartitionFact> { /* private store borrow and baseline */ }
struct ClosedPartition<'store, T: PartitionFact> { /* private same session */ }

impl<'store, T: PartitionFact> LoadedPartition<'store, T> {
	fn prepare(self, incoming: Vec<T>) -> Result<ClosedPartition<'store, T>, Error>;
}

impl<T: PartitionFact> ClosedPartition<'_, T> {
	fn commit(self) -> Result<WriteCounts, Error>;
}
```

Only a checked concrete reader creates `LoadedPartition`. Its private session owns the canonical selected resource, dataset, symbol, day, loaded baseline, and writer choice. It validates incoming and persisted rows against that same resource. `commit` accepts no replacement path, writer, baseline, or action. Empty input cannot authorize overwriting an existing partition with a fabricated empty baseline.

The proposed exclusive store borrow prevents overlapping sessions through that live store object. Other store instances, processes, restarts, symlink or hardlink aliases, and external writers remain outside that guarantee. A pre-write baseline hash alone leaves a time-of-check/time-of-use window. Stronger writer isolation needs locking or an atomic versioned replacement protocol covering the actual load-to-write interval.

## Sink coverage and existing effects

Raw Fact Parquet writers must have one checked authorization path. Rust privacy alone does not constrain code inside the writer's own module. The source gate must find calls, aliases, re-exports, additional Cargo targets, and supported indirection into those sinks. Omitted or unsupported paths must fail rather than disappear. A direct filesystem path that replaces the same resource also needs classification. Collector-wide `fs_write` admission does not establish this closure.

Current v5 inventories production library modules. It does not cover all Cargo targets, features, build scripts, procedural macros, or external processes. Extending that scope is a required implementation unit, not a result of this design.

Preserve archive coverage-before-write ordering from the pending collector changes. Keep conflict logging separate from partition replacement. A refused trial appends reports and never replaces the partition. If appending a report fails, earlier log entries can remain and the method returns the existing error. The `.partial` write, close, and rename path remains a single-file replacement attempt. Neither a consumed plan nor this control model establishes multi-file atomicity or durable recovery.

Architecture and tooling changes require Parangsae's Ops/Release review. Activating or changing required CI checks needs the repository's human approval. Prepare those changes as concrete reviewable work before that final approval step.

## Bypass checks and acceptance

The implementation must demonstrate failures through native interfaces and the source gate. A source-mutation check must exercise the real gate rather than merely assert that generated text contains a condition.

| Attempt or behavior | Required evidence |
| --- | --- |
| New key, conflicts on another key, then an equal row | Temporary Parquet bytes and complete baseline rows remain unchanged. Inserted count is zero, unchanged count includes the equal row, and every conflict pair remains ordered. |
| Identical rejected row twice | Two reports survive even when both models' relevant state stutters. |
| Conflict against a provisionally inserted key in an empty partition | No Parquet partition is created. |
| Equal-only or empty accepted batch | No partition writer is invoked. |
| Forged, replayed, reordered, or cross-trial receipt | No supported submission API exists. A source change that adds one fails the checked output or binding gate. |
| Direct controller dispatch, omitted observation, or swapped delivery | The application cannot reach the controller. Mutating the generated delivery fails regeneration checks. |
| Raw plan construction, plan cloning, restore, or double consumption | Native compilation or runtime authentication rejects the attempt. |
| Different path, writer, resource, or fabricated empty baseline | The resource-bound interface rejects substitution and exposes no raw constructor. |
| Aggregate rejection or count overflow after a private row step | Preparation returns no plan and invokes no sink. |
| Alias or additional target calls a raw writer | The source-coverage gate identifies the unsupported authorization path. |
| Conflict-log failure or partition-write failure | Preserve the existing error and partial-effect boundary without reporting a successful durable commit. |
| TLA+ control requirement changes | Fresh generation changes the native decision in both targets, or rejects the unsupported composition. Editing generated policy cannot satisfy the gate. |

Rust first binds the actual Parangsae types and storage boundary. The same control and fold semantics must have a TypeScript 7 target using authenticated rows and a private, consumed result. Portable DTO parity does not establish TypeScript source bindings or reproduce Rust constructor checks.

Completion of this unit requires a reviewed implementation, real model execution, native bypass checks, actual temporary-partition behavior, and a reproducible mandatory verification path. Sustainable feature, requirement-change, and defect-fix cycles remain part of the [production goal](production-goal.md).

## Concrete following source boundaries

Live Parangsae grounding found additional routes that the resource implementation must close. The private same-module `write_batch(&Path, ...)` serves both Fact and Gap writes; a wrapper around it does not establish exclusive Fact authority. Raw/history paths join a full listing key after classifying only its basename, so a valid archive name does not establish a safe relative key or requested-prefix membership. A typed VisionKey must enforce that path contract before those effects. Kline needs a closed generated dataset selector because five normative datasets share KlineFact.

Workspace binaries also have independent sinks. Backtest's caller-selected ledger reaches arbitrary append/fsync; examples include a DuckDB process. Enumerating only collector libraries cannot establish their namespace or target coverage. The next source profile must classify or refuse every admitted target and effect route, including aliases, function values, new Cargo targets and unsupported expansion. Registry build scripts and genuine trusted dependencies remain a separately stated environment boundary. No current data-fold or package effect grant establishes these properties.
