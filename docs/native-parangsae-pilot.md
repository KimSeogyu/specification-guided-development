# Native plugins in the Parangsae pilot

On 2026-10-24, Parangsae installed the public [v0.2.0-alpha.1 release](https://github.com/KimSeogyu/specification-guided-development/releases/tag/v0.2.0-alpha.1) through Codex CLI 0.163.0 and Claude Code 2.1.304 on macOS arm64. The packages remain installed for project use. This record covers installation, project activation, and native MCP calls against existing project data.

## Observed installation and tool operation

| Host | Loaded package | Activation | Native tool result |
| --- | --- | --- | --- |
| Codex | The installed cache matched the complete released package and executed runtime version `0.2.0-alpha.1`. | A fresh Parangsae process discovered the installed skill. The project enabled the plugin, while the user default and an unrelated project kept it disabled. | The declared MCP server reported `0.2.0-alpha.1`. `sgd_inspect` returned the complete expected project IR and an application error for a known absent input. |
| Claude Code | The local marketplace loaded its complete package in place. The installed record, folder, and executed runtime identified `0.2.0-alpha.1`. | The native installer enabled the plugin with `--scope local` in Parangsae. An unrelated project kept it disabled. | A fresh model session made two `sgd_inspect` calls through the installed server. Actual tool results matched the complete project IR and the expected missing-file error. The trial exited successfully. |

Both hosts used the installed plugin's MCP declaration. No manual MCP configuration replaced it. Claude's in-place loading is separate from a copied Git cache. The [earlier delivery trials](native-plugin-verification.md) cover distinct-version upgrades in disposable installations. This operational installation does not establish a later upgrade in the permanent pilot.

Existing application source, the project SDK pin, CI, and branch protection were unchanged by this deployment. Unrelated user settings and the existing concurrency configuration were preserved. The plugin release and the application's pinned SDK remain separate identities.

## Interventions and session boundary

An unfiltered Codex MCP status request timed out. A fresh probe used the supported `serverName` filter to query only SGD and passed. Other MCP servers remained enabled. The successful filtered query does not explain the original timeout.

A private probe omitted its helper for reading an absent file. After adding the helper, a fresh probe passed the existing-IR and missing-input checks. The released packages were unchanged.

The native Codex installer briefly enabled the user setting before a version-checked write disabled that setting. Final observations confirmed the disabled user default and the enabled project setting. This procedure does not establish an atomic installation that never enables the user setting.

The Parangsae owning chat checked its existing Desktop session after installation and reported no SGD MCP tools. The SDK chat received that report without inspecting the other chat's registry. No inspect call, new task, or restart was part of the check. That session had no SGD MCP tool access at the time, while fresh native CLI operation passed. A later Desktop refresh remains unverified.

## Remaining acceptance

The native calls read existing IR. They did not author a new TLA+ model, complete a new TLC run, generate constraints, develop under those constraints, or inspect Pele through the installed-agent workflow. That complete workflow remains required for both native plugins.

The consumer supplied the following maintenance feedback. These are acceptance requirements, not features delivered by this release.

| Item | Remaining acceptance |
| --- | --- |
| C1: Explain stale provenance | Identify the changed application source and affected contracts. Distinguish changed generated code from unchanged code with stale receipts. Permit an explicit receipt-only refresh only after current source and model verification proves semantic generation unchanged. Fact, equality, key, and model changes must retain their checks. |
| C2: Separate run evidence | Avoid tracked TLC log changes caused only by process IDs, times, and temporary paths. Export fresh invocation receipts and actual logs separately. Readonly verification must identify its new evidence without presenting retained historical logs as fresh. |
| C3: Identify the serving runtime | Distinguish declared SDK, resolved SDK, discovered plugin, installed plugin, current-session activity, fresh-session activity, runtime identity, and actual tool results. Report unknown states when evidence is missing. This pilot's local status records do not provide a public doctor command. |
| C4: Show the checked boundary | Identify the four source-bound Fact families and their closed fold. Separate declared architecture policy from checked behavior. Show physical IO, writer ownership, composite application state, journal round trips, and unanalyzed targets or features outside that Fact contract. |
| C5: Preserve fixed integration behavior | The consumer already fixed the exported TypeScript package entry point and stdout-only child diagnostics. Retain packaged regression coverage for those cases. They are not open SDK defects. |

The consumer also reported a local SDK installation that differed from its lockfile while retaining the same package version. Version equality alone did not identify the resolved source. This observation supports C3 and is not attributed to an SDK defect.

The consumer's composite-state and journal findings belong to the application team and fall outside the Fact-fold contract. This deployment grants no new all-target coverage, storage authority, persistence guarantee, or effect atomicity. Continued feature, requirement-change, and defect-fix trials remain necessary. The [production goal](production-goal.md) is incomplete.
