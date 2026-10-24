import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { CodecRecipeBindingSchema, CodecRecipeReportSchema, type CodecRecipeReport } from '../src/codec-recipe-types.js';
import { analyzeCodecRecipe, recheckCodecRecipe } from '../src/codec-recipe.js';
import { RowBindingSchema } from '../src/row-binding-types.js';
import { analyzeRowBinding } from '../src/row-binding.js';

const execute = promisify(execFile);
const fixtureRoot = resolve('tests/fixtures/rust-codec-recipe');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sgd-codec-recipe-test-'));
  const application = join(root, 'application');
  await cp(join(fixtureRoot, 'parangsae'), application, { recursive: true });
  const binding = CodecRecipeBindingSchema.parse(JSON.parse(await readFile(join(fixtureRoot, 'codec-binding.json'), 'utf8')));
  return { root, application, binding };
}

let baseline: CodecRecipeReport | undefined;
let baselineFixture: Awaited<ReturnType<typeof fixture>> | undefined;
before(async () => {
  baselineFixture = await fixture();
  baseline = await analyzeCodecRecipe(baselineFixture);
});
after(async () => {
  if (baselineFixture) await rm(baselineFixture.root, { recursive: true, force: true });
});
function report(): CodecRecipeReport { assert.ok(baseline); return baseline; }

test('the real native Funding recipe remains evidence with complete raw fields and immutable report values', async () => {
  const result = report();
  assert.equal(result.storageAuthority, false);
  assert.equal(result.scope, 'selected-codec-and-native-constructor-closure');
  assert.equal(result.discovery.scope, 'discovered-targets-only');
  assert.deepEqual(result.columns.map(column => [column.column, column.field, column.scalar]), [
    ['symbol', 'symbol', 'string'], ['raw_calc_time_us', 'raw_calc_time', 'i64'], ['funding_time_us', 'funding_time', 'i64'],
    ['interval_hours', 'interval_hours', 'i64'], ['rate_ticks', 'rate', 'i64'], ['event_ts_us', 'event_ts', 'i64'],
    ['available_ts_us', 'available_ts', 'i64'], ['received_ts_us', 'received_ts', 'i64'], ['schema_version', 'schema_version', 'u32'],
  ]);
  assert.deepEqual(result.row.fields.find(field => field.name === 'received_ts')?.codec, { kind: 'i64', getters: ['micros', 'micros'] });
  assert.equal(result.row.fields.find(field => field.name === 'received_ts')?.provenance, true);
  assert.equal(result.row.fields.find(field => field.name === 'received_ts')?.payload, false);
  assert.equal(result.binding.path, 'binding.json');
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.columns));
  const first = result.columns[0]; assert.ok(first);
  assert.ok(Object.isFrozen(first.decode));
  assert.equal(Reflect.set(result, 'storageAuthority', true), false);
  assert.throws(() => result.columns.push(first), TypeError);
  await recheckCodecRecipe({ report: result });
  for (const copied of [structuredClone(result), CodecRecipeReportSchema.parse(result)]) {
    await assert.rejects(recheckCodecRecipe({ report: copied }), /TLC309:.*exact report.*serialized reports/);
  }
});

test('the report schema refuses malformed column relations, constructors, identities, discovery, and portable paths', () => {
  const original = report();
  const first = original.columns[0]; const second = original.columns[1];
  assert.ok(first && second);
  const column = (index: number, patch: Record<string, unknown>): unknown => ({ ...original, columns: original.columns.map((entry, offset) => offset === index ? { ...entry, ...patch } : entry) });
  const cases: [string, unknown][] = [
    ['storage permission', { ...original, storageAuthority: true }],
    ['all-target claim', { ...original, discovery: { ...original.discovery, allTargetsChecked: true } }],
    ['missing trust assumptions', { ...original, discovery: { ...original.discovery, trustedBoundary: [] } }],
    ['lost receipt', { ...original, columns: original.columns.filter(entry => entry.field !== 'received_ts') }],
    ['duplicate native field', column(1, { field: first.field })],
    ['duplicate physical column', column(1, { column: first.column })],
    ['wrong scalar', column(1, { scalar: 'u32' })],
    ['nullable field', column(1, { nullable: true })],
    ['unknown column metadata', column(1, { writer: 'allowed' })],
    ['missing checked constructor', column(1, { decode: { kind: 'identity', scalar: 'i64' } })],
    ['wrong constructor scalar', column(1, { decode: { kind: 'tuple-wrap', constructor: second.decode.kind === 'tuple-wrap' ? second.decode.constructor : null, inner: { kind: 'identity', scalar: 'u32' } } })],
    ['unknown row field', { ...original, columns: [...original.columns, { ...second, column: 'extra', field: 'extra' }] }],
    ['unclassified native field', { ...original, row: { ...original.row, fields: original.row.fields.map(field => field.name === 'received_ts' ? { ...field, provenance: false } : field) } }],
    ['uncaptured entrypoint', { ...original, entrypoints: { ...original.entrypoints, encode: { ...original.entrypoints.encode, file: 'uncaptured.rs' } } }],
    ['wrong canonical crate', { ...original, wire: { ...original.wire, crateId: 'different_crate' } }],
    ['unselected library', { ...original, library: { ...original.library, target: 'other_target' } }],
    ['absent and present source', { ...original, absentInputs: [...original.absentInputs, original.library.source] }],
    ['unknown dependency package', { ...original, discovery: { ...original.discovery, dependencies: original.discovery.dependencies.map(dependency => ({ ...dependency, dependencyPackageId: 'path+file:///absent#absent@0.0.0' })) } }],
    ['local feature admission', { ...original, discovery: { ...original.discovery, packages: original.discovery.packages.map(package_ => ({ ...package_, enabledFeatures: ['unproved'] })) } }],
    ['invalid package origin', { ...original, discovery: { ...original.discovery, packages: original.discovery.packages.map(package_ => ({ ...package_, source: 'git+https://example.com/untrusted' })) } }],
  ];
  if (second.decode.kind === 'tuple-wrap') {
    const constructor = second.decode.constructor;
    let tooDeep: unknown = { kind: 'identity', scalar: 'i64' };
    for (let depth = 0; depth < 5; depth++) tooDeep = { kind: 'tuple-wrap', constructor, inner: tooDeep };
    cases.push(['excessive constructor depth', column(1, { decode: tooDeep })]);
    cases.push(['constructor cycle', column(1, { decode: { kind: 'tuple-wrap', constructor, inner: { kind: 'tuple-wrap', constructor, inner: { kind: 'identity', scalar: 'i64' } } } })]);
    cases.push(['unresolved constructor source', column(1, { decode: { ...second.decode, constructor: { ...constructor, file: 'unresolved.rs' } } })]);
    cases.push(['function masquerading as constructor', column(1, { decode: { ...second.decode, constructor: { ...constructor, item: 'from_micros' } } })]);
  }
  for (const path of ['../escape.rs', '/absolute.rs', 'C:/drive.rs', 'folder\\file.rs', 'folder/file:stream.rs', 'folder/NUL.rs', 'folder/trailing. ', 'folder/./file.rs', 'folder/\0file.rs']) {
    cases.push([`nonportable path ${JSON.stringify(path)}`, { ...original, sources: original.sources.map((source, index) => index === 0 ? { ...source, path } : source) }]);
  }
  const poison: unknown = JSON.parse('{"__proto__":[]}');
  cases.push(['record key silently omitted by Zod', { ...original, discovery: { ...original.discovery, packages: original.discovery.packages.map(package_ => ({ ...package_, declaredFeatures: poison })) } }]);
  for (const [name, candidate] of cases) assert.equal(CodecRecipeReportSchema.safeParse(candidate).success, false, name);
});

test('foreign feature declarations retain duplicate entries allowed by Cargo metadata', () => {
  const original = report();
  const inventory = structuredClone(original);
  inventory.discovery.packages.push({
    packageId: 'registry+https://github.com/rust-lang/crates.io-index#inventory-witness@1.0.0',
    name: 'inventory-witness', version: '1.0.0', origin: 'registry',
    source: 'registry+https://github.com/rust-lang/crates.io-index', checksum: 'a'.repeat(64),
    enabledFeatures: ['leaf', 'repeated'], declaredFeatures: { leaf: [], repeated: ['leaf', 'leaf'] }, targetKinds: ['lib'],
  });
  const parsed = CodecRecipeReportSchema.parse(inventory);
  assert.deepEqual(parsed.discovery.packages.at(-1)?.declaredFeatures.repeated, ['leaf', 'leaf']);
});

test('unknown binding fields refuse before application access or native invocation', async () => {
  assert.ok(baselineFixture);
  const application = join(baselineFixture.root, 'absent-application');
  await assert.rejects(analyzeCodecRecipe({ application, binding: { ...baselineFixture.binding, writer: 'caller-selected' } }), /TLC309: Invalid codec recipe binding/);
  await assert.rejects(analyzeCodecRecipe({ application, binding: null }), /TLC309: Invalid codec recipe binding/);
});

test('the second complete analysis refuses changed source bytes and newly discovered targets', async () => {
  for (const change of ['comment', 'automatic-target', 'configuration']) {
    const data = await fixture();
    try {
      const result = await analyzeCodecRecipe(data);
      if (change === 'comment') {
        const path = join(data.application, 'crates/collector/src/funding_codec.rs');
        await writeFile(path, `${await readFile(path, 'utf8')}\n// A semantic no-op still changes captured source bytes.\n`);
      } else if (change === 'automatic-target') {
        const path = join(data.application, 'crates/collector/src/bin/new_target.rs');
        await mkdir(join(data.application, 'crates/collector/src/bin'), { recursive: true });
        await writeFile(path, 'fn main() {}\n');
      } else {
        await mkdir(join(data.application, '.cargo'));
        await writeFile(join(data.application, '.cargo/config.toml'), '[alias]\ncodec_fixture = "check"\n');
      }
      await assert.rejects(recheckCodecRecipe({ report: result }), /TLC309:.*changed after analysis/);
      assert.equal(result.storageAuthority, false);
    } finally { await rm(data.root, { recursive: true, force: true }); }
  }
});

test('a changed requested root alias refuses even when the original canonical source still exists', async () => {
  const first = await fixture(); const second = await fixture();
  try {
    const alias = join(first.root, 'selected-application');
    await symlink(first.application, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const result = await analyzeCodecRecipe({ application: alias, binding: first.binding });
    await unlink(alias);
    await symlink(second.application, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(recheckCodecRecipe({ report: result }), /TLC309:.*application root changed/);
  } finally {
    await rm(first.root, { recursive: true, force: true });
    await rm(second.root, { recursive: true, force: true });
  }
});

test('constructor IO refuses the new wrapper while the existing v5 source-binding API keeps its original scope', async () => {
  const data = await fixture();
  try {
    const path = join(data.application, 'crates/core/src/symbol.rs');
    const text = await readFile(path, 'utf8');
    const target = '    pub fn new(raw: &str) -> Result<Self, SymbolError> {';
    assert.equal(text.split(target).length, 2, 'the actual constructor mutation target must exist once');
    await writeFile(path, text.replace(target, `${target}\n        let _ = std::fs::write(".sgd-codec-mutation-must-not-exist", b"effect");`));
    const binding = RowBindingSchema.parse(JSON.parse(await readFile(resolve('tests/fixtures/rust-facts/binding.json'), 'utf8')));
    const oldPlan = await analyzeRowBinding({ application: data.application, binding, out: join(data.application, 'generated') });
    assert.equal(oldPlan.profile, 'rust-whole-row-v1');
    assert.equal(oldPlan.facts.find(fact => fact.name === 'FundingFact')?.fields.length, 9);
    await assert.rejects(analyzeCodecRecipe(data), /TLC309:.*new.*constructor/);
    await assert.rejects(readFile(join(data.application, '.sgd-codec-mutation-must-not-exist')), { code: 'ENOENT' });
  } finally { await rm(data.root, { recursive: true, force: true }); }
});

test('a copied ESM wrapper checks native host metadata before invoking the real bundled analyzer', async () => {
  const data = baselineFixture; assert.ok(data);
  const root = await mkdtemp(join(tmpdir(), 'sgd-codec-packaged-test-'));
  try {
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'bin'));
    for (const name of ['codec-recipe.ts', 'codec-recipe-types.ts', 'row-binding-types.ts', 'schema-record.ts']) await cp(resolve('src', name), join(root, 'src', name));
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    await symlink(resolve('node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const executable = `sgd-rust-bindings${process.platform === 'win32' ? '.exe' : ''}`;
    await cp(resolve('.runtime/rust-binding-tool/debug', executable), join(root, 'bin', executable));
    const bindingPath = join(root, 'request.json');
    await writeFile(bindingPath, JSON.stringify(data.binding));
    const entry = join(root, 'entry.mjs');
    await writeFile(entry, `import {readFile} from 'node:fs/promises';
import {analyzeCodecRecipe} from ${JSON.stringify(pathToFileURL(join(root, 'src/codec-recipe.ts')).href)};
const report=await analyzeCodecRecipe({application:process.argv[2],binding:JSON.parse(await readFile(process.argv[3],'utf8'))});
process.stdout.write(JSON.stringify({profile:report.profile,storageAuthority:report.storageAuthority}));\n`);
    const invoke = () => execute(process.execPath, ['--import', import.meta.resolve('tsx'), entry, data.application, bindingPath], { timeout: 180_000 });
    await writeFile(join(root, 'runtime-platform.json'), JSON.stringify({ version: 1, platform: process.platform, arch: process.arch }));
    const success = await invoke();
    assert.deepEqual(JSON.parse(success.stdout), { profile: 'rust-codec-recipe-v1', storageAuthority: false });
    await writeFile(join(root, 'runtime-platform.json'), JSON.stringify({ version: 1, platform: process.platform, arch: process.arch === 'arm64' ? 'x64' : 'arm64' }));
    await assert.rejects(invoke(), error => error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' && /TLC309: This plugin runtime was built for.*current host/.test(error.stderr));
    await writeFile(join(root, 'runtime-platform.json'), JSON.stringify({ version: 2, platform: process.platform, arch: process.arch }));
    await assert.rejects(invoke(), error => error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' && /TLC309: Native plugin platform metadata is invalid/.test(error.stderr));
  } finally { await rm(root, { recursive: true, force: true }); }
});
