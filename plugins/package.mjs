#!/usr/bin/env node
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export async function packagePlugins(root) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  if (!lock.packages) throw new Error('Use an npm lockfile with a packages map.');
  await access(join(root, 'dist', 'cli.js'));
  const dependencies = Object.entries(lock.packages).filter(([path, entry]) => path && !entry.dev && !entry.link);
  for (const [path] of dependencies) {
    if (!path.startsWith('node_modules/') || isAbsolute(path) || path.split('/').includes('..')) {
      throw new Error(`Invalid dependency path in lockfile: ${path}`);
    }
  }
  for (const name of ['codex', 'claude-code']) {
    const plugin = join(root, 'plugins', name);
    await access(join(plugin, 'scripts', 'run.mjs'));
    const staging = await mkdtemp(join(plugin, '.runtime-'));
    try {
      await cp(join(root, 'dist'), join(staging, 'dist'), { recursive: true });
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
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

export async function archivePlugins({ root, out }) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!/^[A-Za-z0-9.+-]+$/.test(pkg.version)) throw new Error('Invalid package version for archive names.');
  await mkdir(out, { recursive: true });
  const archives = [];
  for (const name of ['codex', 'claude-code']) {
    const plugin = join(root, 'plugins', name);
    await access(join(plugin, 'runtime', 'dist', 'cli.js'));
    const platform = JSON.parse(await readFile(join(plugin, 'runtime', 'runtime-platform.json'), 'utf8'));
    if (platform.version !== 1 || platform.platform !== process.platform || platform.arch !== process.arch) {
      throw new Error('Plugin runtime does not match this host. Rebuild before archiving.');
    }
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
