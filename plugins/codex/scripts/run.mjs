#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../runtime/dist/cli.js', import.meta.url));
if (Number(process.versions.node.split('.')[0]) < 22) {
  process.stderr.write('Specification Guided Development requires Node.js 22 or later.\n');
  process.exit(1);
}
try {
  await access(cli);
} catch {
  process.stderr.write(
    'Specification Guided Development runtime is missing from this plugin package.\n' +
    'In a specification-guided-development source checkout, run npm ci, npm run build, and node plugins/package.mjs.\n' +
    'Then install the prepared local plugin directory or use a prepared release package.\n',
  );
  process.exit(1);
}
try {
  const runtime = JSON.parse(await readFile(new URL('../runtime/runtime-platform.json', import.meta.url), 'utf8'));
  if (!runtime || runtime.version !== 1 || typeof runtime.platform !== 'string' || typeof runtime.arch !== 'string') {
    throw new Error('Runtime platform metadata is invalid.');
  }
  if (runtime.platform !== process.platform || runtime.arch !== process.arch) {
    throw new Error(`This plugin runtime was built for ${runtime.platform}-${runtime.arch}. The current host is ${process.platform}-${process.arch}.`);
  }
} catch (error) {
  process.stderr.write(
    `${error.message}\n` +
    'Rebuild the plugin on this host with npm ci, npm run build, and node plugins/package.mjs.\n' +
    'Or install a prepared archive for this host platform and architecture.\n',
  );
  process.exit(1);
}
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('error', (error) => {
  process.stderr.write(`Cannot start Specification Guided Development: ${error.message}\n`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
