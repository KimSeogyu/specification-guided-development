import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { watch } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { buildProject, compileProject } from '../src/compiler.js';
import { type MachineProject } from '../src/finite-types.js';
import { PartitionPlanSchema, PartitionProjectSchema, type PartitionProject } from '../src/partition-types.js';
import { RowBindingPlanSchema, RowBindingSchema, RowProjectSchema, type RowProject } from '../src/row-binding-types.js';

const execute = promisify(execFile);
const jar = process.env.TLA2TOOLS_JAR ? resolve(process.env.TLA2TOOLS_JAR) : undefined;
const fixtureRoot = resolve('tests/fixtures/rust-facts');
const tsc = resolve('node_modules/typescript/bin/tsc');
const inventorySchema = z.object({ version: z.literal(1), files: z.array(z.string()) });
const families = `---- MODULE PartitionFamilies ----
PartitionFamilies ==
  [version |-> 1, calendar |-> "utc-micros-nonnegative-day-v1", families |->
    [KlineFact |-> [key |-> <<"open_time">>, symbol |-> "symbol", time |-> "open_time", datasets |-> {"um-kline", "mark-price-kline", "index-price-kline", "premium-index-kline", "spot-kline"}],
     FundingFact |-> [key |-> <<"funding_time">>, symbol |-> "symbol", time |-> "funding_time", datasets |-> {"funding-rate"}],
     MetricsFact |-> [key |-> <<"create_time">>, symbol |-> "symbol", time |-> "create_time", datasets |-> {"metrics"}],
     BookFact |-> [key |-> <<"timestamp", "percentage">>, symbol |-> "symbol", time |-> "timestamp", datasets |-> {"book-depth"}]]]
====
`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sgd-partition-compiler-'));
  const application = join(root, 'application'); const models = join(root, 'models'); const rowDirectory = join(models, 'row'); const controlDirectory = join(models, 'control'); const out = join(application, 'generated');
  await cp(join(fixtureRoot, 'parangsae'), application, { recursive: true });
  const workspace = join(application, 'Cargo.toml');
  await writeFile(workspace, (await readFile(workspace, 'utf8')).replace('"crates/collector"]', '"crates/collector", "generated/rust"]'));
  await mkdir(rowDirectory, { recursive: true }); await mkdir(controlDirectory);
  for (const name of ['FactWriteEnvelope.tla', 'FactWriteEnvelope.cfg']) await cp(resolve('examples/fact-envelope', name), join(rowDirectory, name));
  for (const name of ['model.tla', 'model.cfg']) await cp(resolve('examples/partition-control', name), join(controlDirectory, name));
  const binding = RowBindingSchema.parse(JSON.parse(await readFile(join(fixtureRoot, 'binding.json'), 'utf8')));
  const row: RowProject = { version: 5, profile: 'row-owned', name: 'FactWriteEnvelope', spec: 'FactWriteEnvelope.tla', config: 'FactWriteEnvelope.cfg', application: '../../application', targets: ['typescript', 'rust'], binding: { className: 'FactPartitionAuthority', row: binding, rustCrateMode: 'workspace' } };
  const control: MachineProject = { version: 2, profile: 'finite-owned', name: 'PartitionControl', spec: 'model.tla', config: 'model.cfg', targets: ['typescript', 'rust'], binding: { className: 'PartitionControl' } };
  const project: PartitionProject = { version: 6, profile: 'partition-fold', name: 'FactPartition', application: '../application', targets: ['typescript', 'rust'], models: { row: { project: 'row/project.json' }, control: { project: 'control/project.json' }, families: { spec: 'PartitionFamilies.tla', operator: 'PartitionFamilies' } }, binding: { className: 'FactPartitionAuthority', rustCrateMode: 'workspace' } };
  const projectPath = join(models, 'project.json'); const rowPath = join(rowDirectory, 'project.json'); const metadata = join(models, 'PartitionFamilies.tla');
  await writeFile(projectPath, JSON.stringify(project)); await writeFile(rowPath, JSON.stringify(row)); await writeFile(join(controlDirectory, 'project.json'), JSON.stringify(control)); await writeFile(metadata, families);
  // The audited source points at the exact not-yet-existing generated hook and
  // primitive dependency. Bootstrap must skip only those three controlled paths.
  const packageName = `sgd-symbolic-factwriteenvelope-${createHash('sha256').update('FactWriteEnvelope').digest('hex').slice(0, 12)}`;
  const manifest = join(application, 'crates/collector/Cargo.toml');
  await writeFile(manifest, await readFile(manifest, 'utf8') + `sgd_fact_authority = { package = "${packageName}", path = "../../generated/rust" }\n`);
  const library = join(application, 'crates/collector/src/lib.rs');
  const originalLibrary = await readFile(library, 'utf8');
  await writeFile(library, originalLibrary + `\n#[path = "../../../generated/rust/adapter.rs"]\nmod sgd_partition;\n\npub fn check_generated_partition_types() {\n${binding.source.facts.map(fact => `    let _ = sgd_partition::fold_partition::<${fact.rustPath}>(Vec::new(), Vec::new()).unwrap().into_report().unwrap();`).join('\n')}\n}\n`);
  return { root, application, models, out, projectPath, rowPath, metadata, library };
}

async function managedSnapshot(out: string): Promise<Map<string, Buffer>> {
  const inventoryBytes = await readFile(join(out, '.sgd-generated.json'));
  const inventory = inventorySchema.parse(JSON.parse(inventoryBytes.toString('utf8')));
  return new Map([['.sgd-generated.json', inventoryBytes], ...await Promise.all(inventory.files.map(async path => [path, await readFile(join(out, path))] satisfies [string, Buffer]))]);
}
async function unchanged(out: string, before: Map<string, Buffer>): Promise<void> {
  assert.deepEqual(await managedSnapshot(out), before, 'a check or refused model/source build must not publish any managed byte');
}

/** Observe a real controlled child build, then change only an original path alias. */
async function buildAcrossAliasChange(input: { project: string; out: string; fixture: string; alias: string; replacement: string; scratchPrefix: string }) {
  assert.ok(jar);
  const temporary = join(input.fixture, 'isolated-build-temp'); await mkdir(temporary);
  const settings = join(input.fixture, 'alias-build.json');
  const helper = join(input.fixture, 'alias-build.mjs');
  await writeFile(settings, JSON.stringify({ project: input.project, out: input.out, jar }));
  await writeFile(helper, `import { readFile } from 'node:fs/promises';
import { buildProject } from ${JSON.stringify(pathToFileURL(resolve('src/compiler.ts')).href)};
try { await buildProject(JSON.parse(await readFile(process.argv[2], 'utf8'))); process.stdout.write(JSON.stringify({ok:true})); }
catch (error) { process.stdout.write(JSON.stringify({ok:false,error:String(error)})); }
`);
  let swapping = false;
  let mutation: Promise<void> | undefined;
  let observed: (() => void) | undefined;
  let observationFailed: ((error: unknown) => void) | undefined;
  const observation = new Promise<void>((resolve, reject) => { observed = resolve; observationFailed = reject; });
  const observer = watch(temporary, (_event, filename) => {
    if (swapping || !filename?.toString().startsWith(input.scratchPrefix)) return;
    swapping = true;
    mutation = (async () => {
      try { await rm(input.alias); await symlink(input.replacement, input.alias); observed?.(); }
      catch (error) { observationFailed?.(error); }
    })();
  });
  const child = spawn(process.execPath, ['--import', 'tsx', helper, settings], { cwd: resolve('.'), env: { ...process.env, TMPDIR: temporary, TEMP: temporary, TMP: temporary }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', bytes => { stdout += String(bytes); });
  child.stderr.on('data', bytes => { stderr += String(bytes); });
  const terminal = once(child, 'close');
  const watchdog = setTimeout(() => { child.kill('SIGKILL'); observationFailed?.(new Error('native build did not reach the expected scratch phase')); }, 90_000);
  try {
    await Promise.race([observation, terminal.then(([code, signal]) => { throw new Error(`build ended before alias change: ${code}/${signal}: ${stdout} ${stderr}`); })]);
    const [code, signal] = await terminal;
    assert.equal(code, 0, stderr); assert.equal(signal, null, stderr);
    return z.discriminatedUnion('ok', [z.object({ ok: z.literal(true) }).strict(), z.object({ ok: z.literal(false), error: z.string() }).strict()]).parse(JSON.parse(stdout));
  } finally {
    clearTimeout(watchdog); observer.close();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await terminal; }
    await mutation;
  }
}

test('v6 imported DOT cannot create a closed fold or its output directory', async () => {
  const data = await fixture();
  try {
    await assert.rejects(compileProject({ project: data.projectPath, dot: join(data.root, 'absent.dot'), out: data.out }), /TLC206: imported DOT cannot generate partition-fold authority/);
    await assert.rejects(access(data.out), { code: 'ENOENT' });
  } finally { await rm(data.root, { recursive: true, force: true }); }
});

test('v6 model-only inspection refuses composition before TLC or output creation', async () => {
  const data = await fixture();
  try {
    await assert.rejects(buildProject({ project: data.projectPath, jar: join(data.root, 'absent.jar'), out: data.out, modelOnly: true }), /TLC306.*referenced row and control/);
    await assert.rejects(access(data.out), { code: 'ENOENT' });
  } finally { await rm(data.root, { recursive: true, force: true }); }
});

for (const reference of ['row', 'control']) {
  test(`v6 refuses the wrong ${reference} project authority before TLC or output creation`, async () => {
    const data = await fixture();
    try {
      const project = PartitionProjectSchema.parse(JSON.parse(await readFile(data.projectPath, 'utf8')));
      project.models[reference === 'row' ? 'row' : 'control'].project = reference === 'row' ? 'control/project.json' : 'row/project.json';
      await writeFile(data.projectPath, JSON.stringify(project));
      await assert.rejects(buildProject({ project: data.projectPath, jar: join(data.root, 'absent.jar'), out: data.out }), /TLC306.*row-owned v5.*finite-owned v2/);
      await assert.rejects(access(data.out), { code: 'ENOENT' });
    } finally { await rm(data.root, { recursive: true, force: true }); }
  });
}

for (const role of ['row application', 'parent application', 'generated output']) {
  test(`real v6 build refuses a changed ${role} root before publication`, { skip: !jar || process.platform === 'win32', timeout: 120_000 }, async () => {
    const data = await fixture();
    try {
      const alternate = join(data.root, 'alternate-application'); await cp(data.application, alternate, { recursive: true });
      const alias = join(data.root, 'selected-root'); await symlink(data.application, alias);
      let out = data.out;
      if (role === 'row application') {
        const row = RowProjectSchema.parse(JSON.parse(await readFile(data.rowPath, 'utf8'))); row.application = '../../selected-root';
        await writeFile(data.rowPath, JSON.stringify(row)); out = join(alias, 'generated');
      } else if (role === 'parent application') {
        const project = PartitionProjectSchema.parse(JSON.parse(await readFile(data.projectPath, 'utf8'))); project.application = '../selected-root';
        await writeFile(data.projectPath, JSON.stringify(project));
      } else out = join(alias, 'generated');
      const result = await buildAcrossAliasChange({ project: data.projectPath, out, fixture: data.root, alias, replacement: alternate,
        scratchPrefix: role === 'generated output' ? 'sgd-finite-' : 'sgd-symbolic-' });
      assert.equal(result.ok, false, 'path identity drift must not publish authority for a different application or output root');
      if (result.ok) throw new Error('unexpected authority publication');
      assert.match(result.error, /TLC(?:103|203|305|306)/);
      await assert.rejects(access(data.out), { code: 'ENOENT' });
      await assert.rejects(access(join(alternate, 'generated')), { code: 'ENOENT' });
    } finally { await rm(data.root, { recursive: true, force: true }); }
  });
}

test('real v6 bootstrap composes controlled models and all four native Facts without self-hashing generated source', { skip: !jar, timeout: 360_000 }, async () => {
  assert.ok(jar); const data = await fixture();
  try {
    const input = { project: data.projectPath, out: data.out, jar };
    await assert.rejects(access(data.out), { code: 'ENOENT' });
    await buildProject(input);
    const plan = PartitionPlanSchema.parse(JSON.parse(await readFile(join(data.out, 'partition-plan.json'), 'utf8')));
    assert.deepEqual(plan.contract.families.map(family => family.name), ['BookFact', 'FundingFact', 'KlineFact', 'MetricsFact']);
    assert.deepEqual(plan.contract.families.find(family => family.name === 'BookFact')?.key, ['timestamp', 'percentage']);
    assert.deepEqual(plan.row.plan.facts.map(fact => [fact.name, fact.fields.length]), [['KlineFact', 18], ['FundingFact', 9], ['MetricsFact', 13], ['BookFact', 10]]);
    assert.ok(plan.row.plan.sources.some(source => source.path === 'crates/collector/src/lib.rs'));
    assert.ok(plan.row.plan.sources.some(source => source.path === 'crates/collector/Cargo.toml'));
    assert.ok(plan.row.plan.sources.every(source => !source.path.startsWith('generated/')));
    assert.equal(plan.runtimeProfile, 'unbound-partition-v1');
    const receipt = z.object({ kind: z.literal('controlled-partition-fold'), storageAuthority: z.literal(false), generation: z.literal('closed-data-fold') }).parse(JSON.parse(await readFile(join(data.out, 'verification.json'), 'utf8')));
    assert.equal(receipt.storageAuthority, false);
    for (const path of ['models/row/semantic.xml', 'models/control/semantic.xml', 'models/families/semantic.xml']) assert.match(await readFile(join(data.out, path), 'utf8'), /<.*xml|<modules|<context|<module/i);
    await execute(process.execPath, [tsc, '-p', join(data.out, 'typescript/tsconfig.json')], { timeout: 30_000 });
    await execute('cargo', ['check', '--quiet', '--manifest-path', join(data.application, 'crates/collector/Cargo.toml'), '--target-dir', join(data.root, 'target')], { timeout: 180_000 });
    const before = await managedSnapshot(data.out);
    await buildProject({ ...input, check: true }); await unchanged(data.out, before);
    // A type-valid metadata typo is refused against the audited source field,
    // before any existing generated artifact can be replaced.
    await writeFile(data.metadata, families.replace('key |-> <<"open_time">>', 'key |-> <<"missing_key">>'));
    await assert.rejects(buildProject(input), /TLC306.*KlineFact\.missing_key.*i64/); await unchanged(data.out, before);
    await writeFile(data.metadata, families);
    const rows = join(data.application, 'crates/collector/src/vision/rows.rs'); const originalRows = await readFile(rows, 'utf8');
    await writeFile(rows, originalRows.replace('self.count == other.count', 'self.count != other.count'));
    await assert.rejects(buildProject(input), /TLC305.*unsupported boolean operator/); await unchanged(data.out, before);
    await writeFile(rows, originalRows);
    const originalLibrary = await readFile(data.library, 'utf8');
    await writeFile(join(data.out, 'rust/foreign.rs'), 'pub struct UncheckedOriginal;\n');
    await writeFile(data.library, originalLibrary + '\n#[path = "../../../generated/rust/foreign.rs"]\nmod foreign_original;\n');
    await assert.rejects(buildProject(input), /TLC305.*not one of the three controlled generated/); await unchanged(data.out, before);
    await writeFile(data.library, originalLibrary);
    await buildProject({ ...input, check: true }); await unchanged(data.out, before);
  } finally { await rm(data.root, { recursive: true, force: true }); }
});

test('real v5 authority migrates to v6 in the same managed root and removes obsolete standalone row artifacts', { skip: !jar, timeout: 360_000 }, async () => {
  assert.ok(jar); const data = await fixture();
  try {
    await buildProject({ project: data.rowPath, out: data.out, jar });
    await access(join(data.out, 'model.dot')); await access(join(data.out, 'semantic.xml')); await access(join(data.out, 'orbit-proof.json'));
    const before = RowBindingPlanSchema.parse(JSON.parse(await readFile(join(data.out, 'row-binding-plan.json'), 'utf8')));
    await buildProject({ project: data.projectPath, out: data.out, jar });
    const plan = PartitionPlanSchema.parse(JSON.parse(await readFile(join(data.out, 'partition-plan.json'), 'utf8')));
    assert.deepEqual(plan.row.plan, before, 'source inventory and original Fact schema survive same-root migration exactly');
    for (const obsolete of ['model.dot', 'semantic.xml', 'orbit-proof.json', 'input-oracle.dot', 'input-verification.json']) await assert.rejects(access(join(data.out, obsolete)), { code: 'ENOENT' });
    for (const retained of ['models/row/model.dot', 'models/row/semantic.xml', 'models/row/orbit-proof.json', 'models/row/input-verification.json', 'typescript/primitive-control.ts', 'rust/adapter.rs']) await access(join(data.out, retained));
    const snapshot = await managedSnapshot(data.out);
    await buildProject({ project: data.projectPath, out: data.out, jar, check: true }); await unchanged(data.out, snapshot);
    await execute(process.execPath, [tsc, '-p', join(data.out, 'typescript/tsconfig.json')], { timeout: 30_000 });
    await execute('cargo', ['check', '--quiet', '--manifest-path', join(data.application, 'crates/collector/Cargo.toml'), '--target-dir', join(data.root, 'target')], { timeout: 180_000 });
  } finally { await rm(data.root, { recursive: true, force: true }); }
});
