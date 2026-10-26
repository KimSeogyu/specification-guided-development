import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { generateSymbolicTypeScript } from '../src/backends/symbolic-typescript.js';
import { validateObservedResourceProtocol, type ResourceCoverage, type ResourceProtocolBindingV2 } from '../src/resource-protocol.js';
import { parseSanyXml } from '../src/sany-xml.js';
import { lowerSymbolicModel } from '../src/symbolic-lower.js';
import { stepSymbolic, type SymbolicState } from '../src/symbolic-semantics.js';
import { runSymbolicTlc } from '../src/symbolic-tlc.js';
import type { SymbolicInput, SymbolicModelV3 } from '../src/symbolic-types.js';

const execute = promisify(execFile);
const jar = process.env.TLA2TOOLS_JAR;
const compiler = resolve('node_modules/typescript/bin/tsc');
const authority = 'ResourceOutcomeAuthority';
const binding: ResourceProtocolBindingV2 = {
  version: 2,
  inputs: { resource: 'r', event: 'event' },
  variables: {
    phase: 'phase', selected: 'selected', loaded: 'loaded', prepared: 'prepared', attempted: 'attempted',
    loadOutcome: 'loadOutcome', decision: 'decision', coverage: 'coverage', attempts: 'attempts',
    replacements: 'replacements', effect: 'effect', writeOutcome: 'writeOutcome',
  },
};
type Input = readonly [resource: string, event: string];
type Sequence = readonly Input[];
type Config = { file: 'Fixture.cfg' | 'ResourceOutcomes.cfg'; coverage: ResourceCoverage };
const configurations: Config[] = [
  { file: 'Fixture.cfg', coverage: 'independent' },
  { file: 'ResourceOutcomes.cfg', coverage: 'required-before-write' },
];
const writeFinishes = [
  { event: 'finishok', phase: 'Done', outcome: 'Replaced', replacements: '1' },
  { event: 'finishnotreplaced', phase: 'Failed', outcome: 'NotReplaced', replacements: '0' },
  { event: 'finishindeterminate', phase: 'Failed', outcome: 'Indeterminate', replacements: '0' },
  { event: 'finishposterror', phase: 'Failed', outcome: 'Replaced', replacements: '1' },
];

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function observe(model: SymbolicModelV3, sequence: Sequence) {
  let values: SymbolicState = model.initial;
  let revision = 0n;
  const snapshot = () => ({ model: model.name, modelRevision: model.source.semanticSha256, revision: revision.toString(), values });
  const trace = sequence.map(([resource, event]) => {
    const before = snapshot();
    const input: SymbolicInput = { r: resource, event: { kind: 'string', value: event } };
    const result = stepSymbolic(model, values, input);
    if (result.kind !== 'accepted') return { ok: false, reason: result.kind, state: before };
    values = result.state;
    revision++;
    return { ok: true, action: result.action, before, after: snapshot(), updates: result.updates };
  });
  return { trace, state: snapshot() };
}

function prepareWrite(resource: string): Input[] {
  return ['select', 'present', 'preparewrite', 'coversuccess', 'attemptwrite'].map(event => [resource, event]);
}

function terminalSuffix(): Input[] {
  return [
    ...['finishok', 'finishnotreplaced', 'finishindeterminate', 'finishposterror', 'finisherror',
      'attemptwrite', 'attemptnoop', 'attemptrefused', 'repeat', 'select', 'present',
      'preparewrite', 'coversuccess'].map(event => ['selected', event] satisfies Input),
    ['other', 'idle'],
  ];
}

function sequences(): Sequence[] {
  const prefix: Input[] = [
    ['selected', 'present'], ['selected', 'select'], ['other', 'present'],
    ['selected', 'present'], ['selected', 'present'], ['other', 'preparewrite'],
    ['selected', 'preparewrite'], ['other', 'attemptwrite'],
    ['selected', 'coversuccess'], ['other', 'attemptwrite'], ['selected', 'attemptwrite'],
    ['selected', 'finisherror'],
  ];
  return [
    ...writeFinishes.map(({ event }) => [...prefix, ['other', event], ['selected', event], ...terminalSuffix()] satisfies Input[]),
    [...prefix, ['selected', 'repeat']],
    [['selected', 'select'], ['selected', 'notfound'], ['selected', 'preparenoop'],
      ['selected', 'attemptwrite'], ['selected', 'finishnotreplaced'], ['selected', 'attemptnoop'], ...terminalSuffix()],
    ...['finishok', 'finisherror'].map(event => [
      ['selected', 'select'], ['selected', 'present'], ['selected', 'preparerefused'],
      ['selected', 'attemptwrite'], ['selected', 'attemptrefused'], ['selected', 'finishposterror'],
      ['other', event], ['selected', event], ...terminalSuffix(),
    ] satisfies Input[]),
    ...['readerror', 'decodeerror'].map(event => [
      ['selected', 'select'], ['other', event], ['selected', event], ...terminalSuffix(),
    ] satisfies Input[]),
    [['selected', 'select'], ['selected', 'present'], ['selected', 'preparewrite'],
      ['selected', 'coverfailure'], ...terminalSuffix()],
    [['selected', 'select'], ['selected', 'present'], ['selected', 'preparewrite'],
      ['selected', 'attemptwrite']],
  ];
}

test('real controlled observed-write models preserve complete TypeScript traces and distinguish post-rename failure from no replacement', { skip: !jar, timeout: 300_000 }, async () => {
  assert.ok(jar);
  const root = await mkdtemp(join(tmpdir(), 'sgd-resource-outcome-backends-'));
  try {
    const source = join(root, 'source');
    await cp(resolve('tests/fixtures/resource-outcomes'), source, { recursive: true });
    const inputSequences = sequences();
    for (const configuration of configurations) {
      const run = await runSymbolicTlc({ spec: join(source, 'ResourceOutcomes.tla'), config: join(source, configuration.file), jar: resolve(jar) });
      assert.equal(run.evidence.kind, 'tlc-symbolic-completed');
      const model = lowerSymbolicModel({ name: 'ResourceOutcomes', semantic: parseSanyXml(run.xml), config: run.config, profile: 'protocol' });
      assert.equal(model.version, 3);
      const evidence = validateObservedResourceProtocol({ model, binding, coverage: configuration.coverage });
      assert.equal(evidence.profile, 'observed-write-v2');
      assert.equal(evidence.storageAuthority, false);
      assert.equal(model.initial.writeOutcome?.value, 'none');
      assert.deepEqual(model.inputs.map(input => [input.kind, input.parameter]), [['opaque', 'r'], ['finite', 'event']]);
      const events = model.inputs[1];
      assert.ok(events?.kind === 'finite');
      const directory = join(root, configuration.coverage);
      const typescript = join(directory, 'typescript');
      for (const file of generateSymbolicTypeScript({ model, className: authority })) await put(join(typescript, file.path), file.content);
      await put(join(typescript, 'traces.mjs'), `import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,rename,access} from 'node:fs/promises';
import {join} from 'node:path';
import {createResourceOutcomeAuthority} from './dist/machine.js';
const sequences=${JSON.stringify(inputSequences)};
const traces=sequences.map(sequence=>{const owner=createResourceOutcomeAuthority();return sequence.map(([resource,event])=>owner.send(resource,event));});
// The consumer supplies filesystem observations; no generated storage authority is claimed.
const root=process.argv[2];await mkdir(root,{recursive:true});
function prepare(resource){const owner=createResourceOutcomeAuthority();for(const event of ['select','present','preparewrite','coversuccess','attemptwrite'])assert.equal(owner.send(resource,event).ok,true);return owner;}
const selected=join(root,'preinvoke.bin');await writeFile(selected,'before');const before=[...await readFile(selected)];
const owner=prepare(selected);assert.equal(owner.send(selected,'finishnotreplaced').ok,true);const stopped=owner.read();
assert.equal(owner.send(selected,'attemptwrite').ok,false);assert.deepEqual(owner.read(),stopped);const after=[...await readFile(selected)];assert.deepEqual(after,before);
const replaced=join(root,'postrename.bin');const staging=join(root,'postrename.partial');await writeFile(replaced,'before');
const replacement=prepare(replaced);await writeFile(staging,'after');await rename(staging,replaced);
await assert.rejects(readFile(join(root,'missing-metadata')),{code:'ENOENT'});
assert.equal(replacement.send(replaced,'finishposterror').ok,true);const replacedState=replacement.read();
assert.equal(replacement.send(replaced,'attemptwrite').ok,false);assert.equal(replacement.send(replaced,'finishnotreplaced').ok,false);assert.deepEqual(replacement.read(),replacedState);
const replacedAfter=[...await readFile(replaced)];assert.deepEqual(replacedAfter,[...Buffer.from('after')]);await assert.rejects(access(staging),{code:'ENOENT'});
process.stdout.write(JSON.stringify({traces,physical:{preinvoke:{before,after,state:stopped},postrename:{before:[...Buffer.from('before')],after:replacedAfter,laterErrorKind:'ENOENT',stagingExists:false,state:replacedState}}}));\n`);
      await execute(process.execPath, [compiler, '-p', join(typescript, 'tsconfig.json')], { timeout: 30_000 });
      const physicalRoot = join(directory, 'physical');
      const ts = await execute(process.execPath, [join(typescript, 'traces.mjs'), physicalRoot], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      const oracle = inputSequences.map(sequence => observe(model, sequence).trace);
      const observedTypeScript: unknown = JSON.parse(ts.stdout);

      assert.deepEqual(observedTypeScript, {
        traces: oracle,
        physical: {
          preinvoke: {
            before: [...Buffer.from('before')], after: [...Buffer.from('before')],
            state: observe(model, [...prepareWrite(join(physicalRoot, 'preinvoke.bin')), [join(physicalRoot, 'preinvoke.bin'), 'finishnotreplaced']]).state,
          },
          postrename: {
            before: [...Buffer.from('before')], after: [...Buffer.from('after')], laterErrorKind: 'ENOENT', stagingExists: false,
            state: observe(model, [...prepareWrite(join(physicalRoot, 'postrename.bin')), [join(physicalRoot, 'postrename.bin'), 'finishposterror']]).state,
          },
        },
      });

      for (const outcome of writeFinishes) {
        const observed = observe(model, [...prepareWrite('selected'), ['selected', outcome.event]]);
        assert.equal(observed.state.values.phase?.value, outcome.phase);
        assert.equal(observed.state.values.writeOutcome?.value, outcome.outcome);
        assert.equal(observed.state.values.replacements?.value, outcome.replacements);
        assert.equal(observed.state.values.attempts?.value, '1');
      }
      const pending = observe(model, prepareWrite('selected'));
      assert.equal(pending.state.values.writeOutcome?.value, 'Pending');
      assert.equal(pending.state.values.phase?.value, 'Attempted');
      for (const [decision, attempt, finish] of [
        ['preparenoop', 'attemptnoop', 'idle'],
        ['preparerefused', 'attemptrefused', 'finishok'],
        ['preparerefused', 'attemptrefused', 'finisherror'],
      ] satisfies [string, string, string][]) {
        const observed = observe(model, [
          ['selected', 'select'], ['selected', 'present'], ['selected', decision],
          ['selected', attempt], ['selected', finish],
        ]);
        assert.equal(observed.state.values.writeOutcome?.value, 'none');
        assert.equal(observed.state.values.replacements?.value, '0');
      }
      const uncovered = observe(model, [['selected', 'select'], ['selected', 'present'], ['selected', 'preparewrite'], ['selected', 'attemptwrite']]);
      assert.equal(uncovered.trace.at(-1)?.ok, configuration.coverage === 'independent');
      for (const trace of oracle.slice(0, writeFinishes.length)) {
        const suffix = trace.slice(-terminalSuffix().length);
        assert.ok(suffix.slice(0, -1).every(receipt => receipt.ok === false));
        assert.equal(suffix.at(-1)?.ok, true);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
