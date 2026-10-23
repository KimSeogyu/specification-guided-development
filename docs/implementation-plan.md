# Implementation plan

## User requirements

- Create the public repository `KimSeogyu/specification-guided-development`.
- Build a compiler from TLA+ through TLC automata and Graphviz DOT to generated language-specific linter code.
- Support TypeScript and Rust initially.
- Package independent native plugins for Codex and Claude Code. Expose a common MCP server.
- Teach agents the methodology through a skill: model architecture and behavior, check the model, generate constraints, then develop within those constraints.
- Render model structure with Pele. Preserve the link between high-level architecture and lower-level state models.
- Keep context and evidence in files. Use parallel implementation and independent review.

## Completion predicate

A fresh checkout can install dependencies, run tests, model-check both examples with TLC, emit both language backends, reject a forbidden edge, accept a permitted edge, serve MCP tools, and render Pele SVG and HTML. Both plugin packages validate and contain an executable runtime after packaging. The repository is public and the verified source is pushed.

## Work units

- [x] Inspect the empty repository and create the public remote.
- [x] Define the automaton IR, project schema, and backend boundary.
- [x] Import real TLC DOT and reject missing or unsupported semantics.
- [x] Run TLC in an isolated directory. Publish generated outputs only after successful completion.
- [x] Generate TypeScript and Rust linters for explicit transition declarations and module dependency bindings.
- [x] Provide architecture and lifecycle examples with positive and negative application fixtures.
- [x] Provide CLI and MCP tools for model, compile, inspect, and visualize.
- [x] Render Pele visualizations from the same IR.
- [x] Package native agent plugins with the methodology skill and local runtime.
- [x] Replace the TypeScript compatibility API with the pinned native TypeScript 7 API and repeat backend verification.
- [x] Run independent source review and end-to-end checks. Fix accepted findings.

Publication status is recorded in [GitHub releases](https://github.com/KimSeogyu/specification-guided-development/releases).
Disposable validation outputs are removed after publication. Prepared local plugin runtimes remain installation deliverables.

## Design decisions

The compiler consumes TLC action-labeled DOT. A selected string-valued state variable projects concrete TLC states into application states. The IR records concrete graph size and projection scope. An edge means that the transition occurred in the explored model. It does not preserve every guard.

The first transition profile checks explicit three-literal declarations. The TypeScript form is `transition("from", "event", "to")`. The Rust form is `transition!("from", "event", "to")`. These declarations do not establish the runtime state of arbitrary code.

The dependency profile maps projected states to source files or directories. An inter-module import requires a graph edge. Imports within one module do not cross a boundary. Bindings contain code correspondence, not a second policy allowlist.

The source files of independent workers do not overlap. The parent owns frontend, orchestration, examples, and integration. Workers own the TypeScript backend, Rust backend, and plugin packages respectively.

Two TypeScript 7 adapter designs were investigated with executable probes. Oxc supplied a separate parser and Node-oriented resolver. The native TypeScript 7 API supplied snapshots, AST access, and project-aware module symbols. The native adapter was selected to preserve TypeScript module semantics. Its unstable API paths require an exact version pin. Unsupported resolution remains an explicit error. Native runtime archives must identify their host platform and architecture.

## Verification scope

No claim of whole-program refinement, unbounded verification, or arbitrary dynamic code analysis is permitted. Imported DOT without a completed TLC run remains explicitly unverified. Graph projection, current model constants, excluded code constructs, and unchecked files must remain visible to agents and readers.
