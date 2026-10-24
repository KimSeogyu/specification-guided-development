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

The binding maps model parameter and variable identifiers. It contains no native source paths/spans, trusted writer, permission, equality callback, action table, or allowed-source list. This first profile uses the fixed scalar role vocabulary above. Other state shapes need an explicit profile extension.

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

## Evidence and remaining binding

Real controlled tests cover both source compositions and independently replace each required property body with `TRUE`. Generic TLC and orbit checks accept the weakened declarations when guards remain safe; the protocol checker refuses the missing source obligation. Another real source removes the Load identity guard and weakens Affinity. Generic lowering, orbit exploration, and the original-action oracle agree with that unsafe declared relation; the new checker refuses it.

The [generic mixed-input native fixtures](../tests/mixed-input-backends.test.ts) compare complete TS7 and Rust traces with the interpreter, including every finite choice, Unicode, scalar/data spelling collisions, precision, preparation reuse, detached snapshots, invalid primitives, and compile-time enum/privacy failures. Generated Rust crates also pass Clippy with warnings denied. The eleven-role protocol has separate [source/law](../tests/resource-protocol-laws.test.ts) and [lowering/rendering](../tests/protocol-input-profile.test.ts) checks. These tests establish the stated compiler layer, not a native source-to-file authority trial.

The [partition authority design](partition-authority-design.md) still requires private native resource identity, actual selected open/decode, static codec and writer ownership, archive/coverage composition, an admitted filesystem/lease protocol, and complete source/target/sink coverage. A public `send(resource, event)` call cannot certify that an actual file was present or absent. The resource implementation must produce those observations internally from the real operation and the checked v6 fold. The [production goal](production-goal.md) remains incomplete until actual Parangsae maintenance proves the full workflow.
