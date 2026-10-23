# Native Codex Ledger fixture

This original source fixture is copied into temporary scratch by `scripts/verify-codex-host.mjs`. It contains no generated policy. Its private Rust adapter hook and primitive path dependency resolve after fresh MCP generation.

Native `LedgerFact` equality compares symbol, key, time, and value. The received field is complete provenance. The v5 row model preserves complete stored and rejected pairs. The v2 control retains sticky insertion and conflict observations, then closes and consumes once. The v6 family selects the raw signed key, exact symbol, and nonnegative UTC microsecond day. Both finite domains contain two distinct atoms.

First incoming rows win after baseline replay. Baseline duplicates use the existing v6 last-wins Write rule. Noop and Refused preserve the original baseline order and duplicates. Any incoming clash refuses the whole batch and preserves every complete ordered conflict pair.

Rust and TypeScript tests assert all five fields for returned rows and both conflict sides. They emit complete observations for an independent comparison with `expected-observations.json`. `verify-native.mjs` executes exact TypeScript 7.0.2 from the copied runtime and locked offline Cargo, records actual commands and output, and reports success only after every expected observation matches.

The fixture owns one synchronous generated fold. It has no resource binding, external writer, persistence, or effect-atomicity contract.
