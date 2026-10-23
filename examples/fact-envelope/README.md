# Fact payload and provenance

This model extends the per-key contract in `../fact-merge/ManifestWrite.tla` with explicit stored and rejected provenance. It is a compiler example, not an installed Parangsae adapter.

The caller supplies two immutable identities: `v` in `Values` and `provenance` in `Receipts`. The domains use distinct model atoms. An equal stored payload preserves its first provenance. Every conflicting write replaces the latest rejected provenance, including a repeat of the same rejected payload.

For A@r1, B@r2, B@r3, A@r4, the final state stores A@r1 and rejects B@r3. Provenance can represent an application's receipt time and original source schema, but the application must provide and verify that binding. The compiler does not infer it from a payload hash or a TLC atom.

## Build and inspect

From the repository root, run:

```sh
npm ci
node scripts/fetch-tlc.mjs
export TLA2TOOLS_JAR="$PWD/.runtime/tla2tools.jar"
npm run build
node dist/cli.js build --project examples/fact-envelope/project.json --jar "$TLA2TOOLS_JAR" --out .runtime/fact-envelope
node dist/cli.js build --project examples/fact-envelope/project.json --jar "$TLA2TOOLS_JAR" --out .runtime/fact-envelope --check
node dist/cli.js visualize --ir .runtime/fact-envelope/automaton.json --ir .runtime/fact-envelope/symbolic-model.json --out .runtime/fact-envelope/view
```

Open `.runtime/fact-envelope/view/index.html` to inspect the configured witness and the symbolic relation. Both preserve all five variables and distinguish payload atoms from provenance atoms.

## Check the original payload contract

Build the abstract fact-merge model and check the explicit erasure binding:

```sh
node dist/cli.js build --project examples/fact-merge/project.json --jar "$TLA2TOOLS_JAR" --out .runtime/fact-merge
node dist/cli.js refine --abstract .runtime/fact-merge/symbolic-model.json --concrete .runtime/fact-envelope/symbolic-model.json --binding examples/fact-envelope/erasure.json --out .runtime/fact-erasure
node dist/cli.js refine --abstract .runtime/fact-merge/symbolic-model.json --concrete .runtime/fact-envelope/symbolic-model.json --binding examples/fact-envelope/erasure.json --out .runtime/fact-erasure --check
```

`refinement.json` records the checked semantic identities and binding. The check compares the complete projected state, enabled inputs, and action classification across the supported equality-and-copy orbits. It checks the supplied IR. The separate build receipts identify the original source and TLC runs. The erasure check does not establish a Parangsae adapter or a storage transaction.

See [the product-input profile](../../docs/product-inputs.md) for the native APIs and verification scope. Partition rollback, Parquet writes, recovery, and multiple writers remain separate application contracts.
