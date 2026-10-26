import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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
  await chmod(join(fixture, 'dist'), 0o750);
  await chmod(join(fixture, 'dist/cli.js'), 0o755);
  await chmod(join(fixture, 'node_modules/runtime-probe/index.js'), 0o640);
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
  await cp(join(root, 'plugins/package.mjs'), join(fixture, 'plugins/package.mjs'));
}

test('domain-capable plugin runtimes include their trusted Lean protocol source', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'sgd-domain-package-'));
  try {
    await createPackagingFixture(fixture);
    await writeFile(join(fixture, 'dist/domain-proof.js'), 'export {};\n');
    await mkdir(join(fixture, 'proofs/domain'), { recursive: true });
    const source = 'import Std\nnamespace DomainPackageFixture\nend DomainPackageFixture\n';
    await writeFile(join(fixture, 'proofs/domain/DomainProtocol.lean'), source);
    await packagePlugins(fixture);
    for (const name of pluginNames) {
      assert.equal(await readFile(join(fixture, 'plugins', name, 'runtime/proofs/domain/DomainProtocol.lean'), 'utf8'), source);
    }
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('packaging refuses a domain runtime without its Lean protocol instead of publishing a broken runtime', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'sgd-missing-domain-proof-'));
  try {
    await createPackagingFixture(fixture);
    await writeFile(join(fixture, 'dist/domain-proof.js'), 'export {};\n');
    await mkdir(join(fixture, 'plugins/codex/runtime'), { recursive: true });
    await writeFile(join(fixture, 'plugins/codex/runtime/keep'), 'old runtime');
    await assert.rejects(packagePlugins(fixture), /ENOENT/);
    assert.equal(await readFile(join(fixture, 'plugins/codex/runtime/keep'), 'utf8'), 'old runtime');
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

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

for (const format of ['tar.gz', 'zip']) test(`packaged ${format} plugins run after source removal and preserve modes, arguments and failure exits`, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sgd-plugin-package-'));
  const fixture = join(temporary, 'source');
  try {
    await createPackagingFixture(fixture);
    await packagePlugins(fixture);
    for (const name of pluginNames) {
      const plugin = join(fixture, 'plugins', name);
      assert.equal((await stat(join(plugin, 'runtime'))).mode & 0o777, 0o755);
      await mkdir(join(plugin, 'runtime/bin'), { recursive: true });
      await writeFile(join(plugin, 'runtime/bin/native-probe'), Uint8Array.of(0x7f, 0x45, 0x4c, 0x46, 0x00));
      await chmod(join(plugin, 'runtime/bin/native-probe'), 0o755);
      await symlink('runtime/node_modules/runtime-probe/index.js', join(plugin, 'dependency-link'));
      for (const path of ['.runtime-excluded/probe', 'scripts/.runtime-excluded/probe', '.DS_Store', 'runtime/dist/.DS_Store']) {
        await mkdir(dirname(join(plugin, path)), { recursive: true });
        await writeFile(join(plugin, path), 'excluded');
      }
    }
    const cache = join(temporary, 'plugin cache with spaces');
    const archives = await archivePlugins({ root: fixture, out: join(temporary, 'archives'), ...(format === 'zip' ? { format } : {}) });
    for (const [index, name] of pluginNames.entries()) {
      const isolated = join(cache, name);
      const archive = archives[index];
      assert.ok(archive);
      assert.ok(archive.includes(`-${packageVersion}-`));
      assert.ok(archive.endsWith(`-${process.platform}-${process.arch}.${format}`));
      await mkdir(isolated, { recursive: true });
      const extracted = format === 'zip'
        ? spawnSync('unzip', ['-q', archive, '-d', isolated], { encoding: 'utf8' })
        : spawnSync('tar', ['-xzpf', archive, '-C', isolated], { encoding: 'utf8' });
      assert.equal(extracted.status, 0, extracted.stderr);
      for (const [path, mode] of [
        ['runtime', 0o755],
        ['runtime/dist', 0o750],
        ['runtime/dist/cli.js', 0o755],
        ['runtime/bin/native-probe', 0o755],
        ['runtime/node_modules/runtime-probe/index.js', 0o640],
      ] satisfies [string, number][]) {
        assert.equal((await stat(join(isolated, path))).mode & 0o777, mode, `${name}/${path}`);
      }
    }
    await rm(fixture, { recursive: true, force: true });
    for (const name of pluginNames) {
      const isolated = join(cache, name);
      const manifest = name === 'codex' ? '.codex-plugin/plugin.json' : '.claude-plugin/plugin.json';
      assert.deepEqual(JSON.parse(await readFile(join(isolated, manifest), 'utf8')), { name: packageName, version: packageVersion });
      assert.deepEqual(await readFile(join(isolated, 'runtime/bin/native-probe')), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]));
      assert.equal(await readlink(join(isolated, 'dependency-link')), 'runtime/node_modules/runtime-probe/index.js');
      assert.equal(await readFile(join(isolated, 'dependency-link'), 'utf8'), 'export const probe = "dependency loaded";\n');
      for (const path of ['.runtime-excluded', 'scripts/.runtime-excluded', '.DS_Store', 'runtime/dist/.DS_Store']) {
        await assert.rejects(stat(join(isolated, path)), { code: 'ENOENT' });
      }
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

for (const format of ['tar.gz', 'zip']) test(`archiving ${format} refuses an older runtime before producing either release archive`, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sgd-plugin-stale-runtime-'));
  try {
    await createPackagingFixture(temporary);
    await packagePlugins(temporary);
    const runtimePath = join(temporary, 'plugins/claude-code/runtime/package.json');
    const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
    await writeFile(runtimePath, JSON.stringify({ ...runtime, version: '0.1.0' }));
    const out = join(temporary, 'archives');
    await assert.rejects(archivePlugins({ root: temporary, out, format }), /runtime name and version must match/);
    await assert.rejects(readFile(join(out, `specification-guided-development-codex-${packageVersion}-${process.platform}-${process.arch}.${format}`)), { code: 'ENOENT' });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('archive API rejects unsupported formats before creating output', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sgd-plugin-format-'));
  try {
    for (const format of ['7z', '', null]) {
      const out = join(temporary, 'archives');
      await assert.rejects(archivePlugins({ root: join(temporary, 'missing-source'), out, format }), /archive format must be tar.gz or zip/);
      await assert.rejects(stat(out), { code: 'ENOENT' });
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

for (const format of ['tar.gz', 'zip']) test(`archiving ${format} refuses existing output before producing either archive`, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sgd-plugin-existing-'));
  try {
    await createPackagingFixture(temporary);
    await packagePlugins(temporary);
    const out = join(temporary, 'archives');
    await mkdir(out);
    const existing = join(out, `specification-guided-development-claude-code-${packageVersion}-${process.platform}-${process.arch}.${format}`);
    await writeFile(existing, 'published archive');
    await assert.rejects(archivePlugins({ root: temporary, out, format }), /archive already exists/);
    assert.equal(await readFile(existing, 'utf8'), 'published archive');
    assert.deepEqual(await readdir(out), [basename(existing)]);
    await rm(existing);
    await symlink('missing-archive', existing);
    await assert.rejects(archivePlugins({ root: temporary, out, format }), /archive already exists/);
    assert.equal(await readlink(existing), 'missing-archive');
    assert.deepEqual(await readdir(out), [basename(existing)]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

for (const format of ['tar.gz', 'zip']) test(`archiving ${format} cannot replace a file created after preflight and cleans temporary output`, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sgd-plugin-race-'));
  try {
    await createPackagingFixture(temporary);
    const out = join(temporary, 'archives');
    const tools = join(temporary, 'tool-bin');
    await mkdir(out);
    await mkdir(tools);
    const command = format === 'zip' ? 'zip' : 'tar';
    const located = spawnSync('/bin/sh', ['-c', `command -v ${command}`], { encoding: 'utf8' });
    assert.equal(located.status, 0, located.stderr);
    const existing = join(out, `specification-guided-development-codex-${packageVersion}-${process.platform}-${process.arch}.${format}`);
    await writeFile(join(tools, 'package.json'), '{"type":"module"}\n');
    await writeFile(join(tools, command), [
      '#!/usr/bin/env node',
      'import { spawnSync } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `const result = spawnSync(${JSON.stringify(located.stdout.trim())}, process.argv.slice(2), { stdio: "inherit" });`,
      `if (result.status === 0) writeFileSync(${JSON.stringify(existing)}, "competing archive", { flag: "wx" });`,
      'process.exit(result.status ?? 1);',
    ].join('\n'));
    await chmod(join(tools, command), 0o755);
    const result = spawnSync(process.execPath, [await realpath(join(temporary, 'plugins/package.mjs')), '--archive-out', out, '--archive-format', format], {
      encoding: 'utf8', env: { ...process.env, PATH: `${tools}:${process.env.PATH ?? ''}` },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /EEXIST/);
    assert.equal(await readFile(existing, 'utf8'), 'competing archive');
    assert.deepEqual(await readdir(out), [basename(existing)]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('packaging CLI validates archive options and existing output before changing runtimes', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sgd-plugin-options-'));
  try {
    await createPackagingFixture(temporary);
    for (const name of pluginNames) {
      await mkdir(join(temporary, 'plugins', name, 'runtime/dist'), { recursive: true });
      await writeFile(join(temporary, 'plugins', name, 'runtime/dist/cli.js'), `existing ${name} runtime\n`);
    }
    const out = join(temporary, 'archives');
    for (const args of [
      ['--archive-format', 'zip'], ['--archive-out'], ['--archive-out', out, '--archive-format'],
      ['--archive-out', out, '--archive-format', '7z'], ['--archive-out', out, '--unknown', 'zip'],
      ['--archive-out', out, '--archive-out', out],
      ['--archive-out', out, '--archive-format', 'zip', '--archive-format', 'zip'],
      ['--archive-out', '--archive-format', 'zip'],
    ]) {
      const result = spawnSync(process.execPath, [await realpath(join(temporary, 'plugins/package.mjs')), ...args], { encoding: 'utf8' });
      assert.equal(result.status, 1, args.join(' '));
      assert.match(result.stderr, /Usage:/);
      assert.equal(result.stdout, '');
      await assert.rejects(stat(out), { code: 'ENOENT' });
      for (const name of pluginNames) {
        assert.equal(await readFile(join(temporary, 'plugins', name, 'runtime/dist/cli.js'), 'utf8'), `existing ${name} runtime\n`);
      }
    }
    await mkdir(out);
    const existing = join(out, `specification-guided-development-claude-code-${packageVersion}-${process.platform}-${process.arch}.zip`);
    await writeFile(existing, 'published archive');
    const result = spawnSync(process.execPath, [await realpath(join(temporary, 'plugins/package.mjs')), '--archive-format', 'zip', '--archive-out', out], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /archive already exists/);
    assert.equal(result.stdout, '');
    assert.equal(await readFile(existing, 'utf8'), 'published archive');
    assert.deepEqual(await readdir(out), [basename(existing)]);
    for (const name of pluginNames) {
      assert.equal(await readFile(join(temporary, 'plugins', name, 'runtime/dist/cli.js'), 'utf8'), `existing ${name} runtime\n`);
    }
    await rm(existing);
    const valid = spawnSync(process.execPath, [await realpath(join(temporary, 'plugins/package.mjs')), '--archive-format', 'zip', '--archive-out', out], { encoding: 'utf8' });
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /Prepared plugins\/codex and plugins\/claude-code/);
    assert.deepEqual((await readdir(out)).sort(), pluginNames.map(name => `specification-guided-development-${name}-${packageVersion}-${process.platform}-${process.arch}.zip`).sort());
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('archive output cannot be inside either plugin source, including a symlinked directory', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sgd-plugin-output-'));
  try {
    await createPackagingFixture(temporary);
    const alias = join(temporary, 'plugin-alias');
    await symlink(join(temporary, 'plugins/claude-code'), alias);
    for (const out of [join(temporary, 'plugins/codex'), join(temporary, 'plugins/claude-code/archives'), join(alias, 'archives')]) {
      await assert.rejects(archivePlugins({ root: temporary, out, format: 'zip' }), /outside both plugin source directories/);
    }
    await assert.rejects(stat(join(temporary, 'plugins/codex/runtime')), { code: 'ENOENT' });
    await assert.rejects(stat(join(temporary, 'plugins/claude-code/archives')), { code: 'ENOENT' });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
