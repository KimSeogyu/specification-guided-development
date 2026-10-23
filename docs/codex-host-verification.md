# Verify a native Codex session

This manual check runs the installed Codex CLI with a copied prepared SGD plugin, session-only MCP configuration, and an explicitly selected skill. It verifies fresh generation and native Ledger behavior through that real agent. Plugin-manifest discovery, marketplace activation, and permanent installation are separate checks.

## Prepare the host

Use a complete native Codex plugin prepared with [the standalone packaging steps](plugins.md#prepare-the-packages). The plugin must match the host platform and architecture. This verifier does not build the SDK, prepare a plugin, install dependencies, register a marketplace, or change agent configuration.

Keep these prerequisites available:

- Node.js 22 or newer, Java, the pinned `tla2tools.jar`, Cargo, and rustfmt.
- A prepared plugin with its runtime, bundled Rust analyzer, and exact TypeScript 7.0.2 compiler dependencies.
- An installed Codex CLI with an existing working login. The verifier checks login status without retaining its output. It does not run login, copy credentials, reset authentication, or set up an API key.
- The registry dependencies in the Ledger fixture's `Cargo.lock` already available to Cargo. Native checks use `--offline --locked` and never fetch a missing dependency.
- A POSIX host with `pgrep`, `du`, `df`, and `tar`. Windows process cleanup is not supported by this verifier.

The native trial used `codex-cli 0.163.0`. This is a tested version, not a claimed minimum. The verifier checks required CLI flags, then uses `--strict-config` to reject unsupported configuration. Managed host requirements and ordinary user execpolicy rules remain active and can refuse the workflow.

The prepared plugin supplies its compiler and analyzer. It does not guarantee that Cargo has every dependency needed to compile a generated library. If offline Cargo reports a missing package, prepare that dependency through your normal dependency workflow before another manual run.

## Run one workflow

From the SDK checkout, run:

```sh
node scripts/verify-codex-host.mjs \
	--plugin /absolute/path/to/prepared/codex \
	--jar /absolute/path/to/tla2tools.jar
```

Use `--out /absolute/path/to/new-evidence-directory` to choose the evidence location. The directory must not exist. The verifier resolves existing ancestors before creating directories and refuses output physically inside the prepared plugin or original fixture, including symlink aliases. It uses the captured physical output path. Use `--codex /absolute/path/to/codex` to select an already installed CLI. No model flag is accepted or supplied. Codex resolves its default under the invocation's configuration flags, including `--ignore-user-config`.

The verifier copies the complete plugin, JAR, and original Ledger fixture into unique temporary scratch. It resolves the scratch path with realpath before constructing commands and expected receipt paths. Generated output is absent before the native invocation. It derives the MCP command, arguments, and working directory from the copied `.mcp.json` rather than importing SDK source.

The native invocation uses these options:

```text
-a never --strict-config
exec --ignore-user-config --ephemeral --skip-git-repo-check
--sandbox workspace-write --json --color never
```

The verifier supplies only the copied SGD server through `-c` overrides. It restricts the server's tool names and approves build and rendering calls for this session:

```toml
mcp_servers.sgd.enabled_tools = ["sgd_build", "sgd_inspect", "sgd_visualize"]
mcp_servers.sgd.tools.sgd_build.approval_mode = "approve"
mcp_servers.sgd.tools.sgd_visualize.approval_mode = "approve"
```

These settings apply to this invocation. They approve tool names, not argument paths. The prompt scopes work to the owned fixture, and the supervising verifier rejects observed calls with other paths. The broader approval policy stays `never`, and the sandbox stays `workspace-write`. The verifier does not use `--ignore-rules`, bypass hook trust, alter tool read-only annotations, change HOME or CODEX_HOME, or change authentication variables. The [official MCP configuration reference](https://learn.chatgpt.com/docs/extend/mcp) describes the allow list and per-tool approval settings.

The first exploratory native trial omitted these per-tool approvals. Codex rejected its build and visualization calls with `MCP tool call requires approval, but approval policy is never`. Its CLI process still exited successfully after the agent reported a partial result. The earlier trial also used `--ignore-rules`; it does not establish compatibility with ordinary user execpolicy rules. This verifier preserves those rules and reports a refusal instead of disabling them.

The script starts one native workflow, with a 360-second limit. It does not retry a failed workflow or substitute a direct SGD CLI call. Prerequisite checks, copying, evidence archival, and cleanup occur outside that workflow limit. An interrupt stops the owned process group before cleanup.

## Read the result

By default, evidence is saved under a unique `.runtime/codex-host-*` directory. Start with `result.json`. A successful check has `"status": "passed"` and the script exits with code 0.

The verifier requires actual JSONL tool results for fresh `sgd_build`, both IR inspections, `sgd_visualize`, and `sgd_build(check:true)`. It checks their exact fixture paths and return values. A final agent reply or a successful Codex process exit is insufficient.

It also reads the generated controlled receipts, original source identities, JAR identity, input oracle, equality/copy orbit evidence, row binding plan, and Pele files. Only six declared, quoted helper commands are accepted. Exact read-only inspection commands may repeat when output is truncated; the native checker runs once. They read the selected skill, references, original application, and fresh Pele output, then run native checks. Unknown commands, file-writing tools, pipelines, additional statements, failed turns, and unsupported shell wrappers fail verification. The parser supports plain declared commands and the known POSIX `sh`, `bash`, or `zsh` `-lc` wrapper.

The fixed native fixture checker must start after `check:true`, remain unchanged, and record successful generated TypeScript compilation, application typechecking, TypeScript behavior, and locked offline Rust behavior. The supervising script reparses the actual native output and compares complete row and conflict-pair observations with the original expected values.

The evidence directory contains the invocation, scoped prompt, selected native JSONL events, final reply, native command records and output, generated artifacts, Pele files, and a compact `evidence.tgz`. The capture keeps declared event fields and authorized fixture/tool output. It does not capture authentication status output, environment variables, or system input contexts. Known credential-like tokens are redacted as a further precaution. Dependency caches and binaries are excluded.

The script removes its own temporary tree after its native process group and processes that reference the unique scratch path are terminal. `cleanup.removedBytes` records the measured size. `cleanup.freeSpace` records `df -h`, using `/System/Volumes/Data` on macOS. If an owned server remains live or safe cleanup fails, the result fails and reports the retained scratch path. The script does not remove another session's files, caches, or previous evidence directories.

For failure, read `failure.code`, `failure.message`, `process.json`, and the associated logs. `HOST_APPROVAL` identifies an actual native MCP approval refusal. `HOST_PREREQUISITE`, `HOST_LOGIN`, `HOST_RUNTIME`, and `HOST_JAR` identify missing preparation. Missing or failed tool calls, changed or added fixture/plugin files, invalid receipts, native failures, and timeout all fail the check. Do not describe those outcomes as successful host integration.

## Keep the claim within the fixture

The fixture binds native `LedgerFact` equality over symbol, key, time, and value, with received time retained as provenance. It tests first incoming receipt retention, ordered repeated complete conflicts, whole-batch rollback after a provisional insertion, signed key extrema, Noop and empty input, baseline duplicates, group and calendar rejection, and TypeScript token, array, and single-consumption boundaries.

The model witness contains two payload atoms and two provenance atoms. Native observations compare all five fields of returned rows and both sides of each conflict pair. Pele validation reads its real source and model data; this entry point does not open a browser. Reports remain unbound data. The check establishes no loaded-resource authentication, exclusive writer, storage permission, persistence, effect atomicity, application-wide adoption, or arbitrary TLA+ coverage.

Keep this entry point out of default CI. It needs an authenticated native host, can consume account usage, and depends on host policy and cached native dependencies.

## Replay protocol checks without an account

Run `node --test scripts/verify-codex-host.test.mjs` for deterministic checks derived from a sanitized captured native run. They require no login or native agent. They admit repeated identical read-only helpers and reject unknown or mutating commands, repeated native checks, extra MCP calls, missing reads, unfinished actions, early native execution, approval errors, and failed turns. Filesystem checks also reject aliased output inside original inputs before any evidence directory is created. These checks validate protocol and path guards; they do not count as a fresh host workflow.
