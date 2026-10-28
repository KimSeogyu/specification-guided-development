# Verification

Run the repository checks and build:

```sh
npm ci
npm run check
npm run build
```

For controlled model tests, supply the pinned TLC JAR. Domain proof tests also
require an absolute path to Lean 4.35.0:

```sh
TLA2TOOLS_JAR=/absolute/path/tla2tools.jar \
SGD_LEAN_BINARY=/absolute/path/lean npm test
```

Tests that require unavailable tools report skips. A skipped integration test
is not evidence that its model, native tool, or generated program passed.
Run generated TypeScript and Rust consumers to check admission, complete
snapshots, rejection behavior, and actual port outcomes. Include negative cases
that fail for the intended reason and regenerate after changing a model requirement.
Rust domain verification also requires Rust 1.92.0 and its matching rustfmt.

Use the [domain guide](domain-code.md) for TLC and Lean protocol verification,
and the [Bend evaluation](bend-evaluation.md) for the experimental pure core.
Keep model checks, proof-kernel checks, generated-code execution, plugin
installation, and application integration as separate results. None alone
proves that every application requirement has been modeled or enforced.
