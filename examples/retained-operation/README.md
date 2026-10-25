# Keep computed results when reporting fails

Run a structural repair in TypeScript 7 and Rust from the source checkout. This demo command is separate from the frozen alpha4 plugin archives. The demo starts with the failure class from [Parangsae issue #34](https://github.com/KimSeogyu/parangsae/issues/34): a report error escapes while the already-computed payload is lost. It then generates an owner that returns the actual payload on both report success and failure.

The enclosing responsibility is to preserve known execution results. This example isolates the synchronous reporting boundary from that responsibility. `ReportCustody.tla` models admission and the observed report outcome. Generated code owns the actual payload and calls the writer with a read-only borrow. The callback's return determines the completion transition.

The broader Parangsae `EvidenceLifetime` model also covers earlier execution facts and custody acknowledgement. The lower model here does not replace it. A checked refinement relation between the two models remains unestablished. [Parangsae PR #37](https://github.com/KimSeogyu/parangsae/pull/37) supplies separate production integration and fault evidence.

## Prepare the tools

Install these tools before running the demo:

- Node.js 22 or later and npm.
- Java 17 or later.
- Rust with Cargo and rustfmt on `PATH`.

From the repository root, install the locked JavaScript dependencies and explicitly fetch the pinned TLC distribution:

```sh
npm ci
node scripts/fetch-tlc.mjs
```

The fetch helper writes `.runtime/tla2tools.jar` and checks its integrity. The demo does not download a JAR or install a toolchain. On its first run, Cargo may fetch the generated crate's declared dependencies. TypeScript builds use the repository's exact `7.0.2` compiler.

## Run the demo

```sh
npm run demo:retained -- --jar "$PWD/.runtime/tla2tools.jar"
```

An existing pinned JAR can also be supplied through `TLA2TOOLS_JAR`:

```sh
export TLA2TOOLS_JAR=/absolute/path/to/tla2tools.jar
npm run demo:retained
```

The command creates a unique `.runtime/demo-retained-*` directory and prints its location. To select another location, supply a directory that does not yet exist:

```sh
npm run demo:retained -- --jar "$PWD/.runtime/tla2tools.jar" --out /absolute/path/to/new-demo-output
```

The runner refuses an existing `--out` directory without overwriting it. To require cached Cargo dependencies, add `--offline`:

```sh
npm run demo:retained -- --jar "$PWD/.runtime/tla2tools.jar" --offline
```

Offline mode does not populate the cache. If a dependency is missing, rerun without `--offline` when network access is available, using a new output directory.

## Inspect the result

A successful run prints `PASS` and records `status: "passed"` in `report.json`. Its stage summary identifies the report and logs. The run demonstrates these observations:

| Case | Expected observation |
| --- | --- |
| Original-style error-only return | The independent payload-retention observer detects the missing result. |
| Ready model, report succeeds | The generated result retains the payload and records the successful callback result. |
| Ready model, report fails | The generated result retains the same payload and records the report error separately. |
| A Rust writer tries to move or mutate borrowed payload | The native compiler rejects the attempt. |
| Model admission changes | After regeneration, the unchanged consumers retain the payload but do not call the writer. |

Both language consumers exercise the generated API. The demo does not satisfy the failed-report case by keeping an unrelated test copy of the payload as its production owner.

Open these files under the printed output directory:

- `report.json` contains the overall status, stages, observations, negative controls, and evidence paths.
- `logs/` contains the command output for each stage.
- `source/` contains the model and consumer input snapshots.
- `ready/generated/` and `not-ready/generated/` contain the model evidence and generated sources.
- `ready/view/index.html` and `not-ready/view/index.html` contain the Pele views.

In the graphs, inspect the complete `phase`, `ready`, and `resident` variables. The ready configuration admits `StartReport` from Init. The not-ready configuration requires `Prepare` first, so the generated one-attempt operation refuses to call the writer. The consumers do not send their own success or failure events.

`ReportCustody.cfg` sets `InitiallyReady = TRUE`. `NotReady.cfg` sets it to `FALSE`. The demo uses the same consumer source in both cases. It changes model configuration, regenerates the code, and checks the resulting native behavior.

The runtime API and integration requirements are described in [the retained-operation reference](../../docs/retained-operation.md). The binding names model actions and a retention variable. It does not contain a second transition table.

## Diagnose a failed run

A failed stage returns a nonzero exit status. Once the output directory exists, the runner attempts to record `status: "failed"`, the failed stage, and its command logs. If report storage also fails, stderr states that the terminal report is not confirmed. Do not treat an older `running` report as a completed result. Read those files before changing the model or retrying. Completed stages and failure evidence stay in that directory. Use a fresh directory for another attempt.

Argument errors, a missing JAR, or an absent SDK build can fail before the runner creates an output directory. In those cases, read the printed setup error. There is no report yet.

Check the missing prerequisite or reported compiler error first. Do not change the expected outcome to match a failing implementation. If TLC rejects the specification, preserve its output as model evidence. If a native observer fails, inspect the generated binding and consumer together.

The runner cleans its disposable build targets after their child processes terminate. It retains the report, inputs, generated sources, views, and logs for inspection.

## Scope of this walkthrough

The demonstration uses small synthetic payloads and report callbacks. It reproduces the ownership failure class, not a full Parangsae process or filesystem fault replay. The production integration has its own evidence in PR #37.

The generated boundary retains the actual payload on ordinary synchronous returns. It does not prove that a callback's success means durable storage. Rust interior mutability and TypeScript aliases can still change contents. Deliberate disposal, panic, process termination, crash recovery, and untruthful sinks remain outside this contract.

The model's initial readiness is configuration, not a measurement of live application readiness. Each invocation starts a new owner. This example establishes neither business-level exactly-once processing nor a universal retry restriction.

Running the demo also does not establish automatic bug discovery, full application coverage, global model refinement, or an installed-agent workflow. Those require separate evidence.
