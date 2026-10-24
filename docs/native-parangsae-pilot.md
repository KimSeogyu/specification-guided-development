# Native plugins in the Parangsae pilot

On 2026-10-24, Parangsae installed the public [v0.2.0-alpha.1 release](https://github.com/KimSeogyu/specification-guided-development/releases/tag/v0.2.0-alpha.1) through Codex CLI 0.163.0 and Claude Code 2.1.304 on macOS arm64. The packages remain installed for project use. This record covers installation, project activation, native MCP calls, and a staged workflow through the installed Claude skill.

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

## Staged Claude workflow through the installed plugin

On the same date, Claude invoked the installed SGD skill to author `Architecture.tla`, `ReleaseGate.tla`, their configurations, three binding projects, and TypeScript and Rust consumers in a dedicated trial directory. The installed MCP server ran real TLC, generated architecture checks and finite owners, inspected their IR, and produced Pele output. Before running the consumers, the coordinating reviewer read the authored models, bindings, source, and manifest.

The reviewed consumers retained genuine generated owners and delegated reads and events to them. Independent behavior oracles drove the compiled TypeScript 7.0.2 and Rust consumers. Checks covered allowed and forbidden dependencies, direct and aliased writes, and snapshot independence. TypeScript owner authentication and Rust privacy failures were also checked. These results concern the trial's admitted source and finite-state boundaries.

In the baseline, `Review` followed by `Publish` succeeded. The requirement change made `Publish` require both review and sealing. That change edited only `ReleaseGate.tla`; regeneration updated both language owners. The same consumer sequence then rejected `Publish` without changing the complete snapshot or revision. Both languages matched the independent oracle. Native check-only builds also rejected a tampered generated copy and stale output after the model change with `TLC104`.

A separate fresh native session invoked the skill, inspected the changed models, regenerated Pele output, and completed all three check-only builds. The source and generated constraints remained unchanged. This completed the missing final checks after the failed change attempt described below. The baseline browser review distinguished projected diagnostic states from exact owner valuations. The v1 child displayed containment while the v2 owner appeared separately because its profile has no parent field. Displayed containment links are structural and do not prove refinement. Call auditing and additive native permissions defined the trial boundary.

### Required interventions

TypeScript compilation first reported `TS2307` for an import of nonexistent generated `dist/machine.js`. A native repair changed only the import to existing generated source. The strict Rust architecture checker then rejected `#[derive(Default)]` with `TLC002`. A native repair supplied an explicit `Default` implementation with the same empty journal behavior. No checker permission was relaxed.

The coordinating agent repaired the trial helpers to retain stdout-only checker diagnostics and record refused-tool metadata before stopping a session. During changed-model authoring, the supervisor stopped an unexpected tool attempt after controlled regeneration. The original recorder omitted the tool's name. Its identity and cause remain unknown, and that attempt remains failed. The later read-only recheck is separate evidence. The workflow required these interventions. Single-pass reliability remains unestablished.

## Remaining acceptance

The complete installed-Codex modeling and development workflow remains untested. The staged Claude trial uses a separate example inside the pilot workspace. It does not establish an actual Parangsae feature change or continued maintenance.

The consumer supplied the following maintenance feedback. These are acceptance requirements, not features delivered by this release.

| Item | Remaining acceptance |
| --- | --- |
| C1: Explain stale provenance | Identify the changed application source and affected contracts. Distinguish changed generated code from unchanged code with stale receipts. Permit an explicit receipt-only refresh only after current source and model verification proves semantic generation unchanged. Fact, equality, key, and model changes must retain their checks. |
| C2: Separate run evidence | Avoid tracked TLC log changes caused only by process IDs, times, and temporary paths. Export fresh invocation receipts and actual logs separately. Readonly verification must identify its new evidence without presenting retained historical logs as fresh. |
| C3: Identify the serving runtime | Distinguish declared SDK, resolved SDK, discovered plugin, installed plugin, current-session activity, fresh-session activity, runtime identity, and actual tool results. Report unknown states when evidence is missing. This pilot's local status records do not provide a public doctor command. |
| C4: Show the checked boundary | Identify the four source-bound Fact families and their closed fold. Separate declared architecture policy from checked behavior. Show physical IO, writer ownership, composite application state, journal round trips, and unanalyzed targets or features outside that Fact contract. |
| C5: Preserve fixed integration behavior | The consumer already fixed the exported TypeScript package entry point and stdout-only child diagnostics. Retain packaged regression coverage for those cases. They are not open SDK defects. |

The consumer also reported a local SDK installation that differed from its lockfile while retaining the same package version. Version equality alone did not identify the resolved source. This observation supports C3 and is not attributed to an SDK defect.

Work on C1 diagnostics and automatic Pele fitting remains separate and unreleased. The installed alpha package was unchanged throughout the staged workflow.

The consumer's composite-state and journal findings belong to the application team and fall outside the Fact-fold contract. This deployment grants no new all-target coverage, storage authority, persistence guarantee, or effect atomicity. Continued feature, requirement-change, and defect-fix trials remain necessary. The [production goal](production-goal.md) is incomplete.
