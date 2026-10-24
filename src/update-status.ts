import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ReleaseVersionSchema, version } from './version.js';

export const UpdateStatusInputSchema = z.object({
  host: z.enum(['codex', 'claude-code']),
  channel: z.enum(['stable', 'alpha']),
}).strict();
export type UpdateStatusInput = z.infer<typeof UpdateStatusInputSchema>;
const ArchiveFormatSchema = z.enum(['tar.gz', 'zip']);
type ArchiveFormat = z.infer<typeof ArchiveFormatSchema>;

type UnknownReason = 'network' | 'timeout' | 'rate-limited' | 'http-error' | 'invalid-metadata'
  | 'response-limit' | 'pagination-limit' | 'no-channel-release';
type RuntimeContext = UpdateStatusInput & {
  scope: 'running-runtime-only';
  runtime: { version: string; platform: string; arch: string };
};
type Archive = {
  kind: 'published'; name: string; url: string; bytes: number; sha256: string; format: ArchiveFormat;
  verification: 'manifest-metadata-only';
} | { kind: 'unavailable'; reason: 'unsupported-platform' | 'not-published-for-runtime' };
type PublishedRelease = {
  version: string; tag: string; pageUrl: string; manifestUrl: string; archive: Archive;
  sourceCommit?: string;
};
export type UpdateStatus = RuntimeContext & (
  { kind: 'update-available' | 'current' | 'ahead'; release: PublishedRelease }
  | { kind: 'unknown'; reason: UnknownReason }
);

const REPOSITORY = 'KimSeogyu/specification-guided-development';
const WEB_ROOT = `https://github.com/${REPOSITORY}`;
const API_ROOT = `https://api.github.com/repos/${REPOSITORY}/releases`;
const MAX_PAGES = 3;
const PAGE_SIZE = 100;
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = MAX_PAGES * MAX_PAGE_BYTES + MAX_MANIFEST_BYTES;
const DEADLINE_MS = 5000;
const PlatformSchema = z.enum(['darwin', 'linux', 'win32']);
const ArchitectureSchema = z.enum(['arm64', 'x64']);
const ByteSizeSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const GithubAssetSchema = z.object({
  name: z.string().min(1).max(256), size: ByteSizeSchema,
  browser_download_url: z.string().max(2048), state: z.string().max(32),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable().optional(),
});
const GithubReleaseSchema = z.object({
  tag_name: z.string().max(256), draft: z.boolean(), prerelease: z.boolean(),
  html_url: z.string().max(2048), assets: z.array(GithubAssetSchema).max(64),
});
type GithubRelease = z.infer<typeof GithubReleaseSchema>;
const ManifestSchema = z.object({
  schema: z.literal('sgd-plugin-release-v1'), version: ReleaseVersionSchema,
  tag: z.string().max(256), channel: z.enum(['stable', 'alpha']),
  source: z.object({ repository: z.literal(REPOSITORY), commit: z.string().regex(/^[a-f0-9]{40}$/).optional() }),
  build: z.object({ platform: PlatformSchema, architecture: ArchitectureSchema }),
  assets: z.array(z.object({
    name: z.string().min(1).max(256), host: UpdateStatusInputSchema.shape.host,
    bytes: ByteSizeSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/),
    platform: PlatformSchema, architecture: ArchitectureSchema,
    format: ArchiveFormatSchema.default('tar.gz'),
  })).min(1).max(64),
});
type Candidate = { version: string; channel: UpdateStatusInput['channel']; release: GithubRelease };

class UnknownStatus extends Error {
  constructor(readonly reason: UnknownReason) { super(reason); }
}

function numericOrder(left: string, right: string): -1 | 0 | 1 {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function identifierOrder(left: string[], right: string[]): -1 | 0 | 1 {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const a = left[index]; const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const numericA = /^\d+$/.test(a); const numericB = /^\d+$/.test(b);
    if (numericA && numericB) return numericOrder(a, b);
    if (numericA !== numericB) return numericA ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function versionParts(value: string): { core: string[]; prerelease: string[] } {
  const plain = value.replace(/\+.*/, '');
  const separator = plain.indexOf('-');
  return separator < 0 ? { core: plain.split('.'), prerelease: [] }
    : { core: plain.slice(0, separator).split('.'), prerelease: plain.slice(separator + 1).split('.') };
}

function compareVersions(left: string, right: string): -1 | 0 | 1 {
  const a = versionParts(left); const b = versionParts(right);
  const core = identifierOrder(a.core, b.core);
  if (core) return core;
  if (a.prerelease.length === 0 && b.prerelease.length !== 0) return 1;
  if (b.prerelease.length === 0 && a.prerelease.length !== 0) return -1;
  return identifierOrder(a.prerelease, b.prerelease);
}

function publicationChannel(value: string): UpdateStatusInput['channel'] | undefined {
  const validVersion = ReleaseVersionSchema.safeParse(value).success;
  if (validVersion && /^\d+\.\d+\.\d+$/.test(value)) return 'stable';
  if (validVersion && /^\d+\.\d+\.\d+-alpha\.(?:0|[1-9]\d*)$/.test(value)) return 'alpha';
  // Reject malformed stable/alpha publications, while leaving beta/rc and non-version tags outside this profile.
  requireMetadata(!/^\d+\.\d+\.\d+(?:$|\+|-alpha(?:[.+-]|$))/.test(value));
  return undefined;
}

function assetUrl(tag: string, name: string): string {
  return `${WEB_ROOT}/releases/download/${tag}/${name}`;
}

function requireMetadata(condition: boolean): void {
  if (!condition) throw new UnknownStatus('invalid-metadata');
}

async function httpFailure(response: Response): Promise<void> {
  if (response.status === 200 && !response.headers.has('content-range')) return;
  await response.body?.cancel();
  if (response.status === 200) throw new UnknownStatus('invalid-metadata');
  if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
    throw new UnknownStatus('rate-limited');
  }
  throw new UnknownStatus('http-error');
}

async function readJson(response: Response, limit: number, budget: { bytes: number }): Promise<{ value: unknown; bytes: Buffer }> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel();
    throw new UnknownStatus('response-limit');
  }
  if (!response.body) throw new UnknownStatus('invalid-metadata');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      budget.bytes += chunk.value.byteLength;
      if (bytes > limit || budget.bytes > MAX_TOTAL_BYTES) throw new UnknownStatus('response-limit');
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const content = Buffer.concat(chunks);
  try { return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)), bytes: content }; }
  catch { throw new UnknownStatus('invalid-metadata'); }
}

function pagination(response: Response, page: number, count: number, previousLast: number | undefined): { next: boolean; last: number | undefined } {
  const link = response.headers.get('link');
  if (link === null) {
    requireMetadata(previousLast === undefined || previousLast === page);
    return { next: previousLast === undefined && count === PAGE_SIZE, last: previousLast };
  }
  requireMetadata(link.length <= 8192);
  const pages = new Map<string, number>();
  for (const part of link.split(',')) {
    const match = /^\s*<([^>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(part);
    const address = match?.[1]; const relation = match?.[2];
    requireMetadata(address !== undefined && relation !== undefined);
    if (!address || !relation) throw new UnknownStatus('invalid-metadata');
    let target: URL;
    try { target = new URL(address); } catch { throw new UnknownStatus('invalid-metadata'); }
    requireMetadata(!pages.has(relation) && target.origin === 'https://api.github.com' && target.pathname === `/repos/${REPOSITORY}/releases`);
    requireMetadata(target.username === '' && target.password === '' && target.hash === '');
    const pageValue = target.searchParams.get('page');
    requireMetadata(target.searchParams.size === 2 && target.searchParams.get('per_page') === String(PAGE_SIZE));
    requireMetadata(pageValue !== null && /^[1-9]\d*$/.test(pageValue));
    const linkedPage = Number(pageValue);
    requireMetadata(Number.isSafeInteger(linkedPage));
    pages.set(relation, linkedPage);
    switch (relation) {
      case 'first': requireMetadata(linkedPage === 1); break;
      case 'prev': requireMetadata(page > 1 && linkedPage === page - 1); break;
      case 'next': requireMetadata(linkedPage === page + 1); break;
      case 'last': requireMetadata(linkedPage >= page); break;
    }
  }
  const next = pages.get('next'); const last = pages.get('last');
  requireMetadata(last === undefined || previousLast === undefined || last === previousLast);
  const knownLast = last ?? previousLast;
  if (knownLast !== undefined) {
    requireMetadata(knownLast >= page);
    requireMetadata(knownLast === page ? next === undefined : next !== undefined && next <= knownLast);
  }
  return { next: next !== undefined || (knownLast === undefined && count === PAGE_SIZE), last: knownLast };
}

async function request(url: string, signal: AbortSignal, accept: string): Promise<Response> {
  return fetch(url, {
    signal, redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer',
    headers: { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'specification-guided-development-update-status' },
  });
}

async function catalog(signal: AbortSignal, budget: { bytes: number }): Promise<GithubRelease[]> {
  const releases: GithubRelease[] = [];
  let lastPage: number | undefined;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await request(`${API_ROOT}?per_page=${PAGE_SIZE}&page=${page}`, signal, 'application/vnd.github+json');
    await httpFailure(response);
    const parsed = z.array(GithubReleaseSchema).max(PAGE_SIZE).safeParse((await readJson(response, MAX_PAGE_BYTES, budget)).value);
    if (!parsed.success) throw new UnknownStatus('invalid-metadata');
    releases.push(...parsed.data);
    const pages = pagination(response, page, parsed.data.length, lastPage);
    lastPage = pages.last;
    if (!pages.next) return releases;
  }
  throw new UnknownStatus('pagination-limit');
}

function selectRelease(releases: GithubRelease[], channel: UpdateStatusInput['channel']): Candidate {
  let selected: Candidate | undefined;
  const tags = new Set<string>();
  for (const release of releases) {
    if (release.draft || !release.tag_name.startsWith('v')) continue;
    const candidateVersion = release.tag_name.slice(1);
    const candidateChannel = publicationChannel(candidateVersion);
    // Publication profiles other than stable and alpha.N are outside this catalog contract.
    if (!candidateChannel || (channel === 'stable' && candidateChannel !== 'stable')) continue;
    requireMetadata(!tags.has(release.tag_name));
    tags.add(release.tag_name);
    if (!selected || compareVersions(candidateVersion, selected.version) > 0) {
      selected = { version: candidateVersion, channel: candidateChannel, release };
    }
  }
  if (!selected) throw new UnknownStatus('no-channel-release');
  requireMetadata(selected.release.prerelease === (selected.channel === 'alpha'));
  requireMetadata(selected.release.html_url === `${WEB_ROOT}/releases/tag/${selected.release.tag_name}`);
  return selected;
}

async function releaseManifest(candidate: Candidate, signal: AbortSignal, budget: { bytes: number }): Promise<z.infer<typeof ManifestSchema>> {
  const manifests = candidate.release.assets.filter(asset => asset.name === 'release-manifest.json');
  const manifest = manifests[0];
  requireMetadata(manifests.length === 1 && manifest !== undefined);
  if (!manifest) throw new UnknownStatus('invalid-metadata');
  let url = assetUrl(candidate.release.tag_name, manifest.name);
  requireMetadata(manifest.browser_download_url === url && manifest.state === 'uploaded');
  if (manifest.size > MAX_MANIFEST_BYTES) throw new UnknownStatus('response-limit');
  for (let redirects = 0; ; redirects++) {
    const response = await request(url, signal, 'application/octet-stream');
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      requireMetadata(redirects < 2 && location !== null && location.length <= 8192);
      if (!location) throw new UnknownStatus('invalid-metadata');
      let target: URL;
      try { target = new URL(location, url); } catch { throw new UnknownStatus('invalid-metadata'); }
      requireMetadata(target.protocol === 'https:' && target.port === '' && target.username === '' && target.password === '' && target.hash === '');
      requireMetadata(['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname));
      requireMetadata(target.pathname.startsWith('/github-production-release-asset/'));
      url = target.href;
      continue;
    }
    await httpFailure(response);
    const body = await readJson(response, MAX_MANIFEST_BYTES, budget);
    requireMetadata(body.bytes.length === manifest.size);
    requireMetadata(!manifest.digest || manifest.digest === `sha256:${createHash('sha256').update(body.bytes).digest('hex')}`);
    const parsed = ManifestSchema.safeParse(body.value);
    if (!parsed.success) throw new UnknownStatus('invalid-metadata');
    const data = parsed.data;
    requireMetadata(data.version === candidate.version && data.tag === candidate.release.tag_name && data.channel === candidate.channel);
    const names = new Set<string>(); const targets = new Set<string>();
    for (const asset of data.assets) {
      const expected = `specification-guided-development-${asset.host}-${data.version}-${asset.platform}-${asset.architecture}.${asset.format}`;
      const target = `${asset.host}/${asset.platform}/${asset.architecture}/${asset.format}`;
      requireMetadata(asset.name === expected && !names.has(asset.name) && !targets.has(target));
      requireMetadata(asset.platform === data.build.platform && asset.architecture === data.build.architecture);
      names.add(asset.name); targets.add(target);
      const published = candidate.release.assets.filter(entry => entry.name === asset.name);
      const publishedAsset = published[0];
      requireMetadata(published.length === 1 && publishedAsset !== undefined);
      if (!publishedAsset) throw new UnknownStatus('invalid-metadata');
      requireMetadata(publishedAsset.state === 'uploaded' && publishedAsset.size === asset.bytes);
      requireMetadata(publishedAsset.browser_download_url === assetUrl(data.tag, asset.name));
      requireMetadata(!publishedAsset.digest || publishedAsset.digest === `sha256:${asset.sha256}`);
    }
    return data;
  }
}

/** Read public release metadata. This does not inspect installations or verify archive contents. */
export async function checkUpdateStatus(input: UpdateStatusInput): Promise<UpdateStatus> {
  const args = UpdateStatusInputSchema.parse(input);
  const context: RuntimeContext = { ...args, scope: 'running-runtime-only', runtime: { version, platform: process.platform, arch: process.arch } };
  const signal = AbortSignal.timeout(DEADLINE_MS);
  try {
    const budget = { bytes: 0 };
    const candidate = selectRelease(await catalog(signal, budget), args.channel);
    const manifest = await releaseManifest(candidate, signal, budget);
    const platform = PlatformSchema.safeParse(process.platform); const architecture = ArchitectureSchema.safeParse(process.arch);
    const matching = manifest.assets.filter(entry => entry.host === args.host && entry.platform === process.platform && entry.architecture === process.arch);
    const preferred = { codex: 'tar.gz', 'claude-code': 'zip' } satisfies Record<UpdateStatusInput['host'], ArchiveFormat>;
    const asset = matching.find(entry => entry.format === preferred[args.host]) ?? matching[0];
    const archive: Archive = asset ? {
      kind: 'published', name: asset.name, url: assetUrl(manifest.tag, asset.name), bytes: asset.bytes, sha256: asset.sha256, format: asset.format,
      verification: 'manifest-metadata-only',
    } : { kind: 'unavailable', reason: platform.success && architecture.success ? 'not-published-for-runtime' : 'unsupported-platform' };
    const comparison = compareVersions(version, candidate.version);
    return { ...context, kind: comparison < 0 ? 'update-available' : comparison > 0 ? 'ahead' : 'current', release: {
      version: candidate.version, tag: manifest.tag, pageUrl: candidate.release.html_url,
      manifestUrl: assetUrl(manifest.tag, 'release-manifest.json'), archive,
      ...(manifest.source.commit === undefined ? {} : { sourceCommit: manifest.source.commit }),
    } };
  } catch (error) {
    return { ...context, kind: 'unknown', reason: error instanceof UnknownStatus ? error.reason : signal.aborted ? 'timeout' : 'network' };
  }
}
