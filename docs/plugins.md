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
It does not run npm installation commands.
For v5 source bindings, it builds the locked Rust analyzer with Cargo and includes its host-native binary.
Cargo may fetch missing declared dependencies during source preparation.
The runtime also contains the analyzer dependency license records under `licenses/rust`.
The plugin launcher does not download a runtime when that directory is absent.
The source build uses TypeScript 7.0.2.
The generated checks also use native TypeScript 7.0.2 through its unstable API entry points.
The exact version pin protects this integration from API changes.
The packaged runtime includes the native compiler binary and its dependencies.
It includes `runtime/bin/sgd-rust-bindings` or the Windows `.exe` counterpart for Rust source analysis.
Source preparation therefore requires the Rust toolchain and Cargo.
Run `npm ci`, the build, and packaging on the host that will use the plugin.

To create self-contained distribution archives, run:

```sh
node plugins/package.mjs --archive-out .runtime/plugin-packages
```

This command requires `tar`.
It creates `specification-guided-development-codex-VERSION-PLATFORM-ARCH.tar.gz` and `specification-guided-development-claude-code-VERSION-PLATFORM-ARCH.tar.gz`.
`VERSION` is the root package version. The packager refuses mismatched native manifest, lockfile, or prepared runtime versions.
`PLATFORM` and `ARCH` are the packaging Node process's platform and architecture, such as `darwin-arm64`.
Each archive contains one complete plugin, including production dependencies.
Each runtime includes `runtime-platform.json` with that platform and architecture.
The launcher refuses a different host and reports how to rebuild or install a matching archive.
Extract the selected archive into a directory before using that directory with the native installer.
For Claude Code, an extracted directory also works with `--plugin-dir`.
For Codex, point a local marketplace entry's `source.path` to the extracted directory.
The source repository's marketplace already points to the corresponding prepared plugin directory.
An ordinary `npm pack` archive excludes the nested runtime dependencies and is not a prepared plugin distribution.

Since `0.2.0-alpha.3`, packaging also supports ZIP archives. The public alpha3 release contains two TAR archives, one Claude Code ZIP, and `release-manifest.json`.
To create ZIPs from a source checkout, run:

```sh
node plugins/package.mjs --archive-out .runtime/plugin-zip-packages --archive-format zip
```

This option requires `zip`. Use `unzip` for extraction. The ZIP fixtures also require it.
It produces a complete `.zip` archive for each host, with plugin files directly at the archive root, including hidden manifests and executable permissions.
Extract a Codex ZIP before using the existing local marketplace procedure.
TAR remains the CLI and `archivePlugins` API default.
Existing archive filenames are refused before CLI runtime preparation.
Each archive is published atomically without replacement. The host pair is not one atomic publication. Use a new output directory after a partial failure.
The staged Claude release feeds use immutable published ZIPs. Directory-source migration and an actual background auto-update remain unverified.

Each new archive includes a standalone marketplace preparation tool. After extracting the matching release, run the tool for your selected host:

```sh
node /absolute/extracted-plugin/scripts/prepare-marketplace.mjs \
	--host codex \
	--plugin /absolute/extracted-plugin \
	--out /absolute/new-marketplace
```

Use `--host claude-code` for the Claude Code package. The output parent must exist. The new output must be outside the extracted plugin.
The tool checks the complete package, native configuration, version, and platform, then copies it into a self-contained host-specific marketplace.
It refuses an existing output and prints the native installation commands. It does not install a plugin, change agent settings, or download a runtime.
The prepared marketplace works after the extracted source directory is removed. Keep the marketplace while using Claude's local in-place loading.

The preparer captures regular-file bytes, file permission bits, and the complete relative file and directory inventory.
Its read guard compares `dev`, `ino`, `mode`, `size`, and `mtimeNs` before opening a file, after opening it, and after reading it.
Every copy read must match the captured byte digest. After copying, the preparer repeats the complete capture and compares its guards, digests, and inventory.
Source-change diagnostics name one source-relative path and the changed fields, with the path limited to 180 characters.
The checks ignore `ctime` and extended attributes. Neither value is copied into the marketplace.
File writes request the captured `0777` permission bits. Directory creation requests `0755`. Both are subject to the process umask.
These checks detect ordinary changes at their observations. They do not establish continuous immutability or an atomic snapshot, and exclude a hostile concurrent filesystem owner.

Keep Node.js 22 or later available on the agent's `PATH`.
Keep Java available for TLC.
Select a local `tla2tools.jar` for modeling commands.
The Rust checker also needs Cargo and its declared crate dependencies.
Rust generation needs rustfmt for the fixed 2021 style configuration.
Its recorded formatter version is informational, while the style profile/configuration and generated bytes remain checked.
An installed native plugin uses its bundled analyzer instead of compiling source from a nearby checkout.
A v5 TypeScript-only build can use that binary without a Rust source-tool fallback.

## Use Codex

Register the prepared checkout with Codex:

```sh
codex plugin marketplace add /absolute/path/to/specification-guided-development
codex plugin add specification-guided-development@specification-guided-development-codex
```

You can supply a prepared marketplace directory instead of the prepared source checkout.
Start a fresh chat after installation.
The desktop plugin directory also exposes the `specification-guided-development-codex` marketplace and `Specification Guided Development` package.
Restart the desktop app if the source does not appear.

Invoke the `specification-guided-development` skill or ask the agent to use Specification Guided Development.
Confirm that the `sgd` MCP server exposes its tools.

The Codex package uses the current portable `plugin.json` and `mcp.json` format.
It also includes a native `.codex-plugin/plugin.json` compatibility manifest.
The compatibility MCP configuration uses a plugin-relative working directory.
Neither launch configuration assumes that the original checkout remains beside the installed plugin.

## Use Claude Code

### Use the macOS arm64 release feed

The alpha3 ZIP is public. The feed files in this change must merge into `main` before the following URL is live.
After that publication, run these commands from the application project root:

```sh
claude plugin marketplace add https://raw.githubusercontent.com/KimSeogyu/specification-guided-development/main/marketplaces/claude-code/alpha/darwin-arm64/marketplace.json --scope local
claude plugin install specification-guided-development@specification-guided-development-claude --scope local
```

For native auto-update opt-in, open `/plugin`, select **Marketplaces**, choose `specification-guided-development-claude`, and select **Enable auto-update**.
The plugin's local activation scope is separate from the native marketplace registry, which may be user-scoped.
Native archive downloads and the read-only release-status reminder are separate operations.
After a newer version is downloaded, run `/reload-plugins` or start a fresh session to load it. Existing-session replacement is a separate observation.
An actual SGD remote installation, directory-source migration, and background update have not yet been verified.

The pilot feed variant, [parangsae-marketplace.json](https://raw.githubusercontent.com/KimSeogyu/specification-guided-development/main/marketplaces/claude-code/alpha/darwin-arm64/parangsae-marketplace.json), retains `specification-guided-development@parangsae-sgd-claude` for the existing pilot.
Its migration remains pending, and the pilot remains on alpha2.
Use the registered marketplace's existing identity when planning a source change.
These feeds target macOS arm64. Codex native automatic delivery remains unestablished.

### Use a prepared source marketplace

For a source-prepared package on a supported host, register the prepared checkout with Claude Code:

```sh
claude plugin marketplace add /absolute/path/to/specification-guided-development --scope local
claude plugin install specification-guided-development@specification-guided-development-claude --scope local
```

Run these commands from the application project root. A prepared marketplace directory also works.
Local marketplace plugins load from that directory in place; this is distinct from a Git-backed copied plugin cache.
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

## Update an existing local marketplace

Use this procedure when an installed plugin comes from a directory marketplace.
A source merge or a new release download does not update that installed runtime.
Keep each host's registered marketplace name and qualified plugin ID unchanged.
Record the installed version and current user and project activation settings before changing them.

1. Download and extract the matching complete archive from the [public release](https://github.com/KimSeogyu/specification-guided-development/releases/tag/v0.2.0-alpha.3).
   Check the archive against that release's `release-manifest.json`.
   Run its standalone preparer into a new directory as described above. Its printed install commands are for a new installation.
2. Copy the complete prepared plugin, including its runtime, dependencies, and executable permissions, into a new version directory inside the existing marketplace:

	```text
	EXISTING_MARKETPLACE/releases/0.2.0-alpha.3/plugin/
	```

   Keep the previous payload unchanged. Refuse an occupied destination with different content.
3. Save the existing catalogue. Prepare a replacement in a sibling temporary file.
   In that temporary file, change only the selected entry's source and declared version:

	| Host | Catalogue inside the existing marketplace | Change |
	| --- | --- | --- |
	| Codex | `.agents/plugins/marketplace.json` | Set the selected `source.path` to `./releases/0.2.0-alpha.3/plugin`. |
	| Claude Code | `.claude-plugin/marketplace.json` | Set the selected `source` to `./releases/0.2.0-alpha.3/plugin` and its `version` to `0.2.0-alpha.3`. |

   Re-read the live catalogue before publication. If its bytes differ from your saved copy, stop and review the concurrent change.
   Publish the temporary file with an atomic rename in the same directory.
4. Run the selected host's native update from the application root. Replace `MARKETPLACE_NAME` with that host's existing registered name.

For Codex, `plugin add` enables the plugin at user scope on the tested CLI 0.163.0.
If your policy requires a disabled user default, run it only within a procedure that restores that policy after every attempted add, including a failed add.
The repair uses the native `config/value/write` API with a freshly read user-layer version and only the selected `plugins."specification-guided-development@MARKETPLACE_NAME".enabled` key.
The bundled preparer does not perform this scope repair.
Preserve the project's enablement and unrelated settings. Check the disabled user default and unrelated-project activation again afterward.
The observed procedure has a brief user-enabled window. Atomic installation with the user setting disabled has not been established.

```sh
codex plugin add specification-guided-development@MARKETPLACE_NAME --json
```

For Claude Code:

```sh
claude plugin marketplace update MARKETPLACE_NAME --json
claude plugin update specification-guided-development@MARKETPLACE_NAME --scope local --json
```

Start fresh native sessions after the update.
Check the installed skill, complete physical payload, and executed launcher version against the selected release.
For Claude's local loading, check `readFromFolder` and `folderVersion`.
Its cache `installPath` alone does not identify the executed source.
Confirm a successful native `sgd_inspect` call and an application error for a known absent input.
Check target-project activation and disabled activation outside that project separately.
Keep the old payload and catalogue for recovery. Native downgrade and automatic replacement of running servers remain unverified.

### Configure native auto-update

For a remote marketplace that can fetch complete packages, enable Claude Code's native auto-update through `/plugin`, **Marketplaces**, the selected marketplace, and **Enable auto-update**.
See [Claude Code's auto-update instructions](https://code.claude.com/docs/en/discover-plugins#turn-auto-update-on-or-off-for-a-marketplace).
The directory marketplace prepared above has no remote archive source. Its auto-update setting cannot download new SGD GitHub release archives.
Prepare the new payload and update its catalogue before requesting the native update.
Codex automatic updates for this delivery path remain unverified.

### Check public release metadata

The alpha3 release includes the read-only update check. Alpha2 runtimes do not contain it.
From a built source checkout, run:

```sh
node dist/cli.js update-status --host codex --channel alpha
```

Use `--host claude-code` for Claude Code. The equivalent MCP tool is `sgd_update_status` with `{ "host": "codex", "channel": "alpha" }`.
The `stable` channel selects stable releases. The `alpha` channel also includes alpha releases and stable promotions.
The check compares the running SGD version with public GitHub release and manifest metadata.
It returns `update-available`, `current`, `ahead`, or `unknown`, and reports whether metadata lists an archive for the running platform and architecture.
Network failure, timeout, rate limiting, invalid metadata, or a bounded response limit produces `unknown`. Continue modeling when the status is unknown.

This result describes the running runtime. Installed plugin inventory, existing Desktop sessions, archive contents, and the application's SDK pin need separate observations.
The check downloads metadata only and changes no installation or host settings.
The packaged skills request it once per conversation when the tool is available and mention a newer release once.
The check and reminder do not install an update or schedule a background job.
The staged remote catalogue points to the published Claude ZIP. Live-feed verification, native source migration, and observed background delivery remain separate pending gates.

## Check a copied package

After packaging, copy either complete plugin directory to a location outside the checkout.
Run its launcher with `inspect --ir` and an absolute automaton path.
The command must work without the source repository beside it.
Then test an MCP tool call in the chosen agent.

The automated plugin tests check launch behavior from an isolated path with spaces.
They also remove the packaging fixture's source checkout before execution.
Native manifest validation and a real installed-agent session check different parts of the integration.

`node scripts/verify-plugins.mjs` tests both independent copied caches through MCP.
It retains the v1 diagnostics, v2 finite owner, v3 single input, and v4 product-input checks.
The v5 case analyzes public Rust Fact source fixtures with the bundled native helper, then executes the generated closed DTO owners with packaged TypeScript 7.0.2.
It checks complete fields, native-derived schema equality, first receipt/source metadata, latest rejected metadata, input forgery rejection, the TLC input oracle, and Pele views.
The copied runtime contains no `tools/rust-bindings` source crate, so that successful build exercises the bundled helper.
These copied-cache fixtures do not establish actual installed-agent execution or completed Parangsae adoption.

## Check native installation and cached upgrade

The native lifecycle verifier uses genuine, distinct complete releases. Run each host separately:

```sh
node scripts/verify-native-plugin-lifecycle.mjs \
	--host codex \
	--from /absolute/extracted-old-codex-plugin \
	--to /absolute/extracted-new-codex-plugin \
	--out /absolute/new-evidence-directory
```

Use `--host claude-code` with the corresponding Claude packages. The evidence parent must exist.
The verifier requires the selected native CLI, Git, Node.js, and Unix process-group, `lsof`, `du`, and `df` support. Windows execution is explicitly unsupported by this verifier.
It creates an owned loopback Git marketplace and separate native configuration roots, installs the old release, and checks fresh native discovery.
The publisher uses Git's read-only smart HTTP backend and checks both full and shallow clones before native installation.
It then publishes the new artifact to the same Git ref, requests the native update, and checks the actual cached skill, runtime files, and executed CLI version.
It does not substitute remove/reinstall for an update.
The original publisher working tree is hidden during discovery. Native payloads must match the selected artifact and remain independent physical files.
The verifier stops its processes and server before removing its scratch tree. It retains scoped evidence outside that tree.

For Codex, the verifier also starts a fresh native process and an ephemeral read-only thread with approval policy `never`.
It checks the upgraded plugin's native MCP connection and executed server version, then calls `sgd_inspect` with valid and missing owned inputs.
A successful Codex result requires those calls to pass. Claude's native MCP operation remains a separate acceptance gate.
The verifier does not request model inference, authentication, or a real agent skill workflow.
Native startup network access is not measured. Separate configuration roots do not establish complete isolation from ordinary user-home reads.
The thread's policy does not establish filesystem isolation of MCP subprocesses.
Persistent Parangsae deployment and actual modeling workflows have separate acceptance gates.
Read the [native delivery verification record](native-plugin-verification.md) for observed host versions, outcomes, and remaining gates.

## Bind actual application rows

Use project v5 `row-owned` for the supported Rust source binding described in [source-bound complete rows](row-owned.md).
The project names the application root, library manifest, Fact definitions and accessible paths, excluded metadata, and paired model state roles.
The source analyzer derives payload Eq fields and finite u32 classes.
TLA+ supplies the guards and complete paired updates.
Generated result variants preserve the exact source action IDs. A configurable outcome-label map is rejected.
Those IDs do not prove business roles. Source action renames require exhaustive application matches to change, with erasure and native behavior checks retained.
The caller submits an actual audited Rust Fact or an authenticated portable TypeScript row token.

The TypeScript DTO represents exact raw field values from the Rust schema.
It does not analyze TypeScript application source or reproduce Rust Symbol/Qty/Amount constructor preconditions.
Equality and encoding parity apply to admitted native values.
The Rust adapter must remain a private application module beside the separate generated authority crate.
The production-library source profile and its trusted standard/default-registry macro dependencies do not establish all Cargo targets, filesystem permission, partition folding, or exclusive writers.

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
If v5 reports a missing analyzer, prepare and reinstall the complete host-native package.
If source-checkout v5 cannot prepare its fallback, inspect the Cargo diagnostic and toolchain/dependency availability.
If Rust generation reports a formatter failure, check rustfmt availability and retain the recorded profile/configuration.
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
