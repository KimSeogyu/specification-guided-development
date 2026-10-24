import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { sha256 } from './dot.js';
import type { GeneratedFile } from './types.js';

const execute = promisify(execFile);
export const rustFormatConfiguration = 'edition = "2021"\nstyle_edition = "2021"\nnewline_style = "Unix"\n';
export const rustFormatProfile = 'rustfmt-2021-v1';
export type RustFormatterEvidence = { profile: typeof rustFormatProfile; version: string; configSha256: string };

/** Format complete generated units with an explicit config, independent of user settings. */
export async function formatGeneratedRust(files: readonly GeneratedFile[]): Promise<{ files: GeneratedFile[]; formatter: RustFormatterEvidence }> {
  const directory = await mkdtemp(join(tmpdir(), 'sgd-rustfmt-'));
  try {
    const config = join(directory, 'rustfmt.toml');
    await writeFile(config, rustFormatConfiguration, { mode: 0o400 });
    const version = (await execute('rustfmt', ['--version'], { timeout: 10_000 })).stdout.trim();
    const result: GeneratedFile[] = [];
    for (const file of files) {
      if (!file.path.endsWith('.rs')) { result.push(file); continue; }
      const run = (content: string, check = false): Promise<string> => new Promise((resolve, reject) => {
        const child = execFile('rustfmt', [...(check ? ['--check'] : ['--emit', 'stdout']), '--config-path', config], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
          if (error) reject(new Error(`TLC305: generated Rust formatting failed for ${file.path}: ${stderr.trim() || error.message}`));
          else resolve(stdout);
        });
        child.stdin?.end(content);
      });
      const content = await run(file.content);
      if (await run(content) !== content) throw new Error(`TLC305: generated Rust formatting is not idempotent for ${file.path}`);
      await run(content, true);
      result.push({ ...file, content });
    }
    return { files: result, formatter: { profile: rustFormatProfile, version, configSha256: sha256(rustFormatConfiguration) } };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
