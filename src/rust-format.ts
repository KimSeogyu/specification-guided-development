import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const rustfmtConfig = 'edition = "2021"\nstyle_edition = "2021"\nmax_width = 100\nuse_small_heuristics = "Default"\nnewline_style = "Unix"\n';
const expectedRustc = 'rustc 1.92.0 (ded5c06cf 2025-12-08)';
const expectedRustfmt = 'rustfmt 1.8.0-stable (ded5c06cf2 2025-12-08)';

interface RustTools {
  command: string;
  prefix: string[];
  formatter: string;
}

function isExpected(command: string, args: string[], expected: string): boolean {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
  return !result.error && !result.signal && result.status === 0 && result.stdout.trim() === expected;
}

/** Choose one toolchain for both checks and formatting; never change the user's default. */
function selectRustTools(): RustTools {
  if (isExpected('rustc', ['--version'], expectedRustc) &&
      isExpected('rustfmt', ['--version'], expectedRustfmt)) {
    return { command: 'rustfmt', prefix: [], formatter: 'rustfmt' };
  }
  for (const toolchain of ['1.92.0', '1.92']) {
    const prefix = ['run', toolchain];
    if (isExpected('rustup', [...prefix, 'rustc', '--version'], expectedRustc) &&
        isExpected('rustup', [...prefix, 'rustfmt', '--version'], expectedRustfmt)) {
      return { command: 'rustup', prefix: [...prefix, 'rustfmt'], formatter: `rustup run ${toolchain} rustfmt` };
    }
  }
  throw new Error(`TLC208: Rust generation requires ${expectedRustc} and ${expectedRustfmt}; install Rust 1.92.0 with rustfmt using rustup or select matching tools on PATH`);
}

/** Rustfmt is trusted to preserve Rust semantics. Its version and config are fixed. */
export function formatRustSource(source: string): string {
  const tools = selectRustTools();
  const directory = mkdtempSync(join(tmpdir(), 'sgd-rustfmt-'));
  let cleanupSafe = true;
  try {
    const config = join(directory, 'rustfmt.toml');
    writeFileSync(config, rustfmtConfig);
    const formatted = spawnSync(tools.command, [...tools.prefix, '--edition', '2021', '--emit', 'stdout', '--config-path', config], {
      input: source, encoding: 'utf8', timeout: 45_000, maxBuffer: 16 * 1024 * 1024,
    });
    if (formatted.error || formatted.signal) cleanupSafe = false;
    if (formatted.error || formatted.signal || formatted.status !== 0 || formatted.stderr.trim() !== '') {
      throw new Error(`TLC208: ${tools.formatter} failed: ${formatted.stderr.slice(-4096)}`, { cause: formatted.error });
    }
    return formatted.stdout;
  } finally {
    if (cleanupSafe) rmSync(directory, { recursive: true, force: true });
  }
}
