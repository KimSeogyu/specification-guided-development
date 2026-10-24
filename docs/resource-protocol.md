# Resource protocol compiler support

The compiler can now represent a product of opaque identities and finite scalar inputs. It also checks the supported abstract resource protocol against required source predicates and its complete reachable relation. These are compiler building blocks for binding actual file loading and writing. They do not provide a storage implementation or establish Parangsae adoption.

Project versions 3–6 keep their existing profiles. There is no new resource project accepted by `sgd build` yet. The new source-lowering entry point is `lowerSymbolicModel({ ..., profile: 'protocol' })`; it emits symbolic IR version 3. Existing `single` and `product` lowering still emit IR versions 1 and 2. The validated IR can be inspected, visualized, refined, interpreted, and rendered to native abstract owners.

## Mixed input representation

IR version 3 has two or three ordered inputs with distinct parameter and domain names. It requires at least one opaque input and one finite input:

```json
{
	"inputs": [
		{ "kind": "opaque", "parameter": "r", "domain": "Resources" },
		{
			"kind": "finite", "parameter": "event", "domain": "Events",
			"values": [
				{ "kind": "string", "value": "notfound" },
				{ "kind": "string", "value": "present" }
			]
		}
	]
}
```

The source `Next` binds each input over a named configured constant set and passes all parameters directly to each named action in binder order. The source checker resolves semantic symbol identities and expands the existing supported first-order helpers. It derives the finite vocabulary from the configuration; a binding cannot supply another action or update table.

Opaque domains retain the existing disjoint, untyped model-value witness and Unicode identity interpretation. Finite domains contain 1–64 distinct values of one scalar kind: string, Boolean, or integer. Canonical choice order is lexicographic order of the tagged JSON key from `symbolicFiniteValueKey`, not numeric integer order. Mixed scalar sets, duplicate choices, unsupported ranges, repeated domains, or missing input origins fail.

The remaining [equality/copy source grammar](symbolic-owned.md#supported-source-profile) and [product-input restrictions](product-inputs.md#project-and-source-profile) still apply. Init is scalar, every branch assigns or preserves every variable, and supported guards use the listed equality, Boolean, membership, helper, and square-action forms. Arithmetic, ordering, arbitrary record state, and general temporal formulas remain unsupported. Limits are 12 root variables, 256 normalized action cases, 10,000 orbits, and 250,000 attempted orbit/oracle/erasure input cases.

Finite membership lowers to a literal `member` predicate. `in-domain` continues to mean opaque-domain membership. A finite string `"present"` therefore differs from an opaque resource identity with the same spelling. Finite domains do not invent nominal tags around scalar values.

The interpreter receives named records. Opaque entries are strings; finite entries are tagged scalar values:

```ts
stepSymbolic(model, state, {
	r: 'resource-outside-the-two-value-witness',
	event: { kind: 'string', value: 'present' },
});
```

It checks exact own data properties and finite vocabulary without invoking accessors. Orbit exploration checks every finite choice together with each retained opaque equality class and one fresh identity. Only opaque identities are renamed. Enabled-input erasure checks input kinds and finite vocabularies and still enumerates erased finite inputs; an extra event guard cannot silently disable the abstract relation.

The independent oracle calls the original actions for every configured input tuple. Only opaque model atoms receive aliases. Finite observer values retain their scalar tags and exact values. Disabled cases, action dispatch, complete successors, input preservation, and agreement with the original DOT relation remain checked. New oracle evidence records `symbolicIrVersion: 3`, `inputProfile: "mixed-finite-opaque-v1"`, and the finite descriptors. Older evidence keeps its existing shape.

Native owners preserve scalar values and update origins. TypeScript 7 uses exact string, Boolean, or bigint literal unions and validates runtime primitives before preparing a transition. Rust uses a separate enum for each finite input position; its generated README records every `ChoiceN` mapping. Opaque parameters retain their string identity API. Rust source escapes directional Unicode controls without changing returned values. Both owners keep their existing private state, simultaneous updates, checked revisions, and consuming preparation contract.

Signed arbitrary-precision decimal values can remain exact in native IR and snapshots. The controlled `.cfg` parser accepts only nonnegative integer literals, which must also pass the pinned TLC parser. That parser rejected `9007199254740993` in a real controlled run; generation fails rather than truncating it. Native precision tests and successful controlled source checking are separate evidence.

## Supported abstract resource protocol

The [original fixture model](../tests/fixtures/resource-protocol/ResourceProtocol.tla) declares all eleven state roles. `Fixture.cfg` selects the core relation; `ResourceProtocol.cfg` separately requires coverage before a Write attempt.

`ResourceProtocolBindingSchema` identifies the two source parameters and maps every model variable bijectively to one role:

| Role | Contract |
| --- | --- |
| `selected` | One opaque identity chosen at selection |
| `loaded` | That identity after a successful decode or exact NotFound |
| `prepared` | The loaded identity retained by the prepared decision |
| `attempted` | The prepared identity consumed before an effect attempt |
| `phase` | `New`, `Selected`, `Loaded`, `Prepared`, `Attempted`, `Done`, or `Failed` |
| `loadOutcome` | `none`, `Present`, `NotFound`, `ReadError`, or `DecodeError` |
| `decision` | `none`, `Write`, `Noop`, or `Refused` |
| `coverage` | The Boolean coverage observation in this abstract composition |
| `attempts` | Zero before consumption, one afterward |
| `replacements` | Zero except after a successful Write completion |
| `effect` | `none`, `Write`, `None`, or `Diagnostic` |

The binding maps model parameter and variable identifiers. It contains no native source paths/spans, trusted writer, permission, equality callback, action table, or allowed-source list. Binding version 1 uses the fixed scalar role vocabulary above. Its `replacements` counter records successful Write completion. A failed completion with zero does not establish that a physical destination stayed unchanged.

After separate controlled SANY/TLC, lowering, and original-action oracle checks, use the compiler API with an explicit coverage composition:

```ts
const binding = {
	version: 1,
	inputs: { resource: 'r', event: 'event' },
	variables: {
		phase: 'phase', selected: 'selected', loaded: 'loaded',
		prepared: 'prepared', attempted: 'attempted', loadOutcome: 'loadOutcome',
		decision: 'decision', coverage: 'coverage', attempts: 'attempts',
		replacements: 'replacements', effect: 'effect',
	},
};
const checked = validateResourceProtocol({
	model, binding, coverage: 'required-before-write',
});
```

Use `required-before-write` with the production relation from `ResourceProtocol.cfg` and `independent` with the core relation from `Fixture.cfg`. The API does not infer this option from a filename and does not run TLC or the oracle. Both results remain abstract evidence.

`validateResourceProtocol` checks both required source expressions and the full relation. Each required obligation must match one entire configured predicate: the admitted Affinity, ReadOrigin, and WriteOnly forms, plus square-action Terminal and, in the required composition, Coverage forms from the fixture. Matching ignores property names. It normalizes associative/commutative conjunction and disjunction, symmetric equality/inequality, and member-set order. Adding another conjunct to a required predicate also needs a profile extension; separate additional configured predicates are allowed. Other logically equivalent forms are refused until admitted; the checker does not infer their equivalence.

The relation check derives event roles from actual successors rather than event or action spelling. It checks accepted and disabled tuples, required progress, identity retention, exact absence/error handling, Write-only replacement, Noop and Refused restrictions, coverage before the attempt, single consumption, and preservation of every terminal variable. Coherent event aliases for one operation and wholly disabled extra events are allowed. Removing an operation does not yield a vacuous pass. Terminal preservation still permits the explicit Idle stutter; a successful native dispatch increments the owner's revision without changing model variables.

Orbit labels are local to each canonical state. The checker reevaluates each original input from its before-state before comparing successors. It never compares independently renamed endpoint identities as if they were physical resource IDs.

The result is explicitly `kind: "abstract-resource-protocol"` with `storageAuthority: false`. It assumes supplied IR represents its source. Fresh controlled SANY/TLC, the original-action oracle, and final source rechecks provide separate provenance. The result authenticates no loaded file, native path, archive coverage, writer, persistence, or filesystem isolation.

## Observed Write outcomes

Binding version 2 adds one required role, `writeOutcome`, to the eleven existing roles. `ResourceProtocolBindingV2Schema` and `ResourceProtocolBindingV2` describe this shape. The original `ResourceProtocolBindingSchema` and `ResourceProtocolBinding` remain version 1, including the schema's object API. `VersionedResourceProtocolBindingSchema` parses either explicit version. Neither version accepts optional or extra roles. The original validation functions remain version 1. `validateObservedResourceProtocol` and `validateObservedResourceProtocolSource` accept version 2.

The [ResourceOutcomes model](../tests/fixtures/resource-outcomes/ResourceOutcomes.tla) supplies the supported version 2 source forms. `Fixture.cfg` checks independent coverage. `ResourceOutcomes.cfg` requires coverage before the Write attempt. Both lower to IR version 3. The separate validator accepts binding version 2:

```ts
const observedBinding = ResourceProtocolBindingV2Schema.parse({
	...binding,
	version: 2,
	variables: { ...binding.variables, writeOutcome: 'writeOutcome' },
});
const checked = validateObservedResourceProtocol({
	model: observedModel, binding: observedBinding, coverage: 'required-before-write',
});
```

The result has `profile: "observed-write-v2"`. Version 1 reports `profile: "abstract-resource-v1"`. Both results retain evidence format `version: 1` and `storageAuthority: false`. There is no new project schema, CLI build profile, or native storage API.

| `writeOutcome` | Observation |
| --- | --- |
| `none` | No Write decision has been consumed |
| `Pending` | Write has been consumed, but no final replacement result is recorded |
| `NotReplaced` | This owner failed before invoking replacement of its selected destination |
| `Indeterminate` | This owner invoked replacement and cannot confirm its result |
| `Replaced` | This owner observed a successful replacement return |

`Pending` can include an operation in flight. It does not establish that replacement has not begun. `NotReplaced` concerns this owner's replacement of the selected destination. Temporary files, directories, diagnostics, or external writers can have separate effects. `Replaced` records an acknowledgment at that point, without a durability claim.

The complete relation requires four terminal Write results:

| Result | Phase | Outcome | Confirmed replacements |
| --- | --- | --- | --- |
| Success | `Done` | `Replaced` | 1 |
| Failure before replacement invocation | `Failed` | `NotReplaced` | 0 |
| Uncertain replacement failure | `Failed` | `Indeterminate` | 0 |
| Failure after confirmed replacement | `Failed` | `Replaced` | 1 |

In version 2, zero means zero confirmed replacements. `Indeterminate` with zero must not be interpreted as an unchanged file. Rust's [rename API](https://doc.rust-lang.org/std/fs/fn.rename.html) documents platform differences and a non-exhaustive error list. This profile conservatively treats an error after invocation as uncertain unless a later native profile supplies stronger evidence. A successful rename followed by a later error retains `Replaced` and one. [File synchronization](https://doc.rust-lang.org/std/fs/struct.File.html#method.sync_all) is separate from this acknowledgment.

The version 2 Write-only source predicate permits a confirmed replacement in either terminal phase. A separate complete Write observation predicate constrains each outcome, count, phase, and consumed Write. Terminal preservation covers all twelve variables. The relation checker infers finite event roles from successors and requires every difficult failure path. Replacing the only `Indeterminate` branch with another `NotReplaced` branch is refused because the required outcome is missing. Coherently renamed events remain valid. Native source admission must establish which real error produces each observation.

Noop, Refused, read failure, and coverage failure retain `writeOutcome = "none"` and zero replacements. `attempts` remains the shared consumption count for Write, Noop, and Diagnostic. It does not count native rename calls. Coverage still precedes consumption of Write in the required composition.

The native owner must eventually produce these observations internally from the actual selected operation. A caller-supplied event cannot authenticate a filesystem result. Native code must preflight every fallible completion transition and count before the corresponding effect. Source admission must separately establish at most one replacement invocation. Neither profile restores state after process loss or establishes crash durability, isolation, or safe blind retries.

## Evidence and remaining binding

Real controlled tests cover both source compositions and independently replace each required property body with `TRUE`. Generic TLC and orbit checks accept the weakened declarations when guards remain safe; the protocol checker refuses the missing source obligation. Another real source removes the Load identity guard and weakens Affinity. Generic lowering, orbit exploration, and the original-action oracle agree with that unsafe declared relation; the new checker refuses it.

The [generic mixed-input native fixtures](../tests/mixed-input-backends.test.ts) compare complete TS7 and Rust traces with the interpreter, including every finite choice, Unicode, scalar/data spelling collisions, precision, preparation reuse, detached snapshots, invalid primitives, and compile-time enum/privacy failures. Generated Rust crates also pass Clippy with warnings denied. The eleven-role protocol has separate [source/law](../tests/resource-protocol-laws.test.ts) and [lowering/rendering](../tests/protocol-input-profile.test.ts) checks. These tests establish the stated compiler layer, not a native source-to-file authority trial.

The twelve-role profile has [controlled source and law checks](../tests/resource-outcomes.test.ts), including the original-action oracle, required-predicate weakening, missing failure paths, incorrect outcomes, wrong resources, and terminal observation changes. Its [native backend checks](../tests/resource-outcome-backends.test.ts) compare complete interpreter, TypeScript 7, and Rust traces. The native test consumer also observes real file replacement followed by an intentional later error. This demonstrates the observation distinction, while the consumer still supplies abstract events. It does not establish generated IO ownership or a source gate.

The [partition authority design](partition-authority-design.md) still requires private native resource identity, actual selected open/decode, static codec and writer ownership, archive/coverage composition, an admitted filesystem/lease protocol, and complete source/target/sink coverage. A public `send(resource, event)` call cannot certify that an actual file was present or absent. The resource implementation must produce those observations internally from the real operation and the checked v6 fold. The [production goal](production-goal.md) remains incomplete until actual Parangsae maintenance proves the full workflow.
