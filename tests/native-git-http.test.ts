import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startGitHttpServer } from '../scripts/native-plugin-lifecycle/git-http.mjs';

async function fixture(signal: AbortSignal) {
  signal.throwIfAborted();
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sgd-smart-git-test-')));
  const publisher = join(root, 'publisher');
  const httpRoot = join(root, 'http');
  const bare = join(httpRoot, 'marketplace.git');
  const hooks = join(root, 'empty-hooks');
  const globalConfig = join(root, 'empty-git-config');
  try {
    for (const directory of [publisher, httpRoot, hooks]) await mkdir(directory);
    await writeFile(globalConfig, '');
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  };
  const active = new Set<ChildProcess>();
  function killGroup(child: ChildProcess) {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
  }
  async function git(args: string[]) {
    signal.throwIfAborted();
    const child = spawn('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'commit.gpgsign=false', ...args], {
      cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    active.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(child); }, 20_000);
    const abort = () => killGroup(child);
    signal.addEventListener('abort', abort, { once: true });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => { active.delete(child); resolve(code); });
      });
      assert.equal(timedOut, false, `Git exceeded its deadline: ${args[0]}`);
      assert.equal(code, 0, stderr);
      return stdout.trim();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (active.has(child)) killGroup(child);
    }
  }
  async function commit({ message, paths, initial = false }: { message: string; paths: string[]; initial?: boolean }) {
    await git(['-C', publisher, 'add', '--', ...paths]);
    const staged = await git(['-C', publisher, 'diff', '--cached', '--stat', ...(initial ? [] : ['HEAD'])]);
    assert.notEqual(staged, '');
    await git(['-C', publisher, 'commit', '-m', message]);
  }
  async function publish(initial = false) {
    if (initial) await git(['clone', '--bare', '--no-hardlinks', publisher, bare]);
    else await git(['-C', publisher, 'push', bare, 'HEAD:refs/heads/lifecycle']);
    for (const [key, value] of Object.entries({ 'gc.auto': '0', 'maintenance.auto': 'false', 'receive.autogc': 'false', 'http.receivepack': 'false' })) {
      await git(['--git-dir', bare, 'config', key, value]);
    }
    await git(['--git-dir', bare, 'repack', '-a', '-d']);
    await git(['--git-dir', bare, 'fsck', '--full', '--strict']);
  }
  return { root, publisher, httpRoot, bare, env, active, git, commit, publish };
}

function status({ origin, target, signal, method = 'GET', headers = {}, body = '' }: {
  origin: string; target: string; signal: AbortSignal; method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const client = request(origin, { path: target, method, headers, signal }, response => {
      response.resume();
      response.once('error', reject);
      response.once('end', () => {
        if (typeof response.statusCode !== 'number') reject(new Error('The HTTP response has no status code.'));
        else resolve(response.statusCode);
      });
    });
    const timer = setTimeout(() => client.destroy(new Error('HTTP test request exceeded its deadline')), 10_000);
    client.once('close', () => clearTimeout(timer));
    client.once('error', reject);
    client.end(body);
  });
}

test('smart Git HTTP serves changing source snapshots through full and depth-1 clones, refuses writes, and drains its CGI processes', {
  skip: process.platform === 'win32' ? 'This helper requires Unix process groups; Windows lifecycle support remains unverified.' : false,
  timeout: 60_000,
}, async t => {
  const data = await fixture(t.signal);
  let server: Awaited<ReturnType<typeof startGitHttpServer>> | undefined;
  const abortServer = () => { void server?.close().catch(() => {}); };
  t.signal.addEventListener('abort', abortServer, { once: true });
  try {
    await data.git(['init', '--initial-branch=lifecycle', '--template', join(data.root, 'empty-hooks'), data.publisher]);
    await data.git(['-C', data.publisher, 'config', 'user.name', 'SGD HTTP Transport Test']);
    await data.git(['-C', data.publisher, 'config', 'user.email', 'sgd-transport@example.invalid']);
    await writeFile(join(data.publisher, 'component.js'), 'export const behavior = "baseline";\n');
    await writeFile(join(data.publisher, 'obsolete.txt'), 'removed by the next source update\n');
    await data.commit({ message: 'Baseline source', paths: ['component.js', 'obsolete.txt'], initial: true });
    const expectedA = 'export const behavior = "A";\n';
    await writeFile(join(data.publisher, 'component.js'), expectedA);
    await data.commit({ message: 'Source snapshot A', paths: ['component.js'] });
    await data.publish(true);
    server = await startGitHttpServer({ httpRoot: data.httpRoot, bare: data.bare, env: data.env });
    const origin = server.origin;
    async function clones({ snapshot, expected, history }: { snapshot: string; expected: string; history: number }) {
      for (const shallow of [false, true]) {
        const destination = join(data.root, `${snapshot}-${shallow ? 'shallow' : 'full'}`);
        await data.git(['clone', ...(shallow ? ['--depth', '1'] : []), '--branch', 'lifecycle', `${origin}/marketplace.git`, destination]);
        await data.git(['-C', destination, 'fsck', '--full', '--strict']);
        assert.equal(await readFile(join(destination, 'component.js'), 'utf8'), expected);
        assert.equal(await data.git(['-C', destination, 'rev-parse', '--is-shallow-repository']), String(shallow));
        assert.equal(await data.git(['-C', destination, 'rev-list', '--count', 'HEAD']), String(shallow ? 1 : history));
        assert.equal(await data.git(['-C', destination, 'rev-parse', 'HEAD']), await data.git(['--git-dir', data.bare, 'rev-parse', 'refs/heads/lifecycle']));
        if (snapshot === 'B') {
          await assert.rejects(readFile(join(destination, 'obsolete.txt')), { code: 'ENOENT' });
          assert.equal(await readFile(join(destination, 'added.txt'), 'utf8'), 'new source input\n');
        } else assert.equal(await readFile(join(destination, 'obsolete.txt'), 'utf8'), 'removed by the next source update\n');
      }
    }
    await clones({ snapshot: 'A', expected: expectedA, history: 2 });
    const expectedB = 'export const behavior = "B";\n';
    await writeFile(join(data.publisher, 'component.js'), expectedB);
    await rm(join(data.publisher, 'obsolete.txt'));
    await writeFile(join(data.publisher, 'added.txt'), 'new source input\n');
    await data.commit({ message: 'Source snapshot B', paths: ['component.js', 'obsolete.txt', 'added.txt'] });
    await data.publish();
    await clones({ snapshot: 'B', expected: expectedB, history: 3 });

    const beforeRefusals = server.snapshot().cgiStarted;
    assert.equal(server.snapshot().cgiFailures, 0, 'All real full and shallow clone requests must complete successfully.');
    for (const target of ['/marketplace.git/info/refs?service=git-receive-pack', '/marketplace.git/config', '/marketplace.git/%2e%2e/config']) {
      assert.equal(await status({ origin, target, signal: t.signal }), 404);
    }
    assert.equal(await status({ origin, target: '/marketplace.git/git-receive-pack', signal: t.signal, method: 'POST' }), 404);
    const upload = { origin, target: '/marketplace.git/git-upload-pack', signal: t.signal, method: 'POST' } satisfies Parameters<typeof status>[0];
    assert.equal(await status({ ...upload, headers: { 'Content-Type': 'application/x-git-upload-pack-request', 'Content-Length': String(1024 * 1024 + 1) } }), 413);
    assert.equal(await status({ ...upload, headers: { 'Content-Type': 'application/x-git-upload-pack-request', 'Transfer-Encoding': 'chunked' }, body: 'x'.repeat(1024 * 1024 + 1) }), 413);
    assert.equal(await status({ ...upload, headers: { 'Content-Type': 'application/x-git-upload-pack-request', 'Content-Encoding': 'gzip' }, body: 'invalid compressed input' }), 415);
    assert.equal(server.snapshot().cgiStarted, beforeRefusals);
    await server.close();
    const closed = server.snapshot();
    assert.ok(closed.objectPayloadRequests >= 4, 'Each real clone must receive source objects, including both shallow clones.');
    assert.equal(closed.cgiStarted, closed.cgiStopped);
    await assert.rejects(status({ origin, target: '/marketplace.git/info/refs?service=git-upload-pack', signal: t.signal }), { code: 'ECONNREFUSED' });
  } finally {
    t.signal.removeEventListener('abort', abortServer);
    if (server) await server.close();
    assert.equal(data.active.size, 0, 'Do not remove a fixture while its Git command is still active.');
    await rm(data.root, { recursive: true, force: true });
  }
});
