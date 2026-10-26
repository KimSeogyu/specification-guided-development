#!/usr/bin/env node
import { access, chmod, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const pluginNames = ['codex', 'claude-code'];
const archiveFormats = ['tar.gz', 'zip'];
const manifestPaths = [
  'plugins/codex/plugin.json',
  'plugins/codex/.codex-plugin/plugin.json',
  'plugins/claude-code/.claude-plugin/plugin.json',
];
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function supportedVersion(value) {
  if (typeof value !== 'string' || !VERSION.test(value)) return false;
  const prerelease = (value.split('+')[0] ?? '').split('-').slice(1).join('-');
  return !prerelease || prerelease.split('.').every(identifier => !/^\d+$/.test(identifier) || identifier === '0' || !identifier.startsWith('0'));
}

async function releaseMetadata(root) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (typeof pkg?.name !== 'string' || !pkg.name || !supportedVersion(pkg.version)) {
    throw new Error('The root package must have a name and a supported semantic version for plugin packaging.');
  }
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  if (!lock?.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) {
    throw new Error('Use an npm lockfile with a packages map.');
  }
  for (const [path, metadata] of [['package-lock.json', lock], ['package-lock.json packages[""]', lock.packages['']]]) {
    if (metadata === undefined) continue;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new Error(`Invalid release metadata in ${path}.`);
    }
    for (const key of ['name', 'version']) if (metadata[key] !== undefined && metadata[key] !== pkg[key]) {
      throw new Error(`${path} ${key} must match root package.json ${key}.`);
    }
  }
  for (const path of manifestPaths) {
    const manifest = JSON.parse(await readFile(join(root, path), 'utf8'));
    if (manifest?.name !== pkg.name || manifest?.version !== pkg.version) {
      throw new Error(`${path} name and version must match root package.json.`);
    }
  }
  return { pkg, lock };
}

export async function packagePlugins(root) {
  const { pkg, lock } = await releaseMetadata(root);
  const marketplacePreparer = await readFile(join(root, 'plugins/prepare-marketplace.mjs'));
  for (const name of pluginNames) await access(join(root, 'plugins', name, 'scripts/run.mjs'));
  await access(join(root, 'dist', 'cli.js'));
  let domainProofs = false;
  try { await access(join(root, 'dist', 'domain-proof.js')); domainProofs = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const dependencies = Object.entries(lock.packages).filter(([path, entry]) => path && !entry.dev && !entry.link);
  for (const [path] of dependencies) {
    if (!path.startsWith('node_modules/') || isAbsolute(path) || path.split('/').includes('..')) {
      throw new Error(`Invalid dependency path in lockfile: ${path}`);
    }
  }
  for (const name of pluginNames) {
    const plugin = join(root, 'plugins', name);
    const staging = await mkdtemp(join(plugin, '.runtime-'));
    try {
      await cp(join(root, 'dist'), join(staging, 'dist'), { recursive: true });
      if (domainProofs) await cp(join(root, 'proofs', 'domain'), join(staging, 'proofs', 'domain'), { recursive: true });
      for (const [path, entry] of dependencies) {
        const source = join(root, path);
        try { await access(source); }
        catch (error) {
          if (entry.optional) continue;
          throw new Error(`Dependency ${path} is missing. Run npm ci before packaging.`, { cause: error });
        }
        const destination = join(staging, path);
        await mkdir(dirname(destination), { recursive: true });
        await cp(source, destination, {
          recursive: true,
          dereference: true,
          filter: (file) => !relative(source, file).split(sep).includes('node_modules'),
        });
      }
      await writeFile(join(staging, 'package.json'), JSON.stringify({
        name: `${pkg.name}-plugin-runtime`,
        version: pkg.version,
        type: 'module',
        license: pkg.license,
        engines: pkg.engines,
        dependencies: pkg.dependencies,
      }, null, 2) + '\n');
      await writeFile(join(staging, 'runtime-platform.json'), JSON.stringify({
        version: 1, platform: process.platform, arch: process.arch,
      }, null, 2) + '\n');
      await cp(join(root, 'LICENSE'), join(staging, 'LICENSE'));
      await chmod(staging, 0o755);
      await rm(join(plugin, 'runtime'), { recursive: true, force: true });
      await rename(staging, join(plugin, 'runtime'));
      await writeFile(join(plugin, 'scripts/prepare-marketplace.mjs'), marketplacePreparer);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

async function resolveDestination(path) {
  const suffix = [];
  let parent = resolve(path);
  for (;;) {
    try { return resolve(await realpath(parent), ...suffix.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT' || dirname(parent) === parent) throw error;
      suffix.push(basename(parent));
      parent = dirname(parent);
    }
  }
}

async function planArchives({ root, out, format }) {
  if (!archiveFormats.includes(format)) throw new Error('Plugin archive format must be tar.gz or zip.');
  const { pkg } = await releaseMetadata(root);
  const output = resolve(out);
  const destination = await resolveDestination(output);
  for (const name of pluginNames) {
    const path = relative(await realpath(join(root, 'plugins', name)), destination);
    if (!path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))) {
      throw new Error('Plugin archive output must be outside both plugin source directories.');
    }
  }
  const archives = pluginNames.map(name => ({
    name, path: join(output, `specification-guided-development-${name}-${pkg.version}-${process.platform}-${process.arch}.${format}`),
  }));
  for (const { path } of archives) {
    try { await lstat(path); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`Plugin archive already exists: ${path}`);
  }
  return { pkg, output, archives };
}

export async function archivePlugins({ root, out, format = 'tar.gz' }) {
  const { pkg, output, archives } = await planArchives({ root, out, format });
  for (const name of pluginNames) {
    const plugin = join(root, 'plugins', name);
    await access(join(plugin, 'runtime', 'dist', 'cli.js'));
    await access(join(plugin, 'scripts/prepare-marketplace.mjs'));
    const runtime = JSON.parse(await readFile(join(plugin, 'runtime/package.json'), 'utf8'));
    if (runtime?.name !== `${pkg.name}-plugin-runtime` || runtime?.version !== pkg.version) {
      throw new Error(`${name} plugin runtime name and version must match the root package. Rebuild before archiving.`);
    }
    const platform = JSON.parse(await readFile(join(plugin, 'runtime', 'runtime-platform.json'), 'utf8'));
    if (platform.version !== 1 || platform.platform !== process.platform || platform.arch !== process.arch) {
      throw new Error('Plugin runtime does not match this host. Rebuild before archiving.');
    }
  }
  await mkdir(output, { recursive: true });
  const staging = await mkdtemp(join(output, '.runtime-plugin-archives-'));
  try {
    for (const { name, path } of archives) {
      const plugin = resolve(root, 'plugins', name);
      const temporary = join(staging, `${name}.${format}`);
      const command = format === 'zip' ? 'zip' : 'tar';
      const args = format === 'zip' ? [
        '-qry', temporary, '.', '-x', '.runtime-*', '.runtime-*/*', '*/.runtime-*', '*/.runtime-*/*', '.DS_Store', '*/.DS_Store',
      ] : [
        '-czf', temporary, '--exclude=.runtime-*', '--exclude=.DS_Store', '-C', plugin, '.',
      ];
      const result = spawnSync(command, args, {
        cwd: plugin, encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' },
      });
      if (result.error || result.status !== 0) {
        throw new Error(`Cannot create plugin archive with ${command}: ${result.error?.message ?? result.stderr.trim()}`);
      }
      await link(temporary, path);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return archives.map(({ path }) => path);
}

function packagingOptions(args) {
  const usage = 'Usage: node plugins/package.mjs [--archive-out DIR [--archive-format tar.gz|zip]]';
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!['--archive-out', '--archive-format'].includes(option) || options.has(option) || !value || value.startsWith('--')) {
      throw new Error(usage);
    }
    options.set(option, value);
  }
  const out = options.get('--archive-out');
  const format = options.get('--archive-format') ?? 'tar.gz';
  if (!archiveFormats.includes(format) || (options.has('--archive-format') && !out)) throw new Error(usage);
  return { out, format };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { out, format } = packagingOptions(process.argv.slice(2));
    const root = fileURLToPath(new URL('../', import.meta.url));
    if (out) await planArchives({ root, out, format });
    await packagePlugins(root);
    process.stdout.write('Prepared plugins/codex and plugins/claude-code with local runtimes.\n');
    if (out) {
      const archives = await archivePlugins({ root, out, format });
      for (const archive of archives) process.stdout.write(`Created ${archive}\n`);
    }
  } catch (error) {
    process.stderr.write(`Plugin packaging failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
