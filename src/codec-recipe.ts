import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { z } from 'zod';
import { CodecRecipeBindingSchema, CodecRecipeReportSchema, type CodecRecipeBinding, type CodecRecipeReport } from './codec-recipe-types.js';

const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const fail: (message: string) => never = message => { throw new Error(`TLC309: ${message}`); };
type AnalysisContext = { requestedApplication: string; canonicalApplication: string; binding: CodecRecipeBinding; baseline: CodecRecipeReport };
const analyses = new WeakMap<CodecRecipeReport, AnalysisContext>();
const RuntimePlatform = z.object({ version: z.literal(1), platform: z.string().min(1), arch: z.string().min(1) }).strict();

function details(error: unknown): string {
  if (error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' && error.stderr.trim()) return error.stderr.trim().slice(0, 4000);
  return (error instanceof Error ? error.message : String(error)).slice(0, 4000);
}

function freeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  const children: unknown[] = Object.values(value);
  for (const child of children) freeze(child);
  Object.freeze(value);
}

async function checkRoot(context: Pick<AnalysisContext, 'requestedApplication' | 'canonicalApplication'>): Promise<void> {
  let current: string;
  try { current = await realpath(context.requestedApplication); }
  catch (error) { return fail(`Cannot revalidate the selected application root: ${details(error)}`); }
  if (current !== context.canonicalApplication) return fail('The selected application root changed during codec source analysis');
}

async function packagedRuntime(): Promise<boolean> {
  let text: string;
  try { text = await readFile(join(packageRoot, 'runtime-platform.json'), 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    return fail(`Cannot read the native plugin platform metadata: ${details(error)}`);
  }
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { return fail('Native plugin platform metadata is invalid; rebuild the plugin for this host'); }
  const parsed = RuntimePlatform.safeParse(raw);
  if (!parsed.success) return fail('Native plugin platform metadata is invalid; rebuild the plugin for this host');
  if (parsed.data.platform !== process.platform || parsed.data.arch !== process.arch) return fail(`This plugin runtime was built for ${parsed.data.platform}-${parsed.data.arch}; the current host is ${process.platform}-${process.arch}. Install a package built for this host`);
  return true;
}

async function runNative(context: Pick<AnalysisContext, 'requestedApplication' | 'canonicalApplication' | 'binding'>): Promise<CodecRecipeReport> {
  await checkRoot(context);
  const packaged = await packagedRuntime();
  const directory = await mkdtemp(join(tmpdir(), 'sgd-codec-recipe-'));
  const bindingPath = join(directory, 'binding.json');
  try {
    const bindingBytes = JSON.stringify(context.binding);
    await writeFile(bindingPath, bindingBytes, { mode: 0o400 });
    const binary = join(packageRoot, 'bin', `sgd-rust-bindings${process.platform === 'win32' ? '.exe' : ''}`);
    let executable = binary;
    const arguments_ = ['codec-recipe', '--root', context.canonicalApplication, '--binding', bindingPath];
    if (packaged) {
      try { await access(binary); }
      catch (error) { return fail(`Cannot access the packaged Rust codec analyzer; rebuild the plugin: ${details(error)}`); }
    } else {
      const manifest = join(packageRoot, 'tools/rust-bindings/Cargo.toml');
      try { await access(manifest); }
      catch { return fail('Rust codec analyzer is missing; rebuild the native plugin package'); }
      executable = 'cargo';
      arguments_.unshift('run', '--quiet', '--locked', '--manifest-path', manifest, '--target-dir', join(packageRoot, '.runtime/rust-binding-tool'), '--');
    }
    let output: string;
    try {
      const result = await execute(executable, arguments_, { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
      output = result.stdout;
    } catch (error) { return fail(`Rust codec source analysis failed: ${details(error)}`); }
    let raw: unknown;
    try { raw = JSON.parse(output); }
    catch { return fail('Rust codec analyzer returned invalid JSON'); }
    const parsed = CodecRecipeReportSchema.safeParse(raw);
    if (!parsed.success) return fail(`Rust codec analyzer returned an invalid report: ${parsed.error.issues.slice(0, 4).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
    const report = parsed.data;
    if (report.binding.path !== 'binding.json' || report.binding.sha256 !== createHash('sha256').update(bindingBytes).digest('hex')) return fail('Rust codec report does not match the exact supplied binding bytes');
    const fact = context.binding.source.fact;
    if (report.row.name !== fact.name || report.row.rustPath !== fact.rustPath ||
      fact.metadata.some(name => !report.row.fields.some(field => field.name === name && field.provenance && !field.payload)) ||
      report.row.fields.some(field => !field.payload && !fact.metadata.includes(field.name))) return fail('Rust codec report does not match the selected native Fact and metadata');
    const module = context.binding.codec.module.replace(/^crate(?=::|$)/, report.crateName);
    if (report.entrypoints.encode.module !== module || report.entrypoints.decode.module !== module || report.entrypoints.encode.item !== context.binding.codec.encode || report.entrypoints.decode.item !== context.binding.codec.decode) return fail('Rust codec report does not match the selected codec entrypoints');
    await checkRoot(context);
    return report;
  } finally {
    await chmod(bindingPath, 0o600).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

/** Obtain selected native codec evidence. A report grants no storage permission. */
export async function analyzeCodecRecipe(input: { application: string; binding: unknown }): Promise<CodecRecipeReport> {
  const parsed = CodecRecipeBindingSchema.safeParse(input.binding);
  if (!parsed.success) return fail(`Invalid codec recipe binding: ${parsed.error.issues.slice(0, 4).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  const requestedApplication = resolve(input.application);
  let canonicalApplication: string;
  try { canonicalApplication = await realpath(requestedApplication); }
  catch (error) { return fail(`Cannot resolve the codec application root: ${details(error)}`); }
  freeze(parsed.data);
  const context = { requestedApplication, canonicalApplication, binding: parsed.data };
  const report = await runNative(context);
  const baseline = structuredClone(report);
  freeze(report);
  analyses.set(report, { ...context, baseline });
  return report;
}

/** Reanalyze the original inputs; a parsed or copied report has no recheck context. */
export async function recheckCodecRecipe(input: { report: CodecRecipeReport }): Promise<void> {
  const context = analyses.get(input.report);
  if (!context) return fail('Codec recheck requires the exact report returned by a live analyzeCodecRecipe call; serialized reports cannot restore source evidence');
  const current = await runNative(context);
  if (!isDeepStrictEqual(current, context.baseline)) return fail('Codec source, binding, semantics, absent inputs, or Cargo discovery changed after analysis');
}
