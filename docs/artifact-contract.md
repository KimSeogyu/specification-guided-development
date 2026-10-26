# Generated artifact ownership

Backend functions return draft files. Controlled builds prepare an immutable
batch before freshness checking or publication. The publication path rejects
unregistered batches.

Compiler output and captured evidence have different roles. Captured DOT,
SANY XML, oracle output, and logs retain their original bytes. Preparation
must not rewrite evidence and then present it as the original capture.

Before publication, the build rechecks the project, model inputs, source
bindings, and physical output paths. Managed output owns only its inventoried
files. See [managed output](managed-output.md) for concurrent writers, recovery,
symlinks, and refusal behavior.

`--check` compares the prepared output with published bytes. It does not edit
the published files to make them pass. Artifact preparation establishes no
additional model authority, application coverage, or effect permission.
