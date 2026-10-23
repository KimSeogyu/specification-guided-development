import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { buildProject } from '../src/compiler.js';
import type { MachineProject } from '../src/finite-types.js';

const jar = process.env.TLA2TOOLS_JAR;
type BuildOutcome =
  | { kind: 'success'; model: Awaited<ReturnType<typeof buildProject>> }
  | { kind: 'failure'; error: unknown };

test('finite build refuses project changes during the actual isolated TLC run before creating output', { skip: !jar, timeout: 30_000 }, async () => {
  assert.ok(jar);
  const directory = await mkdtemp(join(tmpdir(), 'sgd-project-race-test-'));
  const moduleName = `ProjectRace${randomUUID().replaceAll('-', '')}`;
  const source = `---- MODULE ${moduleName} ----
VARIABLE phase
Init == phase = "New"
Wait == UNCHANGED phase
Next == Wait
Spec == Init /\\ [][Next]_phase
====
`;
  try {
    await writeFile(join(directory, `${moduleName}.tla`), source);
    await writeFile(join(directory, `${moduleName}.cfg`), 'SPECIFICATION Spec\n');
    const project: MachineProject = {
      version: 2, profile: 'finite-owned', name: 'Before',
      spec: `${moduleName}.tla`, config: `${moduleName}.cfg`,
      targets: ['typescript'], binding: { className: 'BeforeMachine' },
    };
    const projectPath = join(directory, 'project.json');
    const out = join(directory, 'out');
    await writeFile(projectPath, JSON.stringify(project));
    const pending: Promise<BuildOutcome> = buildProject({ project: projectPath, jar: resolve(jar), out }).then(
      (model): BuildOutcome => ({ kind: 'success', model }),
      (error: unknown): BuildOutcome => ({ kind: 'failure', error }),
    );
    try {
      let isolatedSource: string | undefined;
      for (let attempt = 0; attempt < 250 && isolatedSource === undefined; attempt++) {
        for (const name of await readdir(tmpdir())) {
          if (!name.startsWith('sgd-finite-')) continue;
          const candidate = join(tmpdir(), name, 'models', `${moduleName}.tla`);
          try {
            if (await readFile(candidate, 'utf8') === source) { isolatedSource = candidate; break; }
          } catch { /* Other concurrent runs and a not-yet-written snapshot are unrelated. */ }
        }
        if (isolatedSource === undefined) await delay(10);
      }
      assert.ok(isolatedSource, 'observe this unique module in the real private snapshot before changing project JSON');
      await writeFile(projectPath, JSON.stringify({ ...project, name: 'After', binding: { className: 'AfterMachine' } }));
      const result = await pending;
      assert.equal(result.kind, 'failure', 'an old project snapshot must not produce current-looking authority output');
      assert.ok(result.kind === 'failure' && result.error instanceof Error);
      assert.match(result.error.message, /TLC203:.*project.*changed/i);
      await assert.rejects(access(out), { code: 'ENOENT' });
      await assert.rejects(access(isolatedSource), { code: 'ENOENT' });
    } finally {
      await pending;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
