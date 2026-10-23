import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ProjectSchema, type GeneratedFile, type Project, type Automaton, type BackendInput, type Target } from './types.js';
import { importDot } from './dot.js';
import { runTlc } from './tlc.js';
import { generateTypeScript } from './backends/typescript.js';
import { generateRust } from './backends/rust.js';
import { z } from 'zod';

const backends = {
  typescript: generateTypeScript,
  rust: generateRust,
} satisfies Record<Target, (input: BackendInput) => GeneratedFile[]>;

export async function readProject(path: string): Promise<Project> {
  return ProjectSchema.parse(JSON.parse(await readFile(path, 'utf8')));
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

export async function writeGenerated(input: { out: string; files: GeneratedFile[]; check?: boolean }): Promise<void> {
  await mkdir(input.out, { recursive: true });
  const root = await realpath(input.out);
  const lockPath = join(root, '.sgd-output.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) { throw new Error('TLC103: output directory is locked. Use a separate output directory for concurrent builds.', { cause: error }); }
  try { await writeManaged({ ...input, out: root }); }
  finally { await lock.close(); await rm(lockPath, { force: true }); }
}

async function writeManaged(input: { out: string; files: GeneratedFile[]; check?: boolean }): Promise<void> {
  await mkdir(input.out, { recursive: true });
  const root = await realpath(input.out);
  const inventoryName = '.sgd-generated.json';
  const Inventory = z.object({ version: z.literal(1), files: z.array(z.string().min(1)) }).strict();
  function outputPath(name: string): string {
    const path = resolve(root, name);
    const rel = relative(root, path);
    if (!name || rel === '..' || rel.startsWith('../') || isAbsolute(rel) || name === inventoryName || name === '.sgd-output.lock') {
      throw new Error('TLC103: invalid output path');
    }
    return path;
  }
  async function rejectSymlinks(name: string): Promise<void> {
    const components = relative(root, outputPath(name)).split('/');
    let current = root;
    for (const part of components) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error('TLC103: generated output cannot traverse a symbolic link');
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
        throw error;
      }
    }
  }
  const wanted = input.files.map(file => file.path).sort();
  if (new Set(wanted).size !== wanted.length) throw new Error('TLC103: duplicate output file');
  for (const name of wanted) await rejectSymlinks(name);
  const inventoryPath = join(root, inventoryName);
  let previous: string[] = [];
  try {
    if ((await lstat(inventoryPath)).isSymbolicLink()) throw new Error('TLC103: output inventory cannot be a symbolic link');
    previous = Inventory.parse(JSON.parse(await readFile(inventoryPath, 'utf8'))).files;
    for (const name of previous) await rejectSymlinks(name);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    if ((await readdir(root)).some(name => name !== '.sgd-output.lock')) throw new Error('TLC103: output directory has no generated-file inventory. Use an empty directory.');
  }
  if (input.check && JSON.stringify([...previous].sort()) !== JSON.stringify(wanted)) {
    throw new Error('TLC104: generated output set changed');
  }
  if (!input.check) {
    for (const name of wanted) {
      if (previous.includes(name)) continue;
      try {
        await lstat(outputPath(name));
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
        throw error;
      }
      throw new Error(`TLC103: refusing to overwrite unowned output file ${name}`);
    }
  }
  for (const file of input.files) {
    const path = outputPath(file.path);
    if (input.check) {
      let current: string;
      try { current = await readFile(path, 'utf8'); } catch { throw new Error(`TLC104: missing generated file ${file.path}`); }
      if (file.stableJsonKeys) {
        const actual = z.record(z.unknown()).parse(JSON.parse(current));
        const expected = z.record(z.unknown()).parse(JSON.parse(file.content));
        for (const key of file.stableJsonKeys) {
          if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key])) throw new Error(`TLC104: stale receipt field ${key}`);
        }
      }
      if (!file.volatile && current !== file.content) throw new Error(`TLC104: stale generated file ${file.path}`);
    } else {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.sgd-tmp-${process.pid}`;
      try { await writeFile(temporary, file.content, { flag: 'wx' }); await rename(temporary, path); }
      finally { await rm(temporary, { force: true }); }
    }
  }
  if (!input.check) {
    for (const name of previous) if (!wanted.includes(name)) await rm(outputPath(name), { force: true });
    await writeFile(inventoryPath, JSON.stringify({ version: 1, files: wanted }, null, 2) + '\n');
  }
}

export async function compileProject(input: { project: string; dot: string; out: string; check?: boolean }): Promise<Automaton> {
  const project = await readProject(input.project);
  const compiled = compile({ dot: await readFile(input.dot, 'utf8'), project });
  await writeGenerated({ out: input.out, files: [...compiled.files,
    { path: 'verification.json', content: JSON.stringify({ kind: 'imported-unverified', message: 'DOT alone does not establish TLC completion.' }, null, 2) + '\n' },
  ], ...(input.check === undefined ? {} : { check: input.check }) });
  return compiled.automaton;
}

export async function buildProject(input: { project: string; jar: string; out: string; check?: boolean; modelOnly?: boolean }): Promise<Automaton> {
  const projectPath = resolve(input.project);
  const project = await readProject(projectPath);
  const model = await runTlc({ spec: resolve(dirname(projectPath), project.spec), config: resolve(dirname(projectPath), project.config), jar: input.jar });
  const compiled = compile({ dot: model.dot, project });
  const files = input.modelOnly ? compiled.files.filter(file => file.path === 'automaton.json' || file.path === 'binding.json') : compiled.files;
  await writeGenerated({ out: input.out, files: [...files,
    { path: 'model.dot', content: model.dot },
    { path: 'tlc.log', content: model.log, volatile: true },
    { path: 'verification.json', content: JSON.stringify(model.evidence, null, 2) + '\n', volatile: true,
      stableJsonKeys: ['kind', 'specSha256', 'configSha256', 'dotSha256'] },
  ], ...(input.check === undefined ? {} : { check: input.check }) });
  return compiled.automaton;
}
