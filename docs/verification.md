# Verification

The initial implementation was exercised on macOS arm64 with Node.js 24, TypeScript 7.0.2, Java 17, and Rust 1.92.
The same checks, ingestion workflow, and isolated plugin verification also passed in GitHub Actions on Linux x64.
The finite-owned milestone also passed [its separate Linux CI run](https://github.com/KimSeogyu/specification-guided-development/actions/runs/39996215994). Later milestones retain their own local and CI evidence in the associated pull request.

## Finite-owned milestone

The source now includes real pinned-TLC tests for full-variable state preservation, isolated dependency closure, rejected reductions/overrides, changed-source rejection, and complete verification receipts. Native TypeScript 7 and Cargo consumers exercise generated owners without declaration-style transition calls. Tests compare all reachable fixture state/action decisions with the graph, reject private-state writes and construction, and verify snapshot independence and revision exhaustion.

A real TLC integration test compares both languages' complete snapshot traces. It changes the TLA+ submission requirement, checks that the old output is stale, regenerates, and verifies the changed native behavior. Model-only generation can render multiple initial states, nondeterministic edges, and terminal graphs; executable generation refuses unsupported choices. A concurrent project JSON edit is rejected before output creation.

Read [the finite-owned contract](finite-owned.md) for the actual trust boundary. These checks establish per-live-object finite safety. They do not establish persistent identity, effect atomicity, all application call paths, or completed Parangsae adoption.

An independent agent followed the revised Codex skill through the source plugin launcher to create a new four-state job model and native TypeScript/Rust consumers. Both retained the two Ready guard states, rejected Run before Validate, accepted the intended lifecycle, and preserved state/revision after rejections. The trial needed a consumer tsconfig rootDir adjustment and a local SVG rendering adjustment; it required no generated policy edit. It exposed an unclear terminal self-loop description, now corrected in both modeling guides. Browser interaction and actual installed agent hosts were outside that trial.

Both prepared native plugin packages also pass the MCP workflow from independent copied caches, including full-state generation, packaged TypeScript 7 compilation, runtime tamper checks, Pele, and imported-authority rejection. These cache tests do not establish installed-host operation.

## Symbolic input milestone

The source adds pinned semantic XML parsing and a v3 equality/copy relation compiler. The configured finite witness and an independent observer module compare original TLA+ actions with every reachable state/input pair. The orbit check separately validates the admitted data-independent relation, invariants, square action properties, ambiguity, scalar comparison semantics, and configured deadlock policy.

Native TypeScript and Rust consumers agree on complete receipts for A→B→C→A, including assignment origins, original stored A, latest rejected C, and the distinction between data `none` and scalar string `none`. A requirement change to Same resolves the conflict after receiving the original stored value, preserves the existing invariants, and changes both languages after regeneration. Stable generation, edited-artifact refusal, imported-DOT refusal, model-only cleanup, and both Pele scopes are exercised.

Independent adversarial tests use real TLC to expose and retain checks for ignored assumptions, lost square-action stuttering, action-level pure-helper applications, typed model values, scalar type errors hidden by a two-atom fixture, and deadlock that appears only with three distinct atoms. These tests and the orbit argument do not constitute a machine-checked correctness proof for the compiler.

The actual Parangsae `ManifestWrite.tla` and configuration were also compiled directly with their own co-located pinned JAR, writing only SGD scratch output. This confirms model compatibility. It does not establish application integration or authorize operational data writes.

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
