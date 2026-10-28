# Install and use the plugins

Codex and Claude Code have independent packages, manifests, skills, and MCP
configuration. Install only the package for the host you use.

The [0.3.0-alpha.2 release](https://github.com/KimSeogyu/specification-guided-development/releases/tag/v0.3.0-alpha.2)
provides macOS arm64 packages. The bundled TypeScript 7.0.2 compiler is native.
The launcher checks `runtime-platform.json` and refuses a different operating
system or CPU architecture. Build on another host to prepare its matching package.

Keep Node.js 22 or newer on the agent's `PATH`. Modeling requires Java and the
pinned local TLC JAR. Domain generation also requires a user-provided absolute
path to Lean 4.35.0. Neither the launcher nor the marketplace preparer installs
these tools or changes global agent settings.

## Prepare the packages

From a source checkout:

```sh
npm ci
npm run check
npm run build
node plugins/package.mjs
```

Packaging copies compiled code and locked production dependencies into each
plugin's `runtime` directory. It does not install missing npm dependencies.
The prepared checkout can serve as a local marketplace.

To create complete archives:

```sh
node plugins/package.mjs --archive-out .runtime/plugin-packages
node plugins/package.mjs --archive-out .runtime/plugin-zips --archive-format zip
```

TAR is the default and requires `tar`. ZIP requires `zip`. Archive names include
the host, package version, platform, and architecture. Existing destinations are
refused. Use a new output directory after a partial failure. An ordinary
`npm pack` archive is not a prepared plugin distribution.

## Install a release archive

Download the selected host's complete archive and check it against the release's
`release-manifest.json`. Extract it into its own directory, then run:

```sh
node /absolute/extracted-plugin/scripts/prepare-marketplace.mjs \
  --host codex --plugin /absolute/extracted-plugin \
  --out /absolute/new-marketplace
```

For Claude Code, use its archive and `--host claude-code`. The output parent
must exist, and the new directory must be outside the extracted plugin.
The preparer validates the package and copies it into a self-contained
marketplace. It refuses an existing output and prints the native installation
commands. It does not install or activate the plugin.

Keep the prepared marketplace while using it. Claude's directory-source plugins
can load from that location rather than from a copied cache.

## Use Codex

Register either the prepared checkout or the prepared marketplace:

```sh
codex plugin marketplace add /absolute/prepared-marketplace
codex plugin add specification-guided-development@specification-guided-development-codex
```

Start a fresh chat, invoke the `specification-guided-development` skill, and
confirm that the `sgd` MCP tools are available. The package includes portable
`plugin.json` and `mcp.json` plus the native compatibility manifest. Its launcher
does not require the original source checkout beside the installed package.

Native installation can change the host's activation settings. Use the host's
scope controls and preserve your project/user activation policy; the preparer
does not manage that policy.

## Use Claude Code

From the application project root:

```sh
claude plugin marketplace add /absolute/prepared-marketplace --scope local
claude plugin install specification-guided-development@specification-guided-development-claude --scope local
```

Start a fresh session and invoke
`/specification-guided-development:specification-guided-development`.
Confirm that the `sgd` MCP tools are available. The package uses
`.claude-plugin/plugin.json` and `.mcp.json` with `${CLAUDE_PLUGIN_ROOT}` paths.
It does not configure Codex.

For a development session without marketplace installation:

```sh
claude --plugin-dir /absolute/prepared-checkout/plugins/claude-code
```

## Update a local marketplace

A source merge or archive download does not replace an installed runtime.
Keep the existing marketplace name and qualified plugin ID.

1. Extract and validate the new package. Keep the previous package unchanged.
2. Put the complete new payload under a new version directory in the existing
   marketplace, such as `releases/0.3.0-alpha.2/plugin`.
3. Update only that plugin's catalogue entry. Codex uses
   `.agents/plugins/marketplace.json` and `source.path`. Claude uses
   `.claude-plugin/marketplace.json`, `source`, and `version`. Save the old
   catalogue, reject concurrent changes, and publish the replacement atomically.
4. Request the host update, replacing `MARKETPLACE_NAME` with the registered name:

```sh
codex plugin add specification-guided-development@MARKETPLACE_NAME --json
```

Or, for Claude Code:

```sh
claude plugin marketplace update MARKETPLACE_NAME --json
claude plugin update specification-guided-development@MARKETPLACE_NAME --scope local --json
```

Start a fresh session and check the executed runtime version and an MCP tool
call. Preserve activation settings and the old payload for recovery. A running
session may still serve its previous runtime.

A directory marketplace cannot download new release archives by itself. Claude
supports native auto-update for suitable remote marketplaces through `/plugin`,
**Marketplaces**, then **Enable auto-update**. Codex automatic delivery for this
local package path is not established.

## Check release metadata

```sh
node dist/cli.js update-status --host codex --channel alpha
```

Use `--host claude-code` for Claude. The MCP equivalent is `sgd_update_status`.
The check reads public release metadata and reports `update-available`, `current`,
`ahead`, or `unknown`. It does not install updates or schedule background work.
Its result describes the running runtime, not every installed or active session.

## Verify a package

`node scripts/verify-plugins.mjs` exercises independent copied packages through
MCP without requiring a neighboring checkout. This checks package execution,
not an installed agent's complete modeling workflow.

For native installation and cached upgrade, run each host separately:

```sh
node scripts/verify-native-plugin-lifecycle.mjs \
  --host codex --from /absolute/old-plugin --to /absolute/new-plugin \
  --out /absolute/new-evidence-directory
```

Use `--host claude-code` with its packages. This verifier requires the native
CLI, Git, Node.js, and Unix process tools. It does not support Windows.
Read [the verification boundaries](native-plugin-verification.md) before
interpreting a successful delivery check as application evidence.

## Resolve setup failures

- Missing runtime: build and package the checkout, then install the complete package.
- Platform mismatch: use a matching archive or rebuild on the target host.
- TLC failure: check Java, the JAR path, and the captured TLC log.
- Domain proof failure: check the supplied Lean 4.35.0 executable and proof diagnostics.
- Missing project: use absolute MCP paths; the server may run from a plugin cache.

Distribute the entire prepared plugin, including `runtime`. No global skill
links or shared configuration between Codex and Claude Code are required.
