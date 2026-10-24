import { readFileSync } from 'node:fs';
import { z } from 'zod';

const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function supportedVersion(value: string): boolean {
  if (!VERSION.test(value)) return false;
  const prerelease = (value.split('+')[0] ?? '').split('-').slice(1).join('-');
  return !prerelease || prerelease.split('.').every(identifier => !/^\d+$/.test(identifier) || identifier === '0' || !identifier.startsWith('0'));
}

export const ReleaseVersionSchema = z.string().refine(supportedVersion, 'Use a supported semantic version.');
const PackageMetadata = z.object({ version: ReleaseVersionSchema });
const metadata: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const version = PackageMetadata.parse(metadata).version;
