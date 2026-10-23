import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { sha256 } from './dot.js';

const execute = promisify(execFile);

export interface ModelResult {
  dot: string;
  log: string;
  evidence: { kind: 'tlc-completed'; specSha256: string; configSha256: string; dotSha256: string; command: string[] };
}

export async function runTlc(input: { spec: string; config: string; jar: string; timeoutMs?: number }): Promise<ModelResult> {
  const spec = resolve(input.spec);
  const config = resolve(input.config);
  const jar = resolve(input.jar);
  const [specText, configText] = await Promise.all([readFile(spec, 'utf8'), readFile(config, 'utf8')]);
  const temp = await mkdtemp(join(tmpdir(), 'sgd-'));
  try {
    const dotPath = join(temp, 'model.dot');
    const args = ['-XX:+UseParallelGC', '-Xmx512m', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-fp', '0', '-seed', '0',
      '-metadir', join(temp, 'states'), '-dump', 'dot,actionlabels', dotPath, '-config', config, spec];
    const { stdout, stderr } = await execute('java', args, {
      cwd: dirname(spec), timeout: input.timeoutMs ?? 120_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
    });
    const log = stdout + stderr;
    if (!log.includes('Model checking completed. No error has been found.') || !/0 states left on queue\./.test(log)) {
      throw new Error('TLC102: TLC did not complete an exhaustive finite model check');
    }
    const dot = await readFile(dotPath, 'utf8');
    return { dot, log, evidence: { kind: 'tlc-completed', specSha256: sha256(specText), configSha256: sha256(configText),
      dotSha256: sha256(dot), command: ['java', ...args] } };
  } catch (error) {
    if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string') {
      throw new Error(`TLC102: model check failed or timed out.\n${error.stdout.slice(-12000)}`, { cause: error });
    }
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
