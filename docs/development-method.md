# Development under compiled model checks

The method uses a compiler to carry decisions from a TLA+ model into generated state ownership and source checks.
The agent models the requested system, inspects TLC's result, and integrates the generated contract.
The goal is to keep applicable constraints active as the implementation changes.

## Architecture and behavior need different questions

Architecture asks which component may depend on another component.
A dependency model can make the permitted direct edges explicit.
The compiler can then check imports between mapped code locations.

Behavior asks which state changes are permitted and under which conditions.
A behavior model can include retries, failures, and concurrent actors.
TLC checks invariants over the selected finite scope.
Project v2 `finite-owned` retains every supported scalar variable and generates an authority that dispatches from its actual concrete state. Use it when the application can obtain modeled state from this owner. Read [its contract and integration limits](finite-owned.md).
The v1 transition binding preserves projected edge declarations. That binding does not preserve every condition in the full behavior model or control actual state writes.

Model both concerns when the feature needs both.
Use separate projects if the concerns require different projections or bindings.
Keep their relationship clear in the requirement and model review.

The optional v1 `parent` field links a behavior model to a state in a higher-level model.
The included order model belongs to the architecture model's `Service` state.
The combined Pele view displays that containment with a dashed link.
This link records structure and does not establish refinement between the two specifications.

## The model comes before the generated check

Start with the user's expected behavior and concrete failure cases.
Choose states that distinguish outcomes the user cares about.
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

Generated state owners constrain their own live state transitions. Generated v1 checks constrain supported source constructs.
The agent still chooses application data structures, algorithms, APIs, and error handling within the requested design.
Native type checks and tests cover behavior that the generated binding cannot establish.

Use architecture rules when the dependency restriction has a concrete purpose.
For example, a gateway boundary can keep external SDK imports in one module.
An import rule cannot prove that a request followed a particular runtime sequence.

Use the generated owner as the source of state for an executable finite contract. A parallel handwritten state field is not protected by that owner. Record creation, object retention, input binding, external effects, persistence, and recovery separately where required. The current owner does not establish those application properties.

Use v1 transition declarations when explicit edge registration helps the application.
A declaration that matches the model can still have an incorrect handler.
Test the handler's effects and runtime state changes separately.

## Requirements change through the same loop

A failed check can indicate an implementation error, a model error, or a changed requirement.
Read the failure against the original requirement before choosing the correction.

For an implementation error, fix application code.
For a model error, explain the omitted or incorrect behavior and correct the model.
For a changed requirement, describe the new expected behavior and the invariant that changes.
Then rerun TLC and regenerate the affected authority or linter.

Do not edit generated policy code to make application code pass.
Do not remove an invariant merely because the current implementation violates that invariant.
An intended requirement change can remove a previous restriction, but the reason must remain reviewable.

The method does not require a person to approve every reversible code edit.
Use the user's existing authorization and the project's review rules.
Keep changes to product requirements distinct from fixes within an accepted requirement.

## Start with a narrow useful contract

Choose a feature whose forbidden behavior matters and whose state space remains manageable.
Model the feature before expanding the number of rules or languages.
Demonstrate a permitted case and a forbidden case with the generated checker.

Measure the time to change a requirement, including model and binding maintenance.
Record actual missed violations and normal changes that the checker blocks.
A larger model or more generated rules does not establish that the method improves development.

Expand coverage when the existing contract remains understandable and useful during real changes.
State the uncovered behavior at each stage.
