import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { buildProject, compileProject } from '../src/compiler.js';
import { RowBindingPlanSchema, RowBindingSchema, type RowProject } from '../src/row-binding-types.js';
import { verifyRowSourcesUnchanged } from '../src/row-binding.js';
import { SymbolicModelV2Schema } from '../src/symbolic-types.js';
import { SymbolicWitnessSchema } from '../src/symbolic-witness.js';
import { generateVisualization, loadAutomaton } from '../src/visualize.js';

const execute = promisify(execFile);
const jar = process.env.TLA2TOOLS_JAR ? resolve(process.env.TLA2TOOLS_JAR) : undefined;
const fixtureRoot = resolve('tests/fixtures/rust-facts');
const tsc = resolve('node_modules/typescript/bin/tsc');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sgd-row-compiler-'));
  const application = join(root, 'application'); const model = join(root, 'model'); const out = join(application, 'generated');
  await cp(join(fixtureRoot, 'parangsae'), application, { recursive: true });
  await mkdir(model);
  for (const name of ['FactWriteEnvelope.tla', 'FactWriteEnvelope.cfg']) await cp(resolve('examples/fact-envelope', name), join(model, name));
  const row = RowBindingSchema.parse(JSON.parse(await readFile(join(fixtureRoot, 'binding.json'), 'utf8')));
  const project: RowProject = { version: 5, profile: 'row-owned', name: 'FactWriteEnvelope', spec: 'FactWriteEnvelope.tla', config: 'FactWriteEnvelope.cfg',
    application: '../application', targets: ['typescript', 'rust'], binding: { className: 'FactAuthority', row, rustCrateMode: 'standalone' } };
  const projectPath = join(model, 'project.json'); await writeFile(projectPath, JSON.stringify(project));
  return { root, application, model, out, project, projectPath };
}

test('v5 imported DOT cannot create a source-bound row authority', async () => {
  const data = await fixture();
  try {
    await assert.rejects(compileProject({ project: data.projectPath, dot: join(data.root, 'absent.dot'), out: data.out }), /TLC206: imported DOT cannot generate row-owned authority/);
    await assert.rejects(access(data.out), { code: 'ENOENT' });
  } finally { await rm(data.root, { recursive: true, force: true }); }
});

test('v5 refuses legacy outcome permutations before TLC, source analysis, or output creation', async () => {
  const data = await fixture();
  try {
    await writeFile(data.projectPath, JSON.stringify({ ...data.project, binding: { ...data.project.binding,
      row: { ...data.project.binding.row, model: { ...data.project.binding.row.model, outcomes: { Insert: 'Clash', Same: 'Insert', Clash: 'Same' } } },
    } }));
    await assert.rejects(buildProject({ project: data.projectPath, jar: join(data.root, 'absent.jar'), out: data.out }), /outcomes/);
    await assert.rejects(access(data.out), { code: 'ENOENT' });
  } finally { await rm(data.root, { recursive: true, force: true }); }
});

test('real v5 source build preserves all native fields, wrapper codecs, finite classes, source scope, and deterministic outputs', { skip: !jar, timeout: 240_000 }, async () => {
  assert.ok(jar); const data = await fixture();
  try {
    const input = { project: data.projectPath, jar, out: data.out };
    const witness = SymbolicWitnessSchema.parse(await buildProject(input));
    const plan = RowBindingPlanSchema.parse(JSON.parse(await readFile(join(data.out, 'row-binding-plan.json'), 'utf8')));
    assert.deepEqual(plan.facts.map(fact => [fact.name, fact.fields.length]), [['KlineFact', 18], ['FundingFact', 9], ['MetricsFact', 13], ['BookFact', 10]]);
    const kline = plan.facts.find(fact => fact.name === 'KlineFact'); assert.ok(kline);
    assert.deepEqual(kline.fields.find(field => field.name === 'schema_version'), { name: 'schema_version', rustType: 'u32', codec: { kind: 'u32', getters: [] }, payload: true, provenance: true, classes: [[1, 2]] });
    assert.deepEqual(kline.fields.find(field => field.name === 'received_ts')?.codec, { kind: 'i64', getters: ['micros', 'micros'] });
    assert.deepEqual(kline.fields.find(field => field.name === 'symbol')?.codec, { kind: 'string', getters: ['as_str'] });
    assert.deepEqual(kline.fields.find(field => field.name === 'tick_domain')?.codec, { kind: 'enum', getters: [], rustPath: 'crate::vision::TickDomain', variants: ['Price', 'Ratio'] });
    assert.ok(plan.facts.every(fact => fact.fields.some(field => field.name === 'received_ts' && !field.payload && field.provenance)));
    assert.ok(plan.sources.some(source => source.path === 'crates/core/src/timestamps.rs'));
    assert.ok(plan.sources.every(source => !source.path.startsWith('generated/')));
    const receiptBytes = await readFile(join(data.out, 'verification.json'), 'utf8');
    const receipt = z.record(z.string(), z.unknown()).parse(JSON.parse(receiptBytes));
    assert.equal(receipt.generation, 'whole-row-authority');
    const binding = z.object({ profile: z.literal('rust-whole-row-v1'), sourceScope: z.literal('production-library-and-audited-local-type-closure'), sources: z.array(z.object({ path: z.string(), sha256: z.string() })), formatter: z.object({ profile: z.literal('rustfmt-2021-v1'), configSha256: z.string() }) }).parse(receipt.rowBinding);
    assert.deepEqual(binding.sources, plan.sources); assert.match(z.string().parse(receipt.formatterVersion), /^rustfmt /);
    const oracle = z.object({ checkedCases: z.number(), acceptedCases: z.number(), disabledCases: z.number() }).parse(JSON.parse(await readFile(join(data.out, 'input-verification.json'), 'utf8')));
    assert.equal(oracle.checkedCases, witness.nodes.length * 4); assert.equal(oracle.acceptedCases, oracle.checkedCases); assert.equal(oracle.disabledCases, 0);
    const program = SymbolicModelV2Schema.parse(JSON.parse(await readFile(join(data.out, 'symbolic-model.json'), 'utf8')));
    const view = generateVisualization([await loadAutomaton(join(data.out, 'automaton.json')), program]);
    const html = view.find(file => file.path === 'index.html')?.content ?? '';
    assert.match(html, /storedProvenance/); assert.match(html, /provenance\[Receipts\]/);
    assert.deepEqual(JSON.parse(view.find(file => file.path === 'models.json')?.content ?? 'null'), [witness, program]);
    const inventory = z.object({ version: z.literal(1), files: z.array(z.string()) }).parse(JSON.parse(await readFile(join(data.out, '.sgd-generated.json'), 'utf8')));
    const before = await Promise.all(inventory.files.map(file => readFile(join(data.out, file))));
    await buildProject({ ...input, check: true });
    assert.deepEqual(await Promise.all(inventory.files.map(file => readFile(join(data.out, file)))), before);
    await writeFile(join(data.out, 'verification.json'), JSON.stringify({ ...receipt, formatterVersion: 'rustfmt informational-version-from-another-host' }));
    await buildProject({ ...input, check: true });
    const receiptBinding = z.record(z.string(), z.unknown()).parse(receipt.rowBinding);
    for (const formatter of [{ ...binding.formatter, profile: 'changed-style' }, { ...binding.formatter, configSha256: '0'.repeat(64) }]) {
      await writeFile(join(data.out, 'verification.json'), JSON.stringify({ ...receipt, rowBinding: { ...receiptBinding, formatter } }));
      await assert.rejects(buildProject({ ...input, check: true }), /TLC104: stale receipt field rowBinding/);
    }
    await writeFile(join(data.out, 'verification.json'), receiptBytes);
    const rowSource = join(data.application, 'crates/collector/src/vision/rows.rs'); const source = await readFile(rowSource, 'utf8');
    await writeFile(rowSource, source.replace('pub interval_us: i64,', 'pub interval_us: i64,\n    pub new_payload: i64,'));
    await assert.rejects(verifyRowSourcesUnchanged(data.application, plan), /TLC305: source changed during binding generation/);
    await assert.rejects(buildProject(input), /TLC305.*new_payload.*omitted/);
    assert.deepEqual(await Promise.all(inventory.files.map(file => readFile(join(data.out, file)))), before, 'a refused source binding must not publish partial output');
    await writeFile(rowSource, source.replace('self.count == other.count', 'self.count != other.count'));
    await assert.rejects(buildProject(input), /TLC305.*unsupported boolean operator/);
    await writeFile(rowSource, source.replace('&& self.event_ts == other.event_ts', '&& self.received_ts == other.received_ts\n            && self.event_ts == other.event_ts'));
    await assert.rejects(buildProject(input), /TLC305.*metadata must name an existing field omitted by native Eq/);
    await writeFile(rowSource, source);
    await writeFile(join(data.out, 'rust/adapter.rs'), '// direct generated policy edit\n');
    await assert.rejects(buildProject({ ...input, check: true }), /TLC104: stale generated file rust\/adapter.rs/);
    await buildProject(input);
    await buildProject({ ...input, modelOnly: true });
    for (const file of [...inventory.files.filter(file => file.startsWith('typescript/') || file.startsWith('rust/')), 'row-binding-plan.json', 'input-verification.json', 'orbit-proof.json']) await assert.rejects(access(join(data.out, file)), { code: 'ENOENT' });
    const modelOnly = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(join(data.out, 'verification.json'), 'utf8')));
    assert.equal(modelOnly.generation, 'model-only'); assert.equal(modelOnly.rowBinding, null);
  } finally { await rm(data.root, { recursive: true, force: true }); }
});

const portableRunner = `import assert from 'node:assert/strict';
const module = await import(process.argv[2]);
const schemaEqual = process.argv[3] === 'equivalent';
const raw = { symbol:'BTCUSDT', interval_us:60000000n, open_time:100n, close_time:59999100n, open_ticks:42n, high_ticks:42n, low_ticks:42n, close_ticks:42n, volume:1n, quote_volume:1n, count:1n, taker_buy_volume:1n, taker_buy_quote_volume:1n, event_ts:59999100n, available_ts:60000100n, received_ts:1n, schema_version:1, tick_domain:'Price' };
const source = {...raw}; const first = module.createKlineFactRow(source); source.received_ts = 999n;
const owner = module.createKlineFactOwner();
const inputs = [first, module.createKlineFactRow({...raw,schema_version:2,received_ts:2n}), module.createKlineFactRow({...raw,open_ticks:43n,schema_version:2,received_ts:3n}), module.createKlineFactRow({...raw,open_ticks:43n,schema_version:2,received_ts:4n}), module.createKlineFactRow({...raw,schema_version:2,received_ts:5n}), module.createKlineFactRow({...raw,schema_version:99,received_ts:6n})];
const trace = inputs.map(row => { const result=owner.write(row); assert.equal(result.ok,true); return {effect:result.effect,observation:owner.read()}; });
assert.deepEqual(trace.map(step=>step.effect),['Insert',schemaEqual?'Same':'Clash','Clash','Clash',schemaEqual?'Same':'Clash','Clash']);
for(const step of trace){assert.equal(step.observation.stored.received_ts,1n);assert.equal(step.observation.stored.schema_version,1);assert.equal(step.observation.stored.open_ticks,42n);assert.equal(Object.keys(step.observation.stored).length,18);}
if(schemaEqual){assert.equal(trace[4].observation.rejected.received_ts,4n);assert.equal(trace[4].observation.rejected.open_ticks,43n);}
assert.equal(trace[5].observation.rejected.schema_version,99);assert.equal(trace[5].observation.rejected.received_ts,6n);
const before=owner.read();for(const forged of [raw,{...first},null,'Same'])assert.equal(owner.write(forged).reason,'invalid-row');assert.deepEqual(owner.read(),before);
assert.equal(Reflect.set(first,'received_ts',1000n),false);
assert.throws(()=>module.createKlineFactRow({...raw,count:1}),/ROW303/);
assert.throws(()=>module.createKlineFactRow({...raw,missing:'unexpected'}),/ROW303/);
const accessor={...raw};Object.defineProperty(accessor,'received_ts',{enumerable:true,get(){throw new Error('must not invoke accessor');}});assert.throws(()=>module.createKlineFactRow(accessor),/ROW303.*accessors/);
process.stdout.write(JSON.stringify(trace,(_name,value)=>typeof value==='bigint'?value.toString():value));
`;

test('real Rust equality source controls portable TS7 complete-row behavior and changes through regeneration', { skip: !jar, timeout: 240_000 }, async () => {
  assert.ok(jar); const data = await fixture();
  try {
    const input = { project: data.projectPath, jar, out: data.out }; await buildProject(input);
    const runner = join(data.root, 'run.mjs'); await writeFile(runner, portableRunner);
    async function replay(equality: string) {
      await execute(process.execPath, [tsc, '-p', join(data.out, 'typescript/tsconfig.json')], { timeout: 30_000 });
      const output = await execute(process.execPath, [runner, pathToFileURL(join(data.out, 'typescript/dist/machine.js')).href, equality], { timeout: 30_000 });
      return z.array(z.object({ effect: z.string(), observation: z.record(z.string(), z.unknown()) })).parse(JSON.parse(output.stdout));
    }
    const equivalent = await replay('equivalent'); assert.equal(equivalent[1]?.effect, 'Same');
    await cp(join(fixtureRoot, 'rows-main.rs'), join(data.application, 'crates/collector/src/vision/rows.rs'));
    await assert.rejects(buildProject({ ...input, check: true }), /TLC104/);
    await buildProject(input);
    const strict = await replay('strict'); assert.equal(strict[1]?.effect, 'Clash');
    const plan = RowBindingPlanSchema.parse(JSON.parse(await readFile(join(data.out, 'row-binding-plan.json'), 'utf8')));
    assert.ok(plan.facts[0]?.fields.find(field => field.name === 'schema_version')?.classes === undefined);
    await buildProject({ ...input, check: true });
  } finally { await rm(data.root, { recursive: true, force: true }); }
});
