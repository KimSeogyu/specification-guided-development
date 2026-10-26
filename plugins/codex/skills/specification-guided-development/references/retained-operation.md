# Retain actual payload across a failed operation

Use this v2 binding when a synchronous fallible callback must return its original native payload on every ordinary path. Keep the enclosing requirement and model. This finite lower contract does not prove their refinement.

```json
{
  "version": 2,
  "profile": "finite-owned",
  "name": "ReportCustody",
  "spec": "ReportCustody.tla",
  "config": "ReportCustody.cfg",
  "targets": ["typescript"],
  "binding": {
    "className": "ReportCustody",
    "operation": {
      "kind": "retained-operation",
      "start": "StartReport",
      "success": "ReportSucceeded",
      "failure": "ReportFailed",
      "retainedVariable": "resident"
    }
  }
}
```

Start from [ReportCustody.tla](ReportCustody.tla) and [ReportCustody.cfg](ReportCustody.cfg) when their one-attempt contract matches the requirement. Copy them into the original model directory. Review and adapt the model before generation. The three names identify distinct observed actions. The retention variable must be Boolean and true in every reachable state. If start is enabled at Init, both completion actions must be enabled after it. The compiler rejects unsupported relations. A disabled initial start produces a refusal without invoking the callback. Initial model readiness does not validate runtime payload fields.

Build with `sgd_build`. TypeScript exports `finalize` from `operation.ts`; the writer returns `{ok:true,value}` or `{ok:false,error}`. Do not use an async callback.

Move the complete native evidence into the boundary. Include earlier results, original execution errors, and independent persistence uncertainty. Both success and failure retain that same payload. Inspect `payload()`, `status()`, and `snapshot()`. No caller-selected event can declare a successful report through this API.

Preserve the owner through the public application return and CLI handoff. Do not wrap a diagnostic copy and then discard the actual result. Do not convert an owning error into a string before the required handoff. A callback success records its return value, not durable custody or execution success.

Exercise real open, write, and sync failures at the owning boundary. Verify exact prior/current payload and original/report causes, not only diagnostic text. Check model refusal invokes no callback and an admitted call invokes one callback. Regenerate after an admission-condition change and check native behavior in TypeScript.

The guarantee covers one synchronous invocation in a trusted JavaScript realm. Aliases, deliberate disposal, process loss, false sink acknowledgements, cross-call retry prevention, persistence, and application-wide coverage require separate evidence. Keep unsupported model composition visible.
