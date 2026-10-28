# Domain generation

A domain binding turns finite TLA+ actions into methods on a private state owner.
Injected ports perform application effects. The generated method selects the
completion action from the port's actual fulfillment or rejection.

## Build and use

From a source checkout, build the [approval example](../examples/domain-approval/project.json)
with the pinned TLC JAR and a trusted Lean 4.35.0 executable:

```sh
npm ci
npm run build
node dist/cli.js build --project examples/domain-approval/project.json \
  --jar /absolute/path/tla2tools.jar --lean /absolute/path/lean --out generated
npm install --prefix generated/typescript
npm run build --prefix generated/typescript
```

An installed SGD package exposes the same command as `sgd build`.
Generation requires TypeScript 7.0.2.

```ts
import { createApprovalDomain } from './generated/typescript/dist/domain.js';

const approval = createApprovalDomain({
  publisher: async (report: { text: string }) => ({ bytes: report.text.length }),
});

approval.send('Approve');
const result = await approval.publish({ text: 'Approved report' });
switch (result.kind) {
  case 'success': console.log(result.value.bytes); break;
  case 'failure': console.error(result.error); break;
  case 'refused': console.log(result.reason, result.state); break;
  case 'completion-rejected': console.error(result.outcome, result.rejection); break;
}
```

The example binds `publish` to port `publisher` and actions `StartPublish`,
`PublishSucceeded`, and `PublishFailed`. Bindings name existing model actions;
they cannot add permission or transitions.

## Operation contract

Each operation owns its pending states. Only its start action may enter them,
and only its success or failure action may leave them. Both completion actions
must have unique successors outside every pending state. Initial states cannot
be pending. Operation roles and pending states cannot overlap.

The generated method commits start before calling the port. A disabled start
or insufficient revision capacity refuses without calling it. While pending,
competing and reentrant operation calls cannot start another effect. The method
reserves both revision increments before admission.

Fulfillment selects success. Rejection or a synchronous throw selects failure.
Results preserve original values and errors, including `undefined`. A fulfilled
`{ kind: 'failure' }` remains fulfillment; payload fields do not select transitions.
`completion-rejected` retains the observed outcome if completion unexpectedly
fails inside the generated implementation.

`send()` accepts ordinary events only. It rejects all start and completion roles
at runtime as well as in its TypeScript type. `read()` returns a frozen snapshot.

## Port contract

Each port takes one inferred input and returns a value or promise-like value.
Operations sharing a port share its types. Ports must be own function-valued
data properties. Accessors and inherited methods are rejected. The factory
captures functions once, so later dependency replacement has no effect.
Functions are called without a receiver; bind methods that need `this`:

```ts
const approval = createApprovalDomain({ publisher: repository.publish.bind(repository) });
```

Inputs, outputs, and errors are opaque application objects. SGD does not clone,
freeze, or validate their business fields. `isApprovalDomain` authenticates
objects created by that generated module, not their payload types.

## Rust

In a copy of the project file, set `targets` to `["rust"]` or
`["typescript", "rust"]`. The project must have `binding.domain`; Rust
generation is not available for the retained or symbolic profiles. Keep the
model and configuration beside the copied project file. Run the same `build`
command with the copied project path, then build the generated crate:

```sh
cargo build --manifest-path generated/rust/Cargo.toml
```

The generated crate has no dependencies and uses Rust 2021. Generation and
`build --check` require Rust 1.92.0 and its matching rustfmt on `PATH`. The
build rejects a missing tool or a different version. The generated
`rustfmt.toml` fixes formatting settings so `cargo fmt` preserves the generated
Rust bytes when it uses the same toolchain.
Add it to an application under a local dependency name, using the package name
from the generated `rust/Cargo.toml`. For the unchanged Approval example:

```toml
[dependencies]
approval-domain = { package = "sgd-domain-147fb813a251", path = "../generated/rust" }
```

Implement the generated `Ports` trait and supply it to the domain owner. The
associated type number corresponds to the port's position in sorted port-name
order. A port shared by several operations has one set of associated types.

```rust
use approval_domain::{ApprovalDomain, OperationResult, Ports, PublicEvent};
use std::future::Future;

struct Publisher;

impl Ports for Publisher {
    type Port0Input = String;
    type Port0Output = usize;
    type Port0Error = String;

    fn publisher(&self, input: String) -> impl Future<Output = Result<usize, String>> {
        async move { Ok(input.len()) }
    }
}

async fn publish() {
    let mut approval = ApprovalDomain::new(Publisher);
    let approve = PublicEvent::from_model_name("Approve").unwrap();
    approval.send(approve).unwrap();
    match approval.publish("report".to_owned()).await {
        OperationResult::Completed { outcome, .. } => println!("{outcome:?}"),
        OperationResult::Refused(error) => println!("{error:?}"),
        OperationResult::CompletionRejected { outcome, error, .. } => {
            println!("{outcome:?}: {error:?}");
        }
    }
}
```

`Completed` retains the port's original `Result`. The owner sends the start
before invoking the port and selects success or failure from that result.
`Refused` does not call the port. `CompletionRejected` retains the observed
result if the internal completion is rejected. `PublicEvent::from_model_name`
does not return operation start or completion events. Snapshots expose copied
state through immutable static values; they cannot change the owner.

Rust operation and port names must be valid supported Rust identifiers. Rust
keywords and collisions with generated names are rejected. Each operation
borrows the owner mutably while its future runs. If that future is dropped after
the start transition, or the port panics, the owner can remain pending. This
profile does not provide cancellation recovery or eventual completion.

### Synchronous ports and retained payload

For a synchronous effect, implement `SyncPorts` instead of `Ports`. Its
associated `Payload` is stored in the private owner at construction. Each port
borrows the payload, receives a separate operation input, and returns a `Result`.
The owner retains the payload when an operation is refused or completes. The
returned `SyncOperation` contains the actual outcome and a snapshot.

```rust
use approval_domain::{ApprovalSyncDomain, OperationResult, PublicEvent, SyncPorts};

struct Publisher;
impl SyncPorts for Publisher {
    type Payload = String;
    type Port0Input = ();
    type Port0Output = usize;
    type Port0Error = String;

    fn publisher(&mut self, payload: &String, _: ()) -> Result<usize, String> {
        Ok(payload.len())
    }
}

fn publish() {
    let mut approval = ApprovalSyncDomain::new(Publisher, "report".to_owned());
    approval.send(PublicEvent::from_model_name("Approve").unwrap()).unwrap();
    let result = approval.publish(());
    if let OperationResult::Completed { outcome, .. } = result.status() {
        println!("{outcome:?}");
    }
    assert_eq!(approval.payload(), "report");
    let (payload, _ports, _snapshot) = approval.into_parts();
    assert_eq!(payload, "report");
}
```

`into_parts` consumes the owner and ends its live-owner contract. A mutable
`SyncPorts` implementation can hold a one-shot `FnOnce` writer. On ordinary
returns, the owner retains the payload; a borrowed payload can still contain
interior-mutability fields. Panic, abort, caller drop, unsafe code, and external
effects are outside the retention guarantee.

To bind this ownership to a modeled Boolean, add a `rust` field inside the
project's `binding` object:

```json
"rust": { "retainedVariable": "resident" }
```

The named variable must be Boolean and true in every reachable graph state.
The build rejects a missing variable, a different kind, or a false valuation.
For this binding, the Rust target omits the non-retaining async owner. The
binding describes one live Rust owner's residency. If the project also generates
TypeScript, this binding does not attach the payload to the TypeScript owner. It
does not prove payload content, durability, or application-wide ownership.

## Verification scope

The build runs TLC and Lean before publishing output. `proof/` contains the
protocol module, generated project proof, diagnostics, and verification metadata.
`--check` reruns verification and checks freshness. Verification failure leaves
previous output intact.

TLC checks the configured finite model. Lean proves the serial operation
contract for its numeric graph. For Rust, the build also checks the emitted
artifact against the graph and binding. Native tests exercise the generated
TypeScript and Rust; the artifact checker, emitters, rustfmt, Rust compiler, and
language runtimes are not formally proved. Injected adapters,
external effects, and the adequacy of the application's model remain separate
verification obligations.

The contract covers one live object in a trusted language runtime. A new
factory call creates a new owner. This profile provides no persistence, crash
recovery, effect atomicity, timeout, cancellation, retry, or eventual completion.
A port that never settles leaves its operation pending.
