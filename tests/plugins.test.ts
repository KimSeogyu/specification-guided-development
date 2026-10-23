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
    await mkdir(join(fixture, 'dist'), { recursive: true });
    await writeFile(join(fixture, 'package.json'), JSON.stringify({
      name: 'specification-guided-development', version: '0.1.0', type: 'module', license: 'MIT',
      dependencies: { 'runtime-probe': '1.0.0' },
    }));
    await writeFile(join(fixture, 'package-lock.json'), JSON.stringify({
      packages: {
        '': {},
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
    await packagePlugins(fixture);
    const cache = join(temporary, 'plugin cache with spaces');
    const archives = await archivePlugins({ root: fixture, out: join(temporary, 'archives') });
    for (const [index, name] of pluginNames.entries()) {
      const isolated = join(cache, name);
      const archive = archives[index];
      assert.ok(archive);
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
    await mkdir(join(temporary, 'dist'));
    await writeFile(join(temporary, 'dist/cli.js'), '');
    await writeFile(join(temporary, 'package.json'), '{}');
    await writeFile(join(temporary, 'package-lock.json'), JSON.stringify({
      packages: { 'node_modules/../../outside': { version: '1.0.0' } },
    }));
    await assert.rejects(packagePlugins(resolve(temporary)), /Invalid dependency path/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
