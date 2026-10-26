import { posix } from 'node:path';
import type { GeneratedFile } from './types.js';

export type ArtifactFile = GeneratedFile & { kind: 'compiler-output' | 'captured-evidence' };

export function compilerFile(file: GeneratedFile): ArtifactFile { return { ...file, kind: 'compiler-output' }; }
export function capturedFile(file: GeneratedFile): ArtifactFile { return { ...file, kind: 'captured-evidence' }; }

function snapshot(file: GeneratedFile): GeneratedFile {
  const result = { ...file, ...(file.stableJsonKeys ? { stableJsonKeys: [...file.stableJsonKeys] } : {}) };
  if (result.stableJsonKeys) Object.freeze(result.stableJsonKeys);
  return Object.freeze(result);
}

type PreparedArtifactData = { files: readonly GeneratedFile[] };
class PreparedArtifactBatch {
  readonly #data: PreparedArtifactData;
  constructor(data: PreparedArtifactData) {
    this.#data = data;
    Object.freeze(this);
  }
  get files(): readonly GeneratedFile[] { return this.#data.files; }
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

/** Preserve exact bytes, validate paths, then seal one immutable batch. */
export async function prepareArtifacts(drafts: readonly ArtifactFile[]): Promise<PreparedArtifacts> {
  const files = drafts.map(snapshot);
  if (files.some(file => !validPath(file.path)) || new Set(files.map(file => posix.normalize(file.path))).size !== files.length) {
    throw new Error('TLC103: invalid or duplicate artifact path');
  }
  const data: PreparedArtifactData = Object.freeze({ files: Object.freeze(files) });
  const prepared = new PreparedArtifactBatch(data);
  readyBatches.set(prepared, data);
  return prepared;
}
