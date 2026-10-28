# Specification Guided Development

Generate domain code from TLA+ state models. SGD runs TLC, checks the finite operation protocol with Lean, and emits TypeScript or Rust domain code with injected ports for application effects.

The generated object owns state, admits operations through model transitions, and selects completion from each port's actual fulfillment or rejection.

```text
TLA+ model and configuration
  → TLC full-state graph
  → Lean operation-protocol check
  → TypeScript or Rust domain + injected ports
```

## Generate a TypeScript domain

Use Node.js 22+, Java 17+, and Lean 4.35.0. From the repository root:

```sh
npm ci
node scripts/fetch-tlc.mjs
npm run build
node dist/cli.js build \
  --project examples/domain-approval/project.json \
  --jar "$PWD/.runtime/tla2tools.jar" \
  --lean /absolute/path/to/lean \
  --out .runtime/approval-domain
node node_modules/typescript/bin/tsc -p .runtime/approval-domain/typescript/tsconfig.json
```

The fetch helper explicitly downloads and verifies the pinned TLC JAR. TypeScript is pinned to 7.0.2. A missing Lean executable or failed proof stops generation before publication.

Use the generated domain with your application's adapters:

```ts
import { writeFile } from 'node:fs/promises';
import { createApprovalDomain } from './.runtime/approval-domain/typescript/dist/domain.js';

const approval = createApprovalDomain({
  publisher: async (report: { path: string; text: string }) => {
    await writeFile(report.path, report.text, { flag: 'wx' });
    return report.path;
  },
});

approval.send('Approve');
const result = await approval.publish({ path: 'report.txt', text: 'Ready' });
console.log(result.kind);
```

This model refuses `publish` before approval. During publication, competing operations cannot start. A rejected or throwing adapter selects the failure transition and preserves the original error. The [domain guide](docs/domain-code.md) describes bindings, result types, dependency capture, and supported protocols.

Inspect the model with Pele:

```sh
node dist/cli.js visualize --ir .runtime/approval-domain/automaton.json --out .runtime/approval-view
```

Open `.runtime/approval-view/index.html`. To verify existing generated output without rewriting it, repeat the build command with `--check`.

TLC checks the configured finite model; Lean checks its operation protocol. These checks do not formally prove the TypeScript emitter or JavaScript runtime. Ownership is per live object, and adapter fulfillment does not establish physical-effect correctness, atomicity, or persistence.

## Generate a Rust domain

In a copy of the domain project, set `targets` to `["rust"]` or `["typescript", "rust"]`. Keep the copied TLA+ model and configuration beside the project file. Use the same `build` command with the copied project path. Rust generation requires a `binding.domain` and rejects unsupported Rust identifiers. It does not support the other Rust profiles.

The output under `rust/` is a dependency-free Rust 2021 crate. Build it with `cargo build --manifest-path <output>/rust/Cargo.toml`. Implement its `Ports` trait and pass the implementation to `ApprovalDomain::new`. Call `send` for public events and the named async operation for its port. The [domain guide](docs/domain-code.md#rust) shows the API.

The build checks the generated Rust artifact against the graph and Lean checks the finite protocol. The artifact checker, emitter, Rust compiler, and native execution remain trust boundaries; this is not a formal proof of Rust code or of the application. Dropping an operation future after it starts, or a panic, can leave the owner pending.

## Evaluate the Bend core

The experimental Bend backend generates pure transition code, modeled snapshots, laws, and proofs. It has no private live owner or async DI driver. Its raw JavaScript export is not an input-validating application API.

With Bend 2.0.39 and its matching BendTT kernel available, run:

```sh
node scripts/evaluate-bend.mjs \
  --project examples/approval/project.json \
  --jar "$PWD/.runtime/tla2tools.jar" \
  --bend /absolute/path/to/bend \
  --kernel /absolute/path/to/bendtt \
  --out .runtime/bend-approval
```

The evaluation runs `--verdict`, compares JavaScript and native execution with the model, and checks deliberate implementation mutations before publishing output. The [Bend guide](docs/bend-evaluation.md) covers tool setup, the separate Lean 4.34.0 kernel dependency, and the typed-input boundary. Bend remains a source-checkout experiment, separate from the normal `build` targets.

## Agent plugins

Independent Codex and Claude Code packages provide the modeling skill and local MCP tools. Follow the [plugin guide](docs/plugins.md) for installation, packaging, and updates.

The [v0.3.0-alpha.2 release](https://github.com/KimSeogyu/specification-guided-development/releases/tag/v0.3.0-alpha.2) provides macOS arm64 plugin archives.

## Other TypeScript profiles

| Profile | Purpose |
| --- | --- |
| [Finite state owners](docs/finite-owned.md) | Preserve complete modeled state and enforce permitted transitions. |
| [Retained operations](docs/retained-operation.md) | Return the original payload on ordinary success, failure, or refusal. |
| [Symbolic inputs](docs/symbolic-owned.md) and [independent inputs](docs/product-inputs.md) | Generate equality/copy guards and preserve payload/provenance distinctions. |
| [Source checks](docs/compiler.md) | Check declared transition edges and module dependencies. |
| [Contract comparison](docs/structural-contracts.md) | Compare supported model contracts against a supplied baseline. |

Source checks and generated owners have different guarantees; each guide defines its boundary.

Start from the application's responsibilities and affected model/code bindings. The [development method](docs/development-method.md) describes that workflow and how to keep unsupported requirements visible.

## Development

```sh
npm run check
npm run build
```

Set `TLA2TOOLS_JAR` for real TLC integration tests. Domain integration tests also need `SGD_LEAN_BINARY` pointing to Lean 4.35.0. See the [verification record](docs/verification.md) for additional checks and their scope.

[MIT license](LICENSE).
