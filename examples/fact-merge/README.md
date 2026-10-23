# Fact-merge relation

`ManifestWrite.tla` and `ManifestWrite.cfg` preserve the original public Parangsae model from [`specs/tla/ManifestWrite.tla`](https://github.com/KimSeogyu/parangsae/blob/main/specs/tla/ManifestWrite.tla). The model describes one key: insert a payload, keep the original on equal or conflicting input, and replace the latest rejected payload on another conflict. It excludes received-time metadata and storage layout.

Build `project.json` with the v3 workflow in [the symbolic-owned guide](../../docs/symbolic-owned.md). The original configuration uses two model values. Native tests also supply a third actual string identity so the latest-rejected assignment cannot be inferred incorrectly from a two-value graph.

This example verifies a generated relation and owner. It does not establish that the Parangsae collector already uses them. An actual payload adapter, existing-state loading, partition rollback, and write-path coverage remain application work.
