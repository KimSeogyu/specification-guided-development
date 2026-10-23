import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { generateTypeScript } from '../src/backends/typescript.js';
import type { Automaton, BackendInput } from '../src/types.js';

const DiagnosticSchema = z.object({ ruleId: z.string(), file: z.string(), line: z.number(), column: z.number(), message: z.string() });
const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const automaton: Automaton = {
  version: 1, name: 'Example', stateVariable: 'state', states: ['Idle', 'Running', 'Done'], initialStates: ['Idle'],
  transitions: [{ from: 'Idle', event: 'start', to: 'Running' }, { from: 'Running', event: 'finish', to: 'Done' }],
  source: { dotSha256: 'fixture', stateCount: 3, edgeCount: 2 },
};
const transitionInput: BackendInput = { automaton, binding: { kind: 'transition', function: 'transition' } };
const dependencyInput: BackendInput = {
  automaton, binding: { kind: 'dependency', modules: { Idle: ['src/idle'], Running: ['src/running'], Done: ['src/done'] } },
};

function fixture(t: TestContext, input: BackendInput, files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlc-typescript-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file: string, content: string) => {
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  };
  for (const file of generateTypeScript(input)) write(file.path, file.content);
  for (const [name, content] of Object.entries(files)) write(name, content);
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [path.join(root, 'checker.mjs'), ...args], { encoding: 'utf8', cwd: projectDirectory });
    if (result.error) throw result.error;
    assert.equal(result.stderr, '', result.stderr);
    const decoded: unknown = JSON.parse(result.stdout);
    return { status: result.status, diagnostics: z.array(DiagnosticSchema).parse(decoded) };
  };
  return { root, write, run, check: (...files: string[]) => run('--root', root, ...files) };
}

test('generated TypeScript checker accepts explicit permitted edges and ignores comments and strings', t => {
  const f = fixture(t, transitionInput, { 'app.ts': `
declare function transition(from: string, event: string, to: string): void;
transition('Idle', 'start', 'Running');
transition("Running", "finish", "Done");
// transition('Idle', 'skip', 'Done');
const text = "transition('Idle', 'skip', 'Done')";
` });
  assert.deepEqual(f.check('app.ts'), { status: 0, diagnostics: [] });
});

test('generated TypeScript checker reports a forbidden edge with source coordinates', t => {
  const f = fixture(t, transitionInput, { 'src/app.ts': "const x = 1;\n  transition('Idle', 'skip', 'Done');\n" });
  const result = f.check('src/app.ts');
  assert.equal(result.status, 1);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.ruleId, 'TLC001');
  assert.equal(result.diagnostics[0]?.file, 'src/app.ts');
  assert.equal(result.diagnostics[0]?.line, 2);
  assert.equal(result.diagnostics[0]?.column, 3);
});

test('generated TypeScript checker rejects dynamic arguments and indirect monitored references', t => {
  const cases = [
    "transition(state, 'start', 'Running');",
    "transition(...['Idle', 'start', 'Running']);",
    "transition('Idle', 'start');",
    "transition(`Idle`, 'start', 'Running');",
    "transition?.('Idle', 'start', 'Running');",
    "const alias = transition; alias('Idle', 'start', 'Running');",
    "import { transition as alias } from './runtime'; alias('Idle', 'start', 'Running');",
    "transition.call(null, 'Idle', 'start', 'Running');",
    "api.transition('Idle', 'start', 'Running');",
    "api['transition']('Idle', 'start', 'Running');",
    "api[key]('Idle', 'start', 'Running');",
    "const key='transition'; const invoke=api[key]; invoke('Idle', 'skip', 'Done');",
    "(transition)('Idle', 'start', 'Running');",
    "const { transition: alias } = api;",
    "const { 'transition': alias } = api;",
    "const { ['transition']: alias } = api;",
    "const { [key]: alias } = api;",
    "import { 'transition' as alias } from './runtime';",
    "const x = { transition };",
  ];
  const f = fixture(t, transitionInput, {});
  for (const source of cases) {
    f.write('app.ts', source);
    const result = f.check('app.ts');
    assert.equal(result.status, 1, source);
    assert.ok(result.diagnostics.some(item => item.ruleId === 'TLC002'), source);
  }
});

test('transition function name is supplied by the binding', t => {
  const f = fixture(t, { automaton, binding: { kind: 'transition', function: 'edge' } }, {
    'app.ts': "edge('Idle', 'skip', 'Done'); transition('Idle', 'skip', 'Done');",
  });
  const result = f.check('app.ts');
  assert.equal(result.status, 1);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.ruleId, 'TLC001');
});

test('dependency checker resolves directory imports, relative js specifiers, re-exports and same-module edges', t => {
  const f = fixture(t, dependencyInput, {
    'src/idle/main.ts': "import { value } from '../running/index.js'; export * from './local'; const example = \"require('../done')\";",
    'src/idle/local.ts': 'export const local = 1;',
    'src/running/index.ts': "export { done } from '../done'; export const value = 1;",
    'src/done/index.ts': 'export const done = 1;',
  });
  assert.deepEqual(f.check('src/idle/main.ts', 'src/running/index.ts'), { status: 0, diagnostics: [] });
});

test('dependency checker inspects imports, exports, require, dynamic import, import equals and type imports', t => {
  const cases = [
    "import { done } from '../done';",
    "export * from '../done';",
    "const done = require('../done');",
    "const done = import('../done');",
    "import done = require('../done');",
    "type Done = import('../done').Done;",
  ];
  const f = fixture(t, dependencyInput, { 'src/done/index.ts': 'export interface Done {} export const done = 1;' });
  for (const source of cases) {
    f.write('src/idle/main.ts', source);
    const result = f.check('src/idle/main.ts');
    assert.equal(result.status, 1, source);
    assert.ok(result.diagnostics.some(item => item.ruleId === 'TLC003' && item.message.includes('Idle -> Done')), source);
  }
});

test('dependency checker rejects dynamic or indirect module loading', t => {
  const cases = [
    'import(destination);', 'require(destination);', 'require(...files);',
    'const load = require; load(destination);', 'module.require(destination);',
    "module['require'](destination);", 'require?.(destination);',
    "const { 'require': load } = module;", "const { ['require']: load } = module;",
    'const { [key]: load } = module;', "module[key]('../done');",
    "const key='require'; const load=module[key]; load('../done');",
  ];
  const f = fixture(t, dependencyInput, {});
  for (const source of cases) {
    f.write('src/idle/main.ts', source);
    const result = f.check('src/idle/main.ts');
    assert.equal(result.status, 1, source);
    assert.ok(result.diagnostics.some(item => item.ruleId === 'TLC002'), source);
  }
});

test('dependency checker resolves tsconfig paths and rejects an unresolved configured alias', t => {
  const f = fixture(t, dependencyInput, {
    'tsconfig.base.json': JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', paths: { '@app/*': ['./src/*'] } } }),
    'tsconfig.json': JSON.stringify({ extends: './tsconfig.base.json', exclude: ['src'] }),
    'src/idle/main.ts': "import { done } from '@app/done';",
    'src/done/index.ts': 'export const done = 1;',
  });
  assert.equal(f.check('src/idle/main.ts').diagnostics[0]?.ruleId, 'TLC003');
  f.write('src/idle/main.ts', "import '@app/missing';");
  const missing = f.check('src/idle/main.ts');
  assert.equal(missing.status, 1);
  assert.equal(missing.diagnostics[0]?.ruleId, 'TLC002');
});

test('native TypeScript resolver uses import and require conditions separately', t => {
  const f = fixture(t, dependencyInput, {
    'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext' } }),
    'package.json': JSON.stringify({ type: 'module', imports: { '#state': { import: './src/running/index.ts', require: './src/done/index.ts' } } }),
    'src/idle/main.ts': "import { value } from '#state'; void import('#state'); const required = require('#state');",
    'src/running/index.ts': 'export const value = 1;',
    'src/done/index.ts': 'export const value = 2;',
  });
  const result = f.check('src/idle/main.ts');
  assert.equal(result.status, 1);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.ruleId, 'TLC003');
  assert.match(result.diagnostics[0]?.message ?? '', /Idle -> Done/);
  assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.sgd-native-')), false);
  assert.equal(fs.readdirSync(path.join(f.root, 'src/idle')).some(name => name.startsWith('.sgd-native-')), false);
});

test('native TypeScript checker fails closed on internal scripts without a module symbol', t => {
  const f = fixture(t, dependencyInput, {
    'src/idle/main.ts': "import '../done';",
    'src/done/index.ts': 'const done = 1;',
  });
  const result = f.check('src/idle/main.ts');
  assert.equal(result.status, 1);
  assert.equal(result.diagnostics[0]?.ruleId, 'TLC002');
  assert.match(result.diagnostics[0]?.message ?? '', /native TypeScript module/);
});

test('native TypeScript checker reports invalid project configuration', t => {
  const f = fixture(t, dependencyInput, { 'tsconfig.json': '{"compilerOptions":', 'src/idle/main.ts': 'export {};' });
  const result = f.check('src/idle/main.ts');
  assert.equal(result.status, 2);
  assert.equal(result.diagnostics[0]?.ruleId, 'TLC002');
  assert.match(result.diagnostics[0]?.message ?? '', /Invalid tsconfig/);
});

test('dependency checker rejects missing, unowned and ambiguous internal targets', t => {
  const f = fixture(t, dependencyInput, {
    'src/idle/main.ts': "import '../missing';",
    'src/unowned.ts': 'export {};',
  });
  assert.equal(f.check('src/idle/main.ts').diagnostics[0]?.ruleId, 'TLC002');
  f.write('src/idle/main.ts', "import '../unowned';");
  assert.match(f.check('src/idle/main.ts').diagnostics[0]?.message ?? '', /no module ownership/);
  const overlapping: BackendInput = {
    automaton, binding: { kind: 'dependency', modules: { Idle: ['src/idle'], Running: ['src/shared'], Done: ['src/shared'] } },
  };
  const ambiguous = fixture(t, overlapping, {
    'src/idle/main.ts': "import '../shared';", 'src/shared/index.ts': 'export {};',
  });
  const result = ambiguous.check('src/idle/main.ts');
  assert.equal(result.status, 1);
  assert.match(result.diagnostics[0]?.message ?? '', /ambiguous module ownership/);
});

test('dependency file mappings are exact and directory prefixes respect path boundaries', t => {
  const exact: BackendInput = {
    automaton, binding: { kind: 'dependency', modules: { Idle: ['src/a.ts'], Running: ['src/b.ts'], Done: ['src/c.ts'] } },
  };
  const f = fixture(t, exact, { 'src/a.ts': "import './b';", 'src/b.ts': 'export {};', 'src/c.ts': 'export {};' });
  assert.deepEqual(f.check('src/a.ts'), { status: 0, diagnostics: [] });
  const bounded = fixture(t, dependencyInput, { 'src/idle2/main.ts': 'export {};' });
  assert.match(bounded.check('src/idle2/main.ts').diagnostics[0]?.message ?? '', /no module ownership/);
});

test('dependency checker handles absolute internal paths and rejects symlink escapes', t => {
  const f = fixture(t, dependencyInput, { 'src/done/index.ts': 'export const done = 1;' });
  f.write('src/idle/main.ts', 'import ' + JSON.stringify(path.join(f.root, 'src/done/index.ts')) + ';');
  assert.equal(f.check('src/idle/main.ts').diagnostics[0]?.ruleId, 'TLC003');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tlc-typescript-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'outside.ts'), 'export {};');
  fs.symlinkSync(path.join(outside, 'outside.ts'), path.join(f.root, 'src/idle/link.ts'));
  f.write('src/idle/main.ts', "import './link';");
  const result = f.check('src/idle/main.ts');
  assert.equal(result.status, 1);
  assert.equal(result.diagnostics[0]?.ruleId, 'TLC002');
  assert.match(result.diagnostics[0]?.message ?? '', /outside --root/);
});

test('dependency checker documents and implements the external-package boundary', t => {
  const f = fixture(t, dependencyInput, {
    'src/idle/main.ts': "import fs from 'node:fs'; import 'not-installed-external-package'; import 'external'; // import '../done'\nconst text = \"require('../done')\";",
    'node_modules/external/package.json': JSON.stringify({ name: 'external', types: 'index.d.ts' }),
    'node_modules/external/index.d.ts': 'export const value: number;',
  });
  assert.deepEqual(f.check('src/idle/main.ts'), { status: 0, diagnostics: [] });
  const generated = generateTypeScript(dependencyInput)[0];
  assert.match(generated?.content ?? '', /Unresolved bare packages are external/);
});

test('checker rejects malformed invocation, TypeScript syntax and inputs outside root with exit 2', t => {
  const f = fixture(t, transitionInput, { 'app.ts': "transition('Idle', 'start', 'Running');", 'broken.ts': 'const value = ;' });
  assert.equal(f.run().status, 2);
  assert.equal(f.run('--root', f.root).status, 2);
  assert.equal(f.check('absent.ts').status, 2);
  const broken = f.check('broken.ts');
  assert.equal(broken.status, 2);
  assert.match(broken.diagnostics[0]?.message ?? '', /parse error/);
  assert.equal(f.check(path.join(projectDirectory, 'src/types.ts')).status, 2);
  assert.deepEqual(f.check('app.ts', 'app.ts'), { status: 0, diagnostics: [] });
});

test('generation rejects module mappings that cannot have a defined project-relative owner', () => {
  for (const prefix of ['../escape', '/absolute', 'src/../escape', 'C:/outside', '', '.', '././', 'src\\file']) {
    const input: BackendInput = { automaton, binding: { kind: 'dependency', modules: { Idle: [prefix], Running: ['b'], Done: ['c'] } } };
    assert.throws(() => generateTypeScript(input), /project-relative/);
  }
  assert.throws(() => generateTypeScript({ automaton, binding: { kind: 'dependency', modules: { Idle: ['a'] } } }), /no dependency module mapping/);
});
