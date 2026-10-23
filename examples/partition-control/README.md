# Partition batch control

This example checks the finite control needed for a proposed closed partition batch. `model.tla` is the authoritative specification. `project.json` selects the existing v2 `finite-owned` profile and generates TypeScript 7 and Rust authorities.

The controller records whether an open batch has inserted a row or encountered a conflict. It then closes for a write, no write, or refusal, and consumes that decision once. A successful `Same` observation and a repeated `Clash` can leave every modeled variable unchanged.

This standalone controller accepts caller-selected events. It does not authenticate actual row operations. The [partition authority design](../../docs/partition-authority-design.md) describes the unimplemented generated fold that must own those observations and the loaded resource. Do not add this example beside a handwritten application fold and report that the application is protected.

## Run the model checks

Use Node.js 22 or later and Java 17. From the SDK root:

```sh
npm ci
npm run build
node scripts/fetch-tlc.mjs
node examples/partition-control/verify-model.mjs
```

`verify-model.mjs` finds the SDK through its own file location. It uses `TLA2TOOLS_JAR` when set, or the SDK's `.runtime/tla2tools.jar` otherwise. A relative environment path is relative to the invocation directory. The compiler verifies the supplied JAR against its pinned tool version.

The script first builds the authoritative model into a fresh owned scratch directory. It requires both language artifacts and then runs `build --check`. It next changes one model rule at a time and requires the intended TLC violation. A syntax error, timeout, unrelated property failure, or interrupted process cannot satisfy a mutation check. Refused models must publish no output.

The script bounds each compiler process and removes its unique scratch directory after success or failure. It does not install a plugin, change agent configuration, invoke storage, or run native consumers.

The configured properties have these scopes:

| Property | Checked requirement |
| --- | --- |
| `TypeOK` | The complete phase and flag state stays within the declared scalar types. |
| `CloseAdmission` | A ready write has an insertion and no conflict. Ready no-write and refusal states have the corresponding flags. |
| `CloseChoice` | Exactly one closing action is enabled in every reachable open state. |
| `NoInputAfterClose` | Insert, equal, and conflict observations are disabled after closing. |
| `SingleConsumption` | No consumption action is enabled in the consumed state. |
| `ConflictSticky` | A later observation cannot clear an earlier conflict. |
| `InsertSticky` | A later observation cannot clear an earlier insertion. |
| `NoReopen` | A closed or consumed batch cannot return to the open phase. |

The mutations permit two closing choices after a conflict, turn refusal into a write, disable refusal closing, clear either historical flag, reopen after closing, consume again, or accept an input after closing. Each must fail its corresponding property. `model.cfg` explicitly disables deadlock checking because the consumed state has no enabled explicit action. Implicit square-action stutters do not create a successful runtime event.

Independent review exposed two missing requirements in the first property set. A model with disabled refusal closing still passed, as did a model where `Same` cleared `hasInserted`. Both incorrectly generated authority. `CloseChoice` now checks close availability and uniqueness explicitly, while `InsertSticky` preserves the insertion history. The public mutations reproduce both findings. Close availability does not establish that the application eventually chooses to close. No fairness or progress property is claimed.

## Generate an inspectable authority

To keep generated output for inspection, run the normal compiler instead of the self-cleaning verifier:

```sh
node dist/cli.js build --project examples/partition-control/project.json --jar .runtime/tla2tools.jar --out .runtime/partition-control/generated
node dist/cli.js build --project examples/partition-control/project.json --jar .runtime/tla2tools.jar --out .runtime/partition-control/generated --check
```

Use `TLA2TOOLS_JAR` as the `--jar` value when using a different pinned JAR location. The generated READMEs describe the native APIs and their live-object boundaries.

During development on 2026-10-24, local consumers compiled the generated TypeScript with TypeScript 7.0.2 and built a separate safe Rust consumer. Their complete short traces agreed. They rejected `CloseWrite` after `Clash`, accepted `CloseRefused` and one `ConsumeRefused`, and rejected consumption again. They also exercised accepted writes and equal-only no-write decisions. Successful `Same` and repeated `Clash` advanced the runtime revision while preserving modeled values. A rejected event preserved the state and revision. This was a separate native trial. The public verifier repeats the model and generation checks, not those native consumers.

## Boundary

TLC checks all reachable states of this finite scalar controller. The generated APIs protect one live controller object. Creating another object at Init remains permitted. Neither the model nor its mutation checks establish fairness, progress, reset prevention, or persistent identity.

The controller contains no map, arbitrary batch, row equality, exact count, conflict sequence, loaded baseline, path, writer, or filesystem effect. Its graph cannot prove those properties. In particular, it does not prove whole-partition rollback or that every row observation reaches the controller. Authentic row composition, the generated collection runtime, source coverage, resource binding, writer isolation, and persistence require their own implementation and evidence.
