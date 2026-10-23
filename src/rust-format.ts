import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { sha256 } from './dot.js';
import type { GeneratedFile } from './types.js';

const execute = promisify(execFile);
const configuration = 'edition = "2021"\nstyle_edition = "2021"\nnewline_style = "Unix"\n';

/** Format complete generated units with an explicit config, independent of user settings. */
export async function formatRowRust(files: GeneratedFile[]) {
  const directory = await mkdtemp(join(tmpdir(), 'sgd-rustfmt-'));
  try {
    const config = join(directory, 'rustfmt.toml');
    await writeFile(config, configuration, { mode: 0o400 });
    const version = (await execute('rustfmt', ['--version'], { timeout: 10_000 })).stdout.trim();
    const result: GeneratedFile[] = [];
    for (const file of files) {
      if (!file.path.endsWith('.rs')) { result.push(file); continue; }
      const content = await new Promise<string>((resolve, reject) => {
        const child = execFile('rustfmt', ['--emit', 'stdout', '--config-path', config], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
          if (error) reject(new Error(`TLC305: generated Rust formatting failed: ${stderr.trim() || error.message}`));
          else resolve(stdout);
        });
        child.stdin?.end(file.content);
      });
      result.push({ ...file, content });
    }
    return { files: result, formatter: { profile: 'rustfmt-2021-v1', version, configSha256: sha256(configuration) } };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
