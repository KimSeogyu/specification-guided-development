import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { BigIntStats } from 'node:fs';
import fs, { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
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

const guardFields = ['dev', 'ino', 'mode', 'size', 'mtimeNs'] satisfies (keyof BigIntStats)[];
const fixedTime = new Date('2001-01-01T00:00:00.000Z');
const probeBytes = Buffer.alloc(2 * 1024 * 1024 + 257, 0x41);
type ReadGate = 'before-open' | 'during-read';

async function sameModeChmod(path: string) {
  const before = await lstat(path, { bigint: true });
  await chmod(path, Number(before.mode & 0o777n));
  const after = await lstat(path, { bigint: true });
  for (const field of guardFields) assert.equal(after[field], before[field], `same-mode chmod must preserve ${field}`);
  assert.notEqual(after.ctimeNs, before.ctimeNs, 'The real same-mode chmod must change ctime.');
}

async function changeBytesWithRestoredMtime(path: string) {
  const before = await lstat(path, { bigint: true });
  const actualWrite = fs.writeFile;
  await actualWrite(path, Buffer.alloc(Number(before.size), 0x42));
  await utimes(path, fixedTime, fixedTime);
  const after = await lstat(path, { bigint: true });
  for (const field of guardFields) assert.equal(after[field], before[field], `content mutation must restore ${field}`);
}

async function interceptReads(context: TestContext, path: string, gate: ReadGate, mutate: () => Promise<void>, run: () => Promise<void>) {
  const actualOpen = fs.open;
  let opens = 0;
  let mutations = 0;
  context.mock.method(fs, 'open', async (...arguments_: Parameters<typeof fs.open>) => {
    if (arguments_[0] !== path) return actualOpen(...arguments_);
    const occurrence = ++opens;
    if (occurrence === 2 && gate === 'before-open') { await mutate(); mutations++; }
    const handle = await actualOpen(...arguments_);
    if (occurrence === 2 && gate === 'during-read') {
      const actualRead = handle.read.bind(handle);
      context.mock.method(handle, 'read', async (...readArguments: Parameters<typeof handle.read>) => {
        const result = await actualRead(...readArguments);
        if (result.bytesRead > 0 && mutations === 0) {
          assert.ok(result.bytesRead < probeBytes.length, 'The mutation must follow an actual partial read.');
          await mutate();
          mutations++;
        }
        return result;
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  try { await run(); }
  finally { context.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(mutations, 1, 'The selected real filesystem mutation must run exactly once.');
}

async function afterCopyWrite(context: TestContext, path: string, mutate: () => Promise<void>, run: () => Promise<void>) {
  const actualWrite = fs.writeFile;
  let mutations = 0;
  context.mock.method(fs, 'writeFile', async (...arguments_: Parameters<typeof fs.writeFile>) => {
    const result = await actualWrite(...arguments_);
    if (arguments_[0] === path) { await mutate(); mutations++; }
    return result;
  });
  syncBuiltinESMExports();
  try { await run(); }
  finally { context.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(mutations, 1, 'The mutation must follow exactly one completed output file write.');
}

for (const gate of ['before-open', 'during-read'] satisfies ReadGate[]) {
  test(`accepts a real ctime-only chmod ${gate} without changing payload identity`, async context => {
    if (process.platform === 'win32') { context.skip('The ctime-only chmod probe requires POSIX metadata behavior.'); return; }
    const temporary = await scratch();
    try {
      const plugin = await fixture(temporary, 'codex');
      const probe = join(plugin, 'copy-probe.bin');
      await writeFile(probe, probeBytes);
      const out = join(temporary, 'out');
      await interceptReads(context, probe, gate, () => sameModeChmod(probe), async () => {
        const result = await prepareMarketplace({ host: 'codex', plugin, out });
        assert.equal(result.sourceConsistency, 'captured-files-and-inventory-rechecked');
      });
      assert.deepEqual(await readFile(join(out, 'plugins/codex/copy-probe.bin')), probeBytes);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });

  test(`rejects same-size changed bytes with restored mtime ${gate}`, async context => {
    const temporary = await scratch();
    try {
      const plugin = await fixture(temporary, 'codex');
      const probe = join(plugin, 'copy-probe.bin');
      await writeFile(probe, probeBytes);
      await utimes(probe, fixedTime, fixedTime);
      const out = join(temporary, 'out');
      await interceptReads(context, probe, gate, () => changeBytesWithRestoredMtime(probe), async () => {
        await assert.rejects(prepareMarketplace({ host: 'codex', plugin, out }), /copy-probe\.bin \(changed fields: digest\)/);
      });
      await assert.rejects(lstat(out), { code: 'ENOENT' });
      assert.deepEqual(await readFile(probe), Buffer.alloc(probeBytes.length, 0x42));
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
}

test('accepts ctime-only file and directory changes before final recapture', async context => {
  if (process.platform === 'win32') { context.skip('The ctime-only chmod probe requires POSIX metadata behavior.'); return; }
  const temporary = await scratch();
  try {
    const plugin = await fixture(temporary, 'codex');
    const probe = join(plugin, 'copy-probe.bin');
    await writeFile(probe, probeBytes);
    const out = join(temporary, 'out');
    const copied = join(out, 'plugins/codex/copy-probe.bin');
    await afterCopyWrite(context, copied, async () => {
      assert.deepEqual(await readFile(copied), probeBytes);
      await sameModeChmod(probe);
      await sameModeChmod(plugin);
    }, async () => {
      await prepareMarketplace({ host: 'codex', plugin, out });
    });
    assert.deepEqual(await readFile(copied), probeBytes);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('rejects permission changes between lstat and open', async context => {
  if (process.platform === 'win32') { context.skip('The permission-bit mutation probe requires POSIX modes.'); return; }
  const temporary = await scratch();
  try {
    const plugin = await fixture(temporary, 'codex');
    const probe = join(plugin, 'copy-probe.bin');
    await writeFile(probe, probeBytes, { mode: 0o644 });
    await chmod(probe, 0o644);
    const out = join(temporary, 'out');
    await interceptReads(context, probe, 'before-open', () => chmod(probe, 0o600), async () => {
      await assert.rejects(prepareMarketplace({ host: 'codex', plugin, out }), /copy-probe\.bin \(changed fields: mode\)/);
    });
    await assert.rejects(lstat(out), { code: 'ENOENT' });
    assert.deepEqual(await readFile(probe), probeBytes);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('source-change diagnostics bound relative paths and omit file contents', async context => {
  const temporary = await scratch();
  try {
    const plugin = await fixture(temporary, 'codex');
    const probe = join(plugin, 'long-directory-'.repeat(12), `${'long-file-'.repeat(12)}probe.bin`);
    await mkdir(dirname(probe));
    await writeFile(probe, probeBytes);
    await utimes(probe, fixedTime, fixedTime);
    const path = relative(plugin, probe).split(sep).join('/');
    assert.ok(path.length > 180);
    const out = join(temporary, 'out');
    await interceptReads(context, probe, 'before-open', () => changeBytesWithRestoredMtime(probe), async () => {
      await assert.rejects(prepareMarketplace({ host: 'codex', plugin, out }), error => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(`${path.slice(0, 177)}... (changed fields: digest)`));
        assert.ok(error.message.length < 400);
        assert.ok(!error.message.includes(plugin));
        assert.ok(!error.message.includes('B'.repeat(32)));
        return true;
      });
    });
    await assert.rejects(lstat(out), { code: 'ENOENT' });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('a file removed between lstat and open reports its relative inventory change', async context => {
  const temporary = await scratch();
  try {
    const plugin = await fixture(temporary, 'codex');
    const probe = join(plugin, 'copy-probe.bin');
    await writeFile(probe, probeBytes);
    const out = join(temporary, 'out');
    await interceptReads(context, probe, 'before-open', () => rm(probe), async () => {
      await assert.rejects(prepareMarketplace({ host: 'codex', plugin, out }), /while opening a file: copy-probe\.bin \(changed fields: inventory\)/);
    });
    await assert.rejects(lstat(out), { code: 'ENOENT' });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('rejects an inode replacement with equal bytes, mode, size, and mtime', async context => {
  const temporary = await scratch();
  try {
    const plugin = await fixture(temporary, 'codex');
    const probe = join(plugin, 'copy-probe.bin');
    const replacement = join(temporary, 'replacement');
    await writeFile(probe, probeBytes);
    await utimes(probe, fixedTime, fixedTime);
    const before = await lstat(probe, { bigint: true });
    await writeFile(replacement, probeBytes);
    await chmod(replacement, Number(before.mode & 0o777n));
    await utimes(replacement, fixedTime, fixedTime);
    const out = join(temporary, 'out');
    await interceptReads(context, probe, 'before-open', async () => {
      await rename(replacement, probe);
      const after = await lstat(probe, { bigint: true });
      for (const field of ['dev', 'mode', 'size', 'mtimeNs'] satisfies (keyof typeof before)[]) assert.equal(after[field], before[field]);
      assert.notEqual(after.ino, before.ino);
    }, async () => {
      await assert.rejects(prepareMarketplace({ host: 'codex', plugin, out }), /copy-probe\.bin \(changed fields: ino\)/);
    });
    await assert.rejects(lstat(out), { code: 'ENOENT' });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

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

for (const mutation of ['addition', 'removal']) {
  test(`a source inventory ${mutation} after a copied file refuses publication and removes only the new output`, async context => {
    const temporary = await scratch();
    try {
      const plugin = await fixture(temporary, 'codex');
      const keep = join(temporary, 'keep');
      await writeFile(keep, 'unrelated data');
      const out = join(temporary, 'out');
      const copied = join(out, 'plugins/codex/LICENSE');
      await afterCopyWrite(context, copied, async () => {
        assert.equal(await readFile(copied, 'utf8'), 'license fixture\n');
        if (mutation === 'addition') await writeFile(join(plugin, 'new-source-file'), 'changed inventory');
        else await rm(join(plugin, 'LICENSE'));
      }, async () => {
        await assert.rejects(prepareMarketplace({ host: 'codex', plugin, out }), mutation === 'addition'
          ? /new-source-file \(changed fields: inventory\)/
          : /LICENSE \(changed fields: inventory\)/);
      });
      await assert.rejects(lstat(out), { code: 'ENOENT' });
      assert.equal(await readFile(keep, 'utf8'), 'unrelated data');
      if (mutation === 'addition') assert.equal(await readFile(join(plugin, 'new-source-file'), 'utf8'), 'changed inventory');
      else await assert.rejects(lstat(join(plugin, 'LICENSE')), { code: 'ENOENT' });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
}

test('a changed file after an earlier file was copied refuses mixed output with restored mtime', async context => {
  const temporary = await scratch();
  try {
    const plugin = await fixture(temporary, 'codex');
    const sourceA = join(plugin, 'copy-a.bin');
    const sourceB = join(plugin, 'copy-b.bin');
    await writeFile(sourceA, probeBytes);
    await writeFile(sourceB, probeBytes);
    await utimes(sourceB, fixedTime, fixedTime);
    const keep = join(temporary, 'keep');
    await writeFile(keep, 'unrelated data');
    const out = join(temporary, 'out');
    const copiedA = join(out, 'plugins/codex/copy-a.bin');
    await afterCopyWrite(context, copiedA, async () => {
      assert.deepEqual(await readFile(copiedA), probeBytes);
      await assert.rejects(lstat(join(out, 'plugins/codex/copy-b.bin')), { code: 'ENOENT' });
      await changeBytesWithRestoredMtime(sourceB);
    }, async () => {
      await assert.rejects(prepareMarketplace({ host: 'codex', plugin, out }), /copy-b\.bin \(changed fields: digest\)/);
    });
    await assert.rejects(lstat(out), { code: 'ENOENT' });
    assert.deepEqual(await readFile(sourceA), probeBytes);
    assert.deepEqual(await readFile(sourceB), Buffer.alloc(probeBytes.length, 0x42));
    assert.equal(await readFile(keep, 'utf8'), 'unrelated data');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('final recapture still refuses changed bytes after their complete copy with restored mtime', async context => {
  const temporary = await scratch();
  try {
    const plugin = await fixture(temporary, 'codex');
    const probe = join(plugin, 'copy-probe.bin');
    await writeFile(probe, probeBytes);
    await utimes(probe, fixedTime, fixedTime);
    const out = join(temporary, 'out');
    const copied = join(out, 'plugins/codex/copy-probe.bin');
    await afterCopyWrite(context, copied, async () => {
      assert.deepEqual(await readFile(copied), probeBytes);
      await changeBytesWithRestoredMtime(probe);
    }, async () => {
      await assert.rejects(prepareMarketplace({ host: 'codex', plugin, out }), /copy-probe\.bin \(changed fields: digest\)/);
    });
    await assert.rejects(lstat(out), { code: 'ENOENT' });
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
