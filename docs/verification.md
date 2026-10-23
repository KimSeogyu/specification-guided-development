# Verification

The initial implementation was exercised on macOS arm64 with Node.js 24, TypeScript 7.0.2, Java 17, and Rust 1.92.

## Reproduce

```sh
npm ci
node scripts/fetch-tlc.mjs
TLA2TOOLS_JAR=.runtime/tla2tools.jar npm run check
npm run demo
npm run verify:ingestion
npm run plugins:package
npm run plugins:verify
```

`npm run check` includes a real TLC integration test when `TLA2TOOLS_JAR` is set.
The CI workflow sets that variable.
Without it, that integration test is skipped and must not be reported as completed.

## Application workflow

An independent agent used the packaged skill to create the ingestion example from behavioral and architectural requirements.
The behavior model contains a string state and a validation-history Boolean.
The architecture model includes a previous-module variable and an explicit Composition module for crate registration.

The same business source files pass both generated checkers in TypeScript and Rust.
A direct Received-to-Stored declaration fails with `TLC001`.
A nonliteral declaration fails with `TLC002`.
A Handler-to-Storage import fails with `TLC003`.
Both intentionally faulty model variants fail their TLC invariants before generation.
Native application tests exercise transition guards and terminal states.

The workflow exposed defects that the original examples did not exercise.
The importer now decodes escaped TLC conjunction prefixes in multi-variable labels.
Rust function-call declarations allow architecture and behavior checks to compose without opaque macro exceptions.

## Compiler and package checks

Backend tests execute generated checkers on permitted, forbidden, and unsupported source forms.
They cover aliases, raw Rust identifiers, conditional TypeScript import resolution, and explicit file ownership.
Frontend tests reject incomplete graphs, stale generated source, unowned-file replacement, and concurrent output writers.
The model receipt's stable fields are checked independently of temporary execution paths.

`npm run plugins:verify` copies each prepared plugin into an isolated cache outside the source checkout.
It starts a real stdio MCP connection and runs model checking, inspection, a generated native TypeScript check, and Pele rendering.
Native Claude Code manifest validation is a separate check.
The workflow does not install either plugin into the user's account or change global agent settings.

## Limits

The linter checks the supplied files and supported source profiles.
Transition declarations do not prove that arbitrary function bodies preserve the model.
The selected finite graph projects one string variable and loses guards over other variables.
Containment links in the viewer are not refinement proofs.
Native TypeScript API entry points are unstable and pinned to 7.0.2.
Prepared plugin archives contain platform-specific native binaries and reject a different host.
