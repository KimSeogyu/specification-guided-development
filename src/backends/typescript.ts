import type { BackendInput, GeneratedFile } from '../types.js';
import path from 'node:path';

/** Generate a syntax checker for explicit edges, not a runtime-state proof. */
export function generateTypeScript(input: BackendInput): GeneratedFile[] {
  if (input.binding.kind === 'dependency') {
    const states = new Set(input.automaton.states);
    for (const [name, prefixes] of Object.entries(input.binding.modules)) {
      if (!states.has(name)) throw new Error(`Dependency module ${name} is not a model state`);
      for (const prefix of prefixes) {
        if (prefix.includes('\\') || prefix.startsWith('/') || /^[A-Za-z]:/.test(prefix)
          || prefix.split('/').includes('..') || path.posix.normalize(prefix).replace(/\/+$/, '') === '.') {
          throw new Error(`Dependency prefix must be a nonempty project-relative path: ${prefix}`);
        }
      }
    }
    for (const state of states) {
      if (!input.binding.modules[state]) throw new Error(`Model state ${state} has no dependency module mapping`);
    }
  }
  return [
    { path: 'checker.mjs', content: `#!/usr/bin/env node\nconst policy = ${JSON.stringify(input)};\n${runtime}` },
    { path: 'package.json', content: JSON.stringify({ name: 'sgd-generated-checker', private: true, type: 'module', dependencies: { typescript: '7.0.2' } }, null, 2) + '\n' },
  ];
}

const runtime = String.raw`
// Uses the native TypeScript 7.0.2 API, pinned because its API entry points are unstable.
// Native project snapshots provide syntax and module resolution.
// Transition profile: bare configured function calls declare explicit static edges.
// It does not prove runtime state, guards, or the behavior of another function.
// Only explicit input files are checked; runtime code generation is not analyzed.
// Dependency profile: exact files or directory-boundary prefixes own source files.
// node: builtins and packages resolved in node_modules are outside this boundary.
// Unresolved bare packages are external unless they match a configured paths alias.
// Relative, absolute, # imports and configured paths aliases must resolve internally.
// Internal targets must expose a native SourceFile module symbol; scripts without one fail closed.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

function diagnostic(ruleId, file, line, column, message) {
  return { ruleId, file, line, column, message };
}
function report(items, status) {
  const unique = [...new Map(items.map(item => [JSON.stringify(item), item])).values()];
  unique.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line
    || a.column - b.column || a.ruleId.localeCompare(b.ruleId) || a.message.localeCompare(b.message));
  process.stdout.write(JSON.stringify(unique) + '\n');
  process.exitCode = status;
}
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function slash(value) { return value.split(path.sep).join('/'); }
async function loadTypeScript(root) {
  for (const location of [import.meta.url, path.join(root, 'package.json'), path.join(process.cwd(), 'package.json')]) {
    try {
      const require = createRequire(location);
      const installed = require('typescript/package.json');
      if (installed.version !== '7.0.2') throw new Error('Native checker requires typescript@7.0.2; found ' + installed.version);
      const [{ API }, ts] = await Promise.all([
        import(pathToFileURL(require.resolve('typescript/unstable/sync')).href),
        import(pathToFileURL(require.resolve('typescript/unstable/ast')).href),
      ]);
      return { API, ts };
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('Install typescript@7.0.2 at the checker, project root, or current working directory, including its native platform package.');
}
async function run() {
  const args = process.argv.slice(2);
  if (args[0] !== '--root' || !args[1] || args.length < 3 || args.slice(2).some(arg => arg.startsWith('--'))) {
    throw new Error('Usage: node checker.mjs --root PROJECT_ROOT FILE [FILE ...]');
  }
  const root = fs.realpathSync(path.resolve(args[1]));
  if (!fs.statSync(root).isDirectory()) throw new Error('--root must name a directory');
  const { API, ts } = await loadTypeScript(root);
  const files = [...new Set(args.slice(2).map(file => fs.realpathSync(path.resolve(root, file))))];
  for (const file of files) {
    if (!inside(root, file)) throw new Error('Input file is outside --root: ' + file);
    if (!fs.statSync(file).isFile()) throw new Error('Input must be a file: ' + file);
    if (!/\.(?:[cm]?ts|tsx)$/.test(file)) throw new Error('Input must be a TypeScript source file: ' + file);
  }
  const nonce = randomUUID();
  const configFile = path.join(root, '.sgd-native-' + nonce + '.json');
  const existingConfig = path.join(root, 'tsconfig.json');
  const requireProbes = new Map(policy.binding.kind === 'dependency' ? files.map((file, index) => [file, {
    file: path.join(path.dirname(file), '.sgd-native-' + nonce + '-' + index + '.cts'), specifiers: [],
  }]) : []);
  const virtualFiles = new Map([...requireProbes.values()].map(probe => [probe.file, '']));
  const config = { files: [...files, ...virtualFiles.keys()], include: [], compilerOptions: { noEmit: true } };
  if (fs.existsSync(existingConfig)) config.extends = existingConfig;
  else Object.assign(config.compilerOptions, { module: 'esnext', moduleResolution: 'bundler', allowJs: true });
  virtualFiles.set(configFile, JSON.stringify(config));
  const api = new API({ cwd: root, fs: {
    readFile: file => virtualFiles.get(path.resolve(file)),
    fileExists: file => virtualFiles.has(path.resolve(file)) ? true : undefined,
  } });
  let snapshot;
  try {
  snapshot = api.updateSnapshot({ openProjects: [configFile] });
  let project = snapshot.getProject(configFile);
  if (!project) throw new Error('Native TypeScript did not load the checked project');
  const configErrors = project.program.getConfigFileParsingDiagnostics();
  if (configErrors.length) throw new Error('Invalid tsconfig.json: ' + configErrors.map(error => error.text).join('; '));
  const parseFiles = () => files.map(file => {
    const source = project.program.getSourceFile(file);
    if (!source) throw new Error('Native TypeScript did not load checked source: ' + file);
    return { file, source };
  });
  let parsed = parseFiles();
  const parseErrors = [];
  for (const { file, source } of parsed) {
    for (const problem of project.program.getSyntacticDiagnostics(file)) {
      const location = source.getLineAndCharacterOfPosition(Math.max(0, problem.pos));
      parseErrors.push(diagnostic('TLC002', slash(path.relative(root, file)), location.line + 1,
        location.character + 1, 'TypeScript parse error: ' + problem.text));
    }
  }
  if (parseErrors.length) { report(parseErrors, 2); return; }
  const diagnostics = [];
  const note = (source, node, ruleId, message) => {
    const location = source.getLineAndCharacterOfPosition(node.getStart(source));
    diagnostics.push(diagnostic(ruleId, slash(path.relative(root, source.fileName)),
      location.line + 1, location.character + 1, message));
  };
  if (policy.binding.kind === 'transition') {
    const monitored = policy.binding.function;
    const edges = new Set(policy.automaton.transitions.map(edge => JSON.stringify([edge.from, edge.event, edge.to])));
    const isDeclaration = node => {
      const parent = node.parent;
      if ((ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent)) && parent.name === node) return true;
      if (ts.isImportSpecifier(parent) && parent.name === node && !parent.propertyName) return true;
      return false;
    };
    for (const { source } of parsed) {
      const visit = node => {
        if (ts.isCallExpression(node)) {
          if (ts.isIdentifier(node.expression) && node.expression.text === monitored) {
            if (node.questionDotToken || node.arguments.length !== 3 || node.arguments.some(arg => !ts.isStringLiteral(arg))) {
              note(source, node, 'TLC002', monitored + ' requires exactly three static string literals (from, event, to)');
            } else {
              const values = node.arguments.map(arg => arg.text);
              if (!edges.has(JSON.stringify(values))) {
                note(source, node, 'TLC001', 'Forbidden explicit transition ' + JSON.stringify(values));
              }
            }
          } else if (ts.isElementAccessExpression(node.expression) && !ts.isStringLiteral(node.expression.argumentExpression)) {
            note(source, node.expression, 'TLC002', 'Dynamic computed calls can hide ' + monitored + '; use a direct checked call');
          }
        }
        if (ts.isIdentifier(node) && node.text === monitored) {
          const parent = node.parent;
          const directCall = ts.isCallExpression(parent) && parent.expression === node;
          if (!directCall && !isDeclaration(node)) {
            note(source, node, 'TLC002', 'Aliased, property, or indirect reference to ' + monitored + ' is unsupported');
          }
        }
        if (ts.isElementAccessExpression(node)
          && (!ts.isStringLiteral(node.argumentExpression) || node.argumentExpression.text === monitored)) {
          note(source, node, 'TLC002', 'Computed property access can hide ' + monitored + '; use a direct checked call');
        }
        if (ts.isStringLiteral(node) && node.text === monitored
          && ((ts.isBindingElement(node.parent) && node.parent.propertyName === node)
            || (ts.isImportSpecifier(node.parent) && node.parent.propertyName === node)
            || (ts.isPropertyAssignment(node.parent) && node.parent.name === node))) {
          note(source, node, 'TLC002', 'Quoted property or alias reference to ' + monitored + ' is unsupported');
        }
        if (ts.isComputedPropertyName(node) && ts.isBindingElement(node.parent)) {
          if (!ts.isStringLiteral(node.expression) || node.expression.text === monitored) {
            note(source, node, 'TLC002', 'Computed destructuring can hide ' + monitored + '; use a direct checked call');
          }
        }
        node.forEachChild(visit);
      };
      visit(source);
    }
  } else {
    // Native 7.0 has no standalone module resolver. A virtual same-directory
    // import-equals declaration gives require() the native resolver's require mode.
    const changed = [];
    for (const { file, source } of parsed) {
      const probe = requireProbes.get(file);
      const collect = node => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
          && !node.questionDotToken && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
          if (!probe.specifiers.includes(node.arguments[0].text)) probe.specifiers.push(node.arguments[0].text);
        }
        node.forEachChild(collect);
      };
      collect(source);
      if (probe.specifiers.length) {
        virtualFiles.set(probe.file, probe.specifiers.map((specifier, index) =>
          'import __sgd' + index + ' = require(' + JSON.stringify(specifier) + ');').join('\n'));
        changed.push(probe.file);
      }
    }
    if (changed.length) {
      const previous = snapshot;
      snapshot = api.updateSnapshot({ fileChanges: { changed } });
      previous.dispose();
      project = snapshot.getProject(configFile);
      if (!project) throw new Error('Native TypeScript lost the checked project');
      parsed = parseFiles();
    }
    const options = project.compilerOptions;
    const requireLiterals = new Map([...requireProbes.entries()].map(([file, probe]) => {
      const source = project.program.getSourceFile(probe.file);
      const literals = new Map();
      for (const statement of source?.statements ?? []) {
        if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
          const literal = statement.moduleReference.expression;
          if (literal && ts.isStringLiteral(literal)) literals.set(literal.text, literal);
        }
      }
      return [file, literals];
    }));
    const mappings = Object.entries(policy.binding.modules).flatMap(([owner, prefixes]) =>
      prefixes.map(prefix => ({ owner, prefix: path.posix.normalize(prefix.replace(/^\.\//, '').replace(/\/+$/, '')) })));
    function ownerOf(file) {
      const relative = slash(path.relative(root, file));
      const owners = new Set(mappings.filter(entry => relative === entry.prefix || relative.startsWith(entry.prefix + '/')).map(entry => entry.owner));
      return owners.size === 1 ? { owner: [...owners][0] } : { problem: owners.size ? 'ambiguous module ownership' : 'no module ownership' };
    }
    const allowed = new Set(policy.automaton.transitions.map(edge => JSON.stringify([edge.from, edge.to])));
    function matchesAlias(specifier) {
      return Object.keys(options.paths ?? {}).some(pattern => {
        const star = pattern.indexOf('*');
        return star < 0 ? pattern === specifier : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1));
      });
    }
    function dependency(source, node, literal, from) {
      if (!literal || !ts.isStringLiteral(literal)) {
        note(source, node, 'TLC002', 'Dependency specifier must be a static string literal');
        return;
      }
      const specifier = literal.text;
      if (specifier.startsWith('node:')) return;
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier) && !path.isAbsolute(specifier)) {
        note(source, node, 'TLC002', 'URL dependency specifiers are outside the supported module profile');
        return;
      }
      const internal = specifier.startsWith('.') || path.isAbsolute(specifier) || specifier.startsWith('#') || matchesAlias(specifier);
      const requireCall = ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const resolvedLiteral = requireCall ? requireLiterals.get(source.fileName)?.get(specifier) : literal;
      const symbol = resolvedLiteral ? project.checker.getSymbolAtLocation(resolvedLiteral) : undefined;
      const targets = (symbol?.declarations ?? []).map(handle => handle.resolve(project)).filter(node => node && ts.isSourceFile(node));
      if (targets.length !== 1) {
        if (internal || targets.length > 1) note(source, node, 'TLC002', 'Cannot resolve internal dependency as one native TypeScript module: ' + JSON.stringify(specifier));
        return;
      }
      const resolved = targets[0];
      if (project.program.isSourceFileFromExternalLibrary(resolved) || slash(resolved.fileName).split('/').includes('node_modules')) return;
      let destination;
      try { destination = fs.realpathSync(resolved.fileName); } catch {
        note(source, node, 'TLC002', 'Cannot read resolved dependency ' + JSON.stringify(specifier));
        return;
      }
      if (!inside(root, destination)) {
        note(source, node, 'TLC002', 'Resolved dependency is outside --root: ' + JSON.stringify(specifier));
        return;
      }
      const target = ownerOf(destination);
      if (target.problem) {
        note(source, node, 'TLC002', target.problem + ' for ' + slash(path.relative(root, destination)));
      } else if (from && from !== target.owner && !allowed.has(JSON.stringify([from, target.owner]))) {
        note(source, node, 'TLC003', 'Forbidden dependency ' + from + ' -> ' + target.owner + ' via ' + JSON.stringify(specifier));
      }
    }
    for (const { file, source } of parsed) {
      const from = ownerOf(file);
      if (from.problem) note(source, source, 'TLC002', from.problem + ' for checked source');
      const visit = node => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          if (node.moduleSpecifier) dependency(source, node, node.moduleSpecifier, from.owner);
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
          dependency(source, node, node.moduleReference.expression, from.owner);
        } else if (ts.isImportTypeNode(node)) {
          dependency(source, node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, from.owner);
        } else if (ts.isCallExpression(node)) {
          const importCall = node.expression.kind === ts.SyntaxKind.ImportKeyword;
          const requireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require';
          if (importCall || requireCall) {
            if (node.questionDotToken || node.arguments.length !== 1) {
              note(source, node, 'TLC002', 'Module loading requires one static string literal argument');
            } else dependency(source, node, node.arguments[0], from.owner);
          } else if (ts.isElementAccessExpression(node.expression) && !ts.isStringLiteral(node.expression.argumentExpression)) {
            note(source, node.expression, 'TLC002', 'Dynamic computed calls can hide module loading');
          }
        }
        if (ts.isIdentifier(node) && node.text === 'require') {
          const parent = node.parent;
          const directCall = ts.isCallExpression(parent) && parent.expression === node;
          if (!directCall) note(source, node, 'TLC002', 'Indirect require references are unsupported');
        }
        if (ts.isElementAccessExpression(node)
          && (!ts.isStringLiteral(node.argumentExpression) || node.argumentExpression.text === 'require')) {
          note(source, node, 'TLC002', 'Computed property access can hide module loading');
        }
        if (ts.isStringLiteral(node) && node.text === 'require'
          && ts.isBindingElement(node.parent) && node.parent.propertyName === node) {
          note(source, node, 'TLC002', 'Quoted require aliases are unsupported');
        }
        if (ts.isComputedPropertyName(node) && ts.isBindingElement(node.parent)) {
          if (!ts.isStringLiteral(node.expression) || node.expression.text === 'require') {
            note(source, node, 'TLC002', 'Computed destructuring can hide module loading');
          }
        }
        node.forEachChild(visit);
      };
      visit(source);
    }
  }
  report(diagnostics, diagnostics.length ? 1 : 0);
  } finally {
    snapshot?.dispose();
    api.close();
  }
}
try { await run(); } catch (error) {
  report([diagnostic('TLC002', '', 1, 1, error instanceof Error ? error.message : String(error))], 2);
}
`;
