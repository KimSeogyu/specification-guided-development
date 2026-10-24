import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { buildContractComparison } from '../src/contract-check.js';

const jar = process.env.TLA2TOOLS_JAR ? resolve(process.env.TLA2TOOLS_JAR) : undefined;
const upperId = `Payload${'X'.repeat(128)}`;
const lowerId = upperId.toLowerCase();
const declaration = String.raw`---- MODULE SystemContracts ----
SGDContracts == [version |-> 1, scope |-> "model-composition",
  contracts |-> {"${upperId}", "${lowerId}"},
  relations |-> <<[id |-> "PayloadErasure", kind |-> "enabled-input-erasure",
    upper |-> "${upperId}", lower |-> "${lowerId}",
    variables |-> [phase |-> "phase", stored |-> "stored", rejected |-> "rejected"],
    inputs |-> [v |-> "v"],
    actions |-> [Insert |-> "Insert", Same |-> "Same", Clash |-> "Clash"]]>>,
  native |-> <<>>]
====
`;
const SourceArchive = z.object({
  schema: z.literal('sgd-captured-sources-v1'),
  origin: z.discriminatedUnion('base', [
    z.object({ source: z.enum(['baseline', 'candidate']), rootProject: z.string(), base: z.literal('root-project-directory') }).strict(),
    z.object({ source: z.enum(['baseline', 'candidate']), rootProject: z.string(), base: z.literal('leaf-project-directory'),
      contract: z.string(), project: z.string(), projectKind: z.enum(['project-relative', 'configured-absolute']) }).strict(),
  ]),
  files: z.array(z.object({
    path: z.string(), pathKind: z.enum(['project-relative', 'configured-absolute']),
    kind: z.enum(['project', 'configuration', 'module', 'root-project', 'binding', 'metadata']),
    bytesBase64: z.string(),
  }).strict()).min(1),
}).strict();
const EvidenceIndex = z.object({
  schema: z.literal('sgd-contract-evidence-index-v1'),
  scope: z.literal('model-composition-only'), preservationGate: z.literal('not-established'),
  independentlySelectedBaseline: z.literal('not-established'),
  sourceArchives: z.array(z.object({ source: z.enum(['baseline', 'candidate']), path: z.string() }).strict()),
  metadata: z.array(z.object({ source: z.enum(['baseline', 'candidate']), path: z.string() }).strict()),
  contracts: z.array(z.object({ source: z.enum(['baseline', 'candidate']), id: z.string(), path: z.string() }).strict()),
  logs: z.array(z.string()),
}).strict();

async function snapshot(root: string, prefix = ''): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) for (const [path, bytes] of await snapshot(join(root, entry.name), `${name}/`)) files.set(path, bytes);
    else files.set(name, await readFile(join(root, entry.name)));
  }
  return files;
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sgd-contract-publication-')));
  const original = new Map<string, Buffer>();
  try {
    const baseline = join(root, 'baseline');
    const candidate = join(root, 'candidate');
    for (const directory of [baseline, candidate]) {
      await cp(resolve('examples/fact-merge'), join(directory, 'payload'), { recursive: true });
      await cp(resolve('examples/fact-envelope'), join(directory, 'envelope'), { recursive: true });
      await writeFile(join(directory, 'SystemContracts.tla'), declaration);
      await writeFile(join(directory, 'bindings.json'), JSON.stringify({ version: 1, bindings: {} }));
      await writeFile(join(directory, 'system.json'), JSON.stringify({ version: 1, profile: 'contract-system',
        root: { spec: 'SystemContracts.tla', operator: 'SGDContracts' },
        models: { [upperId]: { project: 'payload/project.json' }, [lowerId]: { project: 'envelope/project.json' } },
        bindings: 'bindings.json' }));
      for (const path of ['SystemContracts.tla', 'bindings.json', 'system.json',
        'payload/project.json', 'payload/ManifestWrite.tla', 'payload/ManifestWrite.cfg',
        'envelope/project.json', 'envelope/FactWriteEnvelope.tla', 'envelope/FactWriteEnvelope.cfg']) {
        const absolute = join(directory, path);
        original.set(absolute, await readFile(absolute));
      }
    }
    return { root, original, out: join(root, 'comparison'), args: { baseline: join(baseline, 'system.json'), project: join(candidate, 'system.json') } };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

test('public report data cannot publish a managed contract comparison without controlled source inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sgd-contract-report-only-'));
  const out = join(root, 'uncreated');
  try {
    const report = { kind: 'controlled-contract-comparison', scope: 'model-composition-only',
      preservationGate: 'not-established', independentlySelectedBaseline: 'not-established', acceptance: [], composition: [] };
    await assert.rejects(async () => Reflect.apply(buildContractComparison, undefined, [{ out, report, verified: true }]));
    await assert.rejects(readdir(out), { code: 'ENOENT' });
    await assert.rejects(async () => Reflect.apply(buildContractComparison, undefined, [{ out, project: report, baseline: report, jar: 'not-a-jar' }]));
    await assert.rejects(readdir(out), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real managed comparison retains both controlled source sets and checks stable evidence without refreshing published logs', { skip: !jar, timeout: 300_000 }, async () => {
  assert.ok(jar);
  const data = await fixture();
  try {
    const input = { ...data.args, jar, out: data.out };
    const generated = await buildContractComparison(input);
    assert.equal(generated.schema, 'sgd-contract-comparison-summary-v1');
    assert.equal(generated.kind, 'managed-contract-comparison');
    assert.equal(generated.operation, 'generate');
    assert.equal(generated.scope, 'model-composition-only');
    assert.equal(generated.preservationGate, 'not-established');
    assert.equal(generated.independentlySelectedBaseline, 'not-established');
    assert.equal(generated.output.directory, data.out);
    assert.deepEqual(generated.output.entries, ['comparison.json', 'contract-graph.json', 'obligations.json', 'evidence-index.json']);
    assert.equal(generated.verification.invocation, 'completed');
    assert.equal(generated.verification.output, 'generated');
    assert.equal(generated.verification.freshInvocationLogRetained, true);
    assert.equal(generated.evidence.index, join(data.out, 'evidence-index.json'));
    assert.deepEqual(generated.evidence.contractCounts, { baseline: 2, candidate: 2 });
    assert.equal(Reflect.has(generated.evidence, 'contracts'), false);
    assert.equal(generated.evidence.logs.freshness, 'current-invocation');
    assert.equal(generated.evidence.logs.freshInvocationLogRetained, true);
    const published = await snapshot(data.out);
    const index = EvidenceIndex.parse(JSON.parse(await readFile(join(data.out, 'evidence-index.json'), 'utf8')));
    assert.deepEqual(index.metadata.map(entry => entry.source).sort(), ['baseline', 'candidate']);
    assert.deepEqual(index.sourceArchives.map(entry => entry.source).sort(), ['baseline', 'candidate']);
    assert.deepEqual(index.contracts.map(entry => `${entry.source}/${entry.id}`).sort(), [`baseline/${upperId}`, `baseline/${lowerId}`, `candidate/${upperId}`, `candidate/${lowerId}`].sort());
    for (const path of [...index.sourceArchives.map(entry => entry.path), ...index.metadata.map(entry => entry.path), ...index.contracts.map(entry => entry.path), ...index.logs]) {
      assert.equal(isAbsolute(path), false);
      assert.ok(!path.split('/').includes('..'));
      assert.ok(published.has(path), `index path ${path} must name an actual managed artifact`);
    }
    for (const source of ['baseline', 'candidate']) {
      const metadata = z.object({ models: z.object({ source: z.string(), wrapper: z.string(), config: z.string() }).strict() })
        .parse(JSON.parse(await readFile(join(data.out, `metadata/${source}/verification.json`), 'utf8')));
      assert.deepEqual(metadata.models, { source: 'models/SystemContracts.tla', wrapper: 'models/SgdContractMetadata.tla', config: 'models/SgdContractMetadata.cfg' });
      for (const name of [...Object.values(metadata.models), 'semantic.xml', 'model.dot', 'tlc.log', 'verification.json', 'sources.json']) {
        assert.ok(published.has(`metadata/${source}/${name}`), `${source} metadata must retain ${name}`);
      }
      assert.equal(published.get(`metadata/${source}/${metadata.models.source}`)?.toString('utf8'), declaration);
      assert.match(published.get(`metadata/${source}/${metadata.models.wrapper}`)?.toString('utf8') ?? '', /MODULE SgdContractMetadata/);
      assert.match(published.get(`metadata/${source}/${metadata.models.wrapper}`)?.toString('utf8') ?? '', /EXTENDS SystemContracts/);
      assert.match(published.get(`metadata/${source}/${metadata.models.config}`)?.toString('utf8') ?? '', /CHECK_DEADLOCK FALSE/);
      const entries = index.contracts.filter(entry => entry.source === source);
      assert.equal(new Set(entries.map(entry => posix.dirname(entry.path).toLowerCase())).size, 2, 'case-distinct logical IDs need distinct targets on case-insensitive filesystems');
      for (const entry of entries) {
        const leaf = posix.dirname(entry.path);
        const encoded = posix.basename(leaf);
        assert.match(encoded, /^c-[0-9]{3}$/);
        assert.equal(encoded, `c-${String(entries.map(value => value.id).sort().indexOf(entry.id)).padStart(3, '0')}`);
        for (const name of ['sources.json', 'symbolic-model.json', 'automaton.json', 'orbit-proof.json', 'input-verification.json', 'input-oracle.dot', 'input-oracle.log', 'semantic.xml', 'model.dot', 'tlc.log', 'verification.json']) {
          assert.ok(published.has(`${leaf}/${name}`), `${source} ${entry.id} must retain ${name}`);
        }
      }
    }
    const archivedPaths = new Set<string>();
    for (const [path, bytes] of published) if (path.endsWith('/sources.json')) {
      const archive = SourceArchive.parse(JSON.parse(bytes.toString('utf8')));
      assert.equal(archive.origin.rootProject, 'system.json');
      const roleRoot = join(data.root, archive.origin.source);
      const archiveBase = archive.origin.base === 'leaf-project-directory'
        ? dirname(resolve(roleRoot, archive.origin.project)) : roleRoot;
      if (archive.origin.base === 'leaf-project-directory') assert.equal(archive.origin.projectKind, 'project-relative');
      for (const file of archive.files) {
        assert.equal(file.pathKind, 'project-relative');
        assert.equal(isAbsolute(file.path), false);
        const sourcePath = resolve(archiveBase, file.path);
        const expected = data.original.get(sourcePath);
        assert.ok(expected, `source archive must identify an original captured input: ${sourcePath}`);
        assert.deepEqual(Buffer.from(file.bytesBase64, 'base64'), expected);
        archivedPaths.add(sourcePath);
      }
    }
    assert.deepEqual(archivedPaths, new Set(data.original.keys()), 'archives must retain both root/binding/metadata and leaf source sets');
    assert.ok(![...published.keys()].some(path => /\.(?:jar|class)$/i.test(path)), 'the output must not copy the tool JAR');
    for (const [path, bytes] of published) assert.equal(bytes.toString('utf8').includes(data.root), false, `${path} must use portable origins instead of the fixture's absolute root`);

    const log = index.logs[0];
    assert.ok(log);
    const retainedLog = Buffer.from('retained bytes from the last published run\n');
    await writeFile(join(data.out, log), retainedLog);
    const retained = await snapshot(data.out);
    const checked = await buildContractComparison({ ...input, check: true });
    assert.equal(checked.operation, 'check');
    assert.equal(checked.verification.output, 'checked');
    assert.equal(checked.verification.freshInvocationLogRetained, false);
    assert.equal(checked.evidence.logs.freshness, 'retained-output');
    assert.equal(checked.evidence.logs.freshInvocationLogRetained, false);
    assert.deepEqual(await snapshot(data.out), retained, 'check must retain prior output bytes, including different actual log bytes');

    const movedParent = await realpath(await mkdtemp(join(tmpdir(), 'sgd-contract-relocation-')));
    try {
      const movedRoot = join(movedParent, 'relocated');
      await cp(data.root, movedRoot, { recursive: true });
      const movedOut = join(movedRoot, 'comparison');
      const copied = await snapshot(movedOut);
      assert.deepEqual(copied, retained);
      const moved = await buildContractComparison({ baseline: join(movedRoot, 'baseline/system.json'), project: join(movedRoot, 'candidate/system.json'), jar, out: movedOut, check: true });
      assert.equal(moved.operation, 'check');
      assert.equal(moved.output.directory, movedOut);
      assert.deepEqual(moved.evidence.contractCounts, { baseline: 2, candidate: 2 });
      assert.equal(moved.evidence.logs.freshness, 'retained-output');
      assert.equal(moved.evidence.logs.freshInvocationLogRetained, false);
      assert.deepEqual(await snapshot(movedOut), copied, 'moving the input trees and published artifacts together must preserve check freshness and retained logs');
    } finally { await rm(movedParent, { recursive: true, force: true }); }

    const payload = index.contracts.find(entry => entry.source === 'candidate' && entry.id === upperId);
    assert.ok(payload);
    for (const path of ['contract-graph.json', posix.join(posix.dirname(payload.path), 'sources.json')]) {
      const original = await readFile(join(data.out, path));
      try {
        const archive = path.endsWith('/sources.json') ? SourceArchive.parse(JSON.parse(original.toString('utf8'))) : null;
        const changed = archive
          ? JSON.stringify({ ...archive, files: archive.files.map((file, index) => index === 0 ? { ...file, bytesBase64: Buffer.from('changed captured source').toString('base64') } : file) })
          : original.toString('utf8').replaceAll('PayloadErasure', 'ChangedErasure');
        assert.notEqual(changed, original.toString('utf8'));
        await writeFile(join(data.out, path), changed);
        const before = await snapshot(data.out);
        await assert.rejects(buildContractComparison({ ...input, check: true }), /TLC104/);
        assert.deepEqual(await snapshot(data.out), before, `a stale ${path} refusal must not refresh artifacts`);
      } finally { await writeFile(join(data.out, path), original); }
    }
    await rm(join(data.out, log));
    const missingLog = await snapshot(data.out);
    await assert.rejects(buildContractComparison({ ...input, check: true }), /TLC104/);
    assert.deepEqual(await snapshot(data.out), missingLog, 'a missing volatile log is still required and must not be republished by check');
  } finally { await rm(data.root, { recursive: true, force: true }); }
});
