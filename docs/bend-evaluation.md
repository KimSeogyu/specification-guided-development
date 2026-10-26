# Experimental Bend core

The Bend experiment compiles exact finite IR into pure transition code and
checked equations. It runs from a source checkout. Bend is not a production
plugin build target or a domain/DI state owner.

## Run

Use Bend 2.0.39, the pinned TLC JAR, and a trusted BendTT kernel:

```sh
npm ci
npm run build
node scripts/evaluate-bend.mjs \
  --project examples/approval/project.json \
  --jar /absolute/path/tla2tools.jar \
  --bend /absolute/path/bend \
  --kernel /absolute/path/bendtt \
  --out .runtime/bend-result
```

Bend 2.0.39's `--verdict` mode requires BendTT built with Lean 4.34.0, separate
from SGD's Lean 4.35.0 domain checker. Build the upstream release's
`bend2/bendtt.lean` with that matching toolchain:

```sh
lean -c bendtt.c bendtt.lean
leanc -O3 -DNDEBUG bendtt.c -o bendtt
```

The script sets `BENDTT` to the supplied executable and disables update
telemetry. It does not install a kernel into your home directory. It accepts
plain `finite-owned` projects and rejects domain/retained-operation bindings.

## Output and checks

A fresh TLC run supplies the graph. The output contains:

- `domain.bend`: state/event types, initial state, transitions, and variable snapshots.
- `LAWS.bend`: expected equations for initialization, every state/action pair, and valuations.
- `PROOF.bend`: proofs against the generated implementation.
- `cases.bend`: native execution cases.
- `model.json` and `evaluation.json`: mappings, results, and scope.

Publication requires kernel verification, JavaScript and native execution
matching the IR, and two negative controls. An accepted transition changed to
a rejection must fail the unchanged laws despite remaining well-typed.
Removing the law import must also fail.

## Boundaries

State constructors are public and state is an explicit argument. Callers can
construct a state directly; these laws do not enforce initialization or exclusive
use of the transition function. There is no private owner, effect driver,
persistence, or async dependency injection.

The proof covers finite typed transitions and valuations. It does not prove the
TLA-to-IR parser, generator, Bend frontend-to-kernel translation, or native backend.
The JavaScript FFI needs separate input validation. A fabricated event constructor
reached a fallback branch and was accepted in the evaluated model, so the raw
`.mjs` export is not a validated application API.

Integers remain decimal strings. Generation is limited to 4,096 state/action
pairs; this experiment makes no performance or production scalability claim.

See the upstream [Bend guide](https://github.com/bendlang/bend/blob/main/guide/GUIDE.md)
and [limitations](https://github.com/bendlang/bend#limitations).
