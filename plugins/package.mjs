#!/usr/bin/env node
import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const pluginNames = ['codex', 'claude-code'];
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

async function rustBindingAssets(root) {
  try { await access(join(root, 'dist/row-binding.js')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const manifest = join(root, 'tools/rust-bindings/Cargo.toml');
  const target = join(root, '.runtime/rust-binding-tool');
  function cargo(args) {
    const result = spawnSync('cargo', args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`Cannot prepare Rust binding analyzer: ${result.error?.message ?? result.stderr.trim()}`);
    return result.stdout;
  }
  cargo(['build', '--release', '--locked', '--manifest-path', manifest, '--target-dir', target]);
  const binaryName = `sgd-rust-bindings${process.platform === 'win32' ? '.exe' : ''}`;
  const binary = join(target, 'release', binaryName);
  await access(binary);
  const metadata = JSON.parse(cargo(['metadata', '--locked', '--format-version', '1', '--manifest-path', manifest]));
  const licenses = [];
  for (const pkg of metadata.packages) {
    if (!pkg.source) continue;
    const directory = dirname(pkg.manifest_path);
    const names = (await readdir(directory)).filter(name => /^(?:licen[cs]e|notice|copyright)(?:[._-]|$)/i.test(name));
    if (pkg.license_file) {
      const license = resolve(directory, pkg.license_file);
      const rel = relative(directory, license);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Dependency license path escapes its package');
      if (!names.includes(rel)) names.push(rel);
    }
    licenses.push({ name: pkg.name, version: pkg.version, license: pkg.license, directory, files: names.sort() });
  }
  return { binaryName, binary, licenses: licenses.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)) };
}

export async function packagePlugins(root) {
  const { pkg, lock } = await releaseMetadata(root);
  const marketplacePreparer = await readFile(join(root, 'plugins/prepare-marketplace.mjs'));
  for (const name of pluginNames) await access(join(root, 'plugins', name, 'scripts/run.mjs'));
  await access(join(root, 'dist', 'cli.js'));
  const dependencies = Object.entries(lock.packages).filter(([path, entry]) => path && !entry.dev && !entry.link);
  for (const [path] of dependencies) {
    if (!path.startsWith('node_modules/') || isAbsolute(path) || path.split('/').includes('..')) {
      throw new Error(`Invalid dependency path in lockfile: ${path}`);
    }
  }
  const rust = await rustBindingAssets(root);
  for (const name of pluginNames) {
    const plugin = join(root, 'plugins', name);
    const staging = await mkdtemp(join(plugin, '.runtime-'));
    try {
      await cp(join(root, 'dist'), join(staging, 'dist'), { recursive: true });
      if (rust) {
        await mkdir(join(staging, 'bin'), { recursive: true });
        await cp(rust.binary, join(staging, 'bin', rust.binaryName));
        for (const pkg of rust.licenses) for (const file of pkg.files) {
          const destination = join(staging, 'licenses/rust', `${pkg.name}-${pkg.version}`, file);
          await mkdir(dirname(destination), { recursive: true });
          await cp(join(pkg.directory, file), destination);
        }
        await mkdir(join(staging, 'licenses/rust'), { recursive: true });
        await writeFile(join(staging, 'licenses/rust/dependencies.json'), JSON.stringify(rust.licenses.map(({ name, version, license, files }) => ({ name, version, license, files })), null, 2) + '\n');
      }
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
      await rm(join(plugin, 'runtime'), { recursive: true, force: true });
      await rename(staging, join(plugin, 'runtime'));
      await writeFile(join(plugin, 'scripts/prepare-marketplace.mjs'), marketplacePreparer);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

export async function archivePlugins({ root, out }) {
  const { pkg } = await releaseMetadata(root);
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
  await mkdir(out, { recursive: true });
  const archives = [];
  for (const name of pluginNames) {
    const plugin = join(root, 'plugins', name);
    const archive = resolve(out, `specification-guided-development-${name}-${pkg.version}-${process.platform}-${process.arch}.tar.gz`);
    const result = spawnSync('tar', [
      '-czf', archive, '--exclude=.runtime-*', '--exclude=.DS_Store', '-C', plugin, '.',
    ], { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } });
    if (result.error || result.status !== 0) {
      await rm(archive, { force: true });
      throw new Error(`Cannot create plugin archive: ${result.error?.message ?? result.stderr.trim()}`);
    }
    archives.push(archive);
  }
  return archives;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 0 && (args.length !== 2 || args[0] !== '--archive-out' || !args[1])) {
      throw new Error('Usage: node plugins/package.mjs [--archive-out DIR]');
    }
    const root = fileURLToPath(new URL('../', import.meta.url));
    await packagePlugins(root);
    process.stdout.write('Prepared plugins/codex and plugins/claude-code with local runtimes.\n');
    if (args[1]) {
      const archives = await archivePlugins({ root, out: resolve(args[1]) });
      for (const archive of archives) process.stdout.write(`Created ${archive}\n`);
    }
  } catch (error) {
    process.stderr.write(`Plugin packaging failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
