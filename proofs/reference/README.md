# Reference proofs

These Lean 4.35.0 modules define the compiler method's reference semantics. They
do not certify the TypeScript emitter, native parsers, adapters, or runtime.
The executable build uses the separate [domain protocol](../domain/DomainProtocol.lean).

The proof chain covers finite source extraction, generated dispatch,
constraint/compliance equivalence, complete configuration enumeration,
TypeScript-style control flow, and admitted development changes. The whole
program requirement must have a faithful interpretation in the modeled state.
Safety does not imply progress, persistence, or external-effect correctness.

Run the complete dependency-ordered check from the repository root:

```sh
SGD_LEAN_BINARY=/absolute/path/to/lean npm run proofs:check
```

`CompilerPipeline` proves source/graph correspondence. `SemanticConstraints`
proves exact finite initial/state/edge compliance. `LanguageProfiles` and
`ProfileComposition` connect a finite TypeScript-style language to that check.
`CertifiedPipeline` binds admitted development to compiled sources and checked
model safety. `GraphDevelopment` adds reachable-graph migration: the new live
state must be reachable in the new source and commute with the old state view.
Adjacent source refinement remains a separate obligation.

`CheckedTraces` and `GraphCheckedTraces` connect whole-runtime lint acceptance
to source observations with unchanged actor and acceptance/rejection labels.
`RustProfile` defines a separate finite match/Result and scoped-reborrow language.
`MixedProfiles` proves operational lowering, whole-program checking, and full-query
Rust authority installation. `MixedCheckedTraces` and `MixedGraphDevelopment`
connect mixed execution to source observations and approved graph revisions.
These proofs do not verify the production Rust backend. The [scope audit](AUDIT.md)
maps each requirement to its proof and states the native implementation limits.

Counterexamples show why omitted state, unclassified writes, unsafe resets,
and misleading interpretations invalidate broader claims.
