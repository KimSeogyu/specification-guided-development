# Native plugin delivery verification

Use the [native lifecycle verifier](plugins.md#verify-a-package)
to test old and new prepared packages through each host's own installation and
update commands. Test Codex and Claude Code independently.

Confirm that a fresh host process discovers the requested cached plugin and
executes its launcher. Test the installed MCP declaration with a valid tool call
and an invalid input. Installation, version discovery, MCP transport, and an
agent completing a model-driven development task are separate checks.

Use disposable configuration roots and keep authentication out of collected
logs. Do not copy credentials or change ordinary agent settings as an incidental
part of a test. Stop owned processes before removing their test directories.
Separate roots do not establish complete home-directory or network isolation.

A delivery check does not prove model adequacy, generated enforcement, automatic
updates in an existing session, or successful application maintenance. Report
only the workflow actually executed for the release under test.
