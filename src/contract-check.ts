import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { checkContractClosure, lowerStructuralContracts } from './contract-graph.js';
import { ContractBindingsSchema, ContractProjectSchema, type ContractClosureFinding } from './contract-types.js';
import { runControlledTlc } from './finite-tlc.js';
import { captureSymbolicProject, compareCapturedAcceptance, inspectSymbolicCapture, recheckSymbolicCapture,
  readSymbolicCaptureForCompiler, readSymbolicCaptureSources, verifyCapturedErasure, type CheckedSymbolicCapture } from './symbolic-capture.js';
import { capturedFile, compilerFile, prepareArtifacts, preparedFiles, type ArtifactFile } from './artifacts.js';
import { captureOutputLocation, recheckOutputLocation, type CapturedInputLocation, type CapturedSourceDirectory } from './contract-output.js';
import { writePreparedGenerated } from './managed-output.js';
import { sha256 } from './dot.js';

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
  const stat = await lstat(absolute, { bigint: true });
  if (!stat.isFile() || stat.size > 16n * 1024n * 1024n) throw new Error(`TLC311: contract input must be a regular file no larger than 16 MiB: ${absolute}`);
  const location: CapturedInputLocation = { path: absolute, physicalPath: await realpath(absolute), device: stat.dev, inode: stat.ino };
  const directory: CapturedSourceDirectory = { path: dirname(absolute), physicalPath: await realpath(dirname(absolute)) };
  const bytes = await readFile(absolute);
  const recheck = async () => {
    const current = await lstat(absolute, { bigint: true });
    if (!current.isFile() || current.dev !== location.device || current.ino !== location.inode ||
      await realpath(absolute) !== location.physicalPath || await realpath(directory.path) !== directory.physicalPath ||
      !bytes.equals(await readFile(absolute))) throw new Error(`TLC311: contract input changed before comparison completed: ${absolute}`);
  };
  await recheck();
  return { path: absolute, bytes, location, directory, recheck };
}

const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
const generated = (path: string, value: unknown): ArtifactFile => compilerFile({ path, content: json(value) });
type SourceRole = 'baseline' | 'candidate';
type PathKind = 'project-relative' | 'configured-absolute';
type ArchiveOrigin = { source: SourceRole; rootProject: string } & (
  | { base: 'root-project-directory' }
  | { base: 'leaf-project-directory'; contract: string; project: string; projectKind: PathKind }
);
const pathKind = (path: string): PathKind => isAbsolute(path) ? 'configured-absolute' : 'project-relative';
const archive = (files: readonly { path: string; pathKind: PathKind; kind: string; bytesBase64: string }[], origin: ArchiveOrigin) => ({ schema: 'sgd-captured-sources-v1', origin, files });
const archived = (file: Awaited<ReturnType<typeof sourceFile>>, kind: string, path: string) => ({ path, pathKind: pathKind(path), kind, bytesBase64: file.bytes.toString('base64') });
type CompareInput = { project: string; baseline: string; jar: string };
const contractDirectory = (index: number): string => `c-${String(index).padStart(3, '0')}`;

function immutable<T>(value: T): T {
  const copy = structuredClone(value);
  function freeze(item: unknown): void {
    if (item === null || typeof item !== 'object') return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  }
  freeze(copy);
  return copy;
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
  const wrapperSource = `---- MODULE ${wrapper} ----\nEXTENDS ${module}\nVARIABLE ${prefix}Clock\n${prefix}Init == ${prefix}Clock = FALSE\n${prefix}Next == ${prefix}Clock' = ~${prefix}Clock\n${prefix}Spec == ${prefix}Init /\\ [][${prefix}Next]_${prefix}Clock\n====\n`;
  const wrapperConfig = `SPECIFICATION ${prefix}Spec\nCHECK_DEADLOCK FALSE\n`;
  try {
    await writeFile(join(directory, `${module}.tla`), source.bytes, { mode: 0o400 });
    const spec = join(directory, `${wrapper}.tla`);
    const config = join(directory, `${wrapper}.cfg`);
    await writeFile(spec, wrapperSource);
    await writeFile(config, wrapperConfig);
    const run = await runControlledTlc({ spec, config, jar: input.jar }, 'finite-owned-v1');
    if (run.evidence.standardModules.length || run.evidence.moduleClosure.length !== 2) {
      throw new Error('TLC311: contract metadata imports are unsupported');
    }
    const declarations = lowerStructuralContracts({ semantic: run.semantic, module, operator: input.operator });
    await source.recheck();
    return { declarations, source, evidence: { scope: 'literal-metadata-wrapper' as const, run: run.evidence },
      retained: { module, wrapper, wrapperSource, wrapperConfig, xml: run.xml, dot: run.dot, log: run.log } };
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
  return { project, directory, bindings, metadata, rootSource: file, bindingSource: bindingFile, sources: [file, bindingFile], recheck: async () => {
    await file.recheck(); await bindingFile.recheck(); await metadata.source.recheck();
  } };
}

/** Persist declared source identities, while actual filesystem identities remain in private captures. */
function persistentCapture(summary: ReturnType<typeof inspectSymbolicCapture>, source: SourceRole, id: string, project: Awaited<ReturnType<typeof readProject>>) {
  const reference = project.project.models[id];
  if (!reference) throw new Error(`TLC311: captured contract ${id} has no declared project origin`);
  return { ...summary, project: { ...summary.project, path: reference.project, pathKind: pathKind(reference.project),
    origin: { source, base: 'root-project-directory', rootProject: basename(project.rootSource.path), contract: id } } };
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

/** Only this private collector can connect source verification to managed publication. */
async function collectContractComparison(input: CompareInput) {
  const jar = await sourceFile(input.jar);
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
  const report = {
    kind: 'controlled-contract-comparison' as const, scope: 'model-composition-only' as const,
    preservationGate: 'not-established' as const, independentlySelectedBaseline: 'not-established' as const,
    metadata: { baseline: baseline.metadata.evidence, candidate: candidate.metadata.evidence },
    contracts: [...candidateModels].map(([id, capture]) => ({ id, evidence: inspectSymbolicCapture(capture) })),
    acceptance, composition,
  };
  const persistentReport = { ...report,
    contracts: report.contracts.map(item => ({ ...item, evidence: persistentCapture(item.evidence, 'candidate', item.id, candidate) })),
    acceptance: acceptance.map(item => ({ ...item, evidence: { ...item.evidence, behavior: { ...item.evidence.behavior,
      captures: { abstract: persistentCapture(item.evidence.behavior.captures.abstract, 'baseline', item.contract, baseline),
        concrete: persistentCapture(item.evidence.behavior.captures.concrete, 'candidate', item.contract, candidate) } } } })),
    composition: composition.map(item => {
      const relation = candidate.metadata.declarations.relations.find(relation => relation.id === item.relation);
      if (!relation) throw new Error(`TLC311: checked relation ${item.relation} has no declared origin`);
      return { ...item, evidence: { ...item.evidence, captures: {
        abstract: persistentCapture(item.evidence.captures.abstract, 'candidate', relation.upper, candidate),
        concrete: persistentCapture(item.evidence.captures.concrete, 'candidate', relation.lower, candidate),
      } } };
    }),
  };
  const files: ArtifactFile[] = [];
  const inputs: CapturedInputLocation[] = [jar.location];
  const directories: CapturedSourceDirectory[] = [];
  const metadataEntries: { source: SourceRole; path: string }[] = [];
  const contractEntries: { source: SourceRole; id: string; path: string }[] = [];
  const logs: string[] = [];
  const sourceArchives: { source: SourceRole; path: string }[] = [];
  for (const [role, project, models] of [
    ['baseline', baseline, baselineModels], ['candidate', candidate, candidateModels],
  ] satisfies [SourceRole, typeof baseline, Map<string, CheckedSymbolicCapture>][]) {
    const rootArchive = `roots/${role}/sources.json`;
    const origin: ArchiveOrigin = { source: role, base: 'root-project-directory', rootProject: basename(project.rootSource.path) };
    files.push(generated(rootArchive, archive([
      archived(project.rootSource, 'root-project', basename(project.rootSource.path)), archived(project.bindingSource, 'binding', project.project.bindings),
    ], origin)));
    sourceArchives.push({ source: role, path: rootArchive });
    inputs.push(...project.sources.map(file => file.location), project.metadata.source.location);
    directories.push(project.metadata.source.directory);
    const metadataRoot = `metadata/${role}`;
    const retained = project.metadata.retained;
    if (project.metadata.evidence.run.jarSha256 !== sha256(jar.bytes)) throw new Error('TLC311: metadata verification differs from the original captured JAR');
    files.push(
      capturedFile({ path: `${metadataRoot}/models/${retained.module}.tla`, content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(project.metadata.source.bytes) }),
      capturedFile({ path: `${metadataRoot}/models/${retained.wrapper}.tla`, content: retained.wrapperSource }),
      capturedFile({ path: `${metadataRoot}/models/${retained.wrapper}.cfg`, content: retained.wrapperConfig }),
      capturedFile({ path: `${metadataRoot}/semantic.xml`, content: retained.xml }),
      capturedFile({ path: `${metadataRoot}/model.dot`, content: retained.dot }),
      capturedFile({ path: `${metadataRoot}/tlc.log`, content: retained.log, volatile: true }),
      generated(`${metadataRoot}/sources.json`, archive([archived(project.metadata.source, 'metadata', project.project.root.spec)], origin)),
      generated(`${metadataRoot}/verification.json`, { ...project.metadata.evidence, source: { path: project.project.root.spec, pathKind: pathKind(project.project.root.spec), origin, sha256: sha256(project.metadata.source.bytes) },
        operator: project.project.root.operator, models: { source: `models/${retained.module}.tla`, wrapper: `models/${retained.wrapper}.tla`, config: `models/${retained.wrapper}.cfg` }, sourceArchive: 'sources.json' }),
    );
    metadataEntries.push({ source: role, path: `${metadataRoot}/verification.json` });
    logs.push(`${metadataRoot}/tlc.log`);
    for (const [index, [id, capture]] of [...models].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).entries()) {
      const leaf = readSymbolicCaptureForCompiler(capture);
      const sources = readSymbolicCaptureSources(capture);
      const root = `${role}/contracts/${contractDirectory(index)}`;
      const reference = project.project.models[id];
      if (!reference) throw new Error(`TLC311: captured contract ${id} has no declared source archive origin`);
      const leafOrigin: ArchiveOrigin = { source: role, base: 'leaf-project-directory', rootProject: basename(project.rootSource.path), contract: id,
        project: reference.project, projectKind: pathKind(reference.project) };
      inputs.push(...sources.inputs); directories.push(...sources.directories);
      files.push(
        generated(`${root}/sources.json`, archive(sources.files.map(file => ({ path: file.identity.path, pathKind: file.identity.kind, kind: file.kind, bytesBase64: file.bytesBase64 })), leafOrigin)),
        generated(`${root}/symbolic-model.json`, leaf.model), generated(`${root}/automaton.json`, leaf.witness),
        generated(`${root}/orbit-proof.json`, leaf.orbitProof), generated(`${root}/input-verification.json`, leaf.differential.evidence),
        capturedFile({ path: `${root}/input-oracle.dot`, content: leaf.differential.oracleDot }),
        capturedFile({ path: `${root}/input-oracle.log`, content: leaf.differential.oracleLog, volatile: true }),
        capturedFile({ path: `${root}/semantic.xml`, content: leaf.run.xml }), capturedFile({ path: `${root}/model.dot`, content: leaf.run.dot }),
        capturedFile({ path: `${root}/tlc.log`, content: leaf.run.log, volatile: true }),
        generated(`${root}/verification.json`, { ...leaf.run.evidence, generation: 'controlled-symbolic-model', scope: 'model-composition-only',
          project: persistentCapture(inspectSymbolicCapture(capture), role, id, project).project, semanticSha256: leaf.model.source.semanticSha256, runtimeDomain: leaf.runtimeDomain,
          orbitVerification: inspectSymbolicCapture(capture).orbit, inputVerification: 'input-verification.json', sourceArchive: 'sources.json' }),
      );
      contractEntries.push({ source: role, id, path: `${root}/verification.json` });
      logs.push(`${root}/tlc.log`, `${root}/input-oracle.log`);
    }
  }
  files.push(
    generated('comparison.json', persistentReport),
    generated('contract-graph.json', { schema: 'sgd-contract-graph-v1', scope: report.scope,
      baseline: { declarations: baseline.metadata.declarations, models: baseline.project.models },
      candidate: { declarations: candidate.metadata.declarations, models: candidate.project.models } }),
    generated('obligations.json', closure),
    generated('evidence-index.json', { schema: 'sgd-contract-evidence-index-v1', scope: report.scope,
      preservationGate: report.preservationGate, independentlySelectedBaseline: report.independentlySelectedBaseline,
      sourceArchives, metadata: metadataEntries, contracts: contractEntries, logs }),
  );
  const recheck = async () => {
    for (const capture of [...baselineModels.values(), ...candidateModels.values()]) await recheckSymbolicCapture(capture);
    await baseline.recheck(); await candidate.recheck(); await jar.recheck();
  };
  return { report, files, inputs, directories, metadataEntries, contractEntries, recheck };
}

/** Compare controlled sources against supplied baseline sources. This cannot satisfy a protected preservation gate. */
export async function compareContractProjects(input: CompareInput) {
  const collection = await collectContractComparison(input);
  await collection.recheck();
  return immutable(collection.report);
}
export type ContractComparisonReport = Awaited<ReturnType<typeof compareContractProjects>>;

/** Recompute the source comparison and publish only this invocation's captured evidence. */
export async function buildContractComparison(input: CompareInput & { out: string; check?: boolean }) {
  const location = await captureOutputLocation(input.out);
  const collection = await collectContractComparison(input);
  const outputInputs = { files: collection.files, inputs: collection.inputs, directories: collection.directories };
  await recheckOutputLocation(location, outputInputs);
  const prepared = await prepareArtifacts(collection.files);
  await collection.recheck();
  await recheckOutputLocation(location, { ...outputInputs, files: preparedFiles(prepared) });
  await writePreparedGenerated({ out: location.out, prepared, ...(input.check === undefined ? {} : { check: input.check }) });
  const check = input.check === true;
  return immutable({
    schema: 'sgd-contract-comparison-summary-v1', kind: 'managed-contract-comparison', operation: check ? 'check' : 'generate',
    scope: collection.report.scope, preservationGate: collection.report.preservationGate,
    independentlySelectedBaseline: collection.report.independentlySelectedBaseline,
    output: { directory: location.out, entries: ['comparison.json', 'contract-graph.json', 'obligations.json', 'evidence-index.json'] },
    verification: { invocation: 'completed', output: check ? 'checked' : 'generated', freshInvocationLogRetained: !check,
      dimensions: ['literal-root-metadata', 'required-obligation-closure', 'controlled-source-models', 'equality-copy-orbits',
        'original-action-oracles', 'supplied-baseline-properties', 'supplied-baseline-behavior', 'declared-model-composition'] },
    evidence: { index: join(location.out, 'evidence-index.json'),
      metadata: collection.metadataEntries.map(entry => ({ ...entry, path: join(location.out, entry.path) })),
      contractCounts: { baseline: collection.contractEntries.filter(entry => entry.source === 'baseline').length,
        candidate: collection.contractEntries.filter(entry => entry.source === 'candidate').length },
      logs: { freshness: check ? 'retained-output' : 'current-invocation', freshInvocationLogRetained: !check } },
  });
}
export type ContractComparisonSummary = Awaited<ReturnType<typeof buildContractComparison>>;
