import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  captureSymbolicProject, inspectSymbolicCapture, inspectSymbolicProject,
  readSymbolicCaptureForCompiler, recheckSymbolicCapture, verifyCapturedErasure,
} from '../src/symbolic-capture.js';

const jar = process.env.TLA2TOOLS_JAR ? resolve(process.env.TLA2TOOLS_JAR) : undefined;
const binding = {
  version: 1,
  variables: { phase: 'phase', stored: 'stored', rejected: 'rejected' },
  inputs: { v: 'v' },
  actions: { Insert: 'Insert', Same: 'Same', Clash: 'Clash' },
};
const unauthenticated = /capture|controlled.*provenance/i;

test('pure capture readers reject untyped values, supplied IR, and model-only-shaped objects', async () => {
  const inputs: unknown[] = [null, {}, { kind: 'symbolic-owned', version: 1, source: { semanticSha256: 'a'.repeat(64) } },
    { kind: 'model-only', model: {}, orbitProof: null, differential: null }];
  for (const value of inputs) {
    assert.throws(() => Reflect.apply(inspectSymbolicCapture, undefined, [value]), unauthenticated);
    assert.throws(() => Reflect.apply(readSymbolicCaptureForCompiler, undefined, [value]), unauthenticated);
    await assert.rejects(async () => Reflect.apply(recheckSymbolicCapture, undefined, [value]), unauthenticated);
    await assert.rejects(async () => Reflect.apply(verifyCapturedErasure, undefined, [{ abstract: value, concrete: value, binding }]), unauthenticated);
  }
});

test('pure capture collection rejects a non-symbolic project before attempting a missing JAR', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sgd-capture-profile-'));
  try {
    const project = join(root, 'project.json');
    await cp(resolve('examples/order/project.json'), project);
    await assert.rejects(captureSymbolicProject({ project, jar: join(root, 'absent.jar') }), /symbolic|profile|version|project/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function capturePair() {
  assert.ok(jar);
  const root = await mkdtemp(join(tmpdir(), 'sgd-capture-projects-'));
  try {
    const abstractDirectory = join(root, 'abstract');
    const concreteDirectory = join(root, 'concrete');
    await cp(resolve('examples/fact-merge'), abstractDirectory, { recursive: true });
    await cp(resolve('examples/fact-envelope'), concreteDirectory, { recursive: true });
    const abstractProject = join(abstractDirectory, 'project.json');
    const concreteProject = join(concreteDirectory, 'project.json');
    // Controlled runners remain serial. These are separate source checks and original-action oracles.
    const abstract = await captureSymbolicProject({ project: abstractProject, jar });
    const concrete = await captureSymbolicProject({ project: concreteProject, jar });
    return { root, abstractDirectory, concreteDirectory, abstractProject, concreteProject, abstract, concrete };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
let cached: ReturnType<typeof capturePair> | undefined;
const captures = () => cached ??= capturePair();
after(async () => { if (cached) await cached.then(pair => rm(pair.root, { recursive: true, force: true }), () => undefined); });

test('real v3/v4 captures retain controlled evidence and the current enabled-input erasure result', { skip: !jar, timeout: 180_000 }, async () => {
  const pair = await captures();
  const high = readSymbolicCaptureForCompiler(pair.abstract);
  const low = readSymbolicCaptureForCompiler(pair.concrete);
  assert.equal(high.model.version, 1);
  assert.equal(low.model.version, 2);
  for (const [capture, data, version] of [[pair.abstract, high, 3], [pair.concrete, low, 4]] satisfies [typeof pair.abstract, typeof high, number][]) {
    const summary = inspectSymbolicCapture(capture);
    assert.equal(summary.kind, 'controlled-symbolic-capture');
    assert.equal(summary.project.version, version);
    assert.deepEqual(summary.model, { name: data.model.name, semanticSha256: data.model.source.semanticSha256 });
    assert.equal(summary.finite.scope, 'configured-finite-instance');
    assert.deepEqual(summary.finite.evidence, data.run.evidence);
    assert.equal(summary.orbit.scope, 'admitted-equality-copy-orbits');
    assert.equal(summary.orbit.stateCount, data.orbitProof.states.length);
    assert.deepEqual(summary.oracle, data.differential.evidence);
    assert.equal(summary.inputStability, 'complete-flat-module-and-java-override-namespace');
  }
  for (const data of [high, low]) {
    assert.equal(data.run.evidence.kind, 'tlc-symbolic-completed');
    assert.equal(data.run.evidence.profile, 'symbolic-owned-v1');
    assert.equal(data.run.semantic.root, data.run.evidence.rootModule);
    assert.equal(data.orbitProof.kind, 'equality-copy-orbits');
    assert.equal(data.differential.evidence.kind, 'tlc-finite-input-oracle');
    assert.equal(data.differential.evidence.scope, 'configured-reachable-state-input-product');
    assert.ok(data.differential.evidence.checkedCases > 0);
    assert.deepEqual(data.witness, data.differential.witness);
  }
  const evidence = await verifyCapturedErasure({ abstract: pair.abstract, concrete: pair.concrete, binding });
  assert.equal(evidence.kind, 'symbolic-enabled-input-erasure');
  assert.equal(evidence.scope, 'admitted-equality-copy-orbits');
  assert.ok(evidence.concreteOrbitCount > 0);
  assert.equal(evidence.acceptedCases, evidence.checkedCases);
  assert.equal(evidence.disabledCases, 0);
  assert.deepEqual(evidence.captures.abstract, inspectSymbolicCapture(pair.abstract));
  assert.deepEqual(evidence.captures.concrete, inspectSymbolicCapture(pair.concrete));
  assert.ok(Object.isFrozen(evidence.captures.abstract.finite.evidence.moduleClosure));
  await recheckSymbolicCapture(pair.abstract);
  await recheckSymbolicCapture(pair.concrete);
});

test('real capture inspection and compiler views cannot mutate captured model or semantic provenance', { skip: !jar, timeout: 180_000 }, async () => {
  const pair = await captures();
  const summary = inspectSymbolicCapture(pair.abstract);
  const data = readSymbolicCaptureForCompiler(pair.abstract);
  const model = JSON.stringify(data.model);
  assert.ok(Object.isFrozen(summary));
  assert.ok(Object.isFrozen(data));
  assert.ok(Object.isFrozen(data.model));
  assert.ok(Object.isFrozen(data.model.branches));
  assert.equal(Reflect.set(data.model, 'name', 'DifferentModel'), false);
  const firstBranch = data.model.branches[0];
  assert.ok(firstBranch);
  assert.equal(Reflect.set(firstBranch, 'action', 'DifferentAction'), false);
  assert.equal(Reflect.set(data.run.semantic, 'root', 'DifferentRoot'), false);
  const firstSymbol = data.run.semantic.symbols.values().next().value;
  assert.ok(firstSymbol);
  assert.equal(Reflect.set(firstSymbol, 'name', 'DifferentSymbol'), false);
  assert.throws(() => Reflect.apply(Map.prototype.set, data.run.semantic.symbols, [firstSymbol.uid, { ...firstSymbol, name: 'Injected' }]), TypeError);
  const again = readSymbolicCaptureForCompiler(pair.abstract);
  assert.notEqual(again, data);
  assert.equal(JSON.stringify(again.model), model);
  assert.equal(again.run.semantic.symbols.get(firstSymbol.uid)?.name, firstSymbol.name);
  const evidence = await verifyCapturedErasure({ abstract: pair.abstract, concrete: pair.concrete, binding });
  assert.equal(evidence.acceptedCases, evidence.checkedCases);
});

test('real model-only output and reflected constructors cannot mint checked capture provenance', { skip: !jar, timeout: 180_000 }, async () => {
  assert.ok(jar);
  const pair = await captures();
  const modelOnly = await inspectSymbolicProject({ project: pair.abstractProject, jar });
  const data = readSymbolicCaptureForCompiler(pair.abstract);
  for (const supplied of [modelOnly, data, data.model, { ...inspectSymbolicCapture(pair.abstract) }]) {
    assert.throws(() => Reflect.apply(inspectSymbolicCapture, undefined, [supplied]), unauthenticated);
    await assert.rejects(async () => Reflect.apply(verifyCapturedErasure, undefined, [{ abstract: supplied, concrete: pair.concrete, binding }]), unauthenticated);
  }
  const constructor = Object.getPrototypeOf(pair.abstract).constructor;
  let forged: unknown;
  try { forged = Reflect.construct(constructor, []); }
  catch (error) { assert.ok(error instanceof Error); return; }
  assert.throws(() => Reflect.apply(inspectSymbolicCapture, undefined, [forged]), unauthenticated);
  await assert.rejects(async () => Reflect.apply(verifyCapturedErasure, undefined, [{ abstract: forged, concrete: pair.concrete, binding }]), unauthenticated);
});

test('real capture recheck detects original input edits and new supported-namespace entries', { skip: !jar, timeout: 180_000 }, async () => {
  const pair = await captures();
  const paths = [join(pair.abstractDirectory, 'ManifestWrite.tla'), join(pair.abstractDirectory, 'ManifestWrite.cfg'), pair.abstractProject];
  for (const path of paths) {
    const original = await readFile(path);
    try {
      await writeFile(path, Buffer.concat([original, Buffer.from('\n')]));
      await assert.rejects(recheckSymbolicCapture(pair.abstract), /changed|namespace|input|source/i);
      await assert.rejects(verifyCapturedErasure({ abstract: pair.abstract, concrete: pair.concrete, binding }), /changed|namespace|input|source/i);
    } finally { await writeFile(path, original); }
    await recheckSymbolicCapture(pair.abstract);
  }
  for (const name of ['Unused.tla', 'Override.java', 'Override.CLASS', 'tools.JaR']) {
    const path = join(pair.abstractDirectory, name);
    try {
      await writeFile(path, 'unreferenced input must not enter verified provenance');
      await assert.rejects(recheckSymbolicCapture(pair.abstract), /changed|namespace|input|source|override|artifact/i);
    } finally { await rm(path, { force: true }); }
    await recheckSymbolicCapture(pair.abstract);
  }
  const unrelated = join(pair.abstractDirectory, 'unrelated.txt');
  try {
    await writeFile(unrelated, 'outside the controlled flat-module namespace');
    await recheckSymbolicCapture(pair.abstract);
  } finally { await rm(unrelated, { force: true }); }
});
