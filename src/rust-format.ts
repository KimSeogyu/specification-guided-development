import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const rustfmtConfig = 'edition = "2021"\nstyle_edition = "2021"\nmax_width = 100\nuse_small_heuristics = "Default"\nnewline_style = "Unix"\n';
const expectedRustc = 'rustc 1.92.0 (ded5c06cf 2025-12-08)';
const expectedRustfmt = 'rustfmt 1.8.0-stable (ded5c06cf2 2025-12-08)';

/** Rustfmt is trusted to preserve Rust semantics. Its version and config are fixed. */
export function formatRustSource(source: string): string {
  for (const [tool, expected] of [['rustc', expectedRustc], ['rustfmt', expectedRustfmt]] as const) {
    const version = spawnSync(tool, ['--version'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
    if (version.error || version.signal || version.status !== 0 || version.stdout.trim() !== expected) {
      throw new Error(`TLC208: Rust generation requires ${expected}`, { cause: version.error });
    }
  }
  const directory = mkdtempSync(join(tmpdir(), 'sgd-rustfmt-'));
  let cleanupSafe = true;
  try {
    const config = join(directory, 'rustfmt.toml');
    writeFileSync(config, rustfmtConfig);
    const formatted = spawnSync('rustfmt', ['--edition', '2021', '--emit', 'stdout', '--config-path', config], {
      input: source, encoding: 'utf8', timeout: 45_000, maxBuffer: 16 * 1024 * 1024,
    });
    if (formatted.error || formatted.signal) cleanupSafe = false;
    if (formatted.error || formatted.signal || formatted.status !== 0 || formatted.stderr.trim() !== '') {
      throw new Error(`TLC208: pinned rustfmt failed: ${formatted.stderr.slice(-4096)}`, { cause: formatted.error });
    }
    return formatted.stdout;
  } finally {
    if (cleanupSafe) rmSync(directory, { recursive: true, force: true });
  }
}
