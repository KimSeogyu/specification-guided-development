import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { generateSymbolicRust } from '../src/backends/symbolic-rust.js';
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

function rustConsumer(eventMatch: string): string {
  return `#![forbid(unsafe_code)]
use authority::{ResourceOutcomeAuthority, ResourceOutcomeAuthorityInput1};
use serde_json::{json, Value};
use std::path::Path;

fn event(value: &str) -> ResourceOutcomeAuthorityInput1 {
    match value { ${eventMatch}, _ => panic!("event outside the controlled fixture") }
}

fn prepare_write(resource: &str) -> ResourceOutcomeAuthority {
    let mut owner = ResourceOutcomeAuthority::new();
    for name in ["select", "present", "preparewrite", "coversuccess", "attemptwrite"] {
        owner.send(resource, event(name)).unwrap();
    }
    owner
}

// This test consumer supplies observations. It is not a generated filesystem
// adapter, a source-coverage gate, or evidence of application storage authority.
fn physical_observations(root: &Path) -> Value {
    std::fs::create_dir_all(root).unwrap();
    let selected = root.join("preinvoke.bin");
    let resource = selected.to_str().unwrap();
    std::fs::write(&selected, b"before").unwrap();
    let before = std::fs::read(&selected).unwrap();
    let mut owner = prepare_write(resource);
    let preinvoke: Result<(), &str> = Err("deliberate validation failure before writer invocation");
    assert!(preinvoke.is_err());
    owner.send(resource, event("finishnotreplaced")).unwrap();
    let stopped = owner.read();
    assert!(owner.send(resource, event("attemptwrite")).is_err());
    assert_eq!(owner.read(), stopped);
    let preinvoke_after = std::fs::read(&selected).unwrap();
    assert_eq!(preinvoke_after, before);

    let replaced = root.join("postrename.bin");
    let staging = root.join("postrename.partial");
    let replaced_resource = replaced.to_str().unwrap();
    std::fs::write(&replaced, b"before").unwrap();
    let mut replaced_owner = prepare_write(replaced_resource);
    std::fs::write(&staging, b"after").unwrap();
    std::fs::rename(&staging, &replaced).unwrap();
    let later_error = std::fs::read(root.join("missing-metadata")).unwrap_err();
    assert_eq!(later_error.kind(), std::io::ErrorKind::NotFound);
    replaced_owner.send(replaced_resource, event("finishposterror")).unwrap();
    let replaced_state = replaced_owner.read();
    assert!(replaced_owner.send(replaced_resource, event("attemptwrite")).is_err());
    assert!(replaced_owner.send(replaced_resource, event("finishnotreplaced")).is_err());
    assert_eq!(replaced_owner.read(), replaced_state);
    let replaced_after = std::fs::read(&replaced).unwrap();
    assert_eq!(replaced_after, b"after");
    assert!(!staging.exists());
    json!({
        "preinvoke": { "before": before, "after": preinvoke_after, "state": stopped },
        "postrename": { "before": b"before".to_vec(), "after": replaced_after,
            "laterErrorKind": format!("{:?}", later_error.kind()), "stagingExists": staging.exists(),
            "state": replaced_state }
    })
}

fn main() {
    let request = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/request.json")).unwrap();
    let sequences: Vec<Vec<(String, String)>> = serde_json::from_str(&request).unwrap();
    let mut traces = Vec::new();
    for sequence in sequences {
        let mut owner = ResourceOutcomeAuthority::new();
        let mut trace = Vec::new();
        for (resource, name) in sequence {
            let (ok, mut receipt) = match owner.send(&resource, event(&name)) {
                Ok(receipt) => (true, serde_json::to_value(receipt).unwrap()),
                Err(error) => (false, serde_json::to_value(error).unwrap()),
            };
            receipt.as_object_mut().unwrap().insert("ok".into(), json!(ok));
            trace.push(receipt);
        }
        traces.push(trace);
    }
    let physical = physical_observations(Path::new(&std::env::args().nth(1).unwrap()));
    println!("{}", json!({ "traces": traces, "physical": physical }));
}
`;
}

test('real controlled observed-write models preserve complete TS7/Rust traces and distinguish post-rename failure from no replacement', { skip: !jar, timeout: 300_000 }, async () => {
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
      const eventMatch = events.values.map((value, index) => {
        assert.equal(value.kind, 'string');
        return `${JSON.stringify(value.value)} => ${authority}Input1::Choice${index}`;
      }).join(', ');

      const directory = join(root, configuration.coverage);
      const typescript = join(directory, 'typescript');
      const rust = join(directory, 'rust');
      const consumer = join(directory, 'consumer');
      const target = join(root, 'target');
      for (const file of generateSymbolicTypeScript({ model, className: authority })) await put(join(typescript, file.path), file.content);
      const rustFiles = generateSymbolicRust({ model, className: authority });
      for (const file of rustFiles) await put(join(rust, file.path), file.content);
      const manifest = rustFiles.find(file => file.path === 'Cargo.toml');
      assert.ok(manifest);
      const packageName = /^name = "([a-z0-9-]+)"$/m.exec(manifest.content)?.[1];
      assert.ok(packageName);
      await put(join(consumer, 'Cargo.toml'), `[package]\nname = "resource-outcome-consumer"\nversion = "0.1.0"\nedition = "2021"\n\n[workspace]\n\n[dependencies]\nauthority = { package = "${packageName}", path = "../rust" }\nserde_json = "=1.0.154"\n`);
      await put(join(consumer, 'src/main.rs'), rustConsumer(eventMatch));
      await put(join(consumer, 'request.json'), JSON.stringify(inputSequences));
      await put(join(typescript, 'traces.mjs'), `import {createResourceOutcomeAuthority} from './dist/machine.js';
const sequences=${JSON.stringify(inputSequences)};
const traces=sequences.map(sequence=>{const owner=createResourceOutcomeAuthority();return sequence.map(([resource,event])=>owner.send(resource,event));});
process.stdout.write(JSON.stringify(traces));\n`);
      await execute(process.execPath, [compiler, '-p', join(typescript, 'tsconfig.json')], { timeout: 30_000 });
      await execute('cargo', ['fetch', '--quiet', '--manifest-path', join(consumer, 'Cargo.toml')], { timeout: 180_000 });
      const physicalRoot = join(directory, 'physical');
      const ts = await execute(process.execPath, [join(typescript, 'traces.mjs')], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      const native = await execute('cargo', ['run', '--offline', '--locked', '--quiet', '--manifest-path', join(consumer, 'Cargo.toml'), '--target-dir', target, '--', physicalRoot], { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
      const oracle = inputSequences.map(sequence => observe(model, sequence).trace);
      const observedTypeScript: unknown = JSON.parse(ts.stdout);
      const observedRust: unknown = JSON.parse(native.stdout);
      assert.deepEqual(observedTypeScript, oracle);
      assert.deepEqual(observedRust, {
        traces: oracle,
        physical: {
          preinvoke: {
            before: [...Buffer.from('before')], after: [...Buffer.from('before')],
            state: observe(model, [...prepareWrite(join(physicalRoot, 'preinvoke.bin')), [join(physicalRoot, 'preinvoke.bin'), 'finishnotreplaced']]).state,
          },
          postrename: {
            before: [...Buffer.from('before')], after: [...Buffer.from('after')], laterErrorKind: 'NotFound', stagingExists: false,
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
