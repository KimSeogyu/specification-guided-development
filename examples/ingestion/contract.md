# Document ingestion contract

One document starts in Received. Validate moves it to Validated. Persist moves it from Validated to Stored. Reject moves it from Received to Rejected. Stored and Rejected are terminal application states. A failed operation leaves the document state unchanged. A received document must never move directly to Stored.

The architecture permits Handler to depend directly on Pipeline, and Pipeline to depend directly on Storage. Handler must not depend directly on Storage. Composition represents crate module registration and may declare Handler, Pipeline, and Storage; it does not grant Handler any extra dependency. The ingestion behavior is displayed inside architecture.Pipeline; this is visual containment, not refinement.

Finite scope: one document, four behavior state strings, one validation-history Boolean; four architecture modules (including crate Composition) and one previous-module string. No concurrency, retry, external storage failure, multiple documents, or mutable data payload is modeled.

TLC checks the reachable finite model and its invariants. Generated transition checks compare literal declared edges, and generated dependency checks compare supported imports between mapped module paths. They do not verify runtime state changes or recover guards. Native tests will cover the implementation's transition guards and observable results.

Run `node scripts/verify-ingestion.mjs` from the repository root. The script copies this example into `.runtime/ingestion-demo`, checks both models with real TLC, compiles both language checkers, tests accepted and refused application cases, runs native tests, and writes a combined Pele view. Set `TLA2TOOLS_JAR` or provide `.runtime/tla2tools.jar`. Java, Cargo, and the repository dependencies must already be available; the script installs nothing.

Every TypeScript application source file and every Rust source file under `src/` is supplied to both generated checkers. Rust integration tests run through Cargo. The ordinary declaration helper in `support/policy-declarations` has no business policy and is outside application contract inspection.
