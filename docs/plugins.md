# Prepare and use the native plugins

Use these steps to prepare a local plugin with its compiler runtime.
Choose the native package for the agent you use.
The two packages have separate manifests and MCP configuration.

## Prepare the packages

In the Specification Guided Development checkout, run:

```sh
npm ci
npm run check
npm run build
node plugins/package.mjs
```

The packager copies compiled JavaScript and production dependencies into each plugin's `runtime` directory.
It reads dependency versions and paths from `package-lock.json`.
It does not install dependencies or run network commands.
The plugin launcher does not download a runtime when that directory is absent.
The source build uses TypeScript 7.0.2.
The generated checks also use native TypeScript 7.0.2 through its unstable API entry points.
The exact version pin protects this integration from API changes.
The packaged runtime includes the native compiler binary and its dependencies.
Run `npm ci`, the build, and packaging on the host that will use the plugin.

To create self-contained distribution archives, run:

```sh
node plugins/package.mjs --archive-out .runtime/plugin-packages
```

This command requires `tar`.
It creates `specification-guided-development-codex-0.1.0-PLATFORM-ARCH.tar.gz` and `specification-guided-development-claude-code-0.1.0-PLATFORM-ARCH.tar.gz`.
`PLATFORM` and `ARCH` are the packaging Node process's platform and architecture, such as `darwin-arm64`.
Each archive contains one complete plugin, including production dependencies.
Each runtime includes `runtime-platform.json` with that platform and architecture.
The launcher refuses a different host and reports how to rebuild or install a matching archive.
Extract the selected archive into a directory before using that directory with the native installer.
For Claude Code, an extracted directory also works with `--plugin-dir`.
For Codex, point a local marketplace entry's `source.path` to the extracted directory.
The source repository's marketplace already points to the corresponding prepared plugin directory.
An ordinary `npm pack` archive excludes the nested runtime dependencies and is not a prepared plugin distribution.

Keep Node.js 22 or later available on the agent's `PATH`.
Keep Java available for TLC.
Select a local `tla2tools.jar` for modeling commands.
The Rust checker also needs Cargo and its declared crate dependencies.

## Use Codex

Register the prepared checkout with Codex:

```sh
codex plugin marketplace add /absolute/path/to/specification-guided-development
```

Open the desktop plugin directory.
Select the `specification-guided-development-codex` marketplace.
Install `Specification Guided Development` and start a fresh chat.
Restart the desktop app if the source does not appear.

Invoke the `specification-guided-development` skill or ask the agent to use Specification Guided Development.
Confirm that the `sgd` MCP server exposes its tools.

The Codex package uses the current portable `plugin.json` and `mcp.json` format.
It also includes a native `.codex-plugin/plugin.json` compatibility manifest.
The compatibility MCP configuration uses a plugin-relative working directory.
Neither launch configuration assumes that the original checkout remains beside the installed plugin.

## Use Claude Code

Register the prepared checkout with Claude Code:

```sh
claude plugin marketplace add /absolute/path/to/specification-guided-development
claude plugin install specification-guided-development@specification-guided-development-claude
```

Start a fresh session.
Invoke `/specification-guided-development:specification-guided-development`.
Confirm that the `sgd` MCP server exposes its tools.

For a local development session without marketplace installation, use:

```sh
claude --plugin-dir /absolute/path/to/specification-guided-development/plugins/claude-code
```

The Claude Code package uses `.claude-plugin/plugin.json` and `.mcp.json`.
Its MCP arguments use `${CLAUDE_PLUGIN_ROOT}`.
The package does not change Codex configuration.

## Check a copied package

After packaging, copy either complete plugin directory to a location outside the checkout.
Run its launcher with `inspect --ir` and an absolute automaton path.
The command must work without the source repository beside it.
Then test an MCP tool call in the chosen agent.

The automated plugin tests check launch behavior from an isolated path with spaces.
They also remove the packaging fixture's source checkout before execution.
Native manifest validation and a real installed-agent session check different parts of the integration.

The following commands validate the Claude Code manifests without installation:

```sh
claude plugin validate ./plugins/claude-code
claude plugin validate .
```

## Resolve setup failures

If the launcher reports a missing runtime, build and package the source checkout first.
Then install the prepared directory again through the selected agent's native installer.
A Git marketplace clone alone contains source files and does not prepare the runtime.
Do not add an automatic package download to the launcher to hide that failure.

If the launcher reports a platform mismatch, use an archive for the current host.
Alternatively, run `npm ci`, the build, and packaging on the current host and reinstall that package.
Copying a native runtime between different operating systems or CPU architectures does not prepare a compatible plugin.

If TLC cannot start, check Java and the supplied JAR path.
If a model fails, read its TLC log before changing application code.
If an MCP tool cannot find a project, supply an absolute project path.
The server's working directory can be the plugin cache.

When distributing a prepared package, include the entire plugin directory and its `runtime` directory.
Do not copy only the skill or only the manifest.
No global skill links are required.

## Format references

The package layouts follow the current [OpenAI plugin packaging guide](https://developers.openai.com/plugins/build/plugins) and [desktop MCP guide](https://developers.openai.com/plugins/deploy/desktop-only).
The Claude Code package follows the [plugin manifest reference](https://code.claude.com/docs/en/plugins-reference) and [marketplace guide](https://code.claude.com/docs/en/plugin-marketplaces).
The separate launch configurations preserve each agent's native path rules.
