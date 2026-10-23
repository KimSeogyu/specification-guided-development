#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const destination = resolve(process.argv[2] ?? '.runtime/tla2tools.jar');
const response = await fetch('https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar');
if (!response.ok) throw new Error(`TLC download failed with HTTP ${response.status}`);
const data = Buffer.from(await response.arrayBuffer());
const expected = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88';
if (createHash('sha256').update(data).digest('hex') !== expected) throw new Error('TLC download integrity check failed');
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, data);
process.stdout.write(`TLC 2.19 saved to ${destination}\n`);
