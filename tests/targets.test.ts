import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile, readProject } from '../src/compiler.js';

test('Rust is supported only for finite domain bindings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sgd-target-profiles-'));
  try {
    const common = { name: 'Example', spec: 'Missing.tla', config: 'Missing.cfg', targets: ['typescript'] };
    const projects = [
      { ...common, version: 1, stateVariable: 'state', binding: { kind: 'transition', function: 'transition' } },
      { ...common, version: 2, profile: 'finite-owned', binding: { className: 'Owner' } },
      { ...common, version: 3, profile: 'symbolic-owned', binding: { className: 'Owner' } },
      { ...common, version: 4, profile: 'symbolic-owned', binding: { className: 'Owner' } },
    ];
    for (const project of projects) {
      const path = join(root, `${project.version}.json`);
      await writeFile(path, JSON.stringify(project));
      assert.deepEqual((await readProject(path)).targets, ['typescript']);
      for (const targets of [['rust'], ['typescript', 'rust']]) {
        await writeFile(path, JSON.stringify({ ...project, targets }));
        await assert.rejects(readProject(path), project.version === 2 ? /Rust generation requires a domain binding/ : /typescript/);
      }
    }
    const rustDomain = { ...projects[1], targets: ['typescript', 'rust'], binding: {
      className: 'Owner', domain: { operations: [{ name: 'publish', port: 'publisher', start: 'Start', success: 'Done', failure: 'Failed' }] },
    } };
    const rustPath = join(root, 'rust-domain.json');
    await writeFile(rustPath, JSON.stringify(rustDomain));
    assert.deepEqual((await readProject(rustPath)).targets, ['typescript', 'rust']);
    for (const version of [5, 6]) {
      const path = join(root, 'retired.json');
      await writeFile(path, JSON.stringify({ ...common, version }));
      await assert.rejects(readProject(path), /version/);
    }
    assert.throws(() => Reflect.apply(compile, undefined, [{ dot: 'not DOT', project: {
      ...projects[0], targets: ['rust'],
    } }]), /typescript/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
