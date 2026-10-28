import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { checkUpdateStatus, UpdateStatusInputSchema } from '../src/update-status.js';
import { version } from '../src/version.js';

const REPOSITORY = 'KimSeogyu/specification-guided-development';
const WEB = `https://github.com/${REPOSITORY}`;
const API = `https://api.github.com/repos/${REPOSITORY}/releases`;
const nextMajor = String(BigInt(version.split('.')[0] ?? '0') + 1n);
const futureStable = `${nextMajor}.0.0`;
const futureAlpha = `${futureStable}-alpha.10`;
const input = { host: 'codex', channel: 'alpha' } satisfies Parameters<typeof checkUpdateStatus>[0];
type FixtureManifestAsset = { name: string; host: string; bytes: number; sha256: string; platform: string; architecture: string; format?: string };

function fixture(releaseVersion = version, platform = process.platform, architecture = process.arch) {
  const tag = `v${releaseVersion}`;
  const assets: FixtureManifestAsset[] = ['codex', 'claude-code'].map(host => ({
    name: `specification-guided-development-${host}-${releaseVersion}-${platform}-${architecture}.tar.gz`,
    host, bytes: 1234, sha256: 'a'.repeat(64), platform, architecture,
  }));
  const manifest = {
    schema: 'sgd-plugin-release-v1', version: releaseVersion, tag,
    channel: releaseVersion.includes('-alpha.') ? 'alpha' : 'stable',
    source: { repository: REPOSITORY, commit: 'b'.repeat(40) },
    build: { platform, architecture }, assets,
  };
  const manifestText = JSON.stringify(manifest);
  const release = {
    tag_name: tag, draft: false, prerelease: releaseVersion.includes('-alpha.'), html_url: `${WEB}/releases/tag/${tag}`,
    assets: [
      ...assets.map(asset => ({ name: asset.name, size: asset.bytes, browser_download_url: `${WEB}/releases/download/${tag}/${asset.name}`, state: 'uploaded', digest: `sha256:${asset.sha256}` })),
      { name: 'release-manifest.json', size: Buffer.byteLength(manifestText), browser_download_url: `${WEB}/releases/download/${tag}/release-manifest.json`, state: 'uploaded', digest: `sha256:${createHash('sha256').update(manifestText).digest('hex')}` },
    ],
  };
  return { manifest, release };
}

type Fixture = ReturnType<typeof fixture>;

function syncManifest(fixture: Fixture): void {
  const text = JSON.stringify(fixture.manifest);
  const asset = fixture.release.assets.find(entry => entry.name === 'release-manifest.json');
  assert.ok(asset);
  asset.size = Buffer.byteLength(text);
  asset.digest = `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function addArchiveFormat(data: Fixture, host: 'codex' | 'claude-code', format: 'tar.gz' | 'zip'): void {
  const source = data.manifest.assets.find(asset => asset.host === host);
  assert.ok(source);
  const asset = { ...source, name: `specification-guided-development-${host}-${data.manifest.version}-${source.platform}-${source.architecture}.${format}`, format, bytes: 5678, sha256: 'c'.repeat(64) };
  data.manifest.assets.push(asset);
  data.release.assets.push({
    name: asset.name, size: asset.bytes, browser_download_url: `${WEB}/releases/download/${data.manifest.tag}/${asset.name}`,
    state: 'uploaded', digest: `sha256:${asset.sha256}`,
  });
  syncManifest(data);
}

async function withHttp<T>(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>, work: (calls: string[]) => Promise<T>): Promise<T> {
  const calls: string[] = [];
  const transport = mock.method(globalThis, 'fetch', async (resource: string | URL | Request, init?: RequestInit) => {
    const url = resource instanceof Request ? resource.url : String(resource);
    calls.push(url);
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.credentials, 'omit');
    assert.ok(init?.signal);
    assert.ok(!new Headers(init.headers).has('authorization'));
    return handler(url, init);
  });
  try { return await work(calls); } finally { transport.mock.restore(); }
}

async function withCatalog<T>(fixtures: Fixture[], work: (calls: string[]) => Promise<T>): Promise<T> {
  return withHttp(url => {
    if (url === `${API}?per_page=100&page=1`) return Response.json(fixtures.map(item => item.release));
    const selected = fixtures.find(item => url === `${WEB}/releases/download/${item.release.tag_name}/release-manifest.json`);
    assert.ok(selected, `Unexpected network request: ${url}`);
    return Response.json(selected.manifest);
  }, work);
}

test('update awareness compares the running runtime and both native archive metadata profiles', async () => {
  const current = fixture();
  await withCatalog([current], async calls => {
    const result = await checkUpdateStatus(input);
    assert.equal(result.kind, 'current');
    assert.equal(result.scope, 'running-runtime-only');
    assert.deepEqual(result.runtime, { version, platform: process.platform, arch: process.arch });
    assert.ok(result.kind !== 'unknown');
    assert.equal(result.release.archive.kind, 'published');
    assert.ok(result.release.archive.kind === 'published');
    assert.equal(result.release.archive.verification, 'manifest-metadata-only');
    assert.equal(result.release.archive.format, 'tar.gz');
    assert.equal(result.release.archive.sha256, 'a'.repeat(64));
    assert.equal(result.release.sourceCommit, 'b'.repeat(40));
    assert.equal(calls.length, 2);
    assert.ok(calls.every(url => !/\.(?:tar\.gz|zip)$/.test(url)));
    const claude = await checkUpdateStatus({ host: 'claude-code', channel: 'alpha' });
    assert.ok(claude.kind !== 'unknown' && claude.release.archive.kind === 'published');
    assert.match(claude.release.archive.name, /-claude-code-/);
    assert.equal(claude.release.archive.format, 'tar.gz');
  });
});

test('dual-format metadata prefers Claude ZIP and Codex TAR without fetching either archive', async () => {
  const data = fixture();
  addArchiveFormat(data, 'claude-code', 'zip');
  await withCatalog([data], async calls => {
    const claude = await checkUpdateStatus({ ...input, host: 'claude-code' });
    assert.ok(claude.kind === 'current' && claude.release.archive.kind === 'published');
    assert.equal(claude.release.archive.format, 'zip');
    assert.ok(claude.release.archive.name.endsWith('.zip'));
    assert.equal(claude.release.archive.sha256, 'c'.repeat(64));
    assert.equal(claude.release.archive.verification, 'manifest-metadata-only');
    const codex = await checkUpdateStatus(input);
    assert.ok(codex.kind === 'current' && codex.release.archive.kind === 'published');
    assert.equal(codex.release.archive.format, 'tar.gz');
    assert.ok(calls.every(url => !/\.(?:tar\.gz|zip)$/.test(url)));
  });
  addArchiveFormat(data, 'codex', 'zip');
  data.manifest.assets.reverse(); syncManifest(data);
  await withCatalog([data], async () => {
    const codex = await checkUpdateStatus(input);
    assert.ok(codex.kind === 'current' && codex.release.archive.kind === 'published');
    assert.equal(codex.release.archive.format, 'tar.gz');
    const claude = await checkUpdateStatus({ ...input, host: 'claude-code' });
    assert.ok(claude.kind === 'current' && claude.release.archive.kind === 'published');
    assert.equal(claude.release.archive.format, 'zip');
  });
});

test('explicit TAR formats and ZIP-only transport metadata retain format identity', async () => {
  const explicit = fixture();
  for (const asset of explicit.manifest.assets) asset.format = 'tar.gz';
  syncManifest(explicit);
  await withCatalog([explicit], async () => {
    const result = await checkUpdateStatus(input);
    assert.ok(result.kind === 'current' && result.release.archive.kind === 'published');
    assert.equal(result.release.archive.format, 'tar.gz');
  });
  const zip = fixture();
  addArchiveFormat(zip, 'codex', 'zip'); addArchiveFormat(zip, 'claude-code', 'zip');
  zip.manifest.assets = zip.manifest.assets.filter(asset => asset.format === 'zip');
  zip.release.assets = zip.release.assets.filter(asset => !asset.name.endsWith('.tar.gz'));
  syncManifest(zip);
  await withCatalog([zip], async () => {
    for (const host of ['codex', 'claude-code']) {
      const result = await checkUpdateStatus(UpdateStatusInputSchema.parse({ ...input, host }));
      assert.ok(result.kind === 'current' && result.release.archive.kind === 'published');
      assert.equal(result.release.archive.format, 'zip');
      assert.equal(result.release.archive.verification, 'manifest-metadata-only');
    }
  });
});

test('archive format, filename and all declared transports must agree before selection', async t => {
  const mutations: [string, (data: Fixture) => void][] = [
    ['unsupported format', data => { const asset = data.manifest.assets[0]; assert.ok(asset); asset.format = 'tgz'; syncManifest(data); }],
    ['ZIP format with TAR extension', data => { const asset = data.manifest.assets[0]; assert.ok(asset); asset.format = 'zip'; syncManifest(data); }],
    ['implicit TAR format with ZIP extension', data => { const asset = data.manifest.assets[0]; assert.ok(asset); asset.name = asset.name.replace(/\.tar\.gz$/, '.zip'); syncManifest(data); }],
    ['duplicate explicit and implicit TAR target', data => { addArchiveFormat(data, 'codex', 'tar.gz'); }],
    ['duplicate ZIP target', data => { addArchiveFormat(data, 'claude-code', 'zip'); addArchiveFormat(data, 'claude-code', 'zip'); }],
    ['unpreferred ZIP size mismatch', data => { addArchiveFormat(data, 'codex', 'zip'); const asset = data.release.assets.find(asset => asset.name.endsWith('.zip')); assert.ok(asset); asset.size++; }],
    ['unpreferred TAR URL mismatch', data => { addArchiveFormat(data, 'claude-code', 'zip'); const asset = data.release.assets.find(asset => asset.name.includes('-claude-code-') && asset.name.endsWith('.tar.gz')); assert.ok(asset); asset.browser_download_url = 'https://example.com/unpreferred.tar.gz'; }],
    ['unpreferred ZIP digest mismatch', data => { addArchiveFormat(data, 'codex', 'zip'); const asset = data.release.assets.find(asset => asset.name.endsWith('.zip')); assert.ok(asset); asset.digest = `sha256:${'d'.repeat(64)}`; }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const data = fixture(); mutate(data);
    await withCatalog([data], async calls => {
      const result = await checkUpdateStatus({ ...input, host: 'claude-code' });
      assert.ok(result.kind === 'unknown' && result.reason === 'invalid-metadata');
      assert.ok(calls.every(url => !/\.(?:tar\.gz|zip)$/.test(url)));
    });
  });
});

test('alpha selects numeric alpha identifiers and stable promotion; stable excludes alpha and unsupported tags', async () => {
  const alpha9 = fixture(`${futureStable}-alpha.9`); const alpha10 = fixture(futureAlpha);
  const beta = fixture(`${futureStable}-beta.99`); beta.release.prerelease = true;
  const draft = fixture(`${nextMajor}.9.0`); draft.release.draft = true;
  await withCatalog([alpha10, beta, draft, alpha9], async () => {
    const result = await checkUpdateStatus(input);
    assert.ok(result.kind === 'update-available');
    assert.equal(result.release.version, futureAlpha);
    const stable = await checkUpdateStatus({ ...input, channel: 'stable' });
    assert.deepEqual(stable.kind === 'unknown' && stable.reason, 'no-channel-release');
  });
  await withCatalog([alpha10, fixture(futureStable)], async () => {
    for (const channel of ['alpha', 'stable']) {
      const result = await checkUpdateStatus(UpdateStatusInputSchema.parse({ ...input, channel }));
      assert.ok(result.kind === 'update-available');
      assert.equal(result.release.version, futureStable);
    }
  });
});

test('a running runtime newer than the selected channel retains ahead status', async () => {
  await withCatalog([fixture('0.0.0')], async () => {
    const result = await checkUpdateStatus(input);
    assert.equal(result.kind, 'ahead');
  });
});

test('an inconsistent prerelease flag in the catalog cannot poison valid release metadata', async () => {
  const inconsistent = fixture('0.0.0'); inconsistent.release.prerelease = true;
  await withCatalog([inconsistent, fixture()], async () => {
    assert.equal((await checkUpdateStatus(input)).kind, 'current');
  });
});

test('newer release visibility stays separate from platform archive availability', async () => {
  const otherPlatform = process.platform === 'darwin' ? 'linux' : 'darwin';
  await withCatalog([fixture(futureAlpha, otherPlatform)], async () => {
    const result = await checkUpdateStatus(input);
    assert.ok(result.kind === 'update-available');
    assert.deepEqual(result.release.archive, { kind: 'unavailable', reason: 'not-published-for-runtime' });
  });
});

test('release identity, native asset paths and manifest claims fail closed', async t => {
  const mutations: [string, (data: Fixture) => void][] = [
    ['foreign release repository', data => { data.release.html_url = 'https://github.com/other/repo/releases/tag/v1.0.0'; }],
    ['inconsistent prerelease flag', data => { data.release.prerelease = !data.release.prerelease; }],
    ['malformed alpha publication', data => { data.release.tag_name = 'v99.0.0-alpha.01'; }],
    ['malformed stable publication', data => { data.release.tag_name = 'v01.0.0'; }],
    ['foreign manifest URL', data => { const asset = data.release.assets.at(-1); assert.ok(asset); asset.browser_download_url = 'https://example.com/release-manifest.json'; }],
    ['wrong manifest repository', data => { data.manifest.source.repository = 'other/repo'; syncManifest(data); }],
    ['wrong manifest version', data => { data.manifest.version = '0.0.0'; syncManifest(data); }],
    ['wrong manifest tag', data => { data.manifest.tag = 'v0.0.0'; syncManifest(data); }],
    ['wrong manifest channel', data => { data.manifest.channel = 'other'; syncManifest(data); }],
    ['invalid source commit', data => { data.manifest.source.commit = 'not-a-commit'; syncManifest(data); }],
    ['wrong build platform', data => { data.manifest.build.platform = 'not-a-platform'; syncManifest(data); }],
    ['traversal archive name', data => { const asset = data.manifest.assets[0]; assert.ok(asset); asset.name = `../${asset.name}`; syncManifest(data); }],
    ['mixed manifest platform', data => { const asset = data.manifest.assets[0]; assert.ok(asset); asset.platform = 'wrong-platform'; syncManifest(data); }],
    ['duplicate manifest target', data => { const asset = data.manifest.assets[0]; assert.ok(asset); data.manifest.assets.push(asset); syncManifest(data); }],
    ['invalid claimed digest', data => { const asset = data.manifest.assets[0]; assert.ok(asset); asset.sha256 = 'not-sha256'; syncManifest(data); }],
    ['archive size mismatch', data => { const asset = data.release.assets[0]; assert.ok(asset); asset.size++; }],
    ['archive digest metadata mismatch', data => { const asset = data.release.assets[0]; assert.ok(asset); asset.digest = `sha256:${'c'.repeat(64)}`; }],
    ['foreign archive URL', data => { const asset = data.release.assets[0]; assert.ok(asset); asset.browser_download_url = 'https://example.com/archive.tar.gz'; }],
    ['manifest size mismatch', data => { const asset = data.release.assets.at(-1); assert.ok(asset); asset.size = 1; }],
    ['manifest digest mismatch', data => { const asset = data.release.assets.at(-1); assert.ok(asset); asset.digest = `sha256:${'c'.repeat(64)}`; }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const data = fixture(); mutate(data);
    await withCatalog([data], async calls => {
      const result = await checkUpdateStatus(input);
      assert.ok(result.kind === 'unknown');
      assert.equal(result.reason, 'invalid-metadata');
      assert.ok(calls.every(url => url.startsWith(API) || url.endsWith('/release-manifest.json')));
    });
  });
});

test('only bounded GitHub asset CDN redirects can fetch manifest metadata', async () => {
  const data = fixture();
  const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/metadata?signature=public';
  await withHttp(url => {
    if (url.startsWith(API)) return Response.json([data.release]);
    if (url.endsWith('/release-manifest.json')) return new Response(null, { status: 302, headers: { location: cdn } });
    assert.equal(url, cdn);
    return Response.json(data.manifest);
  }, async calls => {
    assert.equal((await checkUpdateStatus(input)).kind, 'current');
    assert.equal(calls.length, 3);
  });
  for (const location of ['https://example.com/manifest', 'http://release-assets.githubusercontent.com/github-production-release-asset/1/2', 'https://user:secret@release-assets.githubusercontent.com/github-production-release-asset/1/2', 'https://release-assets.githubusercontent.com/other-path']) {
    await withHttp(url => url.startsWith(API) ? Response.json([data.release]) : new Response(null, { status: 302, headers: { location } }), async calls => {
      const result = await checkUpdateStatus(input);
      assert.ok(result.kind === 'unknown' && result.reason === 'invalid-metadata');
      assert.equal(calls.length, 2);
    });
  }
  await withHttp(url => url.startsWith(API) ? Response.json([data.release]) : new Response(null, { status: 302, headers: { location: cdn } }), async calls => {
    const result = await checkUpdateStatus(input);
    assert.ok(result.kind === 'unknown' && result.reason === 'invalid-metadata');
    assert.equal(calls.length, 4);
  });
});

test('catalog pagination must complete and never follows arbitrary Link URLs', async () => {
  await withHttp(url => {
    const page = Number(new URL(url).searchParams.get('page'));
    return Response.json([], { headers: { link: `<${API}?per_page=100&page=${page + 1}>; rel="next"` } });
  }, async calls => {
    const result = await checkUpdateStatus(input);
    assert.ok(result.kind === 'unknown' && result.reason === 'pagination-limit');
    assert.equal(calls.length, 3);
  });
  for (const link of [
    `<${API}?per_page=100&page=2>; rel="next"; type="application/json"`,
    '<https://example.com/releases?page=2>; rel="next"',
    `<${API}?per_page=100&page=2>; rel=next`,
    `<${API}?per_page=100&page=2>; rel="last"`,
    `<${API}?per_page=100&page=1>; rel="prev"`,
    `<${API}?per_page=100&page=2>; rel="first"`,
    `<${API}?per_page=100&page=1>; rel="last", <${API}?per_page=100&page=2>; rel="next"`,
    `<${API}?per_page=100&page=1>; rel="first", <${API}?per_page=100&page=1>; rel="first"`,
    `<${API}?per_page=100&page=1>; rel="last", <${API}?per_page=100&page=1>; rel="last"`,
    '<https://example.com/releases?per_page=100&page=1>; rel="last"',
    `<${API}?per_page=100&page=01>; rel="last"`,
    `<${API}?per_page=100&page=9007199254740993>; rel="last"`,
  ]) {
    await withHttp(() => Response.json([fixture().release], { headers: { link } }), async calls => {
      const result = await checkUpdateStatus(input);
      assert.ok(result.kind === 'unknown' && result.reason === 'invalid-metadata');
      assert.equal(calls.length, 1);
    });
  }
  const newer = fixture(futureAlpha);
  await withHttp(url => {
    if (url === `${API}?per_page=100&page=1`) return Response.json([fixture().release], { headers: { link: `<${API}?page=2&per_page=100>; rel="next", <${API}?per_page=100&page=2>; rel="last"` } });
    if (url === `${API}?per_page=100&page=2`) return Response.json([newer.release], { headers: { link: `<${API}?per_page=100&page=1>; rel="first", <${API}?per_page=100&page=1>; rel="prev", <${API}?per_page=100&page=2>; rel="last"` } });
    return Response.json(newer.manifest);
  }, async calls => {
    const result = await checkUpdateStatus(input);
    assert.ok(result.kind === 'update-available' && result.release.version === futureAlpha);
    assert.equal(calls.length, 3);
  });
});

test('contradictory terminal-page metadata and partial HTTP responses cannot establish current', async () => {
  const data = fixture();
  for (const link of [
    `<${API}?per_page=100&page=1>; rel="last"`,
    `<${API}?per_page=100&page=1>; rel="prev", <${API}?per_page=100&page=1>; rel="prev"`,
    '<https://example.com/releases?per_page=100&page=1>; rel="prev"',
  ]) {
    await withHttp(url => url.endsWith('page=1')
      ? Response.json([], { headers: { link: `<${API}?per_page=100&page=2>; rel="next"` } })
      : Response.json([data.release], { headers: { link } }), async calls => {
      const result = await checkUpdateStatus(input);
      assert.ok(result.kind === 'unknown' && result.reason === 'invalid-metadata');
      assert.equal(calls.length, 2);
    });
  }
  for (const headers of [{}, { link: `<${API}?per_page=100&page=2>; rel="last"` }]) {
    await withHttp(url => url.endsWith('page=1')
      ? Response.json([], { headers: { link: `<${API}?per_page=100&page=2>; rel="next", <${API}?per_page=100&page=3>; rel="last"` } })
      : Response.json([data.release], { headers }), async calls => {
      const result = await checkUpdateStatus(input);
      assert.ok(result.kind === 'unknown' && result.reason === 'invalid-metadata');
      assert.equal(calls.length, 2);
    });
  }
  for (const response of [
    Response.json([data.release], { status: 206, headers: { 'content-range': 'bytes 0-999/9999' } }),
    Response.json([data.release], { headers: { 'content-range': 'bytes 0-999/9999' } }),
  ]) {
    await withHttp(() => response, async calls => {
      const result = await checkUpdateStatus(input);
      assert.ok(result.kind === 'unknown');
      assert.equal(calls.length, 1);
    });
  }
  await withHttp(url => url.startsWith(API) ? Response.json([data.release])
    : Response.json(data.manifest, { status: 206 }), async calls => {
    const result = await checkUpdateStatus(input);
    assert.ok(result.kind === 'unknown' && result.reason === 'http-error');
    assert.equal(calls.length, 2);
  });
});

test('a full catalog page without next metadata still receives a bounded continuation check', async () => {
  const data = fixture();
  await withHttp(url => {
    if (url === `${API}?per_page=100&page=1`) return Response.json(Array.from({ length: 100 }, () => ({ ...data.release, draft: true })));
    if (url === `${API}?per_page=100&page=2`) return Response.json([data.release]);
    return Response.json(data.manifest);
  }, async calls => {
    assert.equal((await checkUpdateStatus(input)).kind, 'current');
    assert.equal(calls.length, 3);
  });
});

test('offline, timeout and rate limits return successful unknown results without retry', async () => {
  await withHttp(() => { throw new TypeError('offline'); }, async calls => {
    const result = await checkUpdateStatus(input);
    assert.ok(result.kind === 'unknown' && result.reason === 'network');
    assert.equal(calls.length, 1);
  });
  for (const [status, headers, reason] of [
    [403, { 'x-ratelimit-remaining': '0' }, 'rate-limited'],
    [429, {}, 'rate-limited'], [403, {}, 'http-error'], [500, {}, 'http-error'],
  ] satisfies [number, Record<string, string>, string][]) {
    await withHttp(() => new Response(null, { status, headers }), async calls => {
      const result = await checkUpdateStatus(input);
      assert.ok(result.kind === 'unknown');
      assert.equal(result.reason, reason);
      assert.equal(calls.length, 1);
    });
  }
  const deadline = mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 5000);
    return AbortSignal.abort(new DOMException('deadline', 'TimeoutError'));
  });
  try {
    await withHttp((_url, init) => { throw init?.signal?.reason; }, async () => {
      const result = await checkUpdateStatus(input);
      assert.ok(result.kind === 'unknown' && result.reason === 'timeout');
    });
  } finally { deadline.mock.restore(); }
});

test('metadata body size and malformed JSON are bounded unknown outcomes', async () => {
  for (const response of [new Response('not JSON'), new Response('[', { headers: { 'content-length': String(1024 * 1024 + 1) } }), new Response(new Uint8Array(1024 * 1024 + 1))]) {
    await withHttp(() => response, async () => {
      const result = await checkUpdateStatus(input);
      assert.ok(result.kind === 'unknown' && ['invalid-metadata', 'response-limit'].includes(result.reason));
    });
  }
  const large = fixture(); const manifest = large.release.assets.at(-1); assert.ok(manifest); manifest.size = 64 * 1024 + 1;
  await withCatalog([large], async calls => {
    const result = await checkUpdateStatus(input);
    assert.ok(result.kind === 'unknown' && result.reason === 'response-limit');
    assert.equal(calls.length, 1);
  });
});

test('arguments remain strict and CLI operational failure exits zero with the shared JSON result', async () => {
  for (const invalid of [{ ...input, host: 'other' }, { ...input, channel: 'beta' }, { ...input, url: 'https://example.com' }, { host: 'codex' }]) {
    assert.equal(UpdateStatusInputSchema.safeParse(invalid).success, false);
  }
  const preload = `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => { throw new TypeError("offline fixture"); };')}`;
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--import', preload, cli, 'update-status', '--host', 'codex', '--channel', 'alpha']);
  assert.equal(result.stderr, '');
  const value: unknown = JSON.parse(result.stdout);
  assert.ok(typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'unknown');
  assert.ok('reason' in value && value.reason === 'network');
  const forbidNetwork = `data:text/javascript,${encodeURIComponent('globalThis.fetch = () => { process.stderr.write("unexpected network"); process.exit(99); };')}`;
  const local = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--import', forbidNetwork, cli, '--version']);
  assert.equal(local.stdout.trim(), version);
  assert.equal(local.stderr, '');
  await assert.rejects(promisify(execFile)(process.execPath, ['--import', 'tsx', '--import', forbidNetwork, cli, 'update-status', '--host', 'codex', '--channel', 'beta']), error => error instanceof Error && 'code' in error && error.code === 2);
});
