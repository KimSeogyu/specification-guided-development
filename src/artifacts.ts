import { posix } from 'node:path';
import { z } from 'zod';
import { recordSchema } from './schema-record.js';
import { formatGeneratedRust, rustFormatConfiguration, type RustFormatterEvidence } from './rust-format.js';
import type { GeneratedFile } from './types.js';

export type ArtifactFile = GeneratedFile & (
  | { kind: 'compiler-output'; format: 'rust' | 'verbatim' }
  | { kind: 'captured-evidence' }
  | { kind: 'formatter-receipt'; formatterField: 'root' | 'row-binding' }
);

export function compilerFile(file: GeneratedFile): ArtifactFile {
  return { ...file, kind: 'compiler-output', format: file.path.endsWith('.rs') ? 'rust' : 'verbatim' };
}
export function capturedFile(file: GeneratedFile): ArtifactFile { return { ...file, kind: 'captured-evidence' }; }
export function formatterReceipt(file: GeneratedFile, formatterField: 'root' | 'row-binding'): ArtifactFile {
  return { ...file, kind: 'formatter-receipt', formatterField };
}

const JsonObject = recordSchema(z.string(), z.unknown());

function snapshot(file: GeneratedFile): GeneratedFile {
  const result = { ...file, ...(file.stableJsonKeys ? { stableJsonKeys: [...file.stableJsonKeys] } : {}) };
  if (result.stableJsonKeys) Object.freeze(result.stableJsonKeys);
  return Object.freeze(result);
}

type PreparedArtifactData = { files: readonly GeneratedFile[]; formatter: RustFormatterEvidence | null };
class PreparedArtifactBatch {
  readonly #data: PreparedArtifactData;
  constructor(data: PreparedArtifactData) {
    this.#data = data;
    Object.freeze(this);
  }
  get files(): readonly GeneratedFile[] { return this.#data.files; }
  get formatter(): RustFormatterEvidence | null { return this.#data.formatter; }
}
export type PreparedArtifacts = PreparedArtifactBatch;
const readyBatches = new WeakMap<PreparedArtifactBatch, PreparedArtifactData>();

/** Access the private batch identity before any output directory is touched. */
export function preparedFiles(prepared: PreparedArtifacts): readonly GeneratedFile[] {
  const data = readyBatches.get(prepared);
  if (!data) throw new Error('TLC103: publication requires prepared artifacts');
  return data.files;
}

function validPath(path: string): boolean {
  const normalized = posix.normalize(path);
  return path !== '' && normalized !== '.' && normalized !== '..' && !normalized.startsWith('../') && !posix.isAbsolute(path);
}

function receipt(file: Extract<ArtifactFile, { kind: 'formatter-receipt' }>, formatter: RustFormatterEvidence | null): GeneratedFile {
  if (!file.path.endsWith('.json')) throw new Error('TLC103: formatter receipt must be a JSON artifact');
  const value = JsonObject.parse(JSON.parse(file.content));
  const stable = formatter ? { profile: formatter.profile, configSha256: formatter.configSha256 } : null;
  if (file.formatterField === 'row-binding') {
    const binding = JsonObject.parse(value.rowBinding);
    value.rowBinding = { ...binding, formatter: stable };
  } else value.formatter = stable;
  value.formatterVersion = formatter?.version ?? null;
  return { ...file, content: JSON.stringify(value, null, 2) + '\n' };
}

/** Normalize compiler-owned syntax, preserve captured bytes, then seal one immutable batch. */
export async function prepareArtifacts(drafts: readonly ArtifactFile[]): Promise<PreparedArtifacts> {
  const files = drafts.map(file => ({ ...file, ...(file.stableJsonKeys ? { stableJsonKeys: [...file.stableJsonKeys] } : {}) }));
  if (files.some(file => !validPath(file.path)) || new Set(files.map(file => posix.normalize(file.path))).size !== files.length) {
    throw new Error('TLC103: invalid or duplicate artifact path');
  }
  for (const file of files) {
    if (file.kind === 'compiler-output' && (file.format === 'rust') !== file.path.endsWith('.rs')) {
      throw new Error('TLC103: generated Rust requires the Rust artifact format');
    }
  }
  const rust = files.filter(file => file.kind === 'compiler-output' && file.format === 'rust');
  const formatted = rust.length ? await formatGeneratedRust(rust) : null;
  const formatter = formatted?.formatter ?? null;
  const normalized = new Map(formatted?.files.map(file => [file.path, file.content]));
  const result: GeneratedFile[] = files.map(file => file.kind === 'formatter-receipt' ? receipt(file, formatter)
    : { ...file, content: normalized.get(file.path) ?? file.content });
  if (formatter) {
    const manifests = files.filter(file => file.kind === 'compiler-output' && posix.basename(file.path) === 'Cargo.toml').map(file => posix.dirname(file.path));
    const roots = new Set(rust.map(file => manifests.filter(root => root === '.' || file.path.startsWith(`${root}/`)).sort((a, b) => b.length - a.length)[0] ?? posix.dirname(file.path)));
    for (const root of roots) {
      const path = posix.join(root, 'rustfmt.toml');
      if (files.some(file => file.path === posix.join(root, '.rustfmt.toml'))) throw new Error(`TLC103: generated Rust formatter configuration is ambiguous at ${root}`);
      const existing = files.find(file => file.path === path);
      if (existing && (existing.kind !== 'compiler-output' || existing.content !== rustFormatConfiguration)) throw new Error(`TLC103: generated Rust formatter configuration conflicts at ${path}`);
      if (!existing) result.push({ path, content: rustFormatConfiguration });
    }
    const path = 'artifact-format.json';
    const existing = files.find(file => file.path === path);
    if (existing && existing.kind !== 'compiler-output') throw new Error('TLC103: artifact formatter receipt conflicts with captured evidence');
    const artifact: GeneratedFile = { path, content: JSON.stringify({ schema: 'sgd-artifact-format-v1',
      formatter: { profile: formatter.profile, configSha256: formatter.configSha256 },
      files: rust.map(file => file.path).sort(), formatterVersion: formatter.version }, null, 2) + '\n',
      volatile: true, stableJsonKeys: ['schema', 'formatter', 'files'] };
    if (existing) result.splice(result.findIndex(file => file.path === path), 1, artifact);
    else result.push(artifact);
  }
  const data: PreparedArtifactData = Object.freeze({ files: Object.freeze(result.map(snapshot)), formatter: formatter ? Object.freeze({ ...formatter }) : null });
  const prepared = new PreparedArtifactBatch(data);
  readyBatches.set(prepared, data);
  return prepared;
}
