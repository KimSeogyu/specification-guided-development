import { generateRetainedTypeScript } from './backends/retained-typescript.js';
import { validateRetainedOperation } from './retained-operation.js';
import { generateDomainTypeScript } from './backends/domain-typescript.js';
import { generateDomainRust } from './backends/domain-rust.js';
import { checkRustDomainArtifact } from './rust-domain-artifact.js';
import { validateDomainBinding } from './domain-validation.js';
import { verifyDomainProof } from './domain-proof.js';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { ProjectSchema, type GeneratedFile, type Project, type Automaton, type BackendInput, type Target } from './types.js';
import { importDot, sha256 } from './dot.js';
import { runTlc } from './tlc.js';
import { generateTypeScript } from './backends/typescript.js';
import { generateOwnedTypeScript } from './backends/owned-typescript.js';
import { MachineProjectSchema, validateExecutableGraph, type MachineProject, type OwnedBackendInput } from './finite-types.js';
import { importFiniteDot } from './finite-dot.js';
import { runControlledTlc, type ControlledTlcEvidence } from './finite-tlc.js';
import { ProductSymbolicProjectSchema, SymbolicProjectSchema, symbolicInputs, type SymbolicProject } from './symbolic-types.js';
import { captureSymbolicProject, inspectSymbolicProject, readSymbolicCaptureForCompiler, recheckSymbolicCapture } from './symbolic-capture.js';
import { generateSymbolicTypeScript } from './backends/symbolic-typescript.js';
import { z } from 'zod';
import { writePreparedGenerated } from './managed-output.js';
import { compilerFile, capturedFile, prepareArtifacts, preparedFiles, type ArtifactFile } from './artifacts.js';
import { summarizeBuild, summarizeGraph, type BuildAutomaton, type BuildReport, type CollectedEvidence, type GraphSummary, type VerificationCheck } from './build-report.js';
export { writeGenerated } from './managed-output.js';
export { StaleOutputError, StaleOutputDiagnosticSchema, type StaleOutputDiagnostic } from './output-check.js';
export { BuildSummarySchema, type BuildAutomaton, type BuildReport, type BuildSummary } from './build-report.js';

const backends = {
  typescript: generateTypeScript,
} satisfies Record<Target, (input: BackendInput) => GeneratedFile[]>;

const ownedBackends = {
  typescript: generateOwnedTypeScript,
} satisfies Record<Target, (input: OwnedBackendInput) => GeneratedFile[]>;

const ConfiguredProjectSchema = z.discriminatedUnion('version', [ProjectSchema, MachineProjectSchema, SymbolicProjectSchema, ProductSymbolicProjectSchema]);
function configuredProject(value: unknown) {
  const parsed = ConfiguredProjectSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw parsed.error;
}
export async function readProject(path: string): Promise<Project | MachineProject | SymbolicProject> {
  return configuredProject(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

export function compile(input: { dot: string; project: Project }): { automaton: Automaton; files: GeneratedFile[] } {
  ProjectSchema.parse(input.project);
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

export type BuildInput = { project: string; jar: string; out: string; lean?: string; check?: boolean; modelOnly?: boolean };
type ArtifactBase = { files: ArtifactFile[]; recheck: () => Promise<void>; graph: GraphSummary;
  checks: VerificationCheck[]; evidence: CollectedEvidence[] };
type CollectedArtifacts = ArtifactBase & { automaton: BuildAutomaton };

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

/** Compile into memory; only the public entry point publishes. */
async function collectArtifacts(input: BuildInput): Promise<CollectedArtifacts> {
  const projectPath = resolve(input.project);
  const projectBytes = await readFile(projectPath);
  const project = configuredProject(JSON.parse(projectBytes.toString('utf8')) as unknown);
  const role = 'model';
  const checks: VerificationCheck[] = [];
  const evidence: CollectedEvidence[] = [];
  const evidenceFile = <File extends ArtifactFile>(file: File, evidenceRole: CollectedEvidence['role']): File => {
    evidence.push({ file, role: evidenceRole }); return file;
  };
  const checkProjectUnchanged = async (): Promise<void> => {
    if (!projectBytes.equals(await readFile(projectPath))) throw new Error('TLC203: project configuration changed during verification; rerun against stable inputs');
  };
  if (project.version === 3 || project.version === 4) {
    const spec = resolve(dirname(projectPath), project.spec);
    const config = resolve(dirname(projectPath), project.config);
    const capture = input.modelOnly ? null : await captureSymbolicProject({ project: projectPath, jar: input.jar });
    const { run, model, orbitProof, differential, witness, runtimeDomain } = capture
      ? readSymbolicCaptureForCompiler(capture) : await inspectSymbolicProject({ project: projectPath, jar: input.jar });
    checks.push({ kind: 'controlled-tlc', role, profile: run.evidence.profile, scope: 'configured-bounded-witness',
      rootModule: run.evidence.rootModule, invariants: run.config.invariants, properties: run.config.properties, checkDeadlock: run.config.checkDeadlock });
    checks.push({ kind: 'symbolic-source', role, profile: model.version === 1 ? 'single-input' : 'disjoint-input-product',
      scope: 'accepted-SANY-equality-copy-grammar', inputs: [...symbolicInputs(model)] });
    if (orbitProof) checks.push({ kind: 'symbolic-orbit', role, profile: orbitProof.kind, scope: 'accepted-equality-copy-grammar',
      states: orbitProof.states.length, edges: orbitProof.edges.length, disabledCases: orbitProof.disabled.length,
      invariants: model.invariants.map(item => item.name), actionProperties: model.actionProperties.map(item => item.name), checkDeadlock: model.checkDeadlock });
    if (differential) checks.push({ kind: 'input-oracle', role, profile: differential.evidence.kind, scope: differential.evidence.scope,
      states: differential.evidence.stateCount, checkedCases: differential.evidence.checkedCases,
      acceptedCases: differential.evidence.acceptedCases, disabledCases: differential.evidence.disabledCases });
    const files: ArtifactFile[] = [
      compilerFile({ path: 'automaton.json', content: JSON.stringify(witness, null, 2) + '\n' }),
      compilerFile({ path: 'symbolic-model.json', content: JSON.stringify(model, null, 2) + '\n' }),
      compilerFile({ path: 'binding.json', content: JSON.stringify({ profile: project.profile, ...project.binding }, null, 2) + '\n' }),
      capturedFile({ path: 'semantic.xml', content: run.xml }),
      capturedFile({ path: 'model.dot', content: run.dot }),
      evidenceFile(capturedFile({ path: 'tlc.log', content: run.log, volatile: true }), 'log'),
    ];
    if (!input.modelOnly) for (const target of new Set(project.targets)) {
      const generated = generateSymbolicTypeScript({ model, className: project.binding.className });
      files.push(...generated.map(file => compilerFile({ ...file, path: `${target}/${file.path}` })));
    }
    if (orbitProof) files.push(evidenceFile(compilerFile({ path: 'orbit-proof.json', content: JSON.stringify(orbitProof, null, 2) + '\n' }), 'orbit'));
    if (differential) files.push(
      evidenceFile(compilerFile({ path: 'input-verification.json', content: JSON.stringify(differential.evidence, null, 2) + '\n' }), 'input-oracle'),
      evidenceFile(capturedFile({ path: 'input-oracle.dot', content: differential.oracleDot }), 'input-oracle'),
      evidenceFile(capturedFile({ path: 'input-oracle.log', content: differential.oracleLog, volatile: true }), 'log'),
    );
    const verification: GeneratedFile = { path: 'verification.json', content: JSON.stringify({
      ...run.evidence, projectSha256: sha256(projectBytes), semanticSha256: model.source.semanticSha256,
      ...(model.version === 2 ? { symbolicIrVersion: 2, inputProfile: 'disjoint-input-product-v1' } : {}),
      generation: input.modelOnly ? 'model-only' : 'symbolic-authority',
      runtimeDomain,
      orbitVerification: orbitProof ? { kind: orbitProof.kind, stateCount: orbitProof.states.length, edgeCount: orbitProof.edges.length, checkDeadlock: model.checkDeadlock, invariants: model.invariants.map(item => item.name), actionProperties: model.actionProperties.map(item => item.name) } : null,
    }, null, 2) + '\n', volatile: true, stableJsonKeys: ['kind', 'profile', 'extractor', 'xmlSha256', 'rootModule', 'moduleClosure', 'standardModules', 'configSha256', 'jarSha256', 'dotSha256', 'mode', 'projectSha256', 'semanticSha256',
      ...(model.version === 2 ? ['symbolicIrVersion', 'inputProfile'] : []), 'generation', 'runtimeDomain', 'orbitVerification'] };
    files.push(evidenceFile(compilerFile(verification), 'verification'));
    const recheck = async (): Promise<void> => {
      await checkProjectUnchanged();
      if (capture) await recheckSymbolicCapture(capture);
      else await recheckControlledInputs({ spec, config, jar: input.jar, evidence: run.evidence });

    };
    const report = { files, recheck, checks, evidence, graph: summarizeGraph(witness, 'model') };
    return { automaton: witness, ...report };
  }
  if (project.version === 2) {
    const spec = resolve(dirname(projectPath), project.spec); const config = resolve(dirname(projectPath), project.config);
    const run = await runControlledTlc({ spec, config, jar: input.jar }, 'finite-owned-v1');
    checks.push({ kind: 'controlled-tlc', role, profile: 'finite-owned-v1', scope: 'configured-finite-model',
      rootModule: run.evidence.rootModule, invariants: run.config.invariants, properties: run.config.properties, checkDeadlock: run.config.checkDeadlock });
    const model = { ...run, evidence: { kind: 'tlc-finite-completed', profile: 'finite-owned-v1', ...run.evidence } };
    const automaton = importFiniteDot({ dot: model.dot, name: project.name });
    if (!input.modelOnly) {
      validateExecutableGraph(automaton);
      checks.push({ kind: 'executable-graph', role, profile: 'finite-owned-v1', scope: 'per-live-object' });
      if (project.binding.operation !== undefined) {
        validateRetainedOperation({ automaton, className: project.binding.className, operation: project.binding.operation });
        checks.push({ kind: 'retained-operation', role, scope: 'one-borrowed-synchronous-callback', payload: 'retained-on-all-return-paths' });
      }
    }
    const files: ArtifactFile[] = [
      { path: 'automaton.json', content: JSON.stringify(automaton, null, 2) + '\n' },
      { path: 'binding.json', content: JSON.stringify({ profile: project.profile, ...project.binding }, null, 2) + '\n' },
    ].map(compilerFile);
    if (!input.modelOnly) {
      if (project.binding.domain !== undefined) {
        if (!input.lean) throw new Error('TLC208: domain generation requires --lean pointing to Lean 4.35.0');
        validateDomainBinding({ automaton, domain: project.binding.domain });
        const retained = project.binding.rust?.retainedVariable;
        if (retained !== undefined && (automaton.variables.find(variable => variable.name === retained)?.kind !== 'boolean' ||
            automaton.nodes.some(node => node.values[retained]?.kind !== 'boolean' || node.values[retained]?.value !== true))) {
          throw new Error('TLC208: Rust payload residency requires a Boolean variable that remains true in every reachable state');
        }
        const proof = await verifyDomainProof({ automaton, domain: project.binding.domain, lean: input.lean,
          ...(retained === undefined ? {} : { retainedVariable: retained }) });
        for (const file of proof.files) {
          const artifact = compilerFile({ ...file, ...(file.path.endsWith('.log') ? { volatile: true } : {}) });
          files.push(evidenceFile(artifact, file.path.endsWith('.log') ? 'log' : 'verification'));
        }
        checks.push({ kind: 'domain-protocol', role, scope: project.targets.includes('rust') ? 'per-live-owner-serial-ports' : 'per-live-owner-serial-async-ports',
          proof: 'lean4-kernel', leanVersion: '4.35.0', operations: project.binding.domain.operations.map(operation => operation.name),
          nativeBackend: 'not-formally-verified' });
      }
      for (const target of new Set(project.targets)) {
        const backendInput = { automaton, className: project.binding.className };
        const operation = project.binding.operation;
        const domain = project.binding.domain;
        const generated = target === 'rust'
          ? domain === undefined ? (() => { throw new Error('TLC208: Rust generation requires a domain binding'); })()
            : generateDomainRust({ ...backendInput, domain, ...(project.binding.rust === undefined ? {} : { retainedVariable: project.binding.rust.retainedVariable }) })
          : domain !== undefined ? generateDomainTypeScript({ ...backendInput, domain })
          : operation === undefined ? ownedBackends.typescript(backendInput)
          : generateRetainedTypeScript({ ...backendInput, operation });
        if (target === 'rust' && domain !== undefined) {
          const source = generated.find(file => file.path === 'src/lib.rs');
          if (source === undefined || typeof source.content !== 'string') throw new Error('TLC208: generated Rust source is missing');
          checkRustDomainArtifact({ source: source.content, automaton, domain, className: project.binding.className,
            ...(project.binding.rust === undefined ? {} : { retainedVariable: project.binding.rust.retainedVariable }) });
        }
        files.push(...generated.map(file => compilerFile({ ...file, path: `${target}/${file.path}` })));
      }
    }
    files.push(
      capturedFile({ path: 'model.dot', content: model.dot }),
      evidenceFile(capturedFile({ path: 'tlc.log', content: model.log, volatile: true }), 'log'),
      evidenceFile(compilerFile({ path: 'verification.json', content: JSON.stringify({ ...model.evidence, projectSha256: sha256(projectBytes) }, null, 2) + '\n', volatile: true,
        stableJsonKeys: ['kind', 'profile', 'rootModule', 'moduleClosure', 'standardModules', 'configSha256', 'jarSha256', 'dotSha256', 'projectSha256', 'mode'] }), 'verification'),
    );
    const recheck = async (): Promise<void> => {
      await checkProjectUnchanged();
      await recheckControlledInputs({ spec, config, jar: input.jar, evidence: run.evidence });
    };
    return { automaton, files, recheck, checks, evidence, graph: summarizeGraph(automaton, 'model') };
  }
  const model = await runTlc({ spec: resolve(dirname(projectPath), project.spec), config: resolve(dirname(projectPath), project.config), jar: input.jar });
  checks.push({ kind: 'legacy-tlc', role: 'model', scope: 'observed-possible-transitions' });
  const compiled = compile({ dot: model.dot, project });
  const files = (input.modelOnly ? compiled.files.filter(file => file.path === 'automaton.json' || file.path === 'binding.json') : compiled.files).map(compilerFile);
  files.push(
    capturedFile({ path: 'model.dot', content: model.dot }),
    evidenceFile(capturedFile({ path: 'tlc.log', content: model.log, volatile: true }), 'log'),
    evidenceFile(compilerFile({ path: 'verification.json', content: JSON.stringify(model.evidence, null, 2) + '\n', volatile: true,
      stableJsonKeys: ['kind', 'specSha256', 'configSha256', 'dotSha256'] }), 'verification'),
  );
  return { automaton: compiled.automaton, files, recheck: checkProjectUnchanged, checks, evidence, graph: summarizeGraph(compiled.automaton, 'model') };
}

export async function buildProjectReport(input: BuildInput): Promise<BuildReport> {
  const path = resolve(input.project);
  const bytes = await readFile(path);
  const project = configuredProject(JSON.parse(bytes.toString('utf8')) as unknown);
  const domainBuild = project.version === 2 && project.binding.domain !== undefined && !input.modelOnly;
  if (domainBuild && !input.lean) throw new Error('TLC208: domain generation requires --lean pointing to Lean 4.35.0');
  if (input.lean !== undefined && !domainBuild) throw new Error('TLC208: --lean is supported only for a domain build');
  const out = await physicalOutput(input.out);
  const artifact = await collectArtifacts({ ...input, out });
  const prepared = await prepareArtifacts(artifact.files);
  if (!bytes.equals(await readFile(path))) throw new Error('TLC203: project configuration changed before publication');
  await artifact.recheck();
  if (out !== await physicalOutput(input.out)) throw new Error('TLC103: output root changed during verification; rerun against stable paths');
  await writePreparedGenerated({ out, prepared, ...(input.check === undefined ? {} : { check: input.check }) });
  return { automaton: artifact.automaton, summary: summarizeBuild({ operation: input.modelOnly ? 'model' : 'build',
    out, check: input.check === true, graph: artifact.graph, files: preparedFiles(prepared), checks: artifact.checks, evidence: artifact.evidence }) };
}

export async function buildProject(input: BuildInput): Promise<BuildAutomaton> {
  return (await buildProjectReport(input)).automaton;
}
