# Generate a TypeScript domain

Copy `Approval.tla`, `Approval.cfg`, and `domain-project.json` from this reference directory into the application's model directory. Rename the project file to `project.json` and adapt the model to the requirement. Do not modify installed plugin files.

Call `sgd_build` with absolute paths for `project`, the pinned TLC `jar`, a separate `out`, and the Lean 4.35.0 executable in `lean`. Use `check: true` to verify freshness. A missing tool or failed proof stops generation.

`binding.domain.operations` maps a method and port to existing `start`, `success`, and `failure` actions. It supplies no transition policy. Pending states must admit exactly the two completion outcomes, can only be entered by the associated start, and cannot be initial or completion targets. Roles are distinct. Operations are serial per live owner.

The output contains `typescript/domain.ts`, its internal owner, and `proof/DomainProtocol.lean` plus the model-specific proof. Build the generated TypeScript package before importing `dist/domain.js`.

`createApprovalDomain({ publisher })` captures the injected callback. Call `send('Approve')`, then `publish(input)`. Actual fulfillment selects success; a throw or rejection selects failure. Public `send` rejects all operation start/completion events. A disabled operation calls no port.

Ports are own function-valued data properties, invoked without `this`. Bind receiver-dependent methods explicitly. Input/output types are inferred from those functions. Values and errors remain opaque and are preserved by identity; payload fields are not automatically bound to model variables.

TLC validates the configured finite model. Lean validates the serial port protocol. The native TypeScript emitter, external effects, durability, and eventual completion are not proved. A new factory call creates a distinct owner; a never-settling port stays pending.
