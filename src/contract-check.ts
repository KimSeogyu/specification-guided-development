import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { checkContractClosure, lowerStructuralContracts } from './contract-graph.js';
import { ContractBindingsSchema, ContractProjectSchema, type ContractClosureFinding } from './contract-types.js';
import { runControlledTlc } from './finite-tlc.js';
import { captureSymbolicProject, compareCapturedAcceptance, inspectSymbolicCapture, recheckSymbolicCapture,
  verifyCapturedErasure, type CheckedSymbolicCapture } from './symbolic-capture.js';

export class ContractComparisonError extends Error {
  constructor(readonly findings: readonly ContractClosureFinding[], readonly source: 'baseline' | 'candidate' = 'candidate') {
    super(`TLC312: ${source} contract obligations are unresolved: ${findings.map(finding => finding.kind).join(', ')}`);
    this.name = 'ContractComparisonError';
  }
}

export class ContractVerificationError extends Error {
  readonly diagnostic: { ruleId: 'TLC313'; owner: string; stage: 'model' | 'baseline' | 'composition'; detail: string };
  constructor(owner: string, stage: 'model' | 'baseline' | 'composition', cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`TLC313: ${stage} verification failed for ${owner}: ${detail}`, { cause });
    this.name = 'ContractVerificationError';
    this.diagnostic = { ruleId: 'TLC313', owner, stage, detail };
  }
}

async function checkedStep<T>(owner: string, stage: 'model' | 'baseline' | 'composition', work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (cause) { throw new ContractVerificationError(owner, stage, cause); }
}

async function sourceFile(path: string) {
  const absolute = resolve(path);
  const read = async () => {
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error(`TLC311: contract input must be a regular file no larger than 16 MiB: ${absolute}`);
    return readFile(absolute);
  };
  const bytes = await read();
  return { path: absolute, bytes, recheck: async () => {
    if (!bytes.equals(await read())) throw new Error(`TLC311: contract input changed before comparison completed: ${absolute}`);
  } };
}

async function readDeclarations(input: { spec: string; operator: string; jar: string }) {
  const source = await sourceFile(input.spec);
  const module = basename(source.path, '.tla');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(module) || basename(source.path) !== `${module}.tla`) {
    throw new Error('TLC311: contract metadata requires an identifier .tla filename');
  }
  const directory = await mkdtemp(join(tmpdir(), 'sgd-contract-metadata-'));
  const wrapper = module === 'SgdContractMetadata' ? 'SgdContractMetadataWrapper' : 'SgdContractMetadata';
  let prefix = 'sgdContract';
  while (['Clock', 'Init', 'Next', 'Spec'].some(suffix => `${prefix}${suffix}` === input.operator)) prefix += 'X';
  try {
    await writeFile(join(directory, `${module}.tla`), source.bytes, { mode: 0o400 });
    const spec = join(directory, `${wrapper}.tla`);
    const config = join(directory, `${wrapper}.cfg`);
    await writeFile(spec, `---- MODULE ${wrapper} ----\nEXTENDS ${module}\nVARIABLE ${prefix}Clock\n${prefix}Init == ${prefix}Clock = FALSE\n${prefix}Next == ${prefix}Clock' = ~${prefix}Clock\n${prefix}Spec == ${prefix}Init /\\ [][${prefix}Next]_${prefix}Clock\n====\n`);
    await writeFile(config, `SPECIFICATION ${prefix}Spec\nCHECK_DEADLOCK FALSE\n`);
    const run = await runControlledTlc({ spec, config, jar: input.jar }, 'finite-owned-v1');
    if (run.evidence.standardModules.length || run.evidence.moduleClosure.length !== 2) {
      throw new Error('TLC311: contract metadata imports are unsupported');
    }
    const declarations = lowerStructuralContracts({ semantic: run.semantic, module, operator: input.operator });
    await source.recheck();
    return { declarations, source, evidence: { scope: 'literal-metadata-wrapper' as const, run: run.evidence } };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function readProject(input: { project: string; jar: string }) {
  const file = await sourceFile(input.project);
  const project = ContractProjectSchema.parse(JSON.parse(file.bytes.toString('utf8')) as unknown);
  const directory = dirname(file.path);
  const bindingFile = await sourceFile(resolve(directory, project.bindings));
  const bindings = ContractBindingsSchema.parse(JSON.parse(bindingFile.bytes.toString('utf8')) as unknown);
  const metadata = await readDeclarations({ spec: resolve(directory, project.root.spec), operator: project.root.operator, jar: input.jar });
  const ids = metadata.declarations.contracts;
  if (Object.keys(project.models).length !== ids.length || ids.some(id => !Object.hasOwn(project.models, id))) {
    throw new Error('TLC311: model reference keys must exactly match the root contract identities');
  }
  return { project, directory, bindings, metadata, recheck: async () => {
    await file.recheck(); await bindingFile.recheck(); await metadata.source.recheck();
  } };
}

async function captureLeaves(project: Awaited<ReturnType<typeof readProject>>, jar: string) {
  const captures = new Map<string, CheckedSymbolicCapture>();
  for (const id of project.metadata.declarations.contracts) {
    const reference = project.project.models[id];
    if (!reference) throw new Error(`TLC311: missing model reference ${id}`);
    const path = resolve(project.directory, reference.project);
    const source = await sourceFile(path);
    const configured: unknown = JSON.parse(source.bytes.toString('utf8'));
    if (typeof configured !== 'object' || configured === null || !('version' in configured) ||
      (configured.version !== 3 && configured.version !== 4)) {
      throw new Error(`TLC311: contract ${id} requires an unsupported model profile; this comparison admits v3 and v4`);
    }
    const capture = await checkedStep(id, 'model', () => captureSymbolicProject({ project: path, jar }));
    await source.recheck();
    captures.set(id, capture);
  }
  return captures;
}

/** Compare controlled sources against supplied baseline sources. This cannot satisfy a protected preservation gate. */
export async function compareContractProjects(input: { project: string; baseline: string; jar: string }) {
  const baseline = await readProject({ project: input.baseline, jar: input.jar });
  const candidate = await readProject({ project: input.project, jar: input.jar });
  const baselineExtraBindings = Object.keys(baseline.bindings.bindings)
    .filter(id => !baseline.metadata.declarations.native.some(obligation => obligation.id === id))
    .map<ContractClosureFinding>(id => ({ kind: 'extra-binding', id }));
  if (baselineExtraBindings.length) throw new ContractComparisonError(baselineExtraBindings, 'baseline');
  const closure = checkContractClosure({ baseline: baseline.metadata.declarations, candidate: candidate.metadata.declarations,
    models: candidate.project.models, bindings: candidate.bindings });
  if (closure.findings.length) throw new ContractComparisonError(closure.findings);
  const baselineModels = await captureLeaves(baseline, input.jar);
  const candidateModels = await captureLeaves(candidate, input.jar);
  const required = (models: Map<string, CheckedSymbolicCapture>, id: string) => {
    const capture = models.get(id);
    if (!capture) throw new Error(`TLC311: required captured contract ${id} is missing`);
    return capture;
  };
  const acceptance = [];
  for (const id of baseline.metadata.declarations.contracts) {
    acceptance.push({ contract: id, evidence: await checkedStep(id, 'baseline', () => compareCapturedAcceptance({
      baseline: required(baselineModels, id), candidate: required(candidateModels, id),
    })) });
  }
  const composition = [];
  for (const relation of candidate.metadata.declarations.relations) {
    composition.push({ relation: relation.id, evidence: await checkedStep(relation.id, 'composition', () => verifyCapturedErasure({
      abstract: required(candidateModels, relation.upper), concrete: required(candidateModels, relation.lower),
      binding: { version: 1, variables: relation.variables, inputs: relation.inputs, actions: relation.actions },
    })) });
  }
  for (const capture of [...baselineModels.values(), ...candidateModels.values()]) await recheckSymbolicCapture(capture);
  await baseline.recheck(); await candidate.recheck();
  return {
    kind: 'controlled-contract-comparison' as const, scope: 'model-composition-only' as const,
    preservationGate: 'not-established' as const, independentlySelectedBaseline: 'not-established' as const,
    metadata: { baseline: baseline.metadata.evidence, candidate: candidate.metadata.evidence },
    contracts: [...candidateModels].map(([id, capture]) => ({ id, evidence: inspectSymbolicCapture(capture) })),
    acceptance, composition,
  };
}
