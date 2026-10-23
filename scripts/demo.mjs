#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const jar = resolve(process.env.TLA2TOOLS_JAR ?? '.runtime/tla2tools.jar');
const cli = resolve('dist/cli.js');
const demo = resolve('.runtime/demo');
const results = [];
function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] });
}
for (const model of ['architecture', 'order']) {
  run(process.execPath, [cli, 'build', '--project', `examples/${model}/project.json`, '--jar', jar, '--out', `${demo}/${model}`]);
  run(process.execPath, [cli, 'build', '--project', `examples/${model}/project.json`, '--jar', jar, '--out', `${demo}/${model}`, '--check']);
  results.push({ model, checked: true });
}
await mkdir(`${demo}/application`, { recursive: true });
for (const [name, edge] of [['valid', '"Pending", "Ack", "Acked"'], ['invalid', '"Pending", "Fill", "Filled"']]) {
  await writeFile(`${demo}/application/${name}.ts`, `transition(${edge});\n`);
  await writeFile(`${demo}/application/${name}.rs`, `fn main() { transition!(${edge}); }\n`);
}
run('cargo', ['build', '--quiet', '--manifest-path', `${demo}/order/rust/Cargo.toml`, '--target-dir', `${demo}/cargo-target`]);
for (const [language, command, leading] of [
  ['typescript', process.execPath, [`${demo}/order/typescript/checker.mjs`]],
  ['rust', `${demo}/cargo-target/debug/tlc-generated-checker`, []],
]) {
  for (const name of ['valid', 'invalid']) {
    const extension = language === 'typescript' ? 'ts' : 'rs';
    const result = spawnSync(command, [...leading, '--root', `${demo}/application`, `${name}.${extension}`], { encoding: 'utf8' });
    const expected = name === 'valid' ? 0 : 1;
    if (result.error || result.status !== expected) throw new Error(`${language} ${name} failed: ${result.error ?? result.stderr ?? result.stdout}`);
    results.push({ language, fixture: name, diagnostics: JSON.parse(result.stdout) });
  }
}
run(process.execPath, [cli, 'visualize', '--ir', `${demo}/architecture/automaton.json`, '--ir', `${demo}/order/automaton.json`, '--out', 'examples/visualization']);
await writeFile(`${demo}/results.json`, JSON.stringify(results, null, 2) + '\n');
process.stdout.write('TLC completed for architecture and order. Both language checkers accepted valid edges and rejected forbidden edges.\n');
process.stdout.write('Pele viewer: examples/visualization/index.html\n');
