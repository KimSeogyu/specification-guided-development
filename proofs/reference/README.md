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
model safety. Reachable-only graph compilation has separate migration-domain
obligations; it is not a proof for arbitrary live graph upgrades.

Counterexamples remain in the proof modules to show why omitted state,
unclassified writes, unsafe resets, and misleading interpretations invalidate
broader claims. Deprecated lifecycle experiments and chronological status
records are not part of this reference library.
