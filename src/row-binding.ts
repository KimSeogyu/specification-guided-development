import { execFile } from 'node:child_process';
import { access, lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sha256 } from './dot.js';
import { RowBindingPlanSchema, RowBindingSchema, type RowBinding, type RowBindingPlan } from './row-binding-types.js';
import { sameSymbolicValue } from './symbolic-semantics.js';
import { type SymbolicModelV2, type SymbolicExpression, validateSymbolicModel } from './symbolic-types.js';

const execute = promisify(execFile);
const fail: (message: string) => never = message => { throw new Error(`TLC305: ${message}`); };
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

export type RowCopyOrigin = { kind: 'empty' } | { kind: 'input' } | { kind: 'state'; pair: string };

/** Whole-row lifting can copy a complete old/input row, never mix two rows. */
export function rowCopyOrigin(model: SymbolicModelV2, binding: RowBinding, pair: RowBinding['model']['pairs'][number], updates: Record<string, SymbolicExpression>): RowCopyOrigin {
  const payload = updates[pair.payload]; const provenance = updates[pair.provenance];
  if (!payload || !provenance) return fail('row pair is absent from a complete model update');
  if (payload.kind === 'literal' && provenance.kind === 'literal') {
    const emptyPayload = model.initial[pair.payload]; const emptyProvenance = model.initial[pair.provenance];
    if (emptyPayload && emptyProvenance && sameSymbolicValue(payload.value, emptyPayload) && sameSymbolicValue(provenance.value, emptyProvenance)) return { kind: 'empty' };
  }
  if (payload.kind === 'input' && provenance.kind === 'input' && 'parameter' in payload && 'parameter' in provenance &&
    payload.parameter === binding.model.payloadInput && provenance.parameter === binding.model.provenanceInput) return { kind: 'input' };
  if (payload.kind === 'state' && provenance.kind === 'state') {
    const source = binding.model.pairs.find(candidate => candidate.payload === payload.variable && candidate.provenance === provenance.variable);
    if (source) return { kind: 'state', pair: source.name };
  }
  return fail(`row pair ${pair.name} mixes payload/provenance origins; copy one complete input or old row`);
}

export function validateWholeRowBinding(input: { model: unknown; binding: unknown; plan: unknown }): { model: SymbolicModelV2; binding: RowBinding; plan: RowBindingPlan } {
  const model = validateSymbolicModel(input.model);
  if (model.version !== 2 || model.inputs.length !== 2) return fail('whole-row binding requires exactly two independently typed inputs');
  const bindingResult = RowBindingSchema.safeParse(input.binding);
  const planResult = RowBindingPlanSchema.safeParse(input.plan);
  if (!bindingResult.success) return fail(`invalid whole-row binding: ${bindingResult.error.issues.slice(0, 4).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}. Use source action identifiers directly; manual outcomes classification is unsupported`);
  if (!planResult.success) return fail(`invalid source analysis plan: ${planResult.error.issues.slice(0, 4).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  const binding = bindingResult.data; const plan = planResult.data;
  const inputNames = [binding.model.payloadInput, binding.model.provenanceInput];
  if (new Set(inputNames).size !== 2 || inputNames.some(name => !model.inputs.some(parameter => parameter.parameter === name))) return fail('payload and provenance must name the two distinct model inputs');
  const names = binding.model.pairs.map(pair => pair.name);
  if (new Set(names).size !== 2 || !names.includes('stored') || !names.includes('rejected')) return fail('whole-row pairs must have distinct stored and rejected roles');
  const variables = binding.model.pairs.flatMap(pair => [pair.payload, pair.provenance]);
  if (new Set(variables).size !== 4 || variables.some(variable => !model.variables.includes(variable))) return fail('row pairs must name four distinct model state variables');
  const actions = [...new Set(model.branches.map(branch => branch.action))];
  if (actions.some(action => !/^[A-Z][A-Za-z0-9]*$/.test(action) || action === 'Self')) return fail('whole-row source actions must have distinct UpperCamelCase identifiers for native result variants');
  if (plan.facts.length !== binding.source.facts.length || binding.source.facts.some(fact => {
    const analyzed = plan.facts.find(candidate => candidate.name === fact.name && candidate.rustPath === fact.rustPath);
    return !analyzed || new Set(fact.metadata).size !== fact.metadata.length ||
      fact.metadata.some(field => !analyzed.fields.some(candidate => candidate.name === field && candidate.provenance && !candidate.payload)) ||
      analyzed.fields.some(field => !field.payload && !fact.metadata.includes(field.name));
  })) return fail('analyzed facts and explicit excluded metadata do not match the source binding');
  if (new Set(binding.source.facts.map(fact => fact.name)).size !== binding.source.facts.length) return fail('source fact names must be unique');
  for (const pair of binding.model.pairs) for (const branch of model.branches) rowCopyOrigin(model, binding, pair, branch.updates);
  return { model, binding, plan };
}

export async function verifyRowSourcesUnchanged(application: string, plan: RowBindingPlan): Promise<void> {
  const root = await realpath(application);
  for (const source of plan.sources) {
    let path = root;
    for (const segment of source.path.split('/')) {
      path = join(path, segment);
      if ((await lstat(path)).isSymbolicLink()) return fail('source binding cannot traverse symlinks');
    }
    const resolved = await realpath(path);
    const rel = relative(root, resolved);
    if (rel.startsWith('..' + '/') || rel === '..' || isAbsolute(rel) || !(await lstat(path)).isFile()) return fail('source binding must remain within the application root');
    if (sha256(await readFile(path)) !== source.sha256) return fail(`source changed during binding generation: ${source.path}`);
  }
}

/** Parse Rust source without executing application code. A packaged native helper avoids toolchain setup. */
export async function analyzeRowBinding(input: { application: string; binding: RowBinding; out: string }): Promise<RowBindingPlan> {
  const application = await realpath(input.application);
  const directory = await mkdtemp(join(tmpdir(), 'sgd-row-binding-'));
  const bindingPath = join(directory, 'binding.json');
  try {
    await writeFile(bindingPath, JSON.stringify(input.binding), { mode: 0o400 });
    const binary = join(packageRoot, 'bin', `sgd-rust-bindings${process.platform === 'win32' ? '.exe' : ''}`);
    let executable = binary;
    const arguments_ = ['--root', application, '--binding', bindingPath, '--generated-root', resolve(input.out)];
    try { await access(binary); }
    catch {
      const manifest = join(packageRoot, 'tools/rust-bindings/Cargo.toml');
      try { await access(manifest); }
      catch { return fail('Rust binding analyzer is missing; rebuild the native plugin package'); }
      executable = 'cargo';
      arguments_.unshift('run', '--quiet', '--locked', '--manifest-path', manifest, '--target-dir', join(packageRoot, '.runtime/rust-binding-tool'), '--');
    }
    let output: string;
    try {
      const result = await execute(executable, arguments_, { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
      output = result.stdout;
    } catch (error) {
      const details = error instanceof Error && 'stderr' in error ? String(error.stderr).trim() : error instanceof Error ? error.message : String(error);
      return fail(`Rust source binding failed: ${details.slice(0, 4000)}`);
    }
    let raw: unknown;
    try { raw = JSON.parse(output) as unknown; }
    catch { return fail('Rust binding analyzer returned invalid JSON'); }
    const parsed = RowBindingPlanSchema.safeParse(raw);
    if (!parsed.success) return fail(`Rust binding analyzer returned an invalid plan: ${parsed.error.issues.slice(0, 4).map(issue => issue.message).join('; ')}`);
    await verifyRowSourcesUnchanged(application, parsed.data);
    return parsed.data;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
