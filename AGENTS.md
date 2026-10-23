# sgd

Compile TLC state graphs into language-specific source checks. Keep application policy in TLA+ models. Bindings map model names to code locations and syntax.

## Contract

- Preserve the pipeline: TLA+ and model configuration, TLC, DOT, typed automaton, generated authority or linter, application source.
- Support TypeScript and Rust through separate backends that share one automaton representation.
- Keep exact finite state separate from projected diagnostic state. Only controlled completed builds can generate finite-owned authority; imported DOT remains unverified.
- Read `docs/finite-owned.md` before changing executable semantics. Preserve all supported variables and reject ambiguous executable choices. State the per-live-object boundary; do not claim persistence, external data binding, effect atomicity, or application-wide coverage without separate evidence.
- For v3 data input, read `docs/symbolic-owned.md`. Derive policy from validated SANY source; pinned DOT omits action arguments. Keep bounded TLC evidence, equality/copy orbit validation, and actual application integration as distinct claims. Do not replace original fact equality with all-field serialization or caller-selected Same/Clash events.
- For v4 independent inputs, read `docs/product-inputs.md`. Reject overlapping configured atom domains and repeated-domain binders. Preserve domain tags and named input origins. Model omitted metadata explicitly. An enabled-input erasure checks supplied symbolic programs, not application object bindings or TLC provenance.
- Use exact TypeScript 7.0.2 for builds and native syntax analysis. Do not reintroduce a legacy compiler API.
- Reject unsupported graph labels, ambiguous projections, and unsupported code in a checked construct. Never treat an unknown construct as a permitted transition.
- Report the finite model scope. A projected edge is an observed possible transition, not a proof of every guard or every application behavior.
- Keep diagnostic IDs stable across backends.
- Keep Codex and Claude Code packages independent. Do not alter a user's global agent configuration during tests.

## Validation

Run `npm run check` and `npm run build`. Exercise generated linters against valid and invalid TypeScript and Rust. Use a real TLC run for the end-to-end test when `TLA2TOOLS_JAR` is available.

Stage named paths. Inspect the staged diff before a commit. Do not publish generated runtime output or credentials.
