# Generate a TypeScript or Rust domain

Copy `Approval.tla`, `Approval.cfg`, and `domain-project.json` from this reference directory into the application's model directory. Rename the project file to `project.json` and adapt the model to the requirement. Do not modify installed plugin files.

Call `sgd_build` with absolute paths for `project`, the pinned TLC `jar`, a separate `out`, and the Lean 4.35.0 executable in `lean`. Use `check: true` to verify freshness. A missing tool or failed proof stops generation.

`binding.domain.operations` maps a method and port to existing `start`, `success`, and `failure` actions. It supplies no transition policy. Pending states must admit exactly the two completion outcomes, can only be entered by the associated start, and cannot be initial or completion targets. Roles are distinct. Operations are serial per live owner.

Set `targets` in the copied project to `["typescript"]`, `["rust"]`, or `["typescript", "rust"]`. Rust requires the finite-owned domain binding and rejects unsupported Rust identifiers. Rust is not a target for the retained-operation or symbolic profiles. Every domain build includes `proof/DomainProtocol.lean` and the model-specific proof. The TypeScript target includes `typescript/domain.ts` and its internal owner. Build the package before importing `dist/domain.js`.

`createApprovalDomain({ publisher })` captures the injected callback. Call `send('Approve')`, then `publish(input)`. Actual fulfillment selects success; a throw or rejection selects failure. Public `send` rejects all operation start/completion events. A disabled operation calls no port.

Ports are own function-valued data properties, invoked without `this`. Bind receiver-dependent methods explicitly. Input/output types are inferred from those functions. Values and errors remain opaque and are preserved by identity; payload fields are not automatically bound to model variables.

For the Rust target, build `rust/Cargo.toml` using Cargo and a Rust toolchain supporting return-position `impl Trait` in traits (Rust 1.75 or later). The crate has no dependencies. Implement its generated `Ports` trait, pass the implementation to `ApprovalDomain::new`, and call the named async operation. Use `PublicEvent::from_model_name("Approve")` with `send` for ordinary actions. Operation actions are not public events. The future returns `OperationResult`: `Refused` does not call the port, `Completed` contains its actual `Result`, and `CompletionRejected` retains the result if the internal completion fails.

TLC validates the configured finite model. Lean validates the serial port protocol. The build checks the emitted Rust artifact against the graph and binding, but the artifact checker, native emitters, language runtimes, external effects, durability, and eventual completion are not formally proved. A new owner is distinct. A never-settling port stays pending; dropping a Rust operation future after it starts, or a panic, can also leave the owner pending.
