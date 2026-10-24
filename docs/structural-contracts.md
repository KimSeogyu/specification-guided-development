# Required structural contracts

Status: implementation design. No released command currently checks project contract closure.
The [development method](development-method.md) describes the current workflow requirements.
This design makes required relationships and missing enforcement machine-checkable.

## Purpose

A project can have passing leaf models while omitting a required owner, observation origin, or lifecycle relationship.
The root check must preserve those requirements and reject the incomplete project.
It must not infer system correctness from a collection of passing model runs.

Application policy remains in TLA+.
Project configuration locates model projects and native source bindings.
Configuration cannot declare an obligation checked or provide a second list of permitted business transitions.
The existing TLA+, TLC, DOT, typed automaton, generated constraints, and application pipeline remains authoritative.

## Separate declarations from evidence

A root TLA module declares required contracts, relationships, and acceptance properties.
A strict literal declaration profile supplies a contract graph.
Its nodes identify contracts, and its edges identify obligations.
An edge does not prove a relationship.

The metadata reader must resolve the declaration through SANY and reject unsupported expressions.
If it uses the existing synthetic metadata wrapper, report that run as metadata validation only.
The wrapper does not verify application behavior.

Each supported obligation must invoke a checker against controlled current inputs.
Unknown relationship kinds, missing bindings, and required unsupported semantics fail the root check.
No caller-supplied status, receipt, or deserialized IR can establish controlled build provenance.

## Preserve the accepted requirement

The candidate cannot define its own acceptance baseline and then claim requirement preservation.
The command may receive a baseline location, but that location alone does not establish independent selection or approval.
CI must select the expected baseline outside candidate-controlled configuration.
The report must distinguish a comparison against supplied inputs from a check against an independently selected baseline.
A supplied-baseline-only comparison cannot satisfy the requirement-preservation CI gate.

The baseline retains required contracts, required relationships, required native obligations, and the required properties of each contract.
Deleting an obligation from the candidate must leave it required by the baseline.
Required invariant and action-property definitions must remain present and selected in the candidate configuration.
For the initial supported profile, compare normalized lowered property expressions and their complete state tuple, then rerun the applicable checks.
Reject unsupported comparison rather than treating matching names or file hashes as semantic evidence.

An authorized requirement change can update the baseline through the repository's established review process.
Ordinary implementation fixes do not silently update their own expected outcome.

## Bind composition to controlled models

The existing `verifySymbolicErasure` checks enabled inputs, observable actions, and complete projected successors for supplied symbolic programs.
It does not establish their source or TLC provenance.
The root checker must obtain both programs through controlled SANY lowering, bounded TLC evidence, symbolic orbit checks, and the original-action oracle.
Retain the source/configuration/tool capture and recheck original inputs before publishing a result.

Acceptance must also cover properties erased by a projection.
For example, the existing erasure tests show that a payload projection can pass after removal of the concrete `ProvenanceStable` action property.
The projection does not establish that erased property.
If the baseline requires it, the root check must reject its removal even when payload erasure passes.

Property retention and candidate-to-candidate composition do not preserve accepted behavior by themselves.
For each baseline-required behavioral relation, compare the current model to the fixed baseline model through the supported enabled-input erasure checker.
Check the initial state, every enabled or disabled input class, action identity, and complete projected successor.
For example, changing `Insert` to a self-loop in both candidate models can preserve their invariants and mutual erasure while removing accepted insertion behavior.
The separate candidate-to-baseline relation must reject that change.
If the required mapping or temporal relation exceeds the supported profile, fail with the unsupported obligation.

Compiler-internal checked captures must not be constructible by importing JSON or setting a Boolean field.
Captured semantic data must remain immutable until the last source recheck and publication.
Use the common [artifact preparation boundary](artifact-contract.md) for generated reports and preserve captured evidence bytes.

## Keep native obligations visible

The first model-composition result establishes no application-wide ownership, scheduling, external effects, or persistence.
Those are modelable requirements whose native enforcement remains separate work.
Do not remove them from the root because the current compiler cannot discharge them.

A required native role without a source binding fails as missing.
A supplied binding outside the supported analyzer profile fails as unsupported.
A generated DTO, abstract resource event, visual containment edge, or unbound partition report cannot satisfy native authority.
New targets and reachable effects require independently discovered source closure before application-wide coverage can be reported.

## Acceptance cases

| Change or condition | Required result |
| --- | --- |
| Controlled abstract and concrete sources preserve all required properties and the supported input relation | Pass only the stated model-composition scope |
| A required leaf, relationship, or property is removed | Fail with its owning contract and baseline requirement |
| A required property retains its name but becomes `TRUE` | Fail the retained-property comparison |
| A required property is absent from the current TLC configuration | Fail before reporting the contract checked |
| Concrete provenance changes disable an otherwise enabled abstract input | Fail the relation check |
| An erased concrete property is removed while projection still passes | Fail the per-contract acceptance check |
| Both candidate models remove the same accepted behavior while retaining properties and mutual erasure | Fail the separate candidate-to-fixed-baseline relation |
| Raw IR or a stale receipt is substituted for a controlled build | Refuse it as provenance evidence |
| A source, configuration, project map, or tool changes before publication | Refuse publication |
| The candidate deletes a required native writer obligation | Keep the baseline obligation and fail |
| A native writer, scheduler, or persistence obligation lacks supported enforcement | Fail with the missing or unsupported obligation |
| A caller supplies another self-weakened baseline | Do not satisfy the requirement-preservation gate or claim independently accepted requirements were preserved |

Exercise these cases through the eventual public command and actual controlled model builds.
Pure schema tests cannot establish the workflow.
Retain TypeScript 7 and Rust consumer checks for any changed executable adapter.
Native plugin trials must then exercise model authoring, generation, implementation, inspection, and requirement maintenance under this root.

## Current implementation boundary

`compareRequiredSymbolicProperties` compares every invariant and action property selected in a supplied baseline symbolic program.
It requires unchanged lowered property expressions, the same state-variable set and input definitions, and retention of required deadlock checking.
The comparison deliberately rejects renaming and expression rewrites that need a separate equivalence proof.
It reports neither controlled source provenance nor behavioral refinement nor independent baseline selection.

Its focused tests use synthetic programs with the real existing erasure checker.
They reproduce correlated removal of insertion behavior and show why the separate fixed-baseline relation is necessary.
These tests do not establish controlled TLA+ execution, root closure, native binding, or the complete public workflow.

The internal `compareContractProjects` runner now reads root declarations through controlled SANY metadata validation and captures current baseline and candidate v3/v4 models.
It runs required property retention, candidate-to-baseline behavior comparison, and the declared candidate composition checks separately.
It rechecks project, binding, metadata, model, configuration, and tool inputs before returning.
Required missing or unsupported native obligations fail before the runner reports a composition result.

Pinned SANY/TLC integration tests cover a payload/envelope composition, removal of a selected property, undeclared baseline selectors, and missing or unsupported writer authority.
Captured-model tests additionally reject a self-loop replacement for insertion, forged evidence, and changed original inputs.
The result remains a supplied-baseline comparison, with `preservationGate` and `independentlySelectedBaseline` both `not-established`.
There is no public command, managed root-report publication, or protected CI baseline selector yet.
