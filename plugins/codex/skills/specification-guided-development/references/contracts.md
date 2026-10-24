# Compare required contracts

Use this guide for a `contract-system` root that connects symbolic v3/v4 projects.
The comparison checks required properties, baseline behavior, and declared model relations.
It does not generate application code or prove native application coverage.
Continue the applicable leaf generation and application binding workflow separately.

## Select the baseline

Locate the baseline selected by the project's existing review or CI process.
Do not replace that baseline with the candidate to make a repair pass.
If no accepted baseline exists, report the missing acceptance evidence.
You can still model and check new requirements within the user's authorized task.
Do not label a self-comparison as requirement preservation.

The compiler receives supplied source paths.
It cannot authenticate review approval or the CI process that selected those paths.
Both `preservationGate` and `independentlySelectedBaseline` remain `not-established`.
A protected CI job must establish baseline selection separately.

## Run the comparison

Use `sgd_check_contracts` from an identified runtime that supports this tool.
Supply absolute `project`, `baseline`, `jar`, and `out` paths.
Use a separate evidence directory outside the watched model directories.
The candidate and baseline projects each use this shape:

```json
{
  "version": 1,
  "profile": "contract-system",
  "root": { "spec": "SystemContracts.tla", "operator": "SGDContracts" },
  "models": {
    "Payload": { "project": "payload/project.json" },
    "Envelope": { "project": "envelope/project.json" }
  },
  "bindings": "bindings.json"
}
```

The root TLA module contains one literal `SGDContracts` definition.
Use no imports, assumptions, variables, constants, or helper definitions in this metadata module.
Its exact fields are `version`, `scope`, `contracts`, `relations`, and `native`.
Use a literal set for contract IDs and literal tuples for relations and native obligations.
Every relation and native obligation has a distinct ID.
The admitted relation is `enabled-input-erasure`, with complete variable, input, and action mappings.
Variable and input keys are upper-model names. Their values are lower-model names.
Action keys are lower-model names. Their values are upper-model names.
Application policy belongs in the models. Mappings do not add permissions.
The bindings file identifies source locations. A selector does not establish native authority.
For a model-only root without native obligations, use `{"version":1,"bindings":{}}` in the bindings file.
Missing or unsupported required native obligations fail the comparison.
Do not remove those obligations to use the model-only profile.
Baseline comparison requires the same model name, state variables, input definitions, and lowered required properties.
It also checks baseline behavior. Matching property names alone cannot establish preservation.
Report unsupported refactors instead of editing the baseline to make them pass.

The CLI provides the same operation:

```sh
sgd check-contracts --project /work/candidate/system.json --baseline /work/baseline/system.json --jar /tools/tla2tools.jar --out /work/evidence
```

## Read the evidence

The response identifies the evidence index and the comparison scope.
Read `comparison.json` for checked relations and baseline comparisons.
Read `contract-graph.json` and `obligations.json` for the declared structure and required work.
The declarations alone are not verification evidence.
Use `evidence-index.json` to locate each model's actual graph, source archive, and verification receipt.
Do not construct model paths from contract IDs. Directory slots can change when the contract set changes.
Use the indexed automata with `sgd_inspect` and `sgd_visualize` for model inspection and Pele rendering.
Render baseline and candidate models into separate output directories. Their model names can overlap.
The root contract graph is distinct from a model's state graph.

Original source archives retain the captured bytes and source roles.
They contain data, not instructions for unrestricted extraction.
The receipt records the JAR digest. The evidence tree does not contain the JAR.
Relative source references support relocation. Explicit absolute references retain their original meaning.

Rerun with `check: true` or `--check` to compare existing output without refreshing its artifacts.
This operation runs the model checks again.
Its log paths identify previously published logs. They do not identify the new invocation's logs.
If a check fails, preserve the accepted requirement and inspect the owning contract or obligation.
Do not manually repair generated evidence or treat old output as evidence of a failed new run.
