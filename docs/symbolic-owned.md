# Compile actions with data input

Project v3 `symbolic-owned` compiles a supported TLA+ action relation into TypeScript 7 and Rust owners. Each owner receives an immutable Unicode string identity. Generated guards choose the model action and update the complete state simultaneously.

Use this profile when a finite fixture must represent actual input values. Do not infer a generic update rule from a small DOT graph. The pinned TLC JAR emits action names without their arguments. A two-value graph also cannot distinguish every equality/copy rule: after storing A and rejecting B, a third value C distinguishes replacing the latest rejected value from keeping B.

The compiler reads guards and assignments from pinned SANY semantic XML. TLC graphs remain independent finite verification evidence. This source milestone does not complete [the Parangsae production goal](production-goal.md).

## Build the fact-merge example

```sh
npm ci
node scripts/fetch-tlc.mjs
export TLA2TOOLS_JAR="$PWD/.runtime/tla2tools.jar"
npm run build
node dist/cli.js build --project examples/fact-merge/project.json --jar "$TLA2TOOLS_JAR" --out .runtime/facts
node dist/cli.js visualize --ir .runtime/facts/automaton.json --ir .runtime/facts/symbolic-model.json --out .runtime/facts/view
```

The example preserves Parangsae's original `ManifestWrite.tla` contract. Its project file is:

```json
{
  "version": 3,
  "profile": "symbolic-owned",
  "name": "ManifestWrite",
  "spec": "ManifestWrite.tla",
  "config": "ManifestWrite.cfg",
  "targets": ["typescript", "rust"],
  "binding": { "className": "FactMachine" }
}
```

No permitted edges, equality predicates, or update rules belong in the binding. TLA+ supplies those rules. `compile --dot` refuses this profile. `model` exports the finite witness and symbolic IR without generating an owner, running the input oracle, or establishing the symbolic orbit checks.

## Use the generated API

Build the generated TypeScript package with `npm install --prefix .runtime/facts/typescript` followed by `npm run build --prefix .runtime/facts/typescript`.

```ts
import { createFactMachine } from './dist/machine.js';

const facts = createFactMachine();
facts.send('A'); // Insert
facts.send('B'); // Clash; stored remains A
facts.send('C'); // Clash; rejected becomes C
facts.send('A'); // Same; stored and rejected remain unchanged
const snapshot = facts.read();
```

The Rust output is a separate crate. Read its generated README for the exact Cargo package name and path-dependency alias:

```rust
#![forbid(unsafe_code)]
use authority::FactMachine;

let mut facts = FactMachine::new();
assert_eq!(facts.send("A").unwrap().action, "Insert");
assert_eq!(facts.send("B").unwrap().action, "Clash");
assert_eq!(facts.send("C").unwrap().action, "Clash");
let snapshot = facts.read();
```

The caller supplies data, not an action classification. `send("Same")` supplies the payload identity `Same`; generated guards still select Insert, Same, or Clash. Neither backend exposes a caller-selected action argument.

Values are tagged. A scalar model string `"none"` differs from a data atom whose identity is `none`:

```json
{"kind":"string","value":"none"}
{"kind":"data","domain":"Values","value":"none"}
```

Snapshots contain `model`, `modelRevision`, a decimal-string `revision`, and copied `values`. A successful receipt contains `action`, `before`, `after`, and `updates`. The update expressions retain their origins: literal, input, or an old state variable. For example, Clash copies `stored` from the old state and `rejected` from the new input. This origin information matters when a later application adapter preserves metadata associated with a payload.

TypeScript also returns `ok`; a rejection contains `reason` and an unchanged state. Rust uses `Result<Receipt, TransitionError>`. Both reject disabled or ambiguous dispatch and checked u64 revision exhaustion without changing state. TypeScript rejects non-string input and unpaired Unicode surrogates. Rust's `&str` already supplies valid UTF-8. A modeled no-change action still succeeds and increments revision.

The owner has no arbitrary-state construction, restore, mutable state reference, or caller callback during commit. TypeScript freezes its closure facade, methods, receipts, and copied snapshots and supplies `is<ClassName>()` for module-instance authentication. Rust keeps state private in a separate crate and forbids unsafe code in that crate. The trust boundary remains an unchanged generated module in a trusted JavaScript realm or safe Rust callers.

## Verification stages

1. **Controlled source check.** Run strict SANY, offline `XMLExporter -o`, and TLC in one isolated source snapshot with the pinned JAR. Reject input changes, reductions, external overrides, incomplete runs, and unsafe module resolution. The exporter alone is not trusted to report SANY failure.
2. **Source lowering.** Resolve semantic symbol identities, expand supported first-order helpers, preserve the configured Spec/Init/Next selection and outer input domain, and lower guards plus complete simultaneous updates. Parameter names alone never identify a binding.
3. **Equality/copy orbit check.** Canonicalize opaque atoms by their equality relation in each state. For the one-input grammar, test each existing atom and one fresh atom. Validate configured state invariants, square action properties, dispatch uniqueness, and deadlock freedom when requested. Stop at the profile limits rather than accepting partial exploration.
4. **Independent finite input oracle.** Instrument a temporary module that calls the original TLA+ actions, retaining actual input and action as observer variables. Compare every configured reachable state and input atom with the lowered relation, including disabled decisions and every next variable. Match the oracle's action relation with the original completed DOT so an omitted source action cannot disappear unnoticed.
5. **Native generation.** Render the same checked IR to TypeScript and Rust. Native tests compare dispatch, complete snapshots, and update origins, including a third payload beyond the original two-value fixture.

The orbit argument relies on the accepted equality/copy grammar: opaque values are observed only through equality and domain membership, and updates copy existing values or input. Renaming opaque atoms therefore preserves guards and updates. Orbit atom labels are local to each state; an `a0` label can denote a different representative after canonical renaming. This argument does not apply to arbitrary TLA+, ordering, cardinality, object identity, custom equality, or externally mutable values. The implementation has independent review and differential tests; these are not a machine-checked proof of the compiler.

`[P]_vars` means `P \/ UNCHANGED vars`. Both implicit stutters and explicit no-change actions satisfy that wrapper even when P is false. The compiler preserves this meaning. `CHECK_DEADLOCK TRUE` requires some enabled input in every reachable symbolic orbit; it does not require every input to be enabled or establish progress under an application's input choices.

## Supported source profile

- One fixed scalar Init assigns every root variable exactly once. Initial strings, Booleans, and exact decimal integers are supported. Data atoms enter through input.
- `Next` has one scalar bounded existential input over a named configured domain and a disjunction of named action calls receiving that same input. Bindings cannot substitute an action table.
- The configured domain has at least two distinct untyped model values. Typed TLC model values, such as `A_v1`, are rejected. The exact finite configuration and the runtime interpretation remain distinct.
- Guards support scalar literals, current state and input, equality/inequality, homogeneous finite scalar sets, membership in the opaque domain, conjunction/disjunction, negation, implication, and equivalence. Pure guard disjunctions remain logical predicates. Mixed scalar-kind comparisons that TLC rejects are rejected during validation; data atoms remain distinct from scalar literals.
- Updates copy a literal, the input, or an old state variable. `UNCHANGED` can name variables or the complete tuple. Every branch must cover every variable exactly once. Missing primed variables are unconstrained in TLA+ and never become implicit UNCHANGED. Primed RHS and primed executable guards are rejected.
- Nonrecursive first-order helper definitions are expanded by semantic UID. Unknown operators and semantic nodes in the executable closure are rejected even if the finite fixture does not exercise them. Root and inherited assumptions, instances, and unsupported declarations are rejected; domain restrictions cannot disappear during lifting.
- A configured Spec must match `Init /\ [][Next]_vars`, with every root variable in the tuple. Explicit INIT/NEXT is also supported. State invariants and properties of the form `[][P]_vars` are supported. Fairness, liveness, and other temporal wrappers are rejected.
- Opaque-domain enumeration as a value, cardinality, ordering, arithmetic, CHOOSE, fresh-value construction, records/functions/sequences in state, operator-valued parameters, recursion, LET, and substitution nodes are outside this profile.
- Source isolation and standard modules follow the [controlled finite profile](finite-owned.md). The exact explicitly selected, verified JAR may be beside the model; other Java/class/JAR artifacts remain rejected. Select that co-located JAR when checking an existing model directory that contains it.
- Current limits are 12 state variables, 256 normalized action cases, 10,000 equality/copy orbits, and pinned XML bounds of 16 MiB, depth 256, and 200,000 elements. Reaching a limit fails generation.

## Artifacts and regeneration

| Artifact | Scope |
| --- | --- |
| `automaton.json`, `model.dot` | Original configured finite TLC witness, with complete tagged valuations |
| `semantic.xml` | Pinned SANY semantic source representation |
| `symbolic-model.json` | Canonical typed relation and semantic identity |
| `orbit-proof.json` | Equality/copy states, input classes, accepted edges, and disabled cases |
| `input-verification.json`, `input-oracle.dot` | Independent original-action finite state/input comparison |
| `verification.json` | Source closure, project/configuration/tool identities, runtime domain, and validation mode |
| `typescript/`, `rust/` | Native generated owner and target build instructions |

Use `build --check` to rerun verification and reject stale artifacts. Regeneration removes obsolete owned artifacts, including native code after a model-only run. Run logs vary; source, IR, code, oracle, and stable provenance remain checked.

## Actual application integration is still required

The runtime domain consists of immutable string identities. It is not a generic application object with a user-defined equality callback. An adapter for Parangsae must preserve the existing fact equality relation and its metadata exclusions. The existing Fact types exclude `received_ts` from payload equality. Comparing every serialized field would change the contract. Payload-associated metadata, persisted-state loading, and partition commit also require explicit integration and tests.

The model does not cover many keys, Parquet layout, object-manifest records, conflict-log/file transactions, crash durability, or multiple writers. The existing collector keeps an entire original partition when any incoming key conflicts. A per-key successful action cannot authorize that partition commit by itself. The next application milestone must connect actual value ownership and commit authority, close source bypasses, preserve the original native tests, and exercise real maintenance changes on an independent Parangsae branch.

The current two-value TLC result proves the configured finite instance. It does not alone prove arbitrary-domain invariants. The separate symbolic checks cover only the accepted grammar and immutable value interpretation. Neither result establishes external effects, persistent business identity, restart safety, or completed production adoption.
