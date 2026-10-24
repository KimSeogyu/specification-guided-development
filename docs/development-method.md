# Development under compiled model checks

The method uses a compiler to carry decisions from a TLA+ model into generated state ownership and source checks.
The agent models the requested system, inspects TLC's result, and integrates the generated contract.
The goal is to keep applicable constraints active as the implementation changes.

## Establish structure from the root

Read the request, accepted requirements, and existing root structure before feature implementation.
Establish missing top-level contracts before implementing the feature.
Model required ownership, responsibility, time, information, and resource lifecycles as state.
Follow those responsibilities into lower-level models and their application bindings.

For a change, derive the affected model closure from that root.
Include enclosing acceptance properties, participating actors, input origins, resources, and code bindings.
Limit the work through that structure without omitting enclosing responsibilities.
An isolated state enum cannot establish a responsibility or lifecycle that it does not represent.

Abstraction must retain every distinction required by an accepted property.
Record the assumptions and finite bounds that support the abstraction.
Algorithms, data structures, and internal organization remain open within that contract and its assumptions.
The method does not require TLA+ to enumerate unrelated implementation details.

Record the relations between models and the evidence for each relation.
Missing structure and unsupported enforcement are coverage gaps.
They do not become irrelevant because the current compiler cannot check them.
Expand compiler support or report the gap explicitly.

## Architecture and behavior need different questions

Architecture asks which component may depend on another component.
A dependency model can make the permitted direct edges explicit.
The compiler can then check imports between mapped code locations.

Behavior asks which state changes are permitted and under which conditions.
A behavior model can include retries, failures, and concurrent actors.
TLC checks invariants over the selected finite scope.
Project v2 `finite-owned` retains every supported scalar variable and generates an authority that dispatches from its actual concrete state. Use it when the application can obtain modeled state from this owner. Read [its contract and integration limits](finite-owned.md).
The v1 transition binding preserves projected edge declarations. That binding does not preserve every condition in the full behavior model or control actual state writes.

Model both concerns when the root structure requires both.
Use separate projects if the concerns require different projections or bindings.
Keep their relationship clear in the requirement and model review.

The optional v1 `parent` field links a behavior model to a state in a higher-level model.
The included order model belongs to the architecture model's `Service` state.
The combined Pele view displays that containment with a dashed link.
This link records structure and does not establish refinement between the two specifications.

## The model comes before the generated check

Start with the root requirements and the user's concrete failure cases.
Choose states that preserve every distinction required by the accepted properties.
Choose finite bounds that let TLC explore relevant cases.
Write invariants that could fail if the design is wrong.

A successful TLC run concerns that model and configuration.
Review the state graph to detect a model that omits a required operation or permits an unintended cycle.
Pele visualizations make exact finite and projected graphs available for review.
The visualization does not add a verification guarantee.

The compiler then turns the graph into the selected typed automaton and emits authority or linter source.
The binding describes how a model name corresponds to code.
The binding must not become a second list of permitted application edges.

## Implementation remains open inside the checked contract

Generated state owners constrain their own live state transitions.
Generated v1 checks constrain supported source constructs.
The agent chooses application algorithms, data structures, APIs, and error handling within the contract and its assumptions.
Native type checks and independent properties check behavior that the generated binding cannot establish.
Record any remaining requirement coverage gap.

Use architecture rules when the dependency restriction has a concrete purpose.
For example, a gateway boundary can keep external SDK imports in one module.
An import rule cannot prove that a request followed a particular runtime sequence.

Use the generated owner as the source of state for an executable finite contract. A parallel handwritten state field is not protected by that owner. Record creation, object retention, input binding, external effects, persistence, and recovery separately where required. The current owner does not establish those application properties.

Use v1 transition declarations when explicit edge registration helps the application.
A declaration that matches the model can still have an incorrect handler.
Test the handler's effects and runtime state changes separately.

## Diagnose before changing consumer implementation

Start with structural diagnosis before choosing a local repair.
An implementation bug violates the intended contract under sufficient coverage and enforcement.
A structural bug concerns missing or incorrect state, ownership, responsibility, time, information, lifecycle, composition, or enforcement.

Before changing consumer code:

1. Record the violated requirement and concrete failure or counterexample.
2. For new behavior, record the required outcome and forbidden paths.
3. Locate the owning model and enclosing acceptance properties through the root structure.
4. Check coverage of the required state, participants, paths, and lifecycle boundaries.
5. Check whether the model permits the forbidden path.
6. Inspect the actual application binding, artifact freshness, and enforcement.

Missing structure or coverage requires a structural repair.
A model that permits the forbidden path needs a structure or specification repair.
A model that forbids the path requires a binding and enforcement investigation.
Missing, stale, bypassed, or incomplete enforcement remains a structural gap.
Permit a local implementation repair only after establishing the intended contract, sufficient coverage, and actual enforcement.
A caller's diagnosis label does not establish that evidence.

A consumer can report success after an enforced rejection.
Once the evidence above covers that path, repair its response mapping.
Keep the owner, invariant, and expected rejection unchanged.

For example, duplicated cost application requires checking which component owns each cost and its finalization boundary.
Do not start with an extra condition in one caller.
An interaction between funding waits and position changes requires checking independent lifecycles and scheduling responsibility.
Do not reuse one lifecycle's state as authority for the other without an accepted requirement.
These examples prescribe no financial rates, timing thresholds, or trading actions.

Unsupported analyzer syntax does not establish a consumer defect.
Record the rejected construct, missing semantic support, and resulting coverage gap.
Extend the analyzer with a defined semantic rule or report the unsupported boundary.
Do not rewrite consumer behavior merely to satisfy the analyzer or omit participating files.
Unknown constructs cannot count as permitted transitions.

Repair the responsible structure before adding a local workaround.
Do not add an independent mutable copy of protected state or handwritten policy beside generated authority.
Preserve the accepted invariant and expected oracle during a repair.
Do not edit generated policy code to make application code pass.

## Check the failure class after repair

Preserve the original counterexample and check that the repair excludes it.
Add a regression for the failure class across relevant participants, orderings, repeated operations, and lifecycle boundaries.
Check an independent higher-level acceptance property from the root structure.
Derive expected results from the accepted requirement.
Generated output, paired implementations, and round trips cannot supply their own independent acceptance oracle.

Rebuild affected models, bindings, and generated artifacts through their declared producer.
Rerun TLC and applicable native checks.
Check actual bindings and consumer behavior rather than a neighboring declaration.

For Cargo integration, inspect the effective consuming graph after connecting its generated path dependency.
Keep configured member paths distinct from Cargo's resolved workspace members.
Metadata for the generated crate alone does not establish compatible placement.
Resolve placement failures through the binding or producer contract.
Do not patch generated Cargo manifests.

Canonicalization and freshness must share one artifact producer.
Check generated bytes with the actual consumer's formatter configuration.
Resolve disagreements through artifact ownership and configuration.
Do not manually format generated code, skip formatting, or suppress freshness to obtain a passing result.
Read the [artifact contract](artifact-contract.md) for the current producer and consumer compatibility limits.

## Change requirements explicitly

Keep a requirement change distinct from a repair under an accepted requirement.
For an authorized change, record the new expected behavior and affected invariant, assumptions, or equality contract.
Update the enclosing acceptance property and affected lower-level contracts through the same root structure.
Then rerun TLC, regenerate, and check the affected integration.
Do not weaken an invariant or change an expected oracle merely to match a failing implementation.
An intended requirement change can remove a previous restriction, but its reason must remain reviewable.

The method does not require a person to approve every reversible code edit.
Use the user's existing authorization and the project's review rules.
Keep changes to product requirements distinct from fixes within an accepted requirement.

## Expand coverage through the root structure

Choose an affected contract closure whose forbidden behavior matters and whose state space remains manageable.
Include the enclosing responsibilities identified from the root.
Model that closure before expanding the number of rules or languages.
Demonstrate a permitted case and a forbidden case with the generated checker.

Measure the time to change a requirement, including model and binding maintenance.
Record actual missed violations and normal changes that the checker blocks.
A larger model or more generated rules does not establish that the method improves development.

Expand coverage when the existing contract remains understandable and useful during real changes.
State the uncovered behavior at each stage.

## Distinguish guidance from mechanical enforcement

The root-structure and diagnosis steps are workflow requirements.
Current tools do not check complete application contract closure or mechanically authorize a local repair.
Use [structural contract comparison](structural-contracts.md) to compare supported v3/v4 source models against a supplied baseline.
Independent baseline selection and native application authority remain unestablished.
Report evidence separately for model checks, generated enforcement, native binding, composition, scheduling, and persistence.
A green leaf model does not establish its enclosing properties or application coverage.

Generated owners protect one live object within their documented trust boundary.
Object creation and retention, external effects, persistence, recovery, scheduling, and exclusive writers require separate evidence.
V1 containment remains a display link.
Supported symbolic erasure checks the supplied IR relation and does not establish native application refinement.
Keep unmodeled structure and unsupported enforcement visible as coverage gaps.
