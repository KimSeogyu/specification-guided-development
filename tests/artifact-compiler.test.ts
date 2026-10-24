import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { z } from 'zod';
import { buildProject, readProject } from '../src/compiler.js';
import { consumerFacts } from './fixtures/artifact-models.js';

const execute = promisify(execFile);
const jar = process.env.TLA2TOOLS_JAR;

async function snapshot(root: string, prefix = ''): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) for (const [path, bytes] of await snapshot(join(root, entry.name), `${name}/`)) result.set(path, bytes);
    else result.set(name, await readFile(join(root, entry.name)));
  }
  return result;
}

test('controlled SDK Rust bytes agree with consumer fmt and freshness, and source changes during formatting refuse publication', { skip: !jar, timeout: 120_000 }, async () => {
  assert.ok(jar);
  const root = await mkdtemp(join(tmpdir(), 'sgd-artifact-sdk-'));
  const originalPath = process.env.PATH;
  try {
    const project = join(root, 'project.json');
    const spec = join(root, 'Approval.tla');
    const out = join(root, 'generated');
    await cp(resolve('examples/approval/Approval.tla'), spec);
    await cp(resolve('examples/approval/Approval.cfg'), join(root, 'Approval.cfg'));
    await writeFile(project, JSON.stringify({ version: 2, profile: 'finite-owned', name: 'Approval', spec: 'Approval.tla', config: 'Approval.cfg', targets: ['rust'], binding: { className: 'ApprovalMachine' } }));
    const input = { project, jar, out };
    await buildProject(input);
    const manifest = await readFile(join(out, 'rust/Cargo.toml'), 'utf8');
    const packageName = /^name = "([a-z0-9-]+)"$/m.exec(manifest)?.[1];
    assert.ok(packageName);
    const consumer = join(root, 'consumer');
    await mkdir(join(consumer, 'src'), { recursive: true });
    await writeFile(join(consumer, 'Cargo.toml'), `[package]\nname = "artifact-sdk-consumer"\nversion = "0.1.0"\nedition = "2021"\n[workspace]\n[dependencies]\nauthority = { package = "${packageName}", path = "../generated/rust" }\n`);
    await writeFile(join(consumer, 'src/lib.rs'), 'pub fn consumer() {}\n');
    const before = await snapshot(out);
    await execute('cargo', ['fmt', '--manifest-path', join(consumer, 'Cargo.toml'), '--all', '--', '--check'], { timeout: 30_000, env: { ...process.env, CARGO_NET_OFFLINE: 'true' } });
    await buildProject({ ...input, check: true });
    assert.deepEqual(await snapshot(out), before);
    assert.match(await readFile(join(out, 'rust/rustfmt.toml'), 'utf8'), /style_edition = "2021"/);
    assert.match(await readFile(join(out, 'artifact-format.json'), 'utf8'), /rust\/src\/lib.rs/);

    const library = join(out, 'rust/src/lib.rs');
    const canonical = await readFile(library);
    await appendFile(library, '\n');
    const edited = await snapshot(out);
    await assert.rejects(buildProject({ ...input, check: true }), /TLC104: stale generated file rust\/src\/lib.rs/);
    assert.deepEqual(await snapshot(out), edited);
    await writeFile(library, canonical);

    // The wrapper still runs real rustfmt. It edits only this test's original model.
    const binary = (await execute('which', ['rustfmt'])).stdout.trim();
    const bin = join(root, 'bin');
    await mkdir(bin);
    const wrapper = join(bin, 'rustfmt');
    await writeFile(wrapper, `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nimport { appendFileSync, existsSync, writeFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nif (!args.includes('--version') && !existsSync(${JSON.stringify(join(root, 'changed'))})) { appendFileSync(${JSON.stringify(spec)}, '\\n\\\\* changed while formatter runs\\n'); writeFileSync(${JSON.stringify(join(root, 'changed'))}, 'changed'); }\nconst result = spawnSync(${JSON.stringify(binary)}, args, { input: args.includes('--version') ? '' : await new Promise(resolve => { let content = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => content += chunk); process.stdin.on('end', () => resolve(content)); }), encoding: 'utf8' });\nprocess.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? ''); process.exit(result.status ?? 1);\n`);
    await chmod(wrapper, 0o700);
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    await assert.rejects(buildProject(input), /TLC203: original controlled model inputs changed before publication/);
    assert.deepEqual(await snapshot(out), before);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

test('all six SDK project profiles publish canonical Rust through the shared gate and retain byte-exact freshness', { skip: !jar, timeout: 180_000 }, async () => {
  assert.ok(jar);
  const root = await mkdtemp(join(tmpdir(), 'sgd-artifact-sdk-profiles-'));
  try {
    const projects: string[] = [];
    for (const [version, example] of [[1, 'order'], [2, 'approval'], [3, 'fact-merge'], [4, 'fact-envelope']] satisfies [number, string][]) {
      const directory = join(root, `models-v${version}`);
      await cp(resolve('examples', example), directory, { recursive: true });
      const path = join(directory, 'project.json');
      const project = await readProject(path);
      await writeFile(path, JSON.stringify({ ...project, targets: ['rust'] }));
      projects.push(path);
    }
    const application = join(root, 'application');
    await mkdir(join(application, 'src'), { recursive: true });
    await writeFile(join(application, 'Cargo.toml'), '[package]\nname = "artifact-sdk-source"\nversion = "0.1.0"\nedition = "2021"\n[workspace]\n');
    await writeFile(join(application, 'src/lib.rs'), consumerFacts);
    const models = join(root, 'models-v5');
    await cp(resolve('examples/fact-envelope'), models, { recursive: true });
    const row = { version: 5, profile: 'row-owned', name: 'FactWriteEnvelope', spec: 'FactWriteEnvelope.tla', config: 'FactWriteEnvelope.cfg', application: '../application', targets: ['rust'], binding: {
      className: 'ArtifactRows', rustCrateMode: 'standalone', row: { version: 1, profile: 'rust-whole-row-v1',
        source: { manifest: 'Cargo.toml', module: 'crate::facts', facts: [{ name: 'Fact', rustPath: 'crate::facts::Fact', metadata: ['received'] }] },
        model: { payloadInput: 'v', provenanceInput: 'provenance', pairs: [{ name: 'stored', payload: 'stored', provenance: 'storedProvenance' }, { name: 'rejected', payload: 'rejected', provenance: 'rejectedProvenance' }] },
      },
    } };
    const rowPath = join(models, 'project.json');
    await writeFile(rowPath, JSON.stringify(row));
    projects.push(rowPath);
    const control = join(root, 'control');
    await cp(resolve('examples/partition-control'), control, { recursive: true });
    await writeFile(join(control, 'project.json'), JSON.stringify({ version: 2, profile: 'finite-owned', name: 'PartitionControl', spec: 'model.tla', config: 'model.cfg', targets: ['rust'], binding: { className: 'ArtifactControl' } }));
    await writeFile(join(root, 'Families.tla'), '---- MODULE Families ----\nFamilies == [version |-> 1, calendar |-> "utc-micros-nonnegative-day-v1", families |-> [Fact |-> [key |-> <<"key">>, symbol |-> "symbol", time |-> "time", datasets |-> {"facts"}]]]\n====\n');
    const partition = join(root, 'partition.json');
    await writeFile(partition, JSON.stringify({ version: 6, profile: 'partition-fold', name: 'ArtifactPartition', application: 'application', targets: ['rust'],
      models: { row: { project: 'models-v5/project.json' }, control: { project: 'control/project.json' }, families: { spec: 'Families.tla', operator: 'Families' } },
      binding: { className: 'ArtifactPartition', rustCrateMode: 'standalone' } }));
    projects.push(partition);
    for (const [index, project] of projects.entries()) {
      const out = join(index >= 4 ? application : root, `generated-v${index + 1}`);
      await buildProject({ project, jar, out });
      const before = await snapshot(out);
      assert.match(await readFile(join(out, 'artifact-format.json'), 'utf8'), /rustfmt-2021-v1/);
      assert.match(await readFile(join(out, 'rust/rustfmt.toml'), 'utf8'), /style_edition = "2021"/);
      await execute('cargo', ['fmt', '--manifest-path', join(out, 'rust/Cargo.toml'), '--all', '--', '--check'], { timeout: 30_000, env: { ...process.env, CARGO_NET_OFFLINE: 'true' } });
      await buildProject({ project, jar, out, check: true });
      assert.deepEqual(await snapshot(out), before, `v${index + 1} SDK check must retain canonical output bytes`);
      if (index === 5) {
        const nested = z.object({ rowBinding: z.object({ formatter: z.null() }) }).parse(JSON.parse(await readFile(join(out, 'models/row/verification.json'), 'utf8')));
        assert.equal(nested.rowBinding.formatter, null, 'a referenced row without generated Rust must not claim formatter evidence');
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
