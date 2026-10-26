# Retain payload across a fallible operation

Project v2 can generate a synchronous operation boundary that owns an actual native payload. The callback receives the payload reference. Every ordinary return retains it, including admission refusal and callback failure. Successful reporting also retains the payload. The compiler does not infer durable custody from a callback's success.

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

Use `sgd build` or `sgd_build`. Imported DOT cannot establish executable provenance. The ordinary build pipeline retains controlled TLC evidence, freshness checks. The build summary states the borrowed synchronous callback scope. Its application integration, persistence, and external-effect limits remain unestablished.

## Connect the actual native payload

TypeScript exports `finalize` from `operation.ts`. Its synchronous callback returns `{ ok: true, value }` or `{ ok: false, error }`. The authenticated frozen result exposes `payload()`, `status()`, and `snapshot()`. Thrown callbacks and invalid results retain the same payload reference and select the failure action. Async callbacks are unsupported. An invalid Promise result does not cancel work that a callback already started.

## Verify the real boundary

1. Preserve the original failure before changing the application.
2. Invoke the production owning finalizer with actual synthetic complete and technical payloads.
3. Exercise first-file open, partial-write, and sync failures. Verify the complete native payload and both original and report errors remain inspectable.
4. Include earlier units and uncertain ledger outcomes. Do not promote them to completed execution or acknowledged persistence.
5. Confirm refusal invokes no writer and an admitted call invokes it once. Confirm success retains the payload too.
6. Change the model's initial admission condition, regenerate, and observe changed native admission in TypeScript.
7. Keep the original enclosing acceptance model and independent native tests. Record unsupported composition as a gap.

## Guarantee boundary

The guarantee covers ordinary returns of one generated invocation. TypeScript aliases can still change payload contents or discard references. Process exit, changed generated code, and untruthful sinks remain outside the contract.

Each call creates a new modeled invocation. It does not establish business-level exactly-once processing, retry prevention across calls, crash recovery, physical write authority, or durable handoff.

Native integration and installed-plugin trials are separate acceptance work. Compiler tests alone do not prove that an application's outer error path preserves its owner.
