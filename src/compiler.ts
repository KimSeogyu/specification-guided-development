import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { ProjectSchema, type GeneratedFile, type Project, type Automaton, type BackendInput, type Target } from './types.js';
import { importDot, sha256 } from './dot.js';
import { runTlc } from './tlc.js';
import { generateTypeScript } from './backends/typescript.js';
import { generateRust } from './backends/rust.js';
import { generateOwnedTypeScript } from './backends/owned-typescript.js';
import { generateOwnedRust } from './backends/owned-rust.js';
import { MachineProjectSchema, validateExecutableGraph, type MachineProject, type ExactFiniteAutomaton, type OwnedBackendInput } from './finite-types.js';
import { importFiniteDot } from './finite-dot.js';
import { runFiniteTlc } from './finite-tlc.js';
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
import { formatRowRust } from './rust-format.js';
import { z } from 'zod';
import { writeGenerated } from './managed-output.js';
export { writeGenerated } from './managed-output.js';

const backends = {
  typescript: generateTypeScript,
  rust: generateRust,
} satisfies Record<Target, (input: BackendInput) => GeneratedFile[]>;

const ownedBackends = {
  typescript: generateOwnedTypeScript,
  rust: generateOwnedRust,
} satisfies Record<Target, (input: OwnedBackendInput) => GeneratedFile[]>;

const ConfiguredProjectSchema = z.discriminatedUnion('version', [ProjectSchema, MachineProjectSchema, SymbolicProjectSchema, ProductSymbolicProjectSchema, RowProjectSchema]);
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
export async function readProject(path: string): Promise<Project | MachineProject | SymbolicProject | RowProject> {
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
  await writeGenerated({ out: input.out, files: [...compiled.files,
    { path: 'verification.json', content: JSON.stringify({ kind: 'imported-unverified', message: 'DOT alone does not establish TLC completion.' }, null, 2) + '\n' },
  ], ...(input.check === undefined ? {} : { check: input.check }) });
  return compiled.automaton;
}

export async function buildProject(input: { project: string; jar: string; out: string; check?: boolean; modelOnly?: boolean }): Promise<Automaton | ExactFiniteAutomaton | SymbolicWitnessGraph> {
  const projectPath = resolve(input.project);
  const projectBytes = await readFile(projectPath);
  const project = configuredProject(JSON.parse(projectBytes.toString('utf8')) as unknown);
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
    const files: GeneratedFile[] = [
      { path: 'automaton.json', content: JSON.stringify(witness, null, 2) + '\n' },
      { path: 'symbolic-model.json', content: JSON.stringify(model, null, 2) + '\n' },
      { path: 'binding.json', content: JSON.stringify({ profile: project.profile, ...project.binding }, null, 2) + '\n' },
      { path: 'semantic.xml', content: run.xml },
      { path: 'model.dot', content: run.dot },
      { path: 'tlc.log', content: run.log, volatile: true },
    ];
    const rowApplication = project.version === 5 ? resolve(dirname(projectPath), project.application) : null;
    const rowPlan = project.version === 5 && !input.modelOnly && rowApplication
      ? await analyzeRowBinding({ application: rowApplication, binding: project.binding.row, out: input.out }) : null;
    const row = project.version === 5 && rowPlan
      ? validateWholeRowBinding({ model, binding: project.binding.row, plan: rowPlan }) : null;
    let rowFormatter: Awaited<ReturnType<typeof formatRowRust>>['formatter'] | null = null;
    if (row) files.push({ path: 'row-binding-plan.json', content: JSON.stringify(row.plan, null, 2) + '\n' });
    if (!input.modelOnly) for (const target of new Set(project.targets)) {
      const generated = row && project.version === 5
        ? target === 'typescript' ? generateRowTypeScript({ ...row, className: project.binding.className })
          : generateRowRust({ ...row, className: project.binding.className, rustCrateMode: project.binding.rustCrateMode })
        : target === 'typescript' ? generateSymbolicTypeScript({ model, className: project.binding.className }) : generateSymbolicRust({ model, className: project.binding.className });
      const formatted = row && target === 'rust' ? await formatRowRust(generated) : null;
      if (formatted) rowFormatter = formatted.formatter;
      files.push(...(formatted?.files ?? generated).map(file => ({ path: `${target}/${file.path}`, content: file.content })));
    }
    if (orbitProof) files.push({ path: 'orbit-proof.json', content: JSON.stringify(orbitProof, null, 2) + '\n' });
    if (differential) files.push(
      { path: 'input-verification.json', content: JSON.stringify(differential.evidence, null, 2) + '\n' },
      { path: 'input-oracle.dot', content: differential.oracleDot },
      { path: 'input-oracle.log', content: differential.oracleLog, volatile: true },
    );
    files.push({ path: 'verification.json', content: JSON.stringify({
      ...run.evidence, projectSha256: sha256(projectBytes), semanticSha256: model.source.semanticSha256,
      ...(model.version === 2 ? { symbolicIrVersion: 2, inputProfile: 'disjoint-input-product-v1' } : {}),
      ...(project.version === 5 ? { rowBinding: row ? { profile: row.plan.profile, planSha256: sha256(JSON.stringify(row.plan)), sourceScope: 'production-library-and-audited-local-type-closure', sources: row.plan.sources,
        formatter: rowFormatter ? { profile: rowFormatter.profile, configSha256: rowFormatter.configSha256 } : null } : null,
        formatterVersion: rowFormatter?.version ?? null } : {}),
      generation: input.modelOnly ? 'model-only' : row ? 'whole-row-authority' : 'symbolic-authority',
      runtimeDomain,
      orbitVerification: orbitProof ? { kind: orbitProof.kind, stateCount: orbitProof.states.length, edgeCount: orbitProof.edges.length, checkDeadlock: model.checkDeadlock, invariants: model.invariants.map(item => item.name), actionProperties: model.actionProperties.map(item => item.name) } : null,
    }, null, 2) + '\n', volatile: true, stableJsonKeys: ['kind', 'profile', 'extractor', 'xmlSha256', 'rootModule', 'moduleClosure', 'standardModules', 'configSha256', 'jarSha256', 'dotSha256', 'mode', 'projectSha256', 'semanticSha256',
      ...(model.version === 2 ? ['symbolicIrVersion', 'inputProfile'] : []), ...(project.version === 5 ? ['rowBinding'] : []), 'generation', 'runtimeDomain', 'orbitVerification'] });
    await checkProjectUnchanged();
    if (row && rowApplication) await verifyRowSourcesUnchanged(rowApplication, row.plan);
    await writeGenerated({ out: input.out, files, ...(input.check === undefined ? {} : { check: input.check }) });
    return witness;
  }
  if (project.version === 2) {
    const model = await runFiniteTlc({ spec: resolve(dirname(projectPath), project.spec), config: resolve(dirname(projectPath), project.config), jar: input.jar });
    const automaton = importFiniteDot({ dot: model.dot, name: project.name });
    if (!input.modelOnly) validateExecutableGraph(automaton);
    const files: GeneratedFile[] = [
      { path: 'automaton.json', content: JSON.stringify(automaton, null, 2) + '\n' },
      { path: 'binding.json', content: JSON.stringify({ profile: project.profile, ...project.binding }, null, 2) + '\n' },
    ];
    if (!input.modelOnly) {
      for (const target of new Set(project.targets)) {
        const generated = ownedBackends[target]({ automaton, className: project.binding.className });
        files.push(...generated.map(file => ({ path: `${target}/${file.path}`, content: file.content })));
      }
    }
    await checkProjectUnchanged();
    await writeGenerated({ out: input.out, files: [...files,
      { path: 'model.dot', content: model.dot },
      { path: 'tlc.log', content: model.log, volatile: true },
      { path: 'verification.json', content: JSON.stringify({ ...model.evidence, projectSha256: sha256(projectBytes) }, null, 2) + '\n', volatile: true,
        stableJsonKeys: ['kind', 'profile', 'rootModule', 'moduleClosure', 'standardModules', 'configSha256', 'jarSha256', 'dotSha256', 'projectSha256', 'mode'] },
    ], ...(input.check === undefined ? {} : { check: input.check }) });
    return automaton;
  }
  const model = await runTlc({ spec: resolve(dirname(projectPath), project.spec), config: resolve(dirname(projectPath), project.config), jar: input.jar });
  const compiled = compile({ dot: model.dot, project });
  const files = input.modelOnly ? compiled.files.filter(file => file.path === 'automaton.json' || file.path === 'binding.json') : compiled.files;
  await checkProjectUnchanged();
  await writeGenerated({ out: input.out, files: [...files,
    { path: 'model.dot', content: model.dot },
    { path: 'tlc.log', content: model.log, volatile: true },
    { path: 'verification.json', content: JSON.stringify(model.evidence, null, 2) + '\n', volatile: true,
      stableJsonKeys: ['kind', 'specSha256', 'configSha256', 'dotSha256'] },
  ], ...(input.check === undefined ? {} : { check: input.check }) });
  return compiled.automaton;
}
