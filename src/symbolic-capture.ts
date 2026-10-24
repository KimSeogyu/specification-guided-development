import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { sha256 } from './dot.js';
import { lowerSymbolicModel } from './symbolic-lower.js';
import { RowProjectSchema } from './row-binding-types.js';
import type { SanyModule } from './sany-xml.js';
import { verifySymbolicErasure } from './symbolic-refinement.js';
import { inspectSymbolicOrbits } from './symbolic-semantics.js';
import { runSymbolicTlc } from './symbolic-tlc.js';
import { ProductSymbolicProjectSchema, SymbolicProjectSchema, symbolicInputs } from './symbolic-types.js';
import { importSymbolicDot, verifySymbolicWitness } from './symbolic-witness.js';

const Project = z.discriminatedUnion('version', [SymbolicProjectSchema, ProductSymbolicProjectSchema, RowProjectSchema]);
type ProjectInput = { project: string; jar: string };
type SourceInputs = {
  project: string; projectPhysical: string; projectBytes: Buffer;
  spec: string; config: string; configBytes: Buffer; jar: string; jarBytes: Buffer; jarPhysical: string;
  directory: string; modules: Map<string, Buffer>; javaNames: string[];
};
type SymbolicRun = Awaited<ReturnType<typeof runSymbolicTlc>>;
type SymbolicModel = ReturnType<typeof lowerSymbolicModel>;
type Differential = Awaited<ReturnType<typeof verifySymbolicWitness>>;
type OrbitProof = ReturnType<typeof inspectSymbolicOrbits>;
type CommonData = {
  run: SymbolicRun; model: SymbolicModel; witness: Differential['witness'];
  domains: Record<string, string[]>; runtimeDomain: ReturnType<typeof runtimeDomain>;
};
export type CheckedSymbolicData = CommonData & { kind: 'checked'; orbitProof: OrbitProof; differential: Differential };
export type ModelOnlySymbolicData = CommonData & { kind: 'model-only'; orbitProof: null; differential: null };

class SymbolicCapture {
  readonly #kind = 'controlled-symbolic-capture';
  constructor() { Object.freeze(this); }
}
export type CheckedSymbolicCapture = SymbolicCapture;
type CaptureRecord = { inputs: SourceInputs; data: CheckedSymbolicData; summary: SymbolicCaptureSummary };
const captures = new WeakMap<SymbolicCapture, CaptureRecord>();
const fail = (message: string): never => { throw new Error(`TLC203: ${message}`); };

function record(capture: CheckedSymbolicCapture): CaptureRecord {
  const value = captures.get(capture);
  if (!value) throw new Error('TLC304: controlled symbolic capture required; supplied IR and model-only data do not establish controlled provenance');
  return value;
}

/** Freeze cloned plain data. SANY's map is replaced separately before it leaves this module. */
function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  if (value instanceof Map) for (const item of value.values()) freeze(item);
  else for (const item of Object.values(value)) freeze(item);
  Object.freeze(value);
}
function frozenClone<T>(value: T): T {
  const copy = structuredClone(value);
  freeze(copy);
  return copy;
}
function readonlySymbols(input: SanyModule['symbols']): SanyModule['symbols'] {
  const values = new Map(input);
  const view: SanyModule['symbols'] = {
    get size() { return values.size; },
    get: key => values.get(key), has: key => values.has(key),
    entries: () => values.entries(), keys: () => values.keys(), values: () => values.values(),
    [Symbol.iterator]: () => values[Symbol.iterator](),
    forEach(callback, thisArg) { values.forEach((value, key) => callback.call(thisArg, value, key, view)); },
  };
  return Object.freeze(view);
}
function compilerView<T extends CheckedSymbolicData | ModelOnlySymbolicData>(value: T): T {
  const copy = structuredClone(value);
  for (const symbol of copy.run.semantic.symbols.values()) freeze(symbol);
  copy.run.semantic.symbols = readonlySymbols(copy.run.semantic.symbols);
  freeze(copy);
  return copy;
}

async function regular(path: string): Promise<Buffer> {
  if (!(await lstat(path)).isFile()) return fail(`controlled symbolic input must be a regular, non-symlink file: ${path}`);
  return readFile(path);
}
async function javaNamespace(directory: string, jarPhysical: string): Promise<string[]> {
  const names = (await readdir(directory)).filter(name => /\.(?:java|class|jar)$/i.test(name)).sort();
  for (const name of names) {
    const path = join(directory, name);
    if (!(await lstat(path)).isFile() || await realpath(path) !== jarPhysical) return fail(`Java override artifact ${name} is unsupported in the symbolic model directory; only the explicitly supplied, verified TLC JAR may be present`);
  }
  return names;
}
async function collectInputs(input: ProjectInput) {
  const project = resolve(input.project);
  const projectBytes = await readFile(project);
  const parsed = Project.safeParse(JSON.parse(projectBytes.toString('utf8')));
  if (!parsed.success) throw new Error('TLC206: controlled symbolic capture requires a v3, v4, or v5 source project');
  const configuration = parsed.data;
  const spec = resolve(dirname(project), configuration.spec);
  const config = resolve(dirname(project), configuration.config);
  const jar = resolve(input.jar);
  const directory = await realpath(dirname(spec));
  const modules = new Map<string, Buffer>();
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.tla')).sort()) modules.set(name, await regular(join(directory, name)));
  const source: SourceInputs = { project, projectPhysical: await realpath(project), projectBytes, spec, config, configBytes: await regular(config),
    jar, jarBytes: await regular(jar), jarPhysical: await realpath(jar), directory, modules, javaNames: [] };
  source.javaNames = await javaNamespace(directory, source.jarPhysical);
  return { configuration, source };
}

async function recheck(inputs: SourceInputs): Promise<void> {
  if (await realpath(inputs.project) !== inputs.projectPhysical || !inputs.projectBytes.equals(await readFile(inputs.project))) return fail('project configuration changed during verification; rerun against stable inputs');
  if (await realpath(dirname(inputs.spec)) !== inputs.directory) return fail('symbolic model directory changed during verification');
  const names = (await readdir(inputs.directory)).filter(name => name.endsWith('.tla')).sort();
  if (JSON.stringify(names) !== JSON.stringify([...inputs.modules.keys()])) return fail('model sources changed during symbolic capture; rerun against a stable source tree');
  for (const [name, bytes] of inputs.modules) if (!bytes.equals(await regular(join(inputs.directory, name)))) return fail(`${name} changed during symbolic capture; rerun against stable sources`);
  if (JSON.stringify(await javaNamespace(inputs.directory, inputs.jarPhysical)) !== JSON.stringify(inputs.javaNames)) return fail('Java override namespace changed during symbolic capture');
  if (!inputs.configBytes.equals(await regular(inputs.config)) || !inputs.jarBytes.equals(await regular(inputs.jar)) || await realpath(inputs.jar) !== inputs.jarPhysical) return fail('configuration or JAR changed during symbolic capture; rerun against stable inputs');
}
function assertRunInputs(inputs: SourceInputs, run: SymbolicRun): void {
  if (run.evidence.configSha256 !== sha256(inputs.configBytes) || run.evidence.jarSha256 !== sha256(inputs.jarBytes) ||
    run.evidence.moduleClosure.some(module => sha256(inputs.modules.get(module.name) ?? '') !== module.sha256)) return fail('completed symbolic run differs from the captured original inputs');
}
function domainsFor(model: SymbolicModel, run: SymbolicRun): Record<string, string[]> {
  return Object.fromEntries(symbolicInputs(model).map(({ domain }) => {
    const configured = run.config.constants[domain];
    if (configured?.kind !== 'set') throw new Error('TLC301: missing symbolic input domain');
    return [domain, configured.values.map(value => {
      if (value.kind !== 'model-value') throw new Error('TLC301: symbolic witness requires model atoms');
      return value.value;
    })];
  }));
}
function runtimeDomain(model: SymbolicModel, domains: Record<string, string[]>) {
  const inputs = symbolicInputs(model);
  const first = inputs[0];
  if (!first || !domains[first.domain]) throw new Error('TLC301: symbolic model has no input domain');
  return model.version === 1
    ? { kind: 'untyped-opaque-unicode-string-identities', constant: first.domain, finiteWitnessAtoms: domains[first.domain] }
    : { kind: 'disjoint-untyped-opaque-unicode-string-identities', inputs,
      domains: Object.fromEntries(Object.entries(domains).map(([domain, atoms]) => [domain, { finiteWitnessAtoms: atoms }])) };
}
async function runProject(input: ProjectInput) {
  const { configuration, source } = await collectInputs(input);
  const run = await runSymbolicTlc({ spec: source.spec, config: source.config, jar: source.jar });
  assertRunInputs(source, run);
  const model = lowerSymbolicModel({ name: configuration.name, semantic: run.semantic, config: run.config, profile: configuration.version === 3 ? 'single' : 'product' });
  return { configuration, source, run, model };
}

export type SymbolicCaptureSummary = {
  kind: 'controlled-symbolic-capture';
  project: { path: string; version: 3 | 4 | 5; sha256: string };
  model: { name: string; semanticSha256: string };
  finite: { scope: 'configured-finite-instance'; evidence: SymbolicRun['evidence'] };
  orbit: { scope: 'admitted-equality-copy-orbits'; stateCount: number; edgeCount: number; disabledCount: number };
  oracle: Differential['evidence'];
  inputStability: 'complete-flat-module-and-java-override-namespace';
};
function summary(input: { configuration: z.infer<typeof Project>; source: SourceInputs; data: CheckedSymbolicData }): SymbolicCaptureSummary {
  return {
    kind: 'controlled-symbolic-capture',
    project: { path: input.source.project, version: input.configuration.version, sha256: sha256(input.source.projectBytes) },
    model: { name: input.data.model.name, semanticSha256: input.data.model.source.semanticSha256 },
    finite: { scope: 'configured-finite-instance', evidence: input.data.run.evidence },
    orbit: { scope: 'admitted-equality-copy-orbits', stateCount: input.data.orbitProof.states.length, edgeCount: input.data.orbitProof.edges.length, disabledCount: input.data.orbitProof.disabled.length },
    oracle: input.data.differential.evidence,
    inputStability: 'complete-flat-module-and-java-override-namespace',
  };
}

/** Only a controlled source run, orbit check, and original-action oracle can mint this token.
 * A v5 capture attests its symbolic model; it does not establish the native row binding.
 */
export async function captureSymbolicProject(input: ProjectInput): Promise<CheckedSymbolicCapture> {
  const collected = await runProject(input);
  const { source, run, model } = collected;
  const orbitProof = inspectSymbolicOrbits(model);
  const differential = await verifySymbolicWitness({ model, run, spec: source.spec, config: source.config, jar: source.jar });
  const domains = domainsFor(model, run);
  const data: CheckedSymbolicData = { kind: 'checked', run, model, orbitProof, differential, witness: differential.witness, domains, runtimeDomain: runtimeDomain(model, domains) };
  await recheck(source);
  const capture = new SymbolicCapture();
  captures.set(capture, { inputs: source, data: frozenClone(data), summary: frozenClone(summary({ ...collected, data })) });
  return capture;
}

/** Model-only inspection deliberately returns data and never registers a checked capture. */
export async function inspectSymbolicProject(input: ProjectInput): Promise<ModelOnlySymbolicData> {
  const { source, run, model } = await runProject(input);
  const domains = domainsFor(model, run);
  const first = symbolicInputs(model)[0];
  if (!first) throw new Error('TLC301: symbolic model has no input');
  const atoms = domains[first.domain];
  if (!atoms) throw new Error('TLC301: missing symbolic witness input domain');
  const witness = model.version === 1 ? importSymbolicDot({ dot: run.dot, name: model.name, domain: first.domain, atoms }) : importSymbolicDot({ dot: run.dot, name: model.name, domains });
  await recheck(source);
  return compilerView({ kind: 'model-only', run, model, witness, domains, runtimeDomain: runtimeDomain(model, domains), orbitProof: null, differential: null });
}

/** Detached compiler data is not a provenance token and cannot enter the captured erasure checker. */
export function readSymbolicCaptureForCompiler(capture: CheckedSymbolicCapture): CheckedSymbolicData { return compilerView(record(capture).data); }
export function inspectSymbolicCapture(capture: CheckedSymbolicCapture): SymbolicCaptureSummary { return frozenClone(record(capture).summary); }
export async function recheckSymbolicCapture(capture: CheckedSymbolicCapture): Promise<void> { await recheck(record(capture).inputs); }

/** Recheck genuine source captures around the existing supplied-program relation check. */
export async function verifyCapturedErasure(input: { abstract: CheckedSymbolicCapture; concrete: CheckedSymbolicCapture; binding: unknown }) {
  const abstract = record(input.abstract);
  const concrete = record(input.concrete);
  await recheck(abstract.inputs);
  await recheck(concrete.inputs);
  const evidence = verifySymbolicErasure({ abstract: abstract.data.model, concrete: concrete.data.model, binding: input.binding });
  await recheck(abstract.inputs);
  await recheck(concrete.inputs);
  return frozenClone({ ...evidence, captures: { abstract: abstract.summary, concrete: concrete.summary } });
}
