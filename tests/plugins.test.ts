import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { archivePlugins, packagePlugins } from '../plugins/package.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pluginNames = ['codex', 'claude-code'];
const packageName = 'specification-guided-development';
const packageVersion = '0.2.0-alpha.1';
const manifestPaths = [
  'plugins/codex/plugin.json',
  'plugins/codex/.codex-plugin/plugin.json',
  'plugins/claude-code/.claude-plugin/plugin.json',
];

async function createPackagingFixture(fixture: string) {
  await mkdir(join(fixture, 'dist'), { recursive: true });
  await writeFile(join(fixture, 'package.json'), JSON.stringify({
    name: packageName, version: packageVersion, type: 'module', license: 'MIT',
    dependencies: { 'runtime-probe': '1.0.0' },
  }));
  await writeFile(join(fixture, 'package-lock.json'), JSON.stringify({
    name: packageName, version: packageVersion, lockfileVersion: 3,
    packages: {
      '': { name: packageName, version: packageVersion },
      'node_modules/runtime-probe': { version: '1.0.0' },
      'node_modules/dev-probe': { version: '1.0.0', dev: true },
    },
  }));
  await writeFile(join(fixture, 'LICENSE'), 'test license\n');
  await mkdir(join(fixture, 'node_modules/runtime-probe'), { recursive: true });
  await writeFile(join(fixture, 'node_modules/runtime-probe/package.json'), JSON.stringify({
    name: 'runtime-probe', version: '1.0.0', type: 'module', exports: './index.js',
  }));
  await writeFile(join(fixture, 'node_modules/runtime-probe/index.js'), 'export const probe = "dependency loaded";\n');
  await mkdir(join(fixture, 'node_modules/dev-probe'), { recursive: true });
  await writeFile(join(fixture, 'node_modules/dev-probe/index.js'), 'throw new Error("dev package copied");\n');
  await writeFile(join(fixture, 'dist/cli.js'), [
    'import { probe } from "runtime-probe";',
    'process.stdout.write(JSON.stringify({ probe, args: process.argv.slice(2) }));',
    'process.exitCode = process.argv.includes("fail") ? 7 : 0;',
  ].join('\n'));
  for (const name of pluginNames) {
    const script = join(fixture, 'plugins', name, 'scripts/run.mjs');
    await mkdir(dirname(script), { recursive: true });
    await cp(join(root, 'plugins', name, 'scripts/run.mjs'), script);
  }
  for (const path of manifestPaths) {
    await mkdir(dirname(join(fixture, path)), { recursive: true });
    await writeFile(join(fixture, path), JSON.stringify({ name: packageName, version: packageVersion }));
  }
  await cp(join(root, 'plugins/prepare-marketplace.mjs'), join(fixture, 'plugins/prepare-marketplace.mjs'));
}

test('native marketplaces expose only their own plugin package', async () => {
  const codex = JSON.parse(await readFile(join(root, '.agents/plugins/marketplace.json'), 'utf8'));
  const claude = JSON.parse(await readFile(join(root, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(codex.plugins.length, 1);
  assert.equal(claude.plugins.length, 1);
  assert.equal(codex.plugins[0].source.path, './plugins/codex');
  assert.equal(claude.plugins[0].source, './plugins/claude-code');
  const codexManifest = JSON.parse(await readFile(join(root, 'plugins/codex/plugin.json'), 'utf8'));
  const claudeManifest = JSON.parse(await readFile(join(root, 'plugins/claude-code/.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(codexManifest.name, codex.plugins[0].name);
  assert.equal(claudeManifest.name, claude.plugins[0].name);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const path of manifestPaths) {
    const manifest = JSON.parse(await readFile(join(root, path), 'utf8'));
    assert.equal(manifest.name, pkg.name, path);
    assert.equal(manifest.version, pkg.version, path);
  }
  const codexMcp = JSON.parse(await readFile(join(root, 'plugins/codex/mcp.json'), 'utf8'));
  const claudeMcp = JSON.parse(await readFile(join(root, 'plugins/claude-code/.mcp.json'), 'utf8'));
  assert.equal(codexMcp.mcpServers.sgd.args[0], '${PLUGIN_ROOT}/scripts/run.mjs');
  assert.equal(claudeMcp.mcpServers.sgd.args[0], '${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs');
});

test('an isolated plugin gives setup instructions when its runtime is absent', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sgd-plugin-missing-'));
  try {
    for (const name of pluginNames) {
      const isolated = join(temporary, name, 'scripts/run.mjs');
      await mkdir(dirname(isolated), { recursive: true });
      await cp(join(root, 'plugins', name, 'scripts/run.mjs'), isolated);
      const result = spawnSync(process.execPath, [isolated, 'mcp'], { encoding: 'utf8', cwd: temporary });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /runtime is missing/);
      assert.match(result.stderr, /node plugins\/package\.mjs/);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('packaged plugins run after source removal and preserve arguments and failure exits', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sgd-plugin-package-'));
  const fixture = join(temporary, 'source');
  try {
    await createPackagingFixture(fixture);
    await packagePlugins(fixture);
    const cache = join(temporary, 'plugin cache with spaces');
    const archives = await archivePlugins({ root: fixture, out: join(temporary, 'archives') });
    for (const [index, name] of pluginNames.entries()) {
      const isolated = join(cache, name);
      const archive = archives[index];
      assert.ok(archive);
      assert.ok(archive.includes(`-${packageVersion}-`));
      assert.ok(archive.endsWith(`-${process.platform}-${process.arch}.tar.gz`));
      await mkdir(isolated, { recursive: true });
      const extracted = spawnSync('tar', ['-xzf', archive, '-C', isolated], { encoding: 'utf8' });
      assert.equal(extracted.status, 0, extracted.stderr);
    }
    await rm(fixture, { recursive: true, force: true });
    for (const name of pluginNames) {
      const isolated = join(cache, name);
      await assert.rejects(readFile(join(isolated, 'runtime/node_modules/dev-probe/index.js')));
      assert.deepEqual(JSON.parse(await readFile(join(isolated, 'runtime/runtime-platform.json'), 'utf8')), {
        version: 1, platform: process.platform, arch: process.arch,
      });
      const runtime = JSON.parse(await readFile(join(isolated, 'runtime/package.json'), 'utf8'));
      assert.equal(runtime.name, `${packageName}-plugin-runtime`);
      assert.equal(runtime.version, packageVersion);
      const preparer = spawnSync(process.execPath, [join(isolated, 'scripts/prepare-marketplace.mjs'), '--help'], {
        encoding: 'utf8', cwd: tmpdir(),
      });
      assert.equal(preparer.status, 0, preparer.stderr);
      assert.match(preparer.stdout, /--host/);
      assert.match(preparer.stdout, /--plugin/);
      assert.match(preparer.stdout, /--out/);
      const script = join(isolated, 'scripts/run.mjs');
      for (const command of ['inspect', 'fail']) {
        const result = spawnSync(process.execPath, [script, command, '--ir', 'path with spaces.json'], {
          encoding: 'utf8', cwd: tmpdir(),
        });
        assert.equal(result.status, command === 'fail' ? 7 : 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
          probe: 'dependency loaded', args: [command, '--ir', 'path with spaces.json'],
        });
      }
      await writeFile(join(isolated, 'runtime/runtime-platform.json'), JSON.stringify({
        version: 1, platform: process.platform, arch: 'different-architecture',
      }));
      const mismatch = spawnSync(process.execPath, [script, 'inspect'], { encoding: 'utf8', cwd: tmpdir() });
      assert.equal(mismatch.status, 1);
      assert.equal(mismatch.stdout, '');
      assert.match(mismatch.stderr, /built for/);
      assert.match(mismatch.stderr, /Rebuild the plugin on this host/);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('packaging rejects dependency paths that escape the source checkout', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sgd-plugin-path-'));
  try {
    await createPackagingFixture(temporary);
    await writeFile(join(temporary, 'package-lock.json'), JSON.stringify({
      name: packageName, version: packageVersion,
      packages: { 'node_modules/../../outside': { version: '1.0.0' } },
    }));
    await assert.rejects(packagePlugins(resolve(temporary)), /Invalid dependency path/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('every native manifest is checked before either installed runtime is changed', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sgd-plugin-manifest-'));
  try {
    await createPackagingFixture(temporary);
    for (const name of pluginNames) {
      await mkdir(join(temporary, 'plugins', name, 'runtime/dist'), { recursive: true });
      await writeFile(join(temporary, 'plugins', name, 'runtime/dist/cli.js'), `existing ${name} runtime\n`);
      await writeFile(join(temporary, 'plugins', name, 'scripts/prepare-marketplace.mjs'), `existing ${name} preparer\n`);
    }
    for (const path of manifestPaths) for (const changed of [
      { name: 'different-plugin', version: packageVersion },
      { name: packageName, version: '0.1.0' },
    ]) {
      await writeFile(join(temporary, path), JSON.stringify(changed));
      await assert.rejects(packagePlugins(temporary), /name and version must match root package.json/);
      for (const name of pluginNames) {
        assert.equal(await readFile(join(temporary, 'plugins', name, 'runtime/dist/cli.js'), 'utf8'), `existing ${name} runtime\n`);
        assert.equal(await readFile(join(temporary, 'plugins', name, 'scripts/prepare-marketplace.mjs'), 'utf8'), `existing ${name} preparer\n`);
      }
      await writeFile(join(temporary, path), JSON.stringify({ name: packageName, version: packageVersion }));
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('lockfile release metadata cannot disagree with the root package', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sgd-plugin-lock-version-'));
  try {
    await createPackagingFixture(temporary);
    const lockPath = join(temporary, 'package-lock.json');
    const original = await readFile(lockPath, 'utf8');
    for (const location of ['root', 'packages']) for (const key of ['name', 'version']) {
      const lock = JSON.parse(original);
      const metadata = location === 'root' ? lock : lock.packages[''];
      metadata[key] = key === 'name' ? 'different-package' : '0.1.0';
      await writeFile(lockPath, JSON.stringify(lock));
      await assert.rejects(packagePlugins(temporary), /must match root package.json/);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('malformed matching release versions cannot replace existing runtimes or preparers', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sgd-plugin-invalid-version-'));
  try {
    await createPackagingFixture(temporary);
    for (const name of pluginNames) {
      await mkdir(join(temporary, 'plugins', name, 'runtime/dist'), { recursive: true });
      await writeFile(join(temporary, 'plugins', name, 'runtime/dist/cli.js'), `existing ${name} runtime\n`);
      await writeFile(join(temporary, 'plugins', name, 'scripts/prepare-marketplace.mjs'), `existing ${name} preparer\n`);
    }
    for (const version of ['dev', '01.2.3', '1.02.3', '1.2.03', '0.2.0-01', '0.2.0-alpha.01', '1.2.3\n', '1.2.3\r\n', '1.2.3\u2028', '1.2.3\u2029', '1.2.3+build.01\n']) {
      const pkg = JSON.parse(await readFile(join(temporary, 'package.json'), 'utf8'));
      await writeFile(join(temporary, 'package.json'), JSON.stringify({ ...pkg, version }));
      const lock = JSON.parse(await readFile(join(temporary, 'package-lock.json'), 'utf8'));
      lock.version = version;
      lock.packages[''].version = version;
      await writeFile(join(temporary, 'package-lock.json'), JSON.stringify(lock));
      for (const path of manifestPaths) await writeFile(join(temporary, path), JSON.stringify({ name: packageName, version }));
      await assert.rejects(packagePlugins(temporary), /supported semantic version/, version);
      await assert.rejects(archivePlugins({ root: temporary, out: join(temporary, 'archives') }), /supported semantic version/, version);
      for (const name of pluginNames) {
        assert.equal(await readFile(join(temporary, 'plugins', name, 'runtime/dist/cli.js'), 'utf8'), `existing ${name} runtime\n`, version);
        assert.equal(await readFile(join(temporary, 'plugins', name, 'scripts/prepare-marketplace.mjs'), 'utf8'), `existing ${name} preparer\n`, version);
      }
      await assert.rejects(readFile(join(temporary, 'archives', `specification-guided-development-codex-${version}-${process.platform}-${process.arch}.tar.gz`)), { code: 'ENOENT' });
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('archiving refuses an older runtime before producing either release archive', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sgd-plugin-stale-runtime-'));
  try {
    await createPackagingFixture(temporary);
    await packagePlugins(temporary);
    const runtimePath = join(temporary, 'plugins/claude-code/runtime/package.json');
    const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
    await writeFile(runtimePath, JSON.stringify({ ...runtime, version: '0.1.0' }));
    const out = join(temporary, 'archives');
    await assert.rejects(archivePlugins({ root: temporary, out }), /runtime name and version must match/);
    await assert.rejects(readFile(join(out, `specification-guided-development-codex-${packageVersion}-${process.platform}-${process.arch}.tar.gz`)), { code: 'ENOENT' });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
