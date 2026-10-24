import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { prepareMarketplace } from '../plugins/prepare-marketplace.mjs';

const helper = fileURLToPath(new URL('../plugins/prepare-marketplace.mjs', import.meta.url));
const name = 'specification-guided-development';
const version = '0.2.0-alpha.1';
type Host = 'codex' | 'claude-code';

async function json(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

async function fixture(base: string, host: Host) {
  const plugin = join(base, `extracted ${host}`);
  const rootVariable = host === 'codex' ? '${PLUGIN_ROOT}' : '${CLAUDE_PLUGIN_ROOT}';
  await json(join(plugin, host === 'codex' ? 'plugin.json' : '.claude-plugin/plugin.json'), host === 'codex'
    ? { name, version, extensions: { 'com.openai': { requires_local_executor: true } } }
    : { name, version, skills: './skills/', mcpServers: './.mcp.json' });
  await json(join(plugin, host === 'codex' ? 'mcp.json' : '.mcp.json'), {
    mcpServers: { sgd: host === 'codex'
      ? { type: 'stdio', command: 'node', args: [`${rootVariable}/scripts/run.mjs`, 'mcp'], cwd: rootVariable }
      : { command: 'node', args: [`${rootVariable}/scripts/run.mjs`, 'mcp'] } },
  });
  if (host === 'codex') {
    await json(join(plugin, '.codex-plugin/plugin.json'), { name, version, skills: './skills/', mcpServers: './.mcp.json', requires_local_executor: true });
    await json(join(plugin, '.mcp.json'), { mcpServers: { sgd: { command: 'node', args: ['scripts/run.mjs', 'mcp'], cwd: '.' } } });
  }
  await json(join(plugin, 'runtime/package.json'), { name: `${name}-plugin-runtime`, version, type: 'module', dependencies: { 'runtime-probe': '1.0.0' } });
  await json(join(plugin, 'runtime/runtime-platform.json'), { version: 1, platform: process.platform, arch: process.arch });
  await json(join(plugin, 'runtime/node_modules/runtime-probe/package.json'), { name: 'runtime-probe', version: '1.0.0' });
  for (const path of ['scripts/run.mjs', 'runtime/dist/cli.js', 'runtime/dist/mcp.js', 'skills/specification-guided-development/SKILL.md', `runtime/bin/sgd-rust-bindings${process.platform === 'win32' ? '.exe' : ''}`]) {
    const file = join(plugin, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `fixture ${path}\n`, { mode: 0o755 });
  }
  await cp(helper, join(plugin, 'scripts/prepare-marketplace.mjs'));
  await writeFile(join(plugin, 'LICENSE'), 'license fixture\n');
  return plugin;
}

async function scratch() { return mkdtemp(join(await realpath(tmpdir()), 'sgd-marketplace-test-')); }

for (const host of ['codex', 'claude-code'] satisfies Host[]) {
  test(`prepares an independent ${host} marketplace without installing anything`, async () => {
    const temporary = await scratch();
    try {
      const plugin = await fixture(temporary, host);
      const out = join(temporary, 'prepared marketplace');
      const result = await prepareMarketplace({ host, plugin, out });
      assert.equal(result.installsNothing, true);
      assert.equal(result.version, version);
      assert.equal(result.platform, process.platform);
      assert.equal(result.arch, process.arch);
      assert.equal(result.filesystemAtomicity, 'not-atomic');
      const catalogue = JSON.parse(await readFile(join(out, host === 'codex' ? '.agents/plugins/marketplace.json' : '.claude-plugin/marketplace.json'), 'utf8'));
      assert.equal(catalogue.plugins.length, 1);
      assert.equal(catalogue.name, `${name}-${host === 'codex' ? 'codex' : 'claude'}`);
      assert.deepEqual(catalogue.plugins[0].source, host === 'codex' ? { source: 'local', path: './plugins/codex' } : './plugins/claude-code');
      assert.deepEqual((await readdir(out)).sort(), [host === 'codex' ? '.agents' : '.claude-plugin', 'plugins']);
      assert.deepEqual(await readdir(join(out, 'plugins')), [host]);
      assert.equal(result.marketplace.pluginPath, join(out, 'plugins', host));
      assert.deepEqual(result.installation, {
        runFrom: 'project-root', argv: host === 'codex'
          ? [['codex', 'plugin', 'marketplace', 'add', out, '--json'], ['codex', 'plugin', 'add', `${name}@${name}-codex`, '--json']]
          : [['claude', 'plugin', 'marketplace', 'add', out, '--scope', 'local', '--json'], ['claude', 'plugin', 'install', `${name}@${name}-claude`, '--scope', 'local', '--json']],
      });
      await rm(plugin, { recursive: true });
      const copied = join(out, 'plugins', host);
      assert.equal(await readFile(join(copied, 'LICENSE'), 'utf8'), 'license fixture\n');
      const second = join(temporary, 'second marketplace');
      const command = spawnSync(process.execPath, [join(copied, 'scripts/prepare-marketplace.mjs'), '--host', host, '--plugin', copied, '--out', second], { encoding: 'utf8', cwd: temporary });
      assert.equal(command.status, 0, command.stderr);
      assert.equal(JSON.parse(command.stdout).marketplace.path, second);
      assert.equal(await readFile(join(second, 'plugins', host, 'LICENSE'), 'utf8'), 'license fixture\n');
      if (process.platform !== 'win32') assert.ok(Number((await lstat(join(copied, 'runtime/bin/sgd-rust-bindings'))).mode) & 0o111);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
}

test('refuses existing outputs and output paths inside the extracted artifact', async () => {
  const temporary = await scratch();
  try {
    const plugin = await fixture(temporary, 'codex');
    const out = join(temporary, 'already exists');
    await mkdir(out);
    await writeFile(join(out, 'keep'), 'existing data');
    await assert.rejects(prepareMarketplace({ host: 'codex', plugin, out }), /output already exists/);
    assert.equal(await readFile(join(out, 'keep'), 'utf8'), 'existing data');
    await assert.rejects(prepareMarketplace({ host: 'codex', plugin, out: join(plugin, 'nested') }), /outside the plugin source/);
    await assert.rejects(lstat(join(plugin, 'nested')), { code: 'ENOENT' });
    await assert.rejects(prepareMarketplace({ host: 'other', plugin, out: join(temporary, 'unsupported') }), /--host codex or --host claude-code/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('rejects stale versions, foreign platforms, incomplete dependencies, and launcher escapes before creating output', async () => {
  const temporary = await scratch();
  try {
    const cases = [
      { path: 'runtime/package.json', value: { name: `${name}-plugin-runtime`, version: '0.1.0', type: 'module', dependencies: {} }, error: /same supported version/ },
      { path: 'runtime/runtime-platform.json', value: { version: 1, platform: process.platform, arch: 'unsupported' }, error: /matching release/ },
      { path: 'runtime/runtime-platform.json', value: { version: 9, platform: process.platform, arch: process.arch }, error: /schema 1/ },
      { path: 'plugin.json', value: { name, version: 'not-a-version', extensions: { 'com.openai': { requires_local_executor: true } } }, error: /supported semantic version/ },
      { path: 'plugin.json', value: { name, version: 'dev', extensions: { 'com.openai': { requires_local_executor: true } } }, error: /supported semantic version/ },
      { path: 'plugin.json', value: { name, version: '01.2.3', extensions: { 'com.openai': { requires_local_executor: true } } }, error: /supported semantic version/ },
      { path: 'plugin.json', value: { name, version: '1.02.3', extensions: { 'com.openai': { requires_local_executor: true } } }, error: /supported semantic version/ },
      { path: 'plugin.json', value: { name, version: '1.2.03', extensions: { 'com.openai': { requires_local_executor: true } } }, error: /supported semantic version/ },
      { path: 'plugin.json', value: { name, version: '0.2.0-01', extensions: { 'com.openai': { requires_local_executor: true } } }, error: /supported semantic version/ },
      { path: 'plugin.json', value: { name, version: '0.2.0-alpha.01', extensions: { 'com.openai': { requires_local_executor: true } } }, error: /supported semantic version/ },
      ...['1.2.3\n', '1.2.3\r\n', '1.2.3\u2028', '1.2.3\u2029', '1.2.3+build.01\n'].map(version => ({ path: 'plugin.json', value: { name, version, extensions: { 'com.openai': { requires_local_executor: true } } }, error: /supported semantic version/ })),
      { path: 'mcp.json', value: { mcpServers: { sgd: { command: 'node', args: ['../../external.mjs', 'mcp'], type: 'stdio', cwd: '${PLUGIN_ROOT}' } } }, error: /packaged SGD launcher/ },
      { path: '.codex-plugin/plugin.json', value: { name, version: '0.1.0', skills: './skills/', mcpServers: './.mcp.json', requires_local_executor: true }, error: /compatibility manifest must match/ },
      { path: '.mcp.json', value: { mcpServers: { sgd: { command: 'external-command', args: ['scripts/run.mjs', 'mcp'], cwd: '.' } } }, error: /compatibility .mcp.json must start/ },
      { path: '.mcp.json', value: { mcpServers: { sgd: { command: 'node', args: ['scripts/run.mjs', 'mcp'], cwd: '.', env: { UNEXPECTED: 'value' } } } }, error: /compatibility .mcp.json must start/ },
      { path: 'runtime/package.json', value: { name: `${name}-plugin-runtime`, version, type: 'module', dependencies: { '../outside': '1.0.0' } }, error: /dependency name/ },
      { path: 'runtime/package.json', value: { name: `${name}-plugin-runtime`, version, type: 'module', dependencies: { missing: '1.0.0' } }, error: /runtime\/node_modules\/missing\/package.json/ },
    ];
    for (const [index, invalid] of cases.entries()) {
      const base = join(temporary, `case-${index}`);
      await mkdir(base);
      const plugin = await fixture(base, 'codex');
      const out = join(base, 'out');
      await json(join(plugin, invalid.path), invalid.value);
      await assert.rejects(prepareMarketplace({ host: 'codex', plugin, out }), invalid.error);
      await assert.rejects(lstat(out), { code: 'ENOENT' });
      assert.equal(await readFile(join(plugin, 'LICENSE'), 'utf8'), 'license fixture\n');
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('rejects missing native code, non-executable helpers, and bounded oversized files', async () => {
  const temporary = await scratch();
  try {
    const plugin = await fixture(temporary, 'codex');
    const out = join(temporary, 'out');
    const binary = join(plugin, `runtime/bin/sgd-rust-bindings${process.platform === 'win32' ? '.exe' : ''}`);
    if (process.platform !== 'win32') {
      await chmod(binary, 0o644);
      await assert.rejects(prepareMarketplace({ host: 'codex', plugin, out }), /must be executable/);
      await chmod(binary, 0o755);
    }
    await rm(join(plugin, 'runtime/dist/mcp.js'));
    await assert.rejects(prepareMarketplace({ host: 'codex', plugin, out }), /runtime\/dist\/mcp.js/);
    await writeFile(join(plugin, 'runtime/dist/mcp.js'), 'fixture');
    await writeFile(join(plugin, 'oversized'), '');
    await truncate(join(plugin, 'oversized'), 64 * 1024 * 1024 + 1);
    await assert.rejects(prepareMarketplace({ host: 'codex', plugin, out }), /byte limit/);
    await assert.rejects(lstat(out), { code: 'ENOENT' });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('rejects symlink sources and parents without altering the target', async context => {
  const temporary = await scratch();
  try {
    const plugin = await fixture(temporary, 'codex');
    const alias = join(temporary, 'alias');
    try { await symlink(plugin, alias, 'dir'); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EPERM') { context.skip('This host does not allow test symlinks.'); return; }
      throw error;
    }
    await assert.rejects(prepareMarketplace({ host: 'codex', plugin: alias, out: join(temporary, 'out') }), /Symlink paths/);
    await assert.rejects(prepareMarketplace({ host: 'codex', plugin, out: join(alias, 'nested') }), /Symlink paths/);
    await symlink(join(plugin, 'LICENSE'), join(plugin, 'linked-file'), 'file');
    await assert.rejects(prepareMarketplace({ host: 'codex', plugin, out: join(temporary, 'out') }), /Symlinks are unsupported/);
    assert.equal(await readFile(join(plugin, 'LICENSE'), 'utf8'), 'license fixture\n');
    await assert.rejects(lstat(join(temporary, 'out')), { code: 'ENOENT' });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('a source inventory change while copying refuses publication and removes only the new output', async () => {
  const temporary = await scratch();
  try {
    const plugin = await fixture(temporary, 'codex');
    for (let index = 0; index < 32; index++) await writeFile(join(plugin, `copy-probe-${index}`), Buffer.alloc(128 * 1024, index));
    const keep = join(temporary, 'keep');
    await writeFile(keep, 'unrelated data');
    const out = join(temporary, 'out');
    let finished = false;
    let mutated = false;
    const mutation = (async () => {
      while (!finished) {
        try {
          await lstat(out);
          await writeFile(join(plugin, 'new-source-file'), 'changed inventory');
          mutated = true;
          return;
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
        }
        await setImmediate();
      }
    })();
    try {
      await assert.rejects(prepareMarketplace({ host: 'codex', plugin, out }), /source.*changed|inventory changed|directory inventory changed/);
    } finally {
      finished = true;
      await mutation;
    }
    assert.ok(mutated, 'The output creation must have triggered the source mutation.');
    await assert.rejects(lstat(out), { code: 'ENOENT' });
    assert.equal(await readFile(keep, 'utf8'), 'unrelated data');
    assert.equal(await readFile(join(plugin, 'new-source-file'), 'utf8'), 'changed inventory');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('standalone helper reports usage and refuses malformed arguments without native installation', () => {
  const help = spawnSync(process.execPath, [helper, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Installs nothing/);
  const invalid = spawnSync(process.execPath, [helper, '--host', 'codex', '--host', 'claude-code'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /Usage:/);
});
