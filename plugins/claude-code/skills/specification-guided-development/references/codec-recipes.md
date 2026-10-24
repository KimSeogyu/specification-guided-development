# Check native codec reconstruction

Use this reference when row reconstruction must preserve exact native fields and checked constructor validation.
The separate `rust-codec-recipe-v1` profile is source evidence, not a new SGD project or MCP tool.

The binding names one native Fact, explicit metadata, a codec module, two leaf functions, a plain wire type, and a literal `(physical_column, native_field)` descriptor.
It contains no baseline, callback, writer permission, or trusted-source list.
The native analyzer checks complete field mappings and actual getter/constructor bodies.
It refuses unsupported constructors, custom lifecycle behavior, conditional selected code, and unknown callbacks.

For the packaged TypeScript API, import `runtime/dist/codec-recipe.js` from this plugin's actual directory.
Call `analyzeCodecRecipe({ application, binding })` with an absolute application path and parsed binding value.
Keep its returned immutable report in that process.
Before using the result in another build phase, call `recheckCodecRecipe({ report })` on that exact object.
Recheck repeats the native analysis, source and absence checks, and Cargo discovery.
A copied or parsed JSON report cannot restore the private context.
The API captures the binding value. Retain and recheck the original project or binding file separately when it supplies that value.

Prepared packages validate their runtime platform before invoking the host-native helper.
A source checkout uses Cargo to build the locked helper when the bundled binary is absent.
The native helper also accepts `codec-recipe --root APP --binding JSON` and rechecks the actual binding file.
It prints one JSON report or an actionable `TLC309` diagnostic and exits 2 on refusal.

Record the actual scope in the handoff.
`storageAuthority` remains false.
The selected native library is linked to its Cargo package and target identity.
Other discovered target bodies have not passed effect admission.
Metadata feature lists describe an inventory union, not exact compiler host/target unit features.
Genuine registry dependencies, global Cargo configuration, the toolchain, and the platform remain trusted prerequisites.

For Funding, preserve all nine raw fields, original receipt, signed rate, exact interval/schema integers, and Symbol validation.
Do not transfer CSV-only restrictions into storage decoding.
Compare the physical column contract independently. A round trip can hide a coordinated encoder/decoder swap.
The generated wire fixture grants no IO permission.
The actual selected File, Arrow/Parquet bridge, replacement call, coverage order, and complete effect gate require separate evidence.
