import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.dirname(fileURLToPath(import.meta.url));
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  assert(['--plugin', '--evidence'].includes(process.argv[index]), 'Unknown native-check option');
  options.set(process.argv[index], process.argv[index + 1]);
}
const plugin = options.get('--plugin');
const evidence = options.get('--evidence');
assert(plugin && evidence && path.isAbsolute(plugin) && path.isAbsolute(evidence), 'Use absolute --plugin and --evidence paths');
await mkdir(evidence);
const compiler = path.join(plugin, 'runtime/node_modules/typescript/bin/tsc');
const version = JSON.parse(await readFile(path.join(plugin, 'runtime/node_modules/typescript/package.json'), 'utf8')).version;
assert.equal(version, '7.0.2');
const commands = [
  { id: 'typescript-generated', command: process.execPath, args: [compiler, '-p', path.join(app, 'generated/typescript/tsconfig.json')] },
  { id: 'typescript-app', command: process.execPath, args: [compiler, '-p', path.join(app, 'tsconfig.json')] },
  { id: 'typescript-behavior', command: process.execPath, args: [path.join(app, 'ts-check.js')] },
  { id: 'rust-behavior', command: 'cargo', args: ['test', '--offline', '--locked', '--manifest-path', path.join(app, 'Cargo.toml'), '--target-dir', path.join(app, 'target'), '--', '--nocapture'] },
];
const outcomes = [];
for (const command of commands) {
  const executed = spawnSync(command.command, command.args, { cwd: app, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  await writeFile(path.join(evidence, `${command.id}.stdout.log`), executed.stdout ?? '');
  await writeFile(path.join(evidence, `${command.id}.stderr.log`), executed.stderr ?? '');
  outcomes.push({ ...command, exitCode: executed.status, signal: executed.signal, error: executed.error?.message ?? null });
  await writeFile(path.join(evidence, 'commands.json'), `${JSON.stringify({ version: 1, typescript: version, commands: outcomes }, null, 2)}\n`);
  assert.equal(executed.error, undefined, `${command.id}: ${executed.error?.message}`);
  assert.equal(executed.status, 0, `${command.id} failed; inspect its logs`);
}
const expected = JSON.parse(await readFile(path.join(app, 'expected-observations.json'), 'utf8'));
const sort = values => [...values].sort((left, right) => left.scenario.localeCompare(right.scenario));
for (const [id, marker] of [['typescript-behavior', 'SGD_HOST_LEDGER_TS '], ['rust-behavior', 'SGD_HOST_LEDGER_RUST ']]) {
  const output = await readFile(path.join(evidence, `${id}.stdout.log`), 'utf8');
  const values = output.split('\n').filter(line => line.includes(marker)).map(line => JSON.parse(line.slice(line.indexOf(marker) + marker.length)));
  assert.deepEqual(sort(values), sort(expected), `${id} observations differ from the complete-row contract`);
}
console.log('SGD_HOST_NATIVE_OK ' + JSON.stringify({ typescript: version, commands: outcomes.map(({ id, exitCode }) => ({ id, exitCode })) }));
