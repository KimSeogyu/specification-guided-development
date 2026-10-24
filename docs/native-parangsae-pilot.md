# Native plugins in the Parangsae pilot

On 2026-10-24, Parangsae initially installed the public [v0.2.0-alpha.1 release](https://github.com/KimSeogyu/specification-guided-development/releases/tag/v0.2.0-alpha.1) through Codex CLI 0.163.0 and Claude Code 2.1.304 on macOS arm64. This record separates that installation and staged Claude workflow from the later alpha2 upgrade and fresh native verification.

## Observed alpha1 installation and tool operation

| Host | Loaded package | Activation | Native tool result |
| --- | --- | --- | --- |
| Codex | The installed cache matched the complete released package and executed runtime version `0.2.0-alpha.1`. | A fresh Parangsae process discovered the installed skill. The project enabled the plugin, while the user default and an unrelated project kept it disabled. | The declared MCP server reported `0.2.0-alpha.1`. `sgd_inspect` returned the complete expected project IR and an application error for a known absent input. |
| Claude Code | The local marketplace loaded its complete package in place. The installed record, folder, and executed runtime identified `0.2.0-alpha.1`. | The native installer enabled the plugin with `--scope local` in Parangsae. An unrelated project kept it disabled. | A fresh model session made two `sgd_inspect` calls through the installed server. Actual tool results matched the complete project IR and the expected missing-file error. The trial exited successfully. |

Both hosts used the installed plugin's MCP declaration. No manual MCP configuration replaced it. Claude's in-place loading is separate from a copied Git cache. The [earlier delivery trials](native-plugin-verification.md) cover distinct-version upgrades in disposable installations. The later permanent upgrade is recorded separately below.

Existing application source, the project SDK pin, CI, and branch protection were unchanged by this deployment. Unrelated user settings and the existing concurrency configuration were preserved. The plugin release and the application's pinned SDK remain separate identities.

## Interventions and session boundary

An unfiltered Codex MCP status request timed out. A fresh probe used the supported `serverName` filter to query only SGD and passed. Other MCP servers remained enabled. The successful filtered query does not explain the original timeout.

A private probe omitted its helper for reading an absent file. After adding the helper, a fresh probe passed the existing-IR and missing-input checks. The released packages were unchanged.

The native Codex installer briefly enabled the user setting before a version-checked write disabled that setting. Final observations confirmed the disabled user default and the enabled project setting. This procedure does not establish an atomic installation that never enables the user setting.

The Parangsae owning chat initially reported no SGD MCP tools in its existing Desktop session after installation. Before the alpha2 upgrade, that owner later reported six SGD tools, a loaded alpha1 skill, and a successful `sgd_inspect` call in the existing chat. These are owner-reported Desktop observations, received without inspecting that chat's registry. They establish reported pre-upgrade tool access. The existing Desktop chat's alpha2 serving version remains unobserved.

## Staged Claude workflow through the installed plugin

On the same date, Claude invoked the installed SGD skill to author `Architecture.tla`, `ReleaseGate.tla`, their configurations, three binding projects, and TypeScript and Rust consumers in a dedicated trial directory. The installed MCP server ran real TLC, generated architecture checks and finite owners, inspected their IR, and produced Pele output. Before running the consumers, the coordinating reviewer read the authored models, bindings, source, and manifest.

The reviewed consumers retained genuine generated owners and delegated reads and events to them. Independent behavior oracles drove the compiled TypeScript 7.0.2 and Rust consumers. Checks covered allowed and forbidden dependencies, direct and aliased writes, and snapshot independence. TypeScript owner authentication and Rust privacy failures were also checked. These results concern the trial's admitted source and finite-state boundaries.

In the baseline, `Review` followed by `Publish` succeeded. The requirement change made `Publish` require both review and sealing. That change edited only `ReleaseGate.tla`; regeneration updated both language owners. The same consumer sequence then rejected `Publish` without changing the complete snapshot or revision. Both languages matched the independent oracle. Native check-only builds also rejected a tampered generated copy and stale output after the model change with `TLC104`.

A separate fresh native session invoked the skill, inspected the changed models, regenerated Pele output, and completed all three check-only builds. The source and generated constraints remained unchanged. This completed the missing final checks after the failed change attempt described below. The baseline browser review distinguished projected diagnostic states from exact owner valuations. The v1 child displayed containment while the v2 owner appeared separately because its profile has no parent field. Displayed containment links are structural and do not prove refinement. Call auditing and additive native permissions defined the trial boundary.

### Required interventions

TypeScript compilation first reported `TS2307` for an import of nonexistent generated `dist/machine.js`. A native repair changed only the import to existing generated source. The strict Rust architecture checker then rejected `#[derive(Default)]` with `TLC002`. A native repair supplied an explicit `Default` implementation with the same empty journal behavior. No checker permission was relaxed.

The coordinating agent repaired the trial helpers to retain stdout-only checker diagnostics and record refused-tool metadata before stopping a session. During changed-model authoring, the supervisor stopped an unexpected tool attempt after controlled regeneration. The original recorder omitted the tool's name. Its identity and cause remain unknown, and that attempt remains failed. The later read-only recheck is separate evidence. The workflow required these interventions. Single-pass reliability remains unestablished.

## Upgrade to alpha2 and fresh native verification

Later on the same date, both permanent installations updated to the public [v0.2.0-alpha.2 release](https://github.com/KimSeogyu/specification-guided-development/releases/tag/v0.2.0-alpha.2) through their existing directory catalogues and plugin identities. Complete alpha2 sources were placed in new version directories. The alpha1 sources and trial evidence were retained.

The first attempt completed the Codex native add and Claude marketplace refresh and local plugin update. Its result remains incomplete because both verification steps failed. Codex's cache changed only the `runtime` directory mode from `0700` to `0755`. All file bytes and other modes matched the release. The Claude health check did not recognize the native success marker and required an entrypoint path that the health output did not expose. These verification findings required explicit corrections.

A second attempt reused the installed alpha2 packages and unchanged catalogues. It performed no native add or update and passed fresh verification through both hosts. The first incomplete result remains preserved.

| Host | Fresh package and serving evidence | Native tool result |
| --- | --- | --- |
| Codex | The complete cache passed a reviewed acceptance profile allowing only the `runtime` directory mode change. The installed skill and executed launcher identified alpha2. The declared MCP server reported `serverInfo.version = 0.2.0-alpha.2`. | `sgd_inspect` returned the complete expected project IR and an application missing-file error for a known absent input. |
| Claude Code | The complete in-place payload matched the release. `readFromFolder`, folder version, and executed launcher identified alpha2. A fresh native session identified the exact new plugin path and its declared MCP command. The MCP initialization version was not directly observed. | The fresh native session made actual `sgd_inspect` calls that matched the complete project IR and the expected missing-file application error. |

Final observations confirmed target-project activation for both hosts, a disabled Codex user default, and disabled activation in an unrelated project. Application source, SDK pin, CI, protection, unrelated settings, the concurrency limit of 12, and the original project IR were preserved. Both attempts closed their owned native process groups. Codex's brief user-enabled window remains a limitation.

A separate feature check used both actual installed payloads through direct CLI and stdio MCP execution. A fresh imported-DOT v1 fixture produced matching structured `TLC104` diagnostics, retained the CLI failure and MCP error, and left generated payloads unchanged. This fixture ran no TLC. The generated Pele script preserved complete model and transition content and exercised initial fit, model switching, per-view manual zoom, and resize behavior in a VM DOM harness. Agent-directed feature use and browser rendering were outside that check.

The alpha1 methodology trial retains its original version, interventions, failed attempt, and separate final recheck. The alpha2 upgrade and feature probes do not establish a complete alpha2 development workflow or actual application feature maintenance.

## Alpha3 release and pending delivery

The public [v0.2.0-alpha.3 release](https://github.com/KimSeogyu/specification-guided-development/releases/tag/v0.2.0-alpha.3) adds read-only release awareness and ZIP packaging. Its macOS arm64 assets are the Codex TAR, Claude Code TAR, Claude Code ZIP, and release manifest. The published tag and downloaded assets matched the frozen candidate. Neither pilot installation has been upgraded from alpha2 to alpha3.

The first alpha3 preparation attempt failed when the bundled Codex TAR preparer reported that its input source had changed. The underlying cause remains unobserved. The unchanged archive bytes then passed a separate fresh validation of each archived package, including unmodified preparers, strict complete payload and mode comparisons, and copied-runtime operation. The original copied-plugin suite result was retained rather than rerun. The first failure remains recorded, and single-pass preparation reliability is unestablished.

The [remote feed files](plugins.md#use-the-macos-arm64-release-feed) are staged for publication on `main` and point to the genuine public Claude ZIP. The pilot variant preserves its existing marketplace name and qualified plugin ID. Their public URLs become live only after the feed change merges. Live-feed verification, directory-to-remote migration, native alpha3 operation, and a genuine background update remain pending. The existing Desktop chat's serving version remains a separate observation.

## Remaining acceptance

The complete installed-Codex modeling and development workflow remains untested. The staged Claude trial uses a separate example inside the pilot workspace. It does not establish an actual Parangsae feature change or continued maintenance.

The consumer supplied the following maintenance feedback. Alpha2 addresses the diagnostic part of C1. The remaining acceptance requirements stay separate.

| Item | Remaining acceptance |
| --- | --- |
| C1: Explain stale provenance | Alpha2 reports affected artifacts, changed recorded sources, and generated-source byte status. An explicit receipt-only refresh remains unimplemented and requires current source and model verification to prove semantic generation unchanged. Fact, equality, key, and model changes must retain their checks. |
| C2: Separate run evidence | Avoid tracked TLC log changes caused only by process IDs, times, and temporary paths. Export fresh invocation receipts and actual logs separately. Readonly verification must identify its new evidence without presenting retained historical logs as fresh. |
| C3: Identify the serving runtime | Distinguish declared SDK, resolved SDK, discovered plugin, installed plugin, current-session activity, fresh-session activity, runtime identity, and actual tool results. Report unknown states when evidence is missing. This pilot's local status records do not provide a public doctor command. |
| C4: Show the checked boundary | Identify the four source-bound Fact families and their closed fold. Separate declared architecture policy from checked behavior. Show physical IO, writer ownership, composite application state, journal round trips, and unanalyzed targets or features outside that Fact contract. |
| C5: Preserve fixed integration behavior | The consumer already fixed the exported TypeScript package entry point and stdout-only child diagnostics. Retain packaged regression coverage for those cases. They are not open SDK defects. |
| C6: Summarize successful tool calls | Return output paths and verification summaries by default from model/build. Provide the complete IR through explicit detail or inspect. Preserve access to the underlying evidence. |
| C7: Classify TLC failures | Preserve failure behavior and logs. Report a structured failure kind, invariant name, and trace path when actual TLC evidence supports them. Distinguish invariant violation, timeout, parsing failure, and unknown failure. |
| C8: Diagnose Rust crate placement | Diagnose unsupported standalone Cargo placement before publishing generated output. Guide output selection without edits to generated manifests. Distinguish literal configured member prefixes from glob-selected members, current dependency-graph validation from prospective placement restrictions, and preserve supported workspace modes. |

C6, C7, and C8 source changes are being developed separately and are not included in alpha3. The C8 Cargo 1.92 reproducer failed when a standalone generated crate under a literal configured member prefix became a consumer path dependency, despite an exact root exclude. The corresponding glob-member and exact-exclude case succeeded. Before that dependency was connected, the consumer workspace metadata also succeeded. Check the consumer workspace after connecting the actual dependency. Metadata for the generated crate alone does not establish consumer integration. The demonstrated issue concerns Cargo placement and a missing early diagnostic.

The consumer also reported a local SDK installation that differed from its lockfile while retaining the same package version. Version equality alone did not identify the resolved source. This observation supports C3 and is not attributed to an SDK defect.

C1 diagnostics and automatic Pele fitting were released in alpha2 after the staged alpha1 workflow. The installed package was unchanged throughout that earlier trial.

The released [alpha3 update check](plugins.md#check-public-release-metadata) and once-per-conversation skill reminder inspect public metadata for the running runtime. They provide no installed-plugin or Desktop inventory and do not update the pilot. Its current directory catalogues cannot fetch new archives by themselves. The staged remote feeds and public ZIP enable the next delivery trials. Source migration and actual background delivery remain unverified. Codex native auto-update remains unestablished.

The consumer's composite-state and journal findings belong to the application team and fall outside the Fact-fold contract. This deployment grants no new all-target coverage, storage authority, persistence guarantee, or effect atomicity. Continued feature, requirement-change, and defect-fix trials remain necessary. The [production goal](production-goal.md) is incomplete.
