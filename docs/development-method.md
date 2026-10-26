# Develop from the domain contract

Define the required behavior before implementing it. Keep the accepted
requirements separate from the code being checked; changing both to hide a
failure does not preserve the contract.

## Model the relevant state

Identify the state, ownership, inputs, and external effects that determine the
requirement. State the finite bounds and environment assumptions. A model
cannot protect a fact that its state or input bindings omit.

Keep permission and transitions in TLA+. Project bindings identify actions,
ports, and source locations. They must not supply a second policy table.

## Select supported generation

Use [domain generation](domain-code.md) for finite control with injected async
ports. The generated owner admits the operation, observes its port outcome,
and selects the modeled completion. Port implementations remain application
code and must satisfy their declared effect contract.

Use [symbolic inputs](symbolic-owned.md) or [independent inputs](product-inputs.md)
when the requirement depends on actual equality/copy inputs. Use
[retained operations](retained-operation.md) when a synchronous callback must
return the original payload on every ordinary outcome.

Do not substitute a diagnostic declaration for owned runtime state. Imported
DOT and v1 source checks do not establish executable provenance or complete
application coverage.

## Change and verify

Change the model when policy changes, regenerate, and exercise actual caller
and adapter behavior. Test rejected operations and failure paths. Check that
application code uses the generated owner rather than a parallel mutable state.

Use `build --check` to detect stale generated files. Use
[contract comparison](structural-contracts.md) for supported supplied-baseline
relations. The baseline must represent the independently accepted requirement.

Read failures against their actual scope. A completed finite model check is
not a proof of native compiler correctness, durable storage, external truth,
or eventual completion. The [reference proofs](../proofs/reference/README.md)
state the conditions under which generated constraints preserve a model.
