# Native plugin delivery verification

The later [Parangsae native pilot](native-parangsae-pilot.md) records permanent installation of the public alpha and native MCP calls through both hosts. The disposable upgrade trials below retain their original scope.

## Observed scope

On 2026-10-24, the complete `0.2.0-alpha.1` candidate was tested against the actual public `0.1.0` packages on macOS arm64. The hosts were Codex CLI 0.163.0 and Claude Code 2.1.304. This record describes disposable native installations, not permanent Parangsae deployment or a public release announcement.

Both native hosts installed the old package through a Git marketplace, discovered it in a fresh process, and updated to the new package through the same marketplace ref. The publisher's working tree was hidden during discovery. The installed cache contained independent physical files matching the complete requested artifact, and its launcher executed the new runtime version. Neither trial removed and reinstalled the plugin to simulate an update.

Codex's fresh discovery connected the installed plugin identity to its cached skill. A separate fresh process started an ephemeral read-only thread and connected the upgraded plugin's declared MCP server. The server advertised `0.2.0-alpha.1`. Its native `sgd_inspect` call returned the complete expected v1 automaton, and a missing owned input returned an application tool error. No manual MCP configuration replaced the installed plugin declaration.

Claude's fresh installed inventory and component details identified its copied Git cache, selected version, skill, and MCP declaration. Claude's native MCP calls were not exercised by this verifier.

## Repeat the checks

Prepare complete old and new packages for the current host, then run the [native lifecycle verifier](plugins.md#check-native-installation-and-cached-upgrade) separately for each host. Keep its `result.json` outside the disposable trial tree. The input packages must have distinct versions and substantive executable differences. Artifact authenticity is the caller's responsibility.

The verifier uses Git's read-only smart HTTP backend. Before each native installation or refresh, independent full and depth-1 clones check the published ref, payload, and object connectivity. Native fetch counters and installed-cache checks distinguish actual delivery from catalogue recognition.

The package tests also exercise the extracted standalone marketplace preparer after removing its source checkout. Mismatched versions, malformed release versions, incompatible native declarations, symlinks, existing outputs, and changed source inputs are refused before installation. Malformed release metadata cannot replace either previously prepared runtime.

## Findings and remaining work

A disposable trusted-project experiment supplied only a project catalogue and plugin enablement. Codex displayed the package as enabled but uninstalled, and did not expose its skill. Project declarations alone did not install the plugin on the tested host. Use a native installation step before checking project activation.

An earlier Codex run failed during process-group shutdown with `EPERM`, and its original operation result was lost. The verifier now preserves operation and shutdown failures separately, records bounded RPC diagnostics, and serializes shutdown requests. A subsequent complete run passed. The earlier underlying shutdown cause remains unknown.

These disposable trials do not establish model inference, agent skill use, TLA+ authoring, completed TLC verification through the installed agent, executable authority, or sustainable Parangsae maintenance. Their MCP input was imported v1 diagnostic data. The later permanent pilot separately verifies Parangsae installation and Claude host-to-MCP operation. Existing Desktop session activation, a complete installed-agent workflow, and native Windows installation remain separate gates. Native startup egress and MCP subprocess isolation were not established. The [production goal](production-goal.md) remains incomplete.
