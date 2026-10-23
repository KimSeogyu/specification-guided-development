import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const FINITE_TLC_JAR_SHA256 = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88';
const identifier = /^[A-Za-z_][A-Za-z_0-9]*$/;
const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const pureStandardModules = new Set(['Naturals', 'Integers', 'Sequences', 'FiniteSets']);

export interface FiniteTlcEvidence {
  kind: 'tlc-finite-completed';
  profile: 'finite-owned-v1';
  rootModule: string;
  moduleClosure: { name: string; sha256: string }[];
  standardModules: string[];
  configSha256: string;
  jarSha256: typeof FINITE_TLC_JAR_SHA256;
  dotSha256: string;
  mode: { exploration: 'breadth-first'; workers: 1; fingerprint: 0; seed: 0; dump: 'dot,actionlabels'; source: 'isolated-flat-module-snapshot' };
}

interface Token { kind: 'word' | 'string' | 'symbol'; value: string; line: number }

function tokens(text: string): Token[] {
  const result: Token[] = [];
  let at = 0;
  let line = 1;
  while (at < text.length) {
    const ch = text[at];
    if (ch === undefined) break;
    if (/\s/.test(ch)) { if (ch === '\n') line++; at++; continue; }
    if (text.startsWith('\\*', at)) {
      while (at < text.length && text[at] !== '\n') at++;
      continue;
    }
    if (text.startsWith('(*', at)) {
      let depth = 1;
      at += 2;
      while (at < text.length && depth > 0) {
        if (text.startsWith('(*', at)) { depth++; at += 2; }
        else if (text.startsWith('*)', at)) { depth--; at += 2; }
        else { if (text[at] === '\n') line++; at++; }
      }
      if (depth !== 0) throw new Error('TLC201: unterminated block comment in finite model configuration');
      continue;
    }
    const startLine = line;
    if (ch === '"') {
      const start = at++;
      let closed = false;
      while (at < text.length) {
        const current = text[at++];
        if (current === '\n' || current === '\r') throw new Error(`TLC201: multiline string at configuration line ${startLine}`);
        if (current === '\\') { at++; continue; }
        if (current === '"') { closed = true; break; }
      }
      if (!closed) throw new Error(`TLC201: unterminated string at configuration line ${startLine}`);
      result.push({ kind: 'string', value: text.slice(start, at), line: startLine });
      continue;
    }
    const word = /^[A-Za-z_0-9]+/.exec(text.slice(at))?.[0];
    if (word !== undefined) {
      at += word.length;
      result.push({ kind: 'word', value: word, line: startLine });
      continue;
    }
    const symbol = text.startsWith('<-', at) ? '<-' : ch;
    result.push({ kind: 'symbol', value: symbol, line: startLine });
    at += symbol.length;
  }
  return result;
}

const configSections = new Set(['SPECIFICATION', 'INIT', 'NEXT', 'INVARIANT', 'INVARIANTS', 'PROPERTY', 'PROPERTIES', 'CONSTANT', 'CONSTANTS', 'CHECK_DEADLOCK']);
const forbiddenSections = new Set(['SYMMETRY', 'VIEW', 'ALIAS', 'CONSTRAINT', 'CONSTRAINTS', 'ACTION_CONSTRAINT', 'ACTION_CONSTRAINTS', 'TYPE', 'TYPE_CONSTRAINT', 'SIMULATION', 'SIMULATE', 'DIFFTRACE', 'POSTCONDITION']);

/** This is an explicit configuration subset; TLC still parses and validates the copied configuration. */
export function validateFiniteConfig(text: string): void {
  const input = tokens(text);
  for (const token of input) {
    if (token.kind === 'word' && forbiddenSections.has(token.value)) {
      throw new Error(`TLC201: ${token.value} is unsupported in finite-owned-v1 (configuration line ${token.line}); remove graph reductions, label transforms, and alternate execution modes`);
    }
    if (token.value === '<-') throw new Error(`TLC201: configuration operator overrides are unsupported in finite-owned-v1 (line ${token.line})`);
  }
  let at = 0;
  const seen = new Set<string>();
  const fail: (detail: string) => never = detail => { throw new Error(`TLC201: ${detail}; finite-owned-v1 permits SPECIFICATION or INIT/NEXT, invariants/properties, scalar or scalar-set constant assignments, and CHECK_DEADLOCK`); };
  const takeIdentifier = (): void => {
    const token = input[at++];
    if (token?.kind !== 'word' || !identifier.test(token.value) || configSections.has(token.value)) fail(`expected an operator name at configuration line ${token?.line ?? 'EOF'}`);
  };
  const scalar = (): 'string' | 'boolean' | 'integer' => {
    const token = input[at++];
    if (token?.kind === 'string') return 'string';
    if (token?.kind === 'word' && /^[0-9]+$/.test(token.value)) return 'integer';
    if (token?.kind === 'word' && (token.value === 'TRUE' || token.value === 'FALSE')) return 'boolean';
    fail(`unsupported constant value at configuration line ${token?.line ?? 'EOF'} (pinned TLC configuration integer literals must be nonnegative)`);
  };
  while (at < input.length) {
    const section = input[at++];
    if (section?.kind !== 'word' || !configSections.has(section.value)) fail(`unsupported configuration directive ${section?.value ?? 'EOF'} at line ${section?.line ?? 'EOF'}`);
    const name = section.value;
    if (name === 'CONSTANT' || name === 'CONSTANTS') {
      let count = 0;
      while (at < input.length && !configSections.has(input[at]?.value ?? '')) {
        takeIdentifier();
        if (input[at++]?.value !== '=') fail('constant assignments must use =; module and operator overrides are unsupported');
        if (input[at]?.value === '{') {
          at++;
          if (input[at]?.value !== '}') {
            const kind = scalar();
            while (input[at]?.value === ',') {
              at++;
              if (scalar() !== kind) fail('constant sets must contain one scalar type; pinned TLC cannot order mixed scalar values');
            }
          }
          if (input[at++]?.value !== '}') fail('expected } after a finite scalar constant set');
        } else scalar();
        count++;
      }
      if (count === 0) fail('empty CONSTANTS section');
    } else if (name === 'INVARIANT' || name === 'INVARIANTS' || name === 'PROPERTY' || name === 'PROPERTIES') {
      let count = 0;
      while (at < input.length && !configSections.has(input[at]?.value ?? '')) { takeIdentifier(); count++; }
      if (count === 0) fail(`empty ${name} section`);
    } else {
      if (seen.has(name)) fail(`duplicate ${name} section`);
      seen.add(name);
      if (name === 'CHECK_DEADLOCK') {
        if (!['TRUE', 'FALSE'].includes(input[at++]?.value ?? '')) fail('CHECK_DEADLOCK requires TRUE or FALSE');
      } else takeIdentifier();
    }
  }
  if (seen.has('SPECIFICATION') ? seen.has('INIT') || seen.has('NEXT') : !seen.has('INIT') || !seen.has('NEXT')) {
    fail('select exactly one SPECIFICATION or both INIT and NEXT');
  }
}

function controlledEnvironment(): NodeJS.ProcessEnv {
  for (const name of ['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH', 'TLA_LIBRARY', 'TLA-Library']) {
    if (process.env[name]) throw new Error(`TLC202: unset ${name} for finite-owned-v1; inherited JVM or TLA+ overrides are unsupported`);
  }
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'JAVA_HOME', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.LANG = 'C';
  env.LC_ALL = 'C';
  return env;
}

// The input is already the pinned JAR. Read its ZIP central directory without an external archive executable.
function jarModuleNames(jar: Buffer): { standard: Set<string>; native: Set<string> } {
  const standard = new Set<string>();
  const native = new Set<string>();
  for (let at = jar.length - 22; at >= Math.max(0, jar.length - 65_557); at--) {
    if (jar.readUInt32LE(at) !== 0x06054b50) continue;
    let entry = jar.readUInt32LE(at + 16);
    const count = jar.readUInt16LE(at + 10);
    for (let i = 0; i < count; i++) {
      if (jar.readUInt32LE(entry) !== 0x02014b50) throw new Error('TLC202: invalid pinned JAR module directory');
      const length = jar.readUInt16LE(entry + 28);
      const name = jar.subarray(entry + 46, entry + 46 + length).toString('utf8');
      const match = /^tla2sany\/StandardModules\/([A-Za-z_][A-Za-z_0-9]*)\.tla$/.exec(name);
      if (match?.[1]) standard.add(match[1]);
      const nativeMatch = /^tlc2\/module\/([A-Za-z_][A-Za-z_0-9]*)\.class$/.exec(name);
      if (nativeMatch?.[1]) native.add(nativeMatch[1]);
      entry += 46 + length + jar.readUInt16LE(entry + 30) + jar.readUInt16LE(entry + 32);
    }
    if (standard.size === 0) throw new Error('TLC202: pinned JAR has no standard TLA+ modules');
    return { standard, native };
  }
  throw new Error('TLC202: invalid pinned JAR ZIP directory');
}

async function regularFile(path: string): Promise<Buffer> {
  if (!(await lstat(path)).isFile()) throw new Error(`TLC203: finite-owned-v1 requires a regular, non-symlink file: ${path}`);
  return readFile(path);
}

export async function runFiniteTlc(input: { spec: string; config: string; jar: string; timeoutMs?: number }): Promise<{ dot: string; log: string; evidence: FiniteTlcEvidence }> {
  const env = controlledEnvironment();
  const spec = resolve(input.spec);
  const config = resolve(input.config);
  const jarPath = resolve(input.jar);
  const moduleName = basename(spec, '.tla');
  if (basename(spec) !== `${moduleName}.tla` || !identifier.test(moduleName)) throw new Error('TLC203: the root module must use an identifier filename with the .tla extension');
  const sourceDirectory = await realpath(dirname(spec));
  const [configBytes, jarBytes] = await Promise.all([regularFile(config), regularFile(jarPath)]);
  if (digest(jarBytes) !== FINITE_TLC_JAR_SHA256) throw new Error('TLC202: finite-owned-v1 requires the pinned tla2tools 1.7.4 JAR; use scripts/fetch-tlc.mjs to obtain it');
  validateFiniteConfig(configBytes.toString('utf8'));
  const jarModules = jarModuleNames(jarBytes);
  const standardNames = jarModules.standard;
  const sources = new Map<string, Buffer>();
  const directoryEntries = await readdir(sourceDirectory);
  for (const name of directoryEntries.filter(name => name.endsWith('.tla')).sort()) {
    const module = basename(name, '.tla');
    if (!identifier.test(module)) throw new Error(`TLC203: unsupported local module filename ${name}; use flat identifier module names`);
    if (standardNames.has(module)) throw new Error(`TLC203: local ${name} shadows a pinned standard module; finite-owned-v1 does not support standard-module overrides`);
    if (jarModules.native.has(module)) throw new Error(`TLC203: local ${name} would load a pinned native Java override; finite-owned-v1 supports no local modules with reserved native module names`);
    sources.set(name, await regularFile(join(sourceDirectory, name)));
  }
  if (!sources.has(basename(spec))) throw new Error('TLC203: root module is missing from its local source directory');
  for (const name of directoryEntries) {
    if (/\.(?:java|class|jar)$/i.test(name)) throw new Error(`TLC203: Java override artifact ${name} is unsupported in the finite-owned-v1 model directory; use a directory containing only TLA+ model sources`);
  }
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'sgd-finite-')));
  const started = Date.now();
  const timeout = input.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) { await rm(temp, { recursive: true, force: true }); throw new Error('TLC202: timeoutMs must be a positive safe integer'); }
  try {
    const snapshot = join(temp, 'models');
    const javaTemp = join(temp, 'java-temp');
    const javaHome = join(temp, 'java-home');
    await mkdir(snapshot);
    await mkdir(javaTemp);
    await mkdir(join(javaHome, '.tlaplus'), { recursive: true });
    await writeFile(join(javaHome, '.tlaplus', 'esc.txt'), 'NO_STATISTICS\n');
    const copiedJar = join(temp, 'tla2tools.jar');
    await writeFile(copiedJar, jarBytes, { mode: 0o400 });
    await writeFile(join(snapshot, '__sgd_finite.cfg'), configBytes, { mode: 0o400 });
    for (const [name, bytes] of sources) await writeFile(join(snapshot, name), bytes, { mode: 0o400 });
    const javaArgs = ['-XX:+UseParallelGC', '-Xmx512m', '-Duser.language=en', '-Duser.country=US', '-Dfile.encoding=UTF-8',
      `-Duser.home=${javaHome}`, `-Djava.io.tmpdir=${javaTemp}`, '-cp', copiedJar];
    const run = async (args: string[]): Promise<string> => {
      const remaining = timeout - (Date.now() - started);
      if (remaining <= 0) throw new Error('TLC204: finite model check timed out before completion');
      try {
        const { stdout, stderr } = await execute('java', [...javaArgs, ...args], {
          cwd: snapshot, env, timeout: remaining, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
        });
        return stdout + stderr;
      } catch (error) {
        const output = error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout.slice(-12000) : '';
        throw new Error(`TLC204: finite model check failed or timed out; no executable authority can be generated.\n${output}`, { cause: error });
      }
    };
    const discover = (log: string): { local: string[]; standard: string[] } => {
      const local = new Set<string>();
      const standard = new Set<string>();
      const semantic = new Set<string>();
      for (const line of log.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
        if (/^\*{6} SANY2 Version 2\.1 created 24 February 2014$/.test(line)) continue;
        const parsed = /^Parsing file (.+)$/.exec(line)?.[1];
        if (parsed !== undefined) {
          const name = basename(parsed, '.tla');
          if (dirname(resolve(parsed)) === snapshot && sources.has(`${name}.tla`)) local.add(`${name}.tla`);
          else if (standardNames.has(name) && resolve(parsed).startsWith(`${javaTemp}${sep}`)) {
            if (!pureStandardModules.has(name)) throw new Error(`TLC203: standard module ${name} is unsupported in finite-owned-v1; use only Naturals, Integers, Sequences, and FiniteSets (Bags transitively imports TLC)`);
            standard.add(name);
          }
          else throw new Error(`TLC203: SANY resolved a module outside the isolated flat-module profile: ${basename(parsed)}`);
          continue;
        }
        const processed = /^Semantic processing of module ([A-Za-z_][A-Za-z_0-9]*)$/.exec(line)?.[1];
        if (processed !== undefined) { semantic.add(processed); continue; }
        throw new Error(`TLC204: SANY did not cleanly validate the complete finite model.\n${log.slice(-12000)}`);
      }
      if (!local.has(basename(spec)) || !semantic.has(moduleName) || [...local].some(name => !semantic.has(basename(name, '.tla')))) {
        throw new Error('TLC204: SANY did not semantically validate the root and its complete local module closure');
      }
      return { local: [...local].sort(), standard: [...standard].sort() };
    };
    const sanyLog = await run(['tla2sany.SANY', basename(spec)]);
    const closure = discover(sanyLog);
    for (const name of sources.keys()) if (!closure.local.includes(name)) await rm(join(snapshot, name));
    const checkedClosure = discover(await run(['tla2sany.SANY', basename(spec)]));
    if (JSON.stringify(closure) !== JSON.stringify(checkedClosure)) throw new Error('TLC203: SANY module closure changed after snapshot isolation');
    const dotPath = join(temp, 'model.dot');
    const tlcLog = await run(['tlc2.TLC', '-modelcheck', '-workers', '1', '-fp', '0', '-seed', '0',
      '-metadir', join(temp, 'states'), '-dump', 'dot,actionlabels', dotPath, '-config', '__sgd_finite.cfg', basename(spec)]);
    if (!tlcLog.includes('Model checking completed. No error has been found.') || !/\b0 states left on queue\./.test(tlcLog) || /(?:^|\n)(?:Error:|Warning:)/.test(tlcLog)) {
      throw new Error(`TLC204: TLC did not complete a clean exhaustive finite model check.\n${tlcLog.slice(-12000)}`);
    }
    // Reject edits during verification instead of attaching a fresh-file identity to an older snapshot.
    const currentEntries = (await readdir(sourceDirectory)).filter(name => name.endsWith('.tla')).sort();
    if (JSON.stringify(currentEntries) !== JSON.stringify([...sources.keys()])) throw new Error('TLC203: model sources changed during finite verification; rerun against a stable source tree');
    for (const [name, bytes] of sources) {
      if (!bytes.equals(await regularFile(join(sourceDirectory, name)))) throw new Error(`TLC203: ${name} changed during finite verification; rerun against stable sources`);
    }
    if (!configBytes.equals(await regularFile(config)) || !jarBytes.equals(await regularFile(jarPath))) throw new Error('TLC203: configuration or JAR changed during finite verification; rerun against stable inputs');
    const dot = await readFile(dotPath, 'utf8');
    return { dot, log: sanyLog + tlcLog, evidence: {
      kind: 'tlc-finite-completed', profile: 'finite-owned-v1', rootModule: moduleName,
      moduleClosure: closure.local.map(name => ({ name, sha256: digest(sources.get(name) ?? '') })),
      standardModules: closure.standard, configSha256: digest(configBytes), jarSha256: FINITE_TLC_JAR_SHA256, dotSha256: digest(dot),
      mode: { exploration: 'breadth-first', workers: 1, fingerprint: 0, seed: 0, dump: 'dot,actionlabels', source: 'isolated-flat-module-snapshot' },
    } };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
