# Native plugin delivery verification

The later [Parangsae native pilot](native-parangsae-pilot.md) records permanent installation of the public alpha and native MCP calls through both hosts. The disposable upgrade trials below retain their original scope.

## Alpha3 to alpha4 checkpoint — 2026-10-25

The public alpha3 and alpha4 TAR artifacts were checked against their release manifests, then exercised through the native lifecycle verifier on macOS arm64. The observed hosts were Codex CLI 0.163.0 and Claude Code 2.1.304.

Both hosts installed alpha3 through an owned loopback Git marketplace, fetched the changed alpha4 payload through native update commands, and discovered alpha4 in a fresh process. The cached skill and runtime were independent physical files matching the requested artifact. Their cached launchers executed version `0.2.0-alpha.4`. Neither trial used removal and reinstallation as a substitute for an update.

Codex additionally connected the installed alpha4 MCP declaration in an ephemeral native thread. Its valid inspect call returned the expected complete imported v1 model, and a missing input returned a tool error. This was a host-to-installed-MCP test. It did not request model inference or ask an agent to author a specification.

The Claude trial establishes native installation, cached upgrade, component discovery, and executed launcher version. It does not establish a Claude host-to-MCP call or an agent development workflow. Selected ordinary settings files were observed unchanged across the Claude run. Both trials stopped their owned processes and loopback servers before removing their disposable directories. Separate native storage does not prove complete isolation from ordinary home reads or startup network access.

Separate persistent trial environments now have alpha4 installed for the next agent workflow. Read-only status checks found that authentication from ordinary profiles did not carry into fresh configuration roots. The user then explicitly authorized copying existing authentication into those private trial configurations. Both native clients now report a logged-in state. Credential values were not included in evidence or source control. A subsequent read-only Codex model session read the installed SGD skill and its modeling reference, inspected the supplied legacy model, and invoked the installed `sgd_update_status` exactly once. Its response identified alpha4, and project inputs remained unchanged. This session did not author code or run TLC. The corresponding Claude session connected the installed SGD server but was refused by a provider usage limit before the requested model workflow completed; that attempt remains failed. Their installation is not a claim that the ordinary Parangsae plugin or its serving Desktop session was upgraded.

The [1.0 readiness gates](one-point-zero.md) still require actual installed-agent feature, requirement-change, and defect-maintenance work. Successful delivery and transport checks do not close that gate.

## Earlier observed scope

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
