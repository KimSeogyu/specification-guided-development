#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rmdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'specification-guided-development';
const LIMITS = Object.freeze({ files: 10_000, directories: 2_000, depth: 64, fileBytes: 64 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 });
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const USAGE = 'Usage: node scripts/prepare-marketplace.mjs --host codex|claude-code --plugin COMPLETE_EXTRACTED_PLUGIN_DIR --out NEW_MARKETPLACE_DIRECTORY';

function fail(message) { throw new Error(`Marketplace preparation: ${message}`); }
function inside(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}
function identity(stat) { return `${stat.dev}:${stat.ino}`; }
const READ_GUARD_FIELDS = Object.freeze(['dev', 'ino', 'mode', 'size', 'mtimeNs']);
function readGuard(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode), size: String(stat.size), mtimeNs: String(stat.mtimeNs) };
}
function sourcePath(key) {
  const path = key || '.';
  return path.length > 180 ? `${path.slice(0, 177)}...` : path;
}
function sourceChanged(key, fields, stage) {
  fail(`The plugin source changed ${stage}: ${sourcePath(key)} (changed fields: ${fields.join(', ')}). Retry with an unchanged extracted release.`);
}
function checkReadGuard(stat, expected, kind, key, stage) {
  const current = readGuard(stat);
  const fields = READ_GUARD_FIELDS.filter(field => current[field] !== expected[field]);
  if (stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() : !stat.isDirectory())) fields.unshift('kind');
  if (fields.length) sourceChanged(key, fields, stage);
}
async function sourceStat(path, key, stage) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { sourceError(error, key, stage); }
}
function sourceError(error, key, stage) {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') sourceChanged(key, ['inventory'], stage);
  if (error.code === 'ELOOP') sourceChanged(key, ['kind'], stage);
  const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,23}$/.test(error.code) ? error.code : 'unknown';
  fail(`Cannot access the plugin source ${stage}: ${sourcePath(key)} (filesystem error: ${code}).`);
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function version(value) {
  if (typeof value !== 'string' || !VERSION.test(value)) return false;
  const prerelease = (value.split('+')[0] ?? '').split('-').slice(1).join('-');
  return !prerelease || prerelease.split('.').every(identifier => !/^\d+$/.test(identifier) || identifier === '0' || !identifier.startsWith('0'));
}
function keys(value, expected) {
  return object(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

async function safeAncestors(path, missingLeaf = false) {
  const root = parse(path).root;
  let current = root;
  const parts = relative(root, path).split(sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stat;
    try { stat = await lstat(current, { bigint: true }); }
    catch (error) {
      if (error.code === 'ENOENT' && missingLeaf && index === parts.length - 1) return;
      if (error.code === 'ENOENT') fail('Input and output parent directories must already exist.');
      throw error;
    }
    if (stat.isSymbolicLink()) fail('Symlink paths are unsupported. Select a physical input and output parent directory.');
    if (!stat.isDirectory()) fail('Input and output parent paths must be directories.');
  }
}

async function bytes(path, expected, key) {
  const before = await sourceStat(path, key, 'before opening a file');
  checkReadGuard(before, expected.guard, 'file', key, 'before opening a file');
  const handle = await open(path, 'r').catch(error => sourceError(error, key, 'while opening a file'));
  try {
    checkReadGuard(await handle.stat({ bigint: true }), expected.guard, 'file', key, 'while opening a file');
    const chunks = [];
    let size = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, LIMITS.fileBytes - size + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > LIMITS.fileBytes) fail(`A plugin file exceeds the ${LIMITS.fileBytes} byte limit.`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    checkReadGuard(await handle.stat({ bigint: true }), expected.guard, 'file', key, 'while reading a file');
    if (size !== Number(before.size)) sourceChanged(key, ['readBytes'], 'while reading a file');
    return Buffer.concat(chunks, size);
  } finally { await handle.close(); }
}

async function capture(root) {
  const entries = new Map();
  let fileCount = 0;
  let directoryCount = 0;
  let total = 0;
  async function visit(path, key, depth) {
    if (depth > LIMITS.depth) fail(`Plugin directories exceed the ${LIMITS.depth} level limit.`);
    const stat = await sourceStat(path, key, 'while capturing the inventory');
    if (stat.isSymbolicLink()) fail(`Symlinks are unsupported in the plugin: ${sourcePath(key)}`);
    if (stat.isDirectory()) {
      if (++directoryCount > LIMITS.directories) fail('The plugin has too many directories.');
      const names = (await readdir(path).catch(error => sourceError(error, key, 'while capturing a directory'))).sort();
      const guard = readGuard(stat);
      entries.set(key, { kind: 'directory', guard, names });
      for (const name of names) {
        if (name === '.' || name === '..' || /[\x00-\x1f\x7f]/.test(name)) fail('A plugin path contains unsupported characters.');
        const child = join(path, name);
        if (!inside(root, child)) fail('A plugin source path escapes its root.');
        await visit(child, key ? `${key}/${name}` : name, depth + 1);
      }
      checkReadGuard(await sourceStat(path, key, 'while capturing a directory'), guard, 'directory', key, 'while capturing a directory');
    } else if (stat.isFile()) {
      if (++fileCount > LIMITS.files) fail('The plugin has too many files.');
      if (stat.size > BigInt(LIMITS.fileBytes)) fail(`A plugin file exceeds the ${LIMITS.fileBytes} byte limit.`);
      total += Number(stat.size);
      if (total > LIMITS.totalBytes) fail(`The plugin exceeds the ${LIMITS.totalBytes} byte total limit.`);
      const entry = { kind: 'file', guard: readGuard(stat), mode: Number(stat.mode & 0o777n) };
      const content = await bytes(path, entry, key);
      entries.set(key, { ...entry, digest: createHash('sha256').update(content).digest('hex') });
    } else fail(`Only regular files and directories are supported in the plugin: ${sourcePath(key)}`);
  }
  await visit(root, '', 0);
  return entries;
}

function file(entries, path) {
  const entry = entries.get(path);
  if (entry?.kind !== 'file') fail(`The complete prepared plugin must contain ${path}.`);
  return entry;
}
async function contents(root, entries, path) {
  const entry = file(entries, path);
  const content = await bytes(join(root, path), entry, path);
  if (createHash('sha256').update(content).digest('hex') !== entry.digest) sourceChanged(path, ['digest'], 'while rechecking file bytes');
  return content;
}
function recheckEntries(captured, current) {
  const paths = new Set([...captured.keys(), ...current.keys()]);
  for (const path of paths) {
    if (!captured.has(path) || !current.has(path)) sourceChanged(path, ['inventory'], 'during copying');
  }
  for (const [path, entry] of captured) {
    const latest = current.get(path);
    if (entry.kind !== latest.kind) sourceChanged(path, ['kind'], 'during copying');
    const fields = READ_GUARD_FIELDS.filter(field => entry.guard[field] !== latest.guard[field]);
    if (entry.kind === 'file' && entry.digest !== latest.digest) fields.push('digest');
    if (entry.kind === 'directory' && JSON.stringify(entry.names) !== JSON.stringify(latest.names)) fields.push('inventory');
    if (fields.length) sourceChanged(path, fields, 'during copying');
  }
}
async function json(root, entries, path) {
  try { return JSON.parse((await contents(root, entries, path)).toString('utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) fail(`${path} must contain valid JSON.`);
    throw error;
  }
}

async function validate(host, root, entries) {
  const manifestPath = host === 'codex' ? 'plugin.json' : '.claude-plugin/plugin.json';
  const manifest = await json(root, entries, manifestPath);
  if (!object(manifest) || manifest.name !== NAME || !version(manifest.version)) fail(`${manifestPath} must declare ${NAME} and a supported semantic version.`);
  if (host === 'codex' && manifest.extensions?.['com.openai']?.requires_local_executor !== true) fail('The Codex plugin must require the local executor.');
  if (host === 'claude-code' && (manifest.skills !== './skills/' || manifest.mcpServers !== './.mcp.json')) fail('The Claude Code manifest must use the packaged skills and .mcp.json.');
  const runtime = await json(root, entries, 'runtime/package.json');
  if (!object(runtime) || runtime.name !== `${NAME}-plugin-runtime` || runtime.version !== manifest.version || runtime.type !== 'module') fail('The native manifest and prepared runtime package must have the same supported version and package identity. Rebuild the complete release.');
  const platform = await json(root, entries, 'runtime/runtime-platform.json');
  if (!object(platform) || platform.version !== 1 || platform.platform !== process.platform || platform.arch !== process.arch) fail(`The prepared runtime must use platform schema 1 for ${process.platform}/${process.arch}. Select the matching release.`);
  const mcpPath = host === 'codex' ? 'mcp.json' : '.mcp.json';
  const mcp = await json(root, entries, mcpPath);
  const server = mcp?.mcpServers?.sgd;
  const rootVariable = host === 'codex' ? '${PLUGIN_ROOT}' : '${CLAUDE_PLUGIN_ROOT}';
  if (!keys(mcp?.mcpServers, ['sgd']) || !keys(server, host === 'codex' ? ['type', 'command', 'args', 'cwd'] : ['command', 'args']) || server.command !== 'node' || !Array.isArray(server.args) || server.args.length !== 2 || server.args[0] !== `${rootVariable}/scripts/run.mjs` || server.args[1] !== 'mcp' || (host === 'codex' && (server.type !== 'stdio' || server.cwd !== rootVariable))) fail(`${mcpPath} must start the packaged SGD launcher without unsupported fields or environment overrides.`);
  if (host === 'codex') {
    const compatibility = await json(root, entries, '.codex-plugin/plugin.json');
    if (!object(compatibility) || compatibility.name !== NAME || compatibility.version !== manifest.version || compatibility.skills !== './skills/' || compatibility.mcpServers !== './.mcp.json' || compatibility.requires_local_executor !== true) fail('The Codex compatibility manifest must match the portable name, version, skills, MCP path, and local executor requirement.');
    const compatibilityMcp = await json(root, entries, '.mcp.json');
    const compatibilityServer = compatibilityMcp?.mcpServers?.sgd;
    if (!keys(compatibilityMcp?.mcpServers, ['sgd']) || !keys(compatibilityServer, ['command', 'args', 'cwd']) || compatibilityServer.command !== 'node' || !Array.isArray(compatibilityServer.args) || compatibilityServer.args.length !== 2 || compatibilityServer.args[0] !== 'scripts/run.mjs' || compatibilityServer.args[1] !== 'mcp' || compatibilityServer.cwd !== '.') fail('The Codex compatibility .mcp.json must start scripts/run.mjs from the plugin root without unsupported fields.');
  }
  for (const path of ['scripts/run.mjs', 'scripts/prepare-marketplace.mjs', 'runtime/dist/cli.js', 'runtime/dist/mcp.js', 'skills/specification-guided-development/SKILL.md']) file(entries, path);
  const native = file(entries, `runtime/bin/sgd-rust-bindings${process.platform === 'win32' ? '.exe' : ''}`);
  if (process.platform !== 'win32' && !(native.mode & 0o111)) fail('The packaged Rust helper must be executable. Extract the archive preserving file permissions.');
  if (entries.get('runtime/node_modules')?.kind !== 'directory') fail('The complete prepared plugin must contain runtime/node_modules.');
  if (!object(runtime.dependencies)) fail('The runtime package must declare its production dependencies.');
  for (const name of Object.keys(runtime.dependencies)) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) || name.split('/').some(part => part === '.' || part === '..')) fail('A runtime dependency name is unsupported.');
    file(entries, `runtime/node_modules/${name}/package.json`);
  }
  return { version: manifest.version, platform: platform.platform, arch: platform.arch };
}

function catalogue(host) {
  if (host === 'codex') return {
    name: `${NAME}-codex`,
    plugins: [{ name: NAME, source: { source: 'local', path: './plugins/codex' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools', interface: { displayName: 'Specification Guided Development' } }],
  };
  return {
    name: `${NAME}-claude`, description: 'TLA+ modeling and generated source checks for Claude Code.', owner: { name: 'KimSeogyu' },
    plugins: [{ name: NAME, source: './plugins/claude-code', description: 'Model architecture and behavior in TLA+, then compile TLC graphs into source checks.' }],
  };
}

/** Prepare a new local native marketplace. This does not install or update a host.
 * Captured bytes, permission bits, read guards and inventories are rechecked for
 * ordinary changes. This is not continuous observation or an atomic operation,
 * and does not defend against a hostile concurrent filesystem owner.
 */
export async function prepareMarketplace({ host, plugin, out }) {
  if (host !== 'codex' && host !== 'claude-code') fail('Use --host codex or --host claude-code.');
  if (typeof plugin !== 'string' || !plugin || typeof out !== 'string' || !out) fail(USAGE);
  const source = resolve(plugin);
  const destination = resolve(out);
  if (inside(source, destination)) fail('Choose a new output directory outside the plugin source.');
  await safeAncestors(source);
  await safeAncestors(dirname(destination));
  try { await lstat(destination); fail('The output already exists. Select a new directory; this command does not replace marketplaces.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const captured = await capture(source);
  const release = await validate(host, source, captured);
  const marker = `.sgd-prepare-${randomUUID()}`;
  const token = randomUUID();
  let ownedIdentity;
  let markerWritten = false;
  try {
    await mkdir(destination);
    ownedIdentity = identity(await lstat(destination, { bigint: true }));
    await writeFile(join(destination, marker), token, { flag: 'wx', mode: 0o600 });
    markerWritten = true;
    const selected = join(destination, 'plugins', host);
    await mkdir(join(destination, 'plugins'));
    for (const [path, entry] of captured) {
      const target = path ? join(selected, path) : selected;
      if (entry.kind === 'directory') await mkdir(target, { mode: 0o755 });
      else await writeFile(target, await contents(source, captured, path), { flag: 'wx', mode: entry.mode });
    }
    const nativeDirectory = host === 'codex' ? join(destination, '.agents', 'plugins') : join(destination, '.claude-plugin');
    await mkdir(nativeDirectory, { recursive: true });
    const market = catalogue(host);
    await writeFile(join(nativeDirectory, 'marketplace.json'), `${JSON.stringify(market, null, 2)}\n`, { flag: 'wx' });
    await safeAncestors(source);
    await safeAncestors(dirname(destination));
    const current = await capture(source);
    recheckEntries(captured, current);
    if (identity(await lstat(destination, { bigint: true })) !== ownedIdentity) fail('The output directory changed during preparation.');
    await rm(join(destination, marker));
    const pluginId = `${NAME}@${market.name}`;
    return {
      schemaVersion: 1, host, name: NAME, ...release,
      marketplace: { name: market.name, path: destination, pluginPath: selected },
      installation: { runFrom: 'project-root', argv: host === 'codex'
        ? [['codex', 'plugin', 'marketplace', 'add', destination, '--json'], ['codex', 'plugin', 'add', pluginId, '--json']]
        : [['claude', 'plugin', 'marketplace', 'add', destination, '--scope', 'local', '--json'], ['claude', 'plugin', 'install', pluginId, '--scope', 'local', '--json']] },
      installsNothing: true, sourceConsistency: 'captured-files-and-inventory-rechecked', filesystemAtomicity: 'not-atomic',
    };
  } catch (error) {
    if (ownedIdentity) {
      try {
        const stat = await lstat(destination, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== ownedIdentity) throw new Error('Output ownership changed.');
        if (!markerWritten) await rmdir(destination);
        else {
          const handle = await open(join(destination, marker), 'r');
          let owner;
          try { owner = await handle.readFile('utf8'); } finally { await handle.close(); }
          if (owner === token) await rm(destination, { recursive: true, force: true });
        }
      } catch { /* Keep output when ownership cannot be confirmed. */ }
    }
    throw error;
  }
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => undefined) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) process.stdout.write(`${USAGE}\nPrepares a NEW local marketplace. Installs nothing. Claude installation commands must run at the project root.\n`);
    else {
      const options = {};
      for (let index = 0; index < args.length; index += 2) {
        const key = args[index];
        const value = args[index + 1];
        if (!['--host', '--plugin', '--out'].includes(key) || !value || value.startsWith('--') || Object.hasOwn(options, key.slice(2))) fail(USAGE);
        options[key.slice(2)] = value;
      }
      process.stdout.write(`${JSON.stringify(await prepareMarketplace(options), null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Marketplace preparation failed.'}\n`);
    process.exitCode = 1;
  }
}
