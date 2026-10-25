# Retain payload across a fallible operation

Project v2 can generate a synchronous operation boundary that owns an actual native payload. The callback borrows that payload. Every ordinary return retains it, including admission refusal and callback failure. Successful reporting also retains the payload. The compiler does not infer durable custody from a callback's success.

## Structural problem

[Parangsae issue #34](https://github.com/KimSeogyu/parangsae/issues/34) exposed a gap between a model and its application binding. The enclosing `EvidenceLifetime` model requires known execution payloads to remain resident or have a truthful custody acknowledgement. The batch implementation held completed results locally but returned a string error after report I/O failed. The model property did not protect that native return boundary.

The existing error-only return does not preserve ownership across the finalization boundary. The generated boundary instead moves the complete native evidence into one private result. The report callback receives a shared borrow. Its actual result selects the modeled outcome. Application integration must return or explicitly transfer this complete result.

## Configure the model binding

Start with [the report custody example](../examples/retained-operation/project.json). The existing finite-owned constraints still apply. Add this binding to a v2 project:

```json
{
  "className": "ReportCustody",
  "operation": {
    "kind": "retained-operation",
    "start": "StartReport",
    "success": "ReportSucceeded",
    "failure": "ReportFailed",
    "retainedVariable": "resident"
  }
}
```

The fields identify existing model actions and the Boolean retention variable. They contain no transition table. The compiler requires distinct observed actions and retention in every reachable concrete state. If the initial state admits start, both actual callback outcomes must have an enabled completion edge. Otherwise generation fails with `TLC207` before publication.

If start is disabled at Init, the generated function returns a refusal without invoking the callback. The example's `NotReady.cfg` demonstrates this distinction. Admission comes from the configured model state. It is not inferred from payload fields or live application readiness.

Use `sgd build` or `sgd_build`. Imported DOT cannot establish executable provenance. The ordinary build pipeline retains controlled TLC evidence, canonical Rust formatting, and freshness checks. The build summary states the borrowed synchronous callback scope. Its application integration, persistence, and external-effect limits remain unestablished.

## Connect the actual native payload

Rust exports this operation:

```rust
pub fn finalize<T, R, E>(
    payload: T,
    writer: impl FnOnce(&T) -> Result<R, E>,
) -> Finalized<T, R, E>;
```

`Finalized` has private fields. `payload()`, `status()`, and `snapshot()` return shared borrows. `into_parts()` explicitly transfers all owned parts to the caller. There is no mutable payload accessor, public machine, or caller-selected outcome event.

`FinalizationStatus::Completed(Err(error))` records a report failure. It does not replace execution errors or ledger uncertainty in the payload. `Completed(Ok(value))` means that the callback returned `Ok`. It does not mean that the application execution succeeded. A completion-transition error retains both the payload and the observed callback result. In the admitted profile, that branch is unreachable under the stated trust boundary: validation requires both outcome edges, the callback cannot access the machine, and a fresh revision advances only from zero to one to two. The defensive status does not require a public bypass for testing.

Move the actual batch evidence into `finalize`. Include earlier units, current complete or partial outcomes, identities, selection, computed statistics, and original causes. The callback reads this value to produce reports. Preserve the result through the public batch return and CLI handoff. Applying `finalize` to a diagnostic copy while discarding the original evidence does not satisfy the application contract.

TypeScript exports `finalize` from `operation.ts`. Its synchronous callback returns `{ ok: true, value }` or `{ ok: false, error }`. The authenticated frozen result exposes `payload()`, `status()`, and `snapshot()`. Thrown callbacks and invalid results retain the same payload reference and select the failure action. Async callbacks are unsupported. An invalid Promise result does not cancel work that a callback already started.

## Verify the real boundary

1. Preserve the original failure before changing the application.
2. Invoke the production owning finalizer with actual synthetic complete and technical payloads.
3. Exercise first-file open, partial-write, and sync failures. Verify the complete native payload and both original and report errors remain inspectable.
4. Include earlier units and uncertain ledger outcomes. Do not promote them to completed execution or acknowledged persistence.
5. Confirm refusal invokes no writer and an admitted call invokes it once. Confirm success retains the payload too.
6. Change the model's initial admission condition, regenerate, and observe changed native admission in both languages.
7. Keep the original enclosing acceptance model and independent native tests. Record unsupported composition as a gap.

## Guarantee boundary

The guarantee covers ordinary returns of one generated invocation. Safe Rust prevents moving ordinary owned data through the callback's shared borrow. Rust interior mutability and TypeScript aliases can still change payload contents. Neither language provides a universal prohibition on deliberate disposal. Panic, abort, process exit, unsafe callers, changed generated code, and untruthful sinks remain outside this contract.

Each call creates a new modeled invocation. It does not establish business-level exactly-once processing, retry prevention across calls, crash recovery, physical write authority, or durable handoff. The Parangsae enclosing model uses sets and parameterized actions. This lower finite model does not replace it, and a checked refinement relation between them is not established.

Native integration and installed-plugin trials are separate acceptance work. Compiler tests alone do not prove that an application's outer error path preserves its owner.
