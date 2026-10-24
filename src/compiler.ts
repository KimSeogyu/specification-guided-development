import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { ProjectSchema, type GeneratedFile, type Project, type Automaton, type BackendInput, type Target } from './types.js';
import { importDot, sha256 } from './dot.js';
import { runTlc } from './tlc.js';
import { generateTypeScript } from './backends/typescript.js';
import { generateRust } from './backends/rust.js';
import { generateOwnedTypeScript } from './backends/owned-typescript.js';
import { generateOwnedRust } from './backends/owned-rust.js';
import { MachineProjectSchema, validateExecutableGraph, type MachineProject, type ExactFiniteAutomaton, type OwnedBackendInput } from './finite-types.js';
import { importFiniteDot } from './finite-dot.js';
import { runControlledTlc, type ControlledTlcEvidence } from './finite-tlc.js';
import { ProductSymbolicProjectSchema, SymbolicProjectSchema, symbolicInputs, type SymbolicProject } from './symbolic-types.js';
import { runSymbolicTlc } from './symbolic-tlc.js';
import { parseSanyXml } from './sany-xml.js';
import { lowerSymbolicModel } from './symbolic-lower.js';
import { inspectSymbolicOrbits } from './symbolic-semantics.js';
import { importSymbolicDot, verifySymbolicWitness, type SymbolicWitnessGraph } from './symbolic-witness.js';
import { generateSymbolicTypeScript } from './backends/symbolic-typescript.js';
import { generateSymbolicRust } from './backends/symbolic-rust.js';
import { RowProjectSchema, type RowProject } from './row-binding-types.js';
import { analyzeRowBinding, validateWholeRowBinding, verifyRowSourcesUnchanged } from './row-binding.js';
import { generateRowRust } from './backends/row-rust.js';
import { generateRowTypeScript } from './backends/row-typescript.js';
import { z } from 'zod';
import { writePreparedGenerated } from './managed-output.js';
import { compilerFile, capturedFile, formatterReceipt, prepareArtifacts, type ArtifactFile } from './artifacts.js';
import { PartitionProjectSchema, type PartitionProject, type PartitionPlan } from './partition-types.js';
import { readPartitionContract } from './partition-contract.js';
import { validatePartitionPlan, validatePartitionControlSource } from './partition-composition.js';
import { generatePartitionRust } from './backends/partition-rust.js';
import { generatePartitionTypeScript } from './backends/partition-typescript.js';
export { writeGenerated } from './managed-output.js';
export { StaleOutputError, StaleOutputDiagnosticSchema, type StaleOutputDiagnostic } from './output-check.js';

const backends = {
  typescript: generateTypeScript,
  rust: generateRust,
} satisfies Record<Target, (input: BackendInput) => GeneratedFile[]>;

const ownedBackends = {
  typescript: generateOwnedTypeScript,
  rust: generateOwnedRust,
} satisfies Record<Target, (input: OwnedBackendInput) => GeneratedFile[]>;

const ConfiguredProjectSchema = z.discriminatedUnion('version', [ProjectSchema, MachineProjectSchema, SymbolicProjectSchema, ProductSymbolicProjectSchema, RowProjectSchema, PartitionProjectSchema]);
function configuredProject(value: unknown) {
  const parsed = ConfiguredProjectSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (typeof value === 'object' && value !== null && 'version' in value && value.version === 5) {
    const issues = parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    const hint = parsed.error.issues.some(issue => issue.code === 'unrecognized_keys' && issue.keys.includes('outcomes'))
      ? ' Remove outcomes; generated results use source action identifiers directly.' : '';
    throw new Error(`TLC305: invalid row-owned project: ${issues}.${hint}`);
  }
  throw parsed.error;
}
export async function readProject(path: string): Promise<Project | MachineProject | SymbolicProject | RowProject | PartitionProject> {
  return configuredProject(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

export function compile(input: { dot: string; project: Project }): { automaton: Automaton; files: GeneratedFile[] } {
  const automaton = importDot({ dot: input.dot, name: input.project.name, stateVariable: input.project.stateVariable });
  if (input.project.parent) automaton.parent = input.project.parent;
  if (input.project.binding.kind === 'dependency') {
    const mapped = Object.keys(input.project.binding.modules);
    if (mapped.length !== automaton.states.length || mapped.some(name => !automaton.states.includes(name))) {
      throw new Error('TLC103: dependency binding must map every projected state exactly once');
    }
    for (const paths of Object.values(input.project.binding.modules)) {
      for (const path of paths) {
        if (isAbsolute(path) || path.split(/[\\/]/).includes('..') || path.includes('\\')) {
          throw new Error('TLC103: module paths must be project-relative paths without parent traversal');
        }
      }
    }
  }
  const files: GeneratedFile[] = [
    { path: 'automaton.json', content: JSON.stringify(automaton, null, 2) + '\n' },
    { path: 'binding.json', content: JSON.stringify(input.project.binding, null, 2) + '\n' },
  ];
  for (const target of new Set(input.project.targets)) {
    const generated = backends[target]({ automaton, binding: input.project.binding });
    files.push(...generated.map(file => ({ path: `${target}/${file.path}`, content: file.content })));
  }
  return { automaton, files };
}

export async function compileProject(input: { project: string; dot: string; out: string; check?: boolean }): Promise<Automaton> {
  const project = await readProject(input.project);
  if (project.version !== 1) throw new Error(`TLC206: imported DOT cannot generate ${project.profile} authority. Use build with the pinned TLC JAR and model sources.`);
  const compiled = compile({ dot: await readFile(input.dot, 'utf8'), project });
  const prepared = await prepareArtifacts([...compiled.files,
    { path: 'verification.json', content: JSON.stringify({ kind: 'imported-unverified', message: 'DOT alone does not establish TLC completion.' }, null, 2) + '\n' },
  ].map(compilerFile));
  await writePreparedGenerated({ out: input.out, prepared, ...(input.check === undefined ? {} : { check: input.check }) });
  return compiled.automaton;
}

type BuildInput = { project: string; jar: string; out: string; check?: boolean; modelOnly?: boolean };
type BuildAutomaton = Automaton | ExactFiniteAutomaton | SymbolicWitnessGraph;
type ArtifactBase = { files: ArtifactFile[]; recheck: () => Promise<void> };
type LegacyArtifacts = ArtifactBase & (
  | { kind: 'row'; automaton: SymbolicWitnessGraph; row: ReturnType<typeof validateWholeRowBinding> }
  | { kind: 'finite'; automaton: ExactFiniteAutomaton; run: Awaited<ReturnType<typeof runControlledTlc>> }
  | { kind: 'model'; automaton: BuildAutomaton }
);

async function recheckControlledInputs(input: { spec: string; config: string; jar: string; evidence: ControlledTlcEvidence }): Promise<void> {
  const expected = [...input.evidence.moduleClosure.map(module => ({ path: resolve(dirname(input.spec), module.name), sha256: module.sha256 })),
    { path: resolve(input.config), sha256: input.evidence.configSha256 }, { path: resolve(input.jar), sha256: input.evidence.jarSha256 }];
  for (const file of expected) {
    if (!(await lstat(file.path)).isFile() || sha256(await readFile(file.path)) !== file.sha256) throw new Error('TLC203: original controlled model inputs changed before publication');
  }
}

/** Resolve even a missing output through its nearest existing ancestor. */
async function physicalOutput(path: string): Promise<string> {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try { await lstat(ancestor); break; }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      suffix.unshift(basename(ancestor));
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  return resolve(await realpath(ancestor), ...suffix);
}

/** Compile references into memory; only the public entry point publishes. */
async function collectLegacyArtifacts(input: BuildInput & { generateBackends?: boolean; rowApplicationRoot?: string }): Promise<LegacyArtifacts> {
  const projectPath = resolve(input.project);
  const projectBytes = await readFile(projectPath);
  const project = configuredProject(JSON.parse(projectBytes.toString('utf8')) as unknown);
  if (project.version === 6) throw new Error('TLC306: partition model references must be row-owned v5 and finite-owned v2 projects');
  const checkProjectUnchanged = async (): Promise<void> => {
    if (!projectBytes.equals(await readFile(projectPath))) throw new Error('TLC203: project configuration changed during verification; rerun against stable inputs');
  };
  if (project.version === 3 || project.version === 4 || project.version === 5) {
    const spec = resolve(dirname(projectPath), project.spec);
    const config = resolve(dirname(projectPath), project.config);
    const run = await runSymbolicTlc({ spec, config, jar: input.jar });
    const model = lowerSymbolicModel({ name: project.name, semantic: parseSanyXml(run.xml), config: run.config,
      profile: project.version === 3 ? 'single' : 'product' });
    const orbitProof = input.modelOnly ? null : inspectSymbolicOrbits(model);
    const differential = input.modelOnly ? null : await verifySymbolicWitness({ model, run, spec, config, jar: input.jar });
    const inputs = symbolicInputs(model);
    const domains: Record<string, string[]> = Object.fromEntries(inputs.map(({ domain }) => {
      const configured = run.config.constants[domain];
      if (configured?.kind !== 'set') throw new Error('TLC301: missing symbolic input domain');
      const atoms = configured.values.map(value => {
        if (value.kind !== 'model-value') throw new Error('TLC301: symbolic witness requires model atoms');
        return value.value;
      });
      return [domain, atoms];
    }));
    const firstInput = inputs[0];
    if (!firstInput) throw new Error('TLC301: symbolic model has no input');
    const firstAtoms = domains[firstInput.domain];
    if (!firstAtoms) throw new Error('TLC301: missing symbolic witness input domain');
    const witness = differential?.witness ?? (model.version === 1
      ? importSymbolicDot({ dot: run.dot, name: model.name, domain: firstInput.domain, atoms: firstAtoms })
      : importSymbolicDot({ dot: run.dot, name: model.name, domains }));
    const runtimeDomain = model.version === 1
      ? { kind: 'untyped-opaque-unicode-string-identities', constant: firstInput.domain, finiteWitnessAtoms: firstAtoms }
      : { kind: 'disjoint-untyped-opaque-unicode-string-identities', inputs,
        domains: Object.fromEntries(Object.entries(domains).map(([domain, atoms]) => [domain, { finiteWitnessAtoms: atoms }])) };
    const files: ArtifactFile[] = [
      compilerFile({ path: 'automaton.json', content: JSON.stringify(witness, null, 2) + '\n' }),
      compilerFile({ path: 'symbolic-model.json', content: JSON.stringify(model, null, 2) + '\n' }),
      compilerFile({ path: 'binding.json', content: JSON.stringify({ profile: project.profile, ...project.binding }, null, 2) + '\n' }),
      capturedFile({ path: 'semantic.xml', content: run.xml }),
      capturedFile({ path: 'model.dot', content: run.dot }),
      capturedFile({ path: 'tlc.log', content: run.log, volatile: true }),
    ];
    const rowApplication = project.version === 5 ? input.rowApplicationRoot ?? await realpath(resolve(dirname(projectPath), project.application)) : null;
    const rowPlan = project.version === 5 && !input.modelOnly && rowApplication
      ? await analyzeRowBinding({ application: rowApplication, binding: project.binding.row, out: input.out }) : null;
    const row = project.version === 5 && rowPlan
      ? validateWholeRowBinding({ model, binding: project.binding.row, plan: rowPlan }) : null;
    if (row) files.push(compilerFile({ path: 'row-binding-plan.json', content: JSON.stringify(row.plan, null, 2) + '\n' }));
    if (!input.modelOnly && input.generateBackends !== false) for (const target of new Set(project.targets)) {
      const generated = row && project.version === 5
        ? target === 'typescript' ? generateRowTypeScript({ ...row, className: project.binding.className })
          : generateRowRust({ ...row, className: project.binding.className, rustCrateMode: project.binding.rustCrateMode })
        : target === 'typescript' ? generateSymbolicTypeScript({ model, className: project.binding.className }) : generateSymbolicRust({ model, className: project.binding.className });
      files.push(...generated.map(file => compilerFile({ ...file, path: `${target}/${file.path}` })));
    }
    if (orbitProof) files.push(compilerFile({ path: 'orbit-proof.json', content: JSON.stringify(orbitProof, null, 2) + '\n' }));
    if (differential) files.push(
      compilerFile({ path: 'input-verification.json', content: JSON.stringify(differential.evidence, null, 2) + '\n' }),
      capturedFile({ path: 'input-oracle.dot', content: differential.oracleDot }),
      capturedFile({ path: 'input-oracle.log', content: differential.oracleLog, volatile: true }),
    );
    const verification: GeneratedFile = { path: 'verification.json', content: JSON.stringify({
      ...run.evidence, projectSha256: sha256(projectBytes), semanticSha256: model.source.semanticSha256,
      ...(model.version === 2 ? { symbolicIrVersion: 2, inputProfile: 'disjoint-input-product-v1' } : {}),
      ...(project.version === 5 ? { rowBinding: row ? { profile: row.plan.profile, planSha256: sha256(JSON.stringify(row.plan)), sourceScope: 'production-library-and-audited-local-type-closure', sources: row.plan.sources,
        formatter: null } : null,
        formatterVersion: null } : {}),
      generation: input.modelOnly ? 'model-only' : row ? 'whole-row-authority' : 'symbolic-authority',
      runtimeDomain,
      orbitVerification: orbitProof ? { kind: orbitProof.kind, stateCount: orbitProof.states.length, edgeCount: orbitProof.edges.length, checkDeadlock: model.checkDeadlock, invariants: model.invariants.map(item => item.name), actionProperties: model.actionProperties.map(item => item.name) } : null,
    }, null, 2) + '\n', volatile: true, stableJsonKeys: ['kind', 'profile', 'extractor', 'xmlSha256', 'rootModule', 'moduleClosure', 'standardModules', 'configSha256', 'jarSha256', 'dotSha256', 'mode', 'projectSha256', 'semanticSha256',
      ...(model.version === 2 ? ['symbolicIrVersion', 'inputProfile'] : []), ...(project.version === 5 ? ['rowBinding'] : []), 'generation', 'runtimeDomain', 'orbitVerification'] };
    files.push(row && input.generateBackends !== false ? formatterReceipt(verification, 'row-binding') : compilerFile(verification));
    const recheck = async (): Promise<void> => {
      await checkProjectUnchanged();
      await recheckControlledInputs({ spec, config, jar: input.jar, evidence: run.evidence });
      if (row && rowApplication && project.version === 5) {
        if (await realpath(resolve(dirname(projectPath), project.application)) !== rowApplication) throw new Error('TLC305: row application root changed during verification');
        await verifyRowSourcesUnchanged(rowApplication, row.plan);
      }
    };
    return row ? { kind: 'row', automaton: witness, files, recheck, row } : { kind: 'model', automaton: witness, files, recheck };
  }
  if (project.version === 2) {
    const spec = resolve(dirname(projectPath), project.spec); const config = resolve(dirname(projectPath), project.config);
    const run = await runControlledTlc({ spec, config, jar: input.jar }, 'finite-owned-v1');
    const model = { ...run, evidence: { kind: 'tlc-finite-completed', profile: 'finite-owned-v1', ...run.evidence } };
    const automaton = importFiniteDot({ dot: model.dot, name: project.name });
    if (!input.modelOnly) validateExecutableGraph(automaton);
    const files: ArtifactFile[] = [
      { path: 'automaton.json', content: JSON.stringify(automaton, null, 2) + '\n' },
      { path: 'binding.json', content: JSON.stringify({ profile: project.profile, ...project.binding }, null, 2) + '\n' },
    ].map(compilerFile);
    if (!input.modelOnly && input.generateBackends !== false) {
      for (const target of new Set(project.targets)) {
        const generated = ownedBackends[target]({ automaton, className: project.binding.className });
        files.push(...generated.map(file => compilerFile({ ...file, path: `${target}/${file.path}` })));
      }
    }
    files.push(
      capturedFile({ path: 'model.dot', content: model.dot }),
      capturedFile({ path: 'tlc.log', content: model.log, volatile: true }),
      compilerFile({ path: 'verification.json', content: JSON.stringify({ ...model.evidence, projectSha256: sha256(projectBytes) }, null, 2) + '\n', volatile: true,
        stableJsonKeys: ['kind', 'profile', 'rootModule', 'moduleClosure', 'standardModules', 'configSha256', 'jarSha256', 'dotSha256', 'projectSha256', 'mode'] }),
    );
    const recheck = async (): Promise<void> => {
      await checkProjectUnchanged();
      await recheckControlledInputs({ spec, config, jar: input.jar, evidence: run.evidence });
    };
    return { kind: 'finite', automaton, files, recheck, run };
  }
  const model = await runTlc({ spec: resolve(dirname(projectPath), project.spec), config: resolve(dirname(projectPath), project.config), jar: input.jar });
  const compiled = compile({ dot: model.dot, project });
  const files = (input.modelOnly ? compiled.files.filter(file => file.path === 'automaton.json' || file.path === 'binding.json') : compiled.files).map(compilerFile);
  files.push(
    capturedFile({ path: 'model.dot', content: model.dot }),
    capturedFile({ path: 'tlc.log', content: model.log, volatile: true }),
    compilerFile({ path: 'verification.json', content: JSON.stringify(model.evidence, null, 2) + '\n', volatile: true,
      stableJsonKeys: ['kind', 'specSha256', 'configSha256', 'dotSha256'] }),
  );
  return { kind: 'model', automaton: compiled.automaton, files, recheck: checkProjectUnchanged };
}

export async function buildProject(input: BuildInput): Promise<BuildAutomaton> {
  const path = resolve(input.project);
  const bytes = await readFile(path);
  const project = configuredProject(JSON.parse(bytes.toString('utf8')) as unknown);
  const out = await physicalOutput(input.out);
  const artifact = project.version === 6
    ? await collectPartitionArtifacts({ ...input, out, projectPath: path, projectBytes: bytes, project })
    : await collectLegacyArtifacts({ ...input, out });
  const prepared = await prepareArtifacts(artifact.files);
  if (!bytes.equals(await readFile(path))) throw new Error('TLC203: project configuration changed before publication');
  await artifact.recheck();
  if (out !== await physicalOutput(input.out)) throw new Error('TLC103: output root changed during verification; rerun against stable paths');
  await writePreparedGenerated({ out, prepared, ...(input.check === undefined ? {} : { check: input.check }) });
  return artifact.automaton;
}

async function collectPartitionArtifacts(input: Omit<BuildInput, 'project'> & { projectPath: string; projectBytes: Buffer; project: PartitionProject }): Promise<ArtifactBase & { automaton: ExactFiniteAutomaton }> {
  if (input.modelOnly) throw new Error('TLC306: partition-fold requires build; use the referenced row and control projects for model-only inspection');
  const directory = dirname(input.projectPath);
  const rowPath = resolve(directory, input.project.models.row.project);
  const controlPath = resolve(directory, input.project.models.control.project);
  const readReference = async (path: string): Promise<Buffer> => {
    if (!(await lstat(path)).isFile()) throw new Error('TLC306: partition project references must be regular original files');
    return readFile(path);
  };
  const rowBytes = await readReference(rowPath); const controlBytes = await readReference(controlPath);
  const rowProject = configuredProject(JSON.parse(rowBytes.toString('utf8')) as unknown);
  const controlProject = configuredProject(JSON.parse(controlBytes.toString('utf8')) as unknown);
  if (rowProject.version !== 5 || controlProject.version !== 2) throw new Error('TLC306: partition references require a row-owned v5 project and finite-owned v2 control');
  const application = await realpath(resolve(directory, input.project.application));
  if (application !== await realpath(resolve(dirname(rowPath), rowProject.application))) throw new Error('TLC306: partition and row projects must bind the same application');
  const row = await collectLegacyArtifacts({ project: rowPath, jar: input.jar, out: input.out, generateBackends: false, rowApplicationRoot: application });
  const control = await collectLegacyArtifacts({ project: controlPath, jar: input.jar, out: input.out, generateBackends: false });
  if (row.kind !== 'row' || control.kind !== 'finite') throw new Error('TLC306: partition model references did not produce the required checked artifacts');
  validatePartitionControlSource(control.run);
  const metadata = await readPartitionContract({ spec: resolve(directory, input.project.models.families.spec), operator: input.project.models.families.operator, jar: input.jar });
  const plan: PartitionPlan = validatePartitionPlan({ version: 1, kind: 'closed-partition-fold', runtimeProfile: 'unbound-partition-v1',
    row: row.row, control: control.automaton, contract: metadata.contract });
  const files: ArtifactFile[] = [
    compilerFile({ path: 'partition-plan.json', content: JSON.stringify(plan, null, 2) + '\n' }),
    compilerFile({ path: 'automaton.json', content: JSON.stringify(control.automaton, null, 2) + '\n' }),
    compilerFile({ path: 'symbolic-model.json', content: JSON.stringify(plan.row.model, null, 2) + '\n' }),
    compilerFile({ path: 'row-binding-plan.json', content: JSON.stringify(plan.row.plan, null, 2) + '\n' }),
    compilerFile({ path: 'binding.json', content: JSON.stringify({ profile: 'partition-fold', ...input.project.binding }, null, 2) + '\n' }),
    ...row.files.map(file => ({ ...file, path: `models/row/${file.path}` })),
    ...control.files.map(file => ({ ...file, path: `models/control/${file.path}` })),
    capturedFile({ path: 'models/control/semantic.xml', content: control.run.xml }),
    capturedFile({ path: 'models/families/semantic.xml', content: metadata.xml }),
    capturedFile({ path: 'models/families/tlc.log', content: metadata.log, volatile: true }),
  ];
  for (const target of new Set(input.project.targets)) {
    const backendInput = { plan, className: input.project.binding.className, rustCrateMode: input.project.binding.rustCrateMode };
    const generated = target === 'rust' ? generatePartitionRust(backendInput) : generatePartitionTypeScript(backendInput);
    files.push(...generated.map(file => compilerFile({ ...file, path: `${target}/${file.path}` })));
  }
  const receipt = {
    kind: 'controlled-partition-fold', profile: 'unbound-partition-v1', generation: 'closed-data-fold',
    projectSha256: sha256(input.projectBytes), planSha256: sha256(JSON.stringify(plan)),
    references: { rowProjectSha256: sha256(rowBytes), controlProjectSha256: sha256(controlBytes), familiesSha256: metadata.source.sha256 },
    sourceScope: 'production-library-and-audited-local-type-closure',
    contract: metadata.contract, source: plan.row.plan.sources,
    control: control.run.evidence, metadata: metadata.evidence,
    formatter: null,
    formatterVersion: null,
    storageAuthority: false,
  };
  files.push(formatterReceipt({ path: 'verification.json', content: JSON.stringify(receipt, null, 2) + '\n', volatile: true,
    stableJsonKeys: Object.keys(receipt).filter(key => key !== 'formatterVersion') }, 'root'));
  const recheck = async (): Promise<void> => {
    if (application !== await realpath(resolve(directory, input.project.application)) ||
      application !== await realpath(resolve(dirname(rowPath), rowProject.application))) throw new Error('TLC306: partition application root changed during verification');
    if (!rowBytes.equals(await readReference(rowPath)) || !controlBytes.equals(await readReference(controlPath))) throw new Error('TLC306: partition model references changed during verification');
    await row.recheck(); await control.recheck(); await metadata.recheck();
  };
  return { automaton: control.automaton, files, recheck };
}
