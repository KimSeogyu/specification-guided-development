---
name: specification-guided-development
description: Define domain behavior in TLA+, generate TypeScript code with checked state and port contracts, and develop against those contracts.
---

# Specification guided development

Read the user's requirements and identify the state, ownership, inputs, and effects that determine correctness. Keep the requirements independent of the implementation being checked. State the model's assumptions and finite bounds.

## Choose the contract

- For a TypeScript domain with injected async ports, read [domain generation](references/domain-code.md). Copy [the project](references/domain-project.json), [model](references/Approval.tla), and [configuration](references/Approval.cfg) into the application before adapting them.
- For ordinary finite state owners or symbolic inputs, read [modeling](references/modeling.md). Generation targets TypeScript.
- For a synchronous callback that must retain its payload, use [retained operations](references/retained-operation.md).
- For a supplied baseline, use [contract comparison](references/contracts.md). Do not weaken the baseline to make a change pass.

Keep policy in the model. Bindings identify model actions, code locations, and port names; they do not supply a second transition table. Preserve every state distinction needed by a requirement. Report missing input/effect bindings rather than treating them as verified.

## Generate and develop

Use `sgd_build` with absolute project, pinned TLC JAR, and separate output paths. Domain generation also requires the absolute path to Lean 4.35.0 in `lean`. Missing tools or failed checks must stop generation. Imported DOT supports diagnostics only, not executable state authority.

The domain build runs TLC and checks its finite port protocol in Lean before publishing TypeScript. Pending states admit only their operation's actual completion. Injected function fulfillment selects success; rejection selects failure. Do not expose completion actions or duplicate the owned state in application code.

Use the generated interfaces in the application. Change the model and regenerate when the required policy changes. Use `check: true` to verify generated files are current. Test the actual adapter and caller behavior, including rejected operations and failures.

The tools return summaries by default. Use `sgd_inspect` or `detail: "full"` only when the complete IR is needed. Use `sgd_visualize` for the same model's graph; a visualization link is not a refinement proof.

## Report scope accurately

TLC covers the configured model. Lean's domain check covers the finite serial port protocol. Neither proves the native TypeScript compiler, arbitrary application coverage, persistence, or adapter effect correctness. Opaque port inputs do not automatically update model variables. Fresh factories create distinct live owners.

Bend is a source-checkout experiment for a pure transition core. It is not an installed-plugin generation target or a private owner/DI implementation.

## Runtime version

Once per conversation, call `sgd_update_status` with `{ "host": "codex", "channel": "alpha" }` if available. Mention a newer release once, then continue. This reports the running runtime, not what an existing session has installed, and does not authorize an update or settings change.
