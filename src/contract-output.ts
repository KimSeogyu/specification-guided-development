import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { GeneratedFile } from './types.js';
import { inventoryName, validateManagedOutputPaths } from './managed-output.js';

export interface CapturedInputLocation {
  readonly path: string;
  readonly physicalPath: string;
  readonly device: bigint;
  readonly inode: bigint;
}
export interface CapturedSourceDirectory { readonly path: string; readonly physicalPath: string }
export interface OutputLocation {
  readonly out: string;
  readonly lexicalPath: string;
  readonly ancestor: CapturedInputLocation;
  readonly suffix: readonly string[];
}
type OutputInputs = {
  files: readonly Pick<GeneratedFile, 'path'>[];
  inputs: readonly CapturedInputLocation[];
  directories: readonly CapturedSourceDirectory[];
};
const Inventory = z.object({ version: z.literal(1), files: z.array(z.string().min(1)) }).strict().superRefine((inventory, context) => {
  if (new Set(inventory.files).size !== inventory.files.length) context.addIssue({ code: 'custom', message: 'Duplicate managed output inventory path' });
});
const fail = (message: string): never => { throw new Error(`TLC103: ${message}`); };
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

function contains(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Capture the nearest existing directory without creating any output. */
export async function captureOutputLocation(out: string): Promise<OutputLocation> {
  const lexicalPath = resolve(out);
  let ancestor = lexicalPath;
  const suffix: string[] = [];
  for (;;) {
    try { await lstat(ancestor); break; }
    catch (error) {
      if (!missing(error)) throw error;
      suffix.unshift(basename(ancestor));
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  const physicalPath = await realpath(ancestor);
  const stat = await lstat(physicalPath, { bigint: true });
  if (!stat.isDirectory()) return fail('contract output must resolve through a directory');
  return Object.freeze({ lexicalPath, out: resolve(physicalPath, ...suffix), suffix: Object.freeze(suffix),
    ancestor: Object.freeze({ path: ancestor, physicalPath, device: stat.dev, inode: stat.ino }) });
}


/** The managed writer repeats its own descendant checks while holding its output lease. */
async function existingTarget(root: string, path: string, inputs: readonly CapturedInputLocation[]): Promise<boolean> {
  let current = root;
  for (const component of relative(root, path).split(sep)) {
    current = join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) return fail('managed contract output cannot traverse a symbolic link');
    } catch (error) { if (missing(error)) return false; throw error; }
  }
  const stat = await lstat(path, { bigint: true });
  if (!stat.isFile()) return fail('managed contract output must be a regular file');
  const physical = await realpath(path);
  if (inputs.some(input => stat.dev === input.device && stat.ino === input.inode || physical === input.physicalPath)) {
    return fail('managed contract output aliases a captured original input');
  }
  return true;
}

async function previousFiles(root: string, inputs: readonly CapturedInputLocation[]): Promise<string[]> {
  const inventory = join(root, inventoryName);
  if (!await existingTarget(root, inventory, inputs)) return [];
  try {
    const bytes = await readFile(inventory);
    return Inventory.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))).files;
  } catch (error) { return fail('invalid managed contract output inventory'); }
}

/** Repeat alias/overlap checks after preparation and original-input rechecks, before publication. */
export async function recheckOutputLocation(location: OutputLocation, input: OutputInputs): Promise<void> {
  const ancestor = location.ancestor;
  const physical = await realpath(ancestor.path);
  const stat = await lstat(physical, { bigint: true });
  if (!stat.isDirectory() || physical !== ancestor.physicalPath || stat.dev !== ancestor.device || stat.ino !== ancestor.inode) {
    return fail('contract output ancestor changed during verification');
  }
  if ((await captureOutputLocation(location.lexicalPath)).out !== location.out) return fail('contract output root changed during verification');
  const roots = [location.lexicalPath, location.out];
  for (const directory of input.directories) for (const source of [directory.path, directory.physicalPath]) for (const root of roots) {
    if (contains(root, source) || contains(source, root)) return fail('contract output overlaps a watched source directory; select a separate sibling output');
  }
  for (const original of input.inputs) for (const source of [original.path, original.physicalPath]) for (const root of roots) {
    if (contains(root, source)) return fail('contract output contains a captured original input');
  }
  const names = [...new Set([...input.files.map(file => file.path), ...await previousFiles(location.out, input.inputs)])];
  if (names.some(name => isAbsolute(name))) return fail('invalid managed contract artifact path');
  const paths = validateManagedOutputPaths(location.out, names);
  for (const path of paths) await existingTarget(location.out, path, input.inputs);
}
