#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'tests/fixtures/codex-host-ledger');
const timeoutMs = 360_000;
const allowedTools = ['sgd_build', 'sgd_inspect', 'sgd_visualize'];
const scope = 'native-codex-session-mcp-and-explicit-skill';
const redact = value => value.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[redacted credential]').replace(/\bBearer\s+[A-Za-z0-9._~-]{16,}/gi, 'Bearer [redacted]');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const save = async (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
class Failure extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const requireThat = (condition, code, message) => { if (!condition) throw new Failure(code, message); };
const exists = async file => access(file).then(() => true, () => false);
const inside = (directory, file) => file === directory || file.startsWith(`${directory}${path.sep}`);
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const shellCommand = argv => argv.map(shellQuote).join(' ');

async function physicalPath(file) {
  let ancestor = path.resolve(file);
  const missing = [];
  for (;;) {
    try { return path.join(await realpath(ancestor), ...missing); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const entry = await lstat(ancestor).catch(failure => { if (failure.code !== 'ENOENT') throw failure; return null; });
      requireThat(!entry, 'HOST_ARGUMENT', 'A path has an unresolved symlink ancestor.');
      const parent = path.dirname(ancestor);
      requireThat(parent !== ancestor, 'HOST_ARGUMENT', 'Cannot resolve the proposed path.');
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export async function resolveEvidenceOutput(plugin, requested, originalFixture = fixture) {
  const [pluginRoot, output, fixtureRoot] = await Promise.all([physicalPath(plugin), physicalPath(requested), physicalPath(originalFixture)]);
  requireThat(!inside(pluginRoot, output) && !inside(fixtureRoot, output), 'HOST_ARGUMENT', 'Evidence output must remain physically outside the prepared plugin and original fixture.');
  return output;
}

// Parse argv only. Expansion, substitutions, operators, and unsupported wrappers fail.
function shellWords(source) {
  const words = [];
  let word = ''; let quote = null; let started = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quote === "'") { if (char === "'") quote = null; else word += char; continue; }
    if (char === '\\') {
      requireThat(index + 1 < source.length && !['\n', '\r'].includes(source[index + 1]), 'HOST_COMMAND', 'Unsupported shell escape.');
      requireThat(quote !== '"' || ['$', '`', '"', '\\'].includes(source[index + 1]), 'HOST_COMMAND', 'Unsupported double-quoted shell escape.');
      word += source[++index]; started = true; continue;
    }
    if (quote === '"') { if (char === '"') quote = null; else { requireThat(!['$', '`', '\n', '\r'].includes(char), 'HOST_COMMAND', 'Shell expansion is not an approved command.'); word += char; } continue; }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    requireThat(!';&|<>`$()\n\r'.includes(char), 'HOST_COMMAND', 'Shell operators are not approved commands.');
    if (/\s/.test(char)) { if (started) { words.push(word); word = ''; started = false; } }
    else { word += char; started = true; }
  }
  requireThat(!quote, 'HOST_COMMAND', 'Unclosed shell quote.');
  if (started) words.push(word);
  return words;
}

function commandArgv(command) {
  const outer = shellWords(command);
  const shells = ['/bin/zsh', '/bin/bash', '/bin/sh', '/usr/bin/zsh', '/usr/bin/bash', '/usr/bin/sh'];
  if (outer.length === 3 && shells.includes(outer[0]) && outer[1] === '-lc') return shellWords(outer[2]);
  return outer;
}

function options(argv) {
  if (argv.includes('--help')) {
    console.log('Usage: node scripts/verify-codex-host.mjs --plugin PREPARED_CODEX_PLUGIN --jar PINNED_JAR [--codex EXECUTABLE] [--out NEW_DIRECTORY]\nRuns one real native Codex workflow, bounded to 360 seconds. Requires an existing Codex login. Installs nothing.');
    return null;
  }
  const result = { codex: 'codex' };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    requireThat(['--plugin', '--jar', '--codex', '--out'].includes(key) && argv[index + 1], 'HOST_ARGUMENT', `Unknown or missing option: ${key}`);
    result[key.slice(2)] = argv[index + 1];
  }
  requireThat(result.plugin && result.jar, 'HOST_ARGUMENT', 'Supply an already prepared --plugin directory and an existing pinned --jar file.');
  return result;
}

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(file));
    else result.push(file);
  }
  return result.sort();
}

async function identities(directory, exclusions = []) {
  const result = {};
  requireThat((await lstat(directory)).isDirectory(), 'HOST_SOURCE', `Snapshot root must be a regular directory: ${directory}`);
  for (const file of await files(directory)) {
    const relative = path.relative(directory, file);
    if (exclusions.some(excluded => relative === excluded || relative.startsWith(`${excluded}${path.sep}`))) continue;
    requireThat((await lstat(file)).isFile(), 'HOST_SOURCE', `Snapshot trees require regular files: ${relative}`);
    result[relative] = digest(await readFile(file));
  }
  return result;
}

function prerequisite(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 });
  requireThat(!result.error && result.status === 0, 'HOST_PREREQUISITE', `${label} is unavailable. Prepare the host before running this manual check.`);
  return redact(`${result.stdout ?? ''}${result.stderr ?? ''}`).trim();
}

function promptFor(scratch) {
  const app = path.join(scratch, 'app');
  const plugin = path.join(scratch, 'plugin');
  const generated = path.join(app, 'generated');
  const ir = path.join(generated, 'automaton.json');
  const symbolic = path.join(generated, 'symbolic-model.json');
  const commands = ['skill', 'modeling', 'partition', 'application', 'generated'].map(view => ({ id: view, argv: [process.execPath, path.join(app, 'inspect-fixture.mjs'), '--plugin', plugin, '--view', view, '--pele', path.join(scratch, 'pele')], marker: `SGD_HOST_INSPECT_OK ${view}` }));
  commands.push({ id: 'native', argv: [process.execPath, path.join(app, 'verify-native.mjs'), '--plugin', plugin, '--evidence', path.join(scratch, 'native')], marker: 'SGD_HOST_NATIVE_OK ' });
  return { commands, text: `Run this one real native Codex verification yourself within 360 seconds. Do not delegate.
Read the copied SKILL.md, bundled modeling/partition references, and original app by executing these four exact trusted read commands before generation. Use max_output_tokens at least 20000 for their complete contents:
${commands.slice(0, 4).map(command => shellCommand(command.argv)).join('\n')}
These and the two later declared commands are your ONLY permitted shell commands. The exact read-only inspection commands may be repeated if output is truncated. The native-check command must run exactly once. Do not use cat, rg, ls, test, shell pipelines, extra statements, alternate spelling, arbitrary commands, or file-writing tools. Execute the given quoted command strings unchanged. The helpers perform the allowed reads and native checks. Use MCP for SGD, not a CLI fallback.
Your only working tree is ${scratch}. Do not read other repositories, sessions, user files, global configuration, auth or secrets. Do not install anything, run login/reset, alter HOME/CODEX_HOME/auth variables, register plugins/marketplaces, change globals, use Docker, commit, or change remotes. Existing normal toolchain/authentication use and offline dependency-cache reads are allowed. No model override or CLI SGD fallback. If an operation fails, report it and stop dependent work. Poll the same live command handle instead of restarting it.
The copied app contains only original LedgerFact sources, models, and complete-row behavior tests. ${generated} is absent. Never fabricate or copy generated policy. Use actual session-configured MCP tools:
1. sgd_build with project ${app}/models/fold.json, jar ${scratch}/tla2tools.jar, out ${generated}.
Keep detail omitted for both build calls. The default summaries report graph scope and evidence paths. The check response must identify retained output logs rather than claim a fresh invocation log was retained.
2. Invoke sgd_inspect once on ${ir} and once on ${symbolic}. The generated-file helper below supplies the fresh row binding for comparison with native Eq.
3. Invoke sgd_visualize with both ${ir} and ${symbolic}, out ${scratch}/pele. Then execute this exact trusted generated-file read command and explain its real refusal/provenance paths. Do not claim browser inspection:
${shellCommand(commands[4].argv)}
4. Invoke sgd_build with the same project/jar/out and check:true.
5. Execute exactly this one native-check command, without a shell pipeline or extra statements:
${shellCommand(commands[5].argv)}
That trusted fixture checker executes both TypeScript 7.0.2 builds, actual TypeScript behavior, and cargo test --offline --locked. It compares every field of the emitted complete rows/conflict pairs with explicit expected observations. Do not edit app original files, tests, expected observations, this checker, plugin code, or generated policy. Do not run these checks from archived results or final prose. Only generated/build outputs and the specified native evidence directory may be written.
The fixture tests first incoming receipt retention, ordered repeated complete conflicts, new-key insertion then other-key clash rollback, signed extrema ordering, Noop/empty, baseline duplicates, group/calendar rejection, and TypeScript token/array/single-consumption boundaries.
The session configuration restricts MCP to sgd_build, sgd_inspect, and sgd_visualize and explicitly approves fixture build/visualize only. Keep approval never and workspace-write. This is manually configured per-session MCP plus an explicit skill in the installed Codex agent, not plugin-manifest discovery or permanent installation. Reports remain unbound data without resource authentication, persistence, exclusive writer coverage, or effect atomicity. Finish with actual outcomes and limitations. Leave cleanup to the supervising verifier.
` };
}

function groupExists(pid) {
  try { process.kill(-pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function stopGroup(pid) {
  if (!pid || !groupExists(pid)) return;
  process.kill(-pid, 'SIGTERM');
  for (let attempt = 0; attempt < 20 && groupExists(pid); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  if (groupExists(pid)) process.kill(-pid, 'SIGKILL');
  for (let attempt = 0; attempt < 20 && groupExists(pid); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  requireThat(!groupExists(pid), 'HOST_CLEANUP', 'The owned native process group remains live; scratch was preserved.');
}

async function runNative(command, args, prompt, output, state, declaredCommands) {
  const events = [];
  const invalidLines = [];
  let pending = '';
  let stderr = '';
  let timedOut = false;
  let invalidJson = false;
  let unscopedAction = false;
  const started = Date.now();
  const child = spawn(command, args, { cwd: state.scratch, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  state.pid = child.pid;
  const accept = line => {
    if (!line.trim()) return;
    try {
      const parsed = JSON.parse(line);
      if (['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error', 'item.started', 'item.completed'].includes(parsed.type)) {
        const event = { type: parsed.type };
        if (parsed.item) {
          const keys = ['mcp_tool_call', 'command_execution', 'agent_message', 'file_change'].includes(parsed.item.type) ? ['id', 'type', 'server', 'tool', 'arguments', 'result', 'error', 'status', 'command', 'aggregated_output', 'exit_code', 'text', 'changes'] : ['id', 'type'];
          event.item = Object.fromEntries(keys.filter(key => key in parsed.item).map(key => [key, parsed.item[key]]));
          if (parsed.item.type === 'command_execution') {
            let approved = false;
            try { approved = declaredCommands.some(declared => JSON.stringify(declared.argv) === JSON.stringify(commandArgv(parsed.item.command))); } catch {}
            if (!approved) {
              unscopedAction = true;
              event.item.command = '[undeclared command omitted]';
              event.item.aggregated_output = '[undeclared command output omitted]';
            }
          } else if (parsed.item.type === 'mcp_tool_call') {
            const args = parsed.item.arguments ?? {};
            const generated = path.join(state.scratch, 'app/generated');
            const ir = [path.join(generated, 'automaton.json'), path.join(generated, 'symbolic-model.json')];
            const scoped = parsed.item.server === 'sgd' && (
              parsed.item.tool === 'sgd_build' && args.project === path.join(state.scratch, 'app/models/fold.json') && args.jar === path.join(state.scratch, 'tla2tools.jar') && args.out === generated ||
              parsed.item.tool === 'sgd_inspect' && ir.includes(args.ir) ||
              parsed.item.tool === 'sgd_visualize' && args.out === path.join(state.scratch, 'pele') && Array.isArray(args.ir) && args.ir.length === 2 && ir.every(file => args.ir.includes(file))
            );
            if (!scoped) {
              unscopedAction = true;
              event.item.arguments = {};
              event.item.result = null;
              event.item.error = { message: 'Unscoped MCP arguments and return omitted.' };
            }
          } else if (parsed.item.type !== 'agent_message') {
            unscopedAction = true;
            event.item = { id: parsed.item.id, type: parsed.item.type };
          }
        }
        if (parsed.error) event.error = { message: String(parsed.error.message ?? parsed.error) };
        events.push(event);
      }
    } catch { invalidJson = true; invalidLines.push({ type: 'invalid-output', text: '[non-JSON output omitted]' }); }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { pending += chunk; let index; while ((index = pending.indexOf('\n')) !== -1) { accept(pending.slice(0, index)); pending = pending.slice(index + 1); } });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} }, timeoutMs);
  const killTimer = setTimeout(() => { if (timedOut) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }, timeoutMs + 5_000);
  const exit = await new Promise(resolve => {
    child.once('error', error => resolve({ exitCode: null, signal: null, error: error.message }));
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal, error: null }));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
  clearTimeout(timer); clearTimeout(killTimer);
  if (pending) accept(pending);
  if (unscopedAction) for (const event of events) {
    if (event.item?.type === 'agent_message') event.item.text = '[agent prose omitted after an unscoped action]';
    if (event.item?.type === 'command_execution') event.item.aggregated_output = '[tool output omitted after an unscoped action]';
    if (event.item?.type === 'mcp_tool_call') event.item.result = null;
  }
  await writeFile(path.join(output, 'events.jsonl'), `${[...events, ...invalidLines].map(event => redact(JSON.stringify(event))).join('\n')}\n`);
  await writeFile(path.join(output, 'stderr.log'), redact(stderr));
  const result = { ...exit, timedOut, invalidJson, unscopedAction, elapsedSeconds: (Date.now() - started) / 1000 };
  await save(path.join(output, 'process.json'), result);
  return { events, result };
}

function returned(item) {
  requireThat(item.status === 'completed' && !item.error && item.result && !item.result.isError, /approval/i.test(item.error?.message ?? '') ? 'HOST_APPROVAL' : 'HOST_MCP', item.error?.message ?? `${item.tool} did not complete successfully.`);
  const blocks = item.result.content?.filter(block => block.type === 'text') ?? [];
  requireThat(blocks.length === 1, 'HOST_MCP', `${item.tool} returned an unexpected result shape.`);
  const value = JSON.parse(blocks[0].text);
  requireThat(!value.error, 'HOST_MCP', `${item.tool}: ${value.error}`);
  return value;
}

/** Check this fixture's default response contract without treating it as application authority. */
export function validateBuildSummary(value, generated, checked) {
  requireThat(value?.schema === 'sgd-build-summary-v1' && value.operation === 'build' && value.output?.directory === generated,
    'HOST_SUMMARY', 'Build must return the default summary for its actual output directory.');
  const graph = value.graph;
  requireThat(graph?.kind === 'exact-finite' && graph.role === 'partition-control' && graph.name === 'LedgerControl' &&
    Array.isArray(graph.variables) && graph.variables.every(variable => typeof variable === 'string') &&
    [graph.states, graph.edges, graph.initialStates].every(count => Number.isSafeInteger(count) && count > 0) &&
    !('nodes' in graph) && !('transitions' in graph) && !('automaton' in value),
  'HOST_SUMMARY', 'Build summary must describe the finite partition controller without returning the full IR.');
  const verification = value.verification;
  requireThat(verification?.invocation === 'completed' && verification.output === (checked ? 'checked' : 'generated') &&
    verification.freshInvocationLogRetained === !checked && Array.isArray(verification.checks),
  'HOST_SUMMARY', 'Build summary must distinguish current completion from retained check logs.');
  const scopes = [
    { kind: 'controlled-tlc', role: 'row', profile: 'symbolic-owned-v1', scope: 'configured-bounded-witness' },
    { kind: 'symbolic-source', role: 'row', scope: 'accepted-SANY-equality-copy-grammar' },
    { kind: 'symbolic-orbit', role: 'row', scope: 'accepted-equality-copy-grammar' },
    { kind: 'input-oracle', role: 'row', scope: 'configured-reachable-state-input-product' },
    { kind: 'whole-row-binding', role: 'row', scope: 'production-library-and-audited-local-type-closure', boundary: 'per-live-object' },
    { kind: 'controlled-tlc', role: 'control', profile: 'finite-owned-v1', scope: 'configured-finite-model' },
    { kind: 'executable-graph', role: 'control', scope: 'per-live-object' },
    { kind: 'partition-control-source', role: 'control', scope: 'admitted-finite-control-laws' },
    { kind: 'partition-metadata', role: 'families', scope: 'literal-TLA-family-metadata', tlcScope: 'synthetic-metadata-wrapper' },
    { kind: 'partition-composition', role: 'composition', profile: 'unbound-partition-v1', scope: 'complete-row-roles-and-finite-control-laws', boundary: 'unbound-data-report', storageAuthority: false },
  ];
  requireThat(verification.checks.length === scopes.length && scopes.every(expected => verification.checks.filter(check => check && Object.entries(expected).every(([key, expectedValue]) => check[key] === expectedValue)).length === 1),
    'HOST_SUMMARY', 'Build summary must retain separate bounded row, finite control, source, oracle, and unbound composition scopes.');
  requireThat(['applicationIntegration', 'persistence', 'externalEffects'].every(limit => value.limits?.[limit] === 'not-established'),
    'HOST_SUMMARY', 'Build summary must retain its application, persistence, and external-effect limits.');
  const artifacts = value.output.artifacts;
  const relativeArtifact = file => typeof file === 'string' && file !== '' && file !== '.' && file !== '..' &&
    !file.includes('\\') && !path.posix.isAbsolute(file) && !file.startsWith('../') && path.posix.normalize(file) === file;
  requireThat(Array.isArray(artifacts) && artifacts.length > 0 && artifacts.every(relativeArtifact) && new Set(artifacts).size === artifacts.length && !artifacts.includes('tlc.log'),
    'HOST_SUMMARY', 'Build summary must list distinct relative artifacts and no invented top-level partition log.');
  requireThat(Array.isArray(value.evidence) && value.evidence.every(item => item && typeof item.path === 'string' &&
    artifacts.some(file => path.join(generated, file) === item.path) &&
    ['verification', 'log', 'orbit', 'input-oracle', 'source-plan'].includes(item.role) &&
    item.freshness === (checked ? 'retained-output' : 'current-invocation')) &&
    new Set(value.evidence.map(item => item.path)).size === value.evidence.length,
  'HOST_SUMMARY', 'Build evidence must name an actual listed output with the correct invocation freshness.');
  for (const [file, role] of [
    ['verification.json', 'verification'], ['partition-plan.json', 'source-plan'], ['row-binding-plan.json', 'source-plan'],
    ['models/row/row-binding-plan.json', 'source-plan'], ['models/row/orbit-proof.json', 'orbit'],
    ['models/row/input-verification.json', 'input-oracle'], ['models/row/input-oracle.dot', 'input-oracle'],
    ['models/row/input-oracle.log', 'log'], ['models/row/tlc.log', 'log'], ['models/row/verification.json', 'verification'],
    ['models/control/tlc.log', 'log'], ['models/control/verification.json', 'verification'],
    ['models/families/semantic.xml', 'source-plan'], ['models/families/tlc.log', 'log'],
  ]) requireThat(value.evidence.some(item => item.path === path.join(generated, file) && item.role === role),
    'HOST_SUMMARY', `Missing scoped partition evidence: ${file}`);
  return value;
}

/** Compare reports with the emitted IR, managed inventory, and real files. */
export async function validateBuildSummaryArtifacts(value, generated, checked, automaton, inventory) {
  const summary = validateBuildSummary(value, generated, checked);
  requireThat(automaton.kind === summary.graph.kind && automaton.name === summary.graph.name &&
    JSON.stringify(automaton.variables.map(variable => variable.name)) === JSON.stringify(summary.graph.variables) &&
    automaton.nodes.length === summary.graph.states && automaton.edges.length === summary.graph.edges && automaton.initial.length === summary.graph.initialStates,
  'HOST_SUMMARY', 'Build summary graph differs from the emitted controller IR.');
  requireThat(inventory.version === 1 && Array.isArray(inventory.files) &&
    JSON.stringify([...inventory.files].sort()) === JSON.stringify([...summary.output.artifacts].sort()),
  'HOST_SUMMARY', 'Build summary artifact list differs from the published managed inventory.');
  const physicalRoot = await realpath(generated);
  for (const file of summary.output.artifacts) {
    let location = generated;
    const segments = file.split('/');
    for (const [index, segment] of segments.entries()) {
      location = path.join(location, segment);
      const entry = await lstat(location).catch(() => null);
      requireThat(entry && !entry.isSymbolicLink() && (index === segments.length - 1 ? entry.isFile() : entry.isDirectory()),
        'HOST_SUMMARY', `Build summary artifact is absent, not a regular file, or traverses a symlink: ${file}`);
    }
    requireThat(inside(physicalRoot, await realpath(location)), 'HOST_SUMMARY', `Build summary artifact resolves outside the generated output: ${file}`);
  }
  return summary;
}

function observedFailures(events, declaredCommands) {
  const completed = events.filter(event => event.type === 'item.completed');
  for (const event of completed) if (event.item?.type === 'mcp_tool_call') returned(event.item);
  for (const event of completed) if (event.item?.type === 'command_execution') {
    const item = event.item;
    const argv = commandArgv(item.command);
    const declared = declaredCommands.find(command => JSON.stringify(command.argv) === JSON.stringify(argv));
    requireThat(declared, 'HOST_COMMAND', 'An undeclared command was executed.');
    requireThat(item.exit_code === 0 && item.status === 'completed', declared.id === 'native' ? 'HOST_NATIVE' : 'HOST_COMMAND', `Trusted helper ${declared.id} failed with exit ${item.exit_code}; inspect its command/native logs.`);
  }
  requireThat(!events.some(event => ['error', 'turn.failed'].includes(event.type)), 'HOST_TURN', 'Native Codex reported an error or failed turn.');
}

export function validateProtocol(events, scratch, declaredCommands) {
  const generated = path.join(scratch, 'app/generated');
  observedFailures(events, declaredCommands);
  const completed = events.map((event, index) => ({ event, index })).filter(({ event }) => event.type === 'item.completed');
  requireThat(completed.every(({ event }) => !event.item || ['agent_message', 'mcp_tool_call', 'command_execution'].includes(event.item.type)), 'HOST_ACTION', 'An undeclared native action or file-writing tool was used.');
  const starts = events.map((event, index) => ({ event, index })).filter(({ event }) => event.type === 'item.started');
  for (const start of starts) {
    requireThat(start.event.item && ['agent_message', 'mcp_tool_call', 'command_execution'].includes(start.event.item.type), 'HOST_ACTION', 'An undeclared native action was started.');
    const terminal = completed.filter(entry => entry.event.item?.id === start.event.item.id);
    requireThat(terminal.length === 1 && terminal[0].index > start.index && terminal[0].event.item.type === start.event.item.type, 'HOST_EVENT', 'Every action start needs one matching later terminal event.');
    if (start.event.item.type === 'command_execution') assert.equal(start.event.item.command, terminal[0].event.item.command);
    if (start.event.item.type === 'mcp_tool_call') for (const field of ['server', 'tool', 'arguments']) assert.deepEqual(start.event.item[field], terminal[0].event.item[field]);
  }
  const startedAt = entry => {
    const matching = starts.filter(({ event }) => event.item?.id === entry.event.item.id);
    requireThat(matching.length === 1, 'HOST_EVENT', `Missing or repeated start for ${entry.event.item.id}.`);
    return matching[0].index;
  };
  for (const entry of completed) if (['command_execution', 'mcp_tool_call'].includes(entry.event.item?.type)) startedAt(entry);
  const commandEvents = completed.filter(({ event }) => event.item?.type === 'command_execution');
  const matchedCommands = new Map();
  for (const entry of commandEvents) {
    const item = entry.event.item;
    const argv = commandArgv(item.command);
    const declared = declaredCommands.find(command => JSON.stringify(command.argv) === JSON.stringify(argv));
    requireThat(declared && item.exit_code === 0 && item.status === 'completed' && item.aggregated_output?.includes(declared.marker), 'HOST_COMMAND', 'An undeclared or unsuccessful shell command was executed.');
    matchedCommands.set(declared.id, [...(matchedCommands.get(declared.id) ?? []), entry]);
  }
  requireThat(declaredCommands.every(command => matchedCommands.has(command.id)) && matchedCommands.get('native').length === 1, 'HOST_COMMAND', 'Require every exact trusted inspection command and exactly one native-check invocation.');
  const calls = completed.filter(({ event }) => event.item?.type === 'mcp_tool_call');
  for (const { event } of calls) {
    requireThat(event.item.server === 'sgd' && allowedTools.includes(event.item.tool), 'HOST_MCP', 'A tool outside the scoped SGD server was called.');
    returned(event.item);
  }
  const matching = (tool, predicate) => calls.filter(({ event }) => event.item.tool === tool && predicate(event.item.arguments));
  const project = path.join(scratch, 'app/models/fold.json');
  const jar = path.join(scratch, 'tla2tools.jar');
  const validBuild = args => args.project === project && args.jar === jar && args.out === generated && !('detail' in args);
  const build = matching('sgd_build', args => validBuild(args) && args.check !== true);
  const check = matching('sgd_build', args => validBuild(args) && args.check === true);
  const control = matching('sgd_inspect', args => args.ir === path.join(generated, 'automaton.json'));
  const row = matching('sgd_inspect', args => args.ir === path.join(generated, 'symbolic-model.json'));
  const visual = matching('sgd_visualize', args => args.out === path.join(scratch, 'pele') && Array.isArray(args.ir) && args.ir.length === 2 && args.ir.includes(path.join(generated, 'automaton.json')) && args.ir.includes(path.join(generated, 'symbolic-model.json')));
  requireThat(calls.length === 5 && [build, check, control, row, visual].every(values => values.length === 1), 'HOST_MISSING_TOOL', 'Require exactly fresh build, two IR inspections, visualization, and build(check:true) through MCP.');
  requireThat(['skill', 'modeling', 'partition', 'application'].every(id => matchedCommands.get(id).some(entry => entry.index < startedAt(build[0]))), 'HOST_TOOL_ORDER', 'Read the complete fixed context before generation.');
  requireThat(build[0].index < startedAt(control[0]) && build[0].index < startedAt(row[0]) && Math.max(control[0].index, row[0].index) < startedAt(visual[0]), 'HOST_TOOL_ORDER', 'Inspect and render the completed fresh generation.');
  requireThat(matchedCommands.get('generated').some(entry => visual[0].index < startedAt(entry) && entry.index < startedAt(check[0])) && check[0].index < startedAt(matchedCommands.get('native')[0]), 'HOST_TOOL_ORDER', 'Read fresh Pele files, complete check:true, then start native checks.');
  validateBuildSummary(returned(build[0].event.item), generated, false);
  validateBuildSummary(returned(check[0].event.item), generated, true);
  return { calls, build, check, control, row, visual, matchedCommands };
}

async function inspectEvidence(events, scratch, expected, declaredCommands) {
  const generated = path.join(scratch, 'app/generated');
  const jar = path.join(scratch, 'tla2tools.jar');
  const { calls, build, check, control, row, visual } = validateProtocol(events, scratch, declaredCommands);
  for (const directory of [generated, path.join(scratch, 'pele'), path.join(scratch, 'native')]) await identities(directory);
  const automaton = await json(path.join(generated, 'automaton.json'));
  const symbolic = await json(path.join(generated, 'symbolic-model.json'));
  assert.deepEqual(returned(control[0].event.item), automaton);
  assert.deepEqual(returned(row[0].event.item), symbolic);
  const inventory = await json(path.join(generated, '.sgd-generated.json'));
  await validateBuildSummaryArtifacts(returned(build[0].event.item), generated, false, automaton, inventory);
  await validateBuildSummaryArtifacts(returned(check[0].event.item), generated, true, automaton, inventory);
  requireThat(automaton.kind === 'exact-finite' && automaton.name === 'LedgerControl' && symbolic.kind === 'symbolic-owned' && symbolic.name === 'LedgerRow', 'HOST_IR', 'Unexpected generated model identities.');
  const verification = await json(path.join(generated, 'verification.json'));
  const rowReceipt = await json(path.join(generated, 'models/row/verification.json'));
  const controlReceipt = await json(path.join(generated, 'models/control/verification.json'));
  const oracle = await json(path.join(generated, 'models/row/input-verification.json'));
  const orbit = await json(path.join(generated, 'models/row/orbit-proof.json'));
  const jarDigest = digest(await readFile(jar));
  requireThat(verification.kind === 'controlled-partition-fold' && verification.generation === 'closed-data-fold' && verification.storageAuthority === false, 'HOST_RECEIPT', 'Missing controlled unbound partition receipt.');
  requireThat(rowReceipt.kind === 'tlc-symbolic-completed' && rowReceipt.generation === 'whole-row-authority' && controlReceipt.kind === 'tlc-finite-completed' && oracle.kind === 'tlc-finite-input-oracle' && oracle.checkedCases === oracle.acceptedCases && orbit.kind === 'equality-copy-orbits' && orbit.states.length > 0, 'HOST_RECEIPT', 'Missing completed row/control/oracle/orbit evidence.');
  for (const receipt of [verification.control, verification.metadata, rowReceipt, controlReceipt, oracle.base, oracle.oracle]) assert.equal(receipt.jarSha256, jarDigest);
  for (const source of verification.source) assert.equal(source.sha256, expected[source.path], `Receipt source differs: ${source.path}`);
  requireThat(['Cargo.toml', 'src/facts.rs', 'src/lib.rs'].every(file => verification.source.some(source => source.path === file)), 'HOST_RECEIPT', 'The production library source scope is incomplete.');
  const binding = await json(path.join(generated, 'row-binding-plan.json'));
  assert.deepEqual(binding.facts.map(fact => ({ name: fact.name, fields: fact.fields.map(field => ({ name: field.name, payload: field.payload, provenance: field.provenance })) })), [{ name: 'LedgerFact', fields: ['symbol', 'key', 'time', 'value', 'received'].map(name => ({ name, payload: name !== 'received', provenance: name === 'received' })) }]);
  const visualReturn = returned(visual[0].event.item);
  for (const file of ['index.html', 'structure.svg', 'structure.mmd', 'models.json']) {
    requireThat(visualReturn.files.includes(file) && (await readFile(path.join(scratch, 'pele', file))).length > 0, 'HOST_PELE', `Missing fresh Pele file: ${file}`);
  }
  const mermaid = await readFile(path.join(scratch, 'pele/structure.mmd'), 'utf8');
  requireThat(mermaid.includes('CloseRefused') && mermaid.includes('storedProvenance') && mermaid.includes('rejectedProvenance'), 'HOST_PELE', 'Pele does not retain the refusal and provenance relations.');
  const native = await json(path.join(scratch, 'native/commands.json'));
  assert.equal(native.typescript, '7.0.2');
  assert.deepEqual(native.commands.map(({ id, exitCode, signal, error }) => ({ id, exitCode, signal, error })), ['typescript-generated', 'typescript-app', 'typescript-behavior', 'rust-behavior'].map(id => ({ id, exitCode: 0, signal: null, error: null })));
  const compiler = path.join(scratch, 'plugin/runtime/node_modules/typescript/bin/tsc');
  assert.deepEqual(native.commands.map(command => command.args), [
    [compiler, '-p', path.join(generated, 'typescript/tsconfig.json')],
    [compiler, '-p', path.join(scratch, 'app/tsconfig.json')],
    [path.join(scratch, 'app/ts-check.js')],
    ['test', '--offline', '--locked', '--manifest-path', path.join(scratch, 'app/Cargo.toml'), '--target-dir', path.join(scratch, 'app/target'), '--', '--nocapture'],
  ]);
  assert.equal(native.commands[3].command, 'cargo');
  const expectedObservations = await json(path.join(fixture, 'expected-observations.json'));
  const sorted = values => [...values].sort((a, b) => a.scenario.localeCompare(b.scenario));
  for (const [id, marker] of [['typescript-behavior', 'SGD_HOST_LEDGER_TS '], ['rust-behavior', 'SGD_HOST_LEDGER_RUST ']]) {
    const stdout = await readFile(path.join(scratch, 'native', `${id}.stdout.log`), 'utf8');
    const observed = stdout.split('\n').filter(line => line.includes(marker)).map(line => JSON.parse(line.slice(line.indexOf(marker) + marker.length)));
    assert.deepEqual(sorted(observed), sorted(expectedObservations), `${id}: actual complete-row observations differ`);
  }
  return { mcp: calls.map(({ event }) => ({ tool: event.item.tool, arguments: event.item.arguments, status: event.item.status })), native, modelScope: { payloadAtoms: oracle.domains.Values.length, provenanceAtoms: oracle.domains.Receipts.length, sourceScope: verification.sourceScope, storageAuthority: false } };
}

async function main() {
  const config = options(process.argv.slice(2));
  if (!config) return;
  requireThat(process.platform !== 'win32', 'HOST_PLATFORM', 'This verifier requires POSIX process groups; Windows is not supported.');
  const output = await resolveEvidenceOutput(config.plugin, config.out ?? path.join(root, '.runtime', `codex-host-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`));
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  const result = { version: 1, scope, status: 'failed', evidence: output, workflowTimeoutSeconds: 360, claims: { pluginManifestDiscovery: false, permanentInstallation: false, persistence: false } };
  const state = { scratch: null, pid: null, interrupted: null };
  const interrupt = signal => { state.interrupted = signal; if (state.pid) { try { process.kill(-state.pid, 'SIGTERM'); } catch {} } };
  const onInterrupt = () => interrupt('SIGINT');
  const onTerminate = () => interrupt('SIGTERM');
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
  try {
    requireThat(Number(process.versions.node.split('.')[0]) >= 22, 'HOST_PREREQUISITE', 'Node.js 22 or newer is required.');
    for (const [command, args, label] of [[config.codex, ['--version'], 'Native Codex CLI'], ['java', ['-version'], 'Java'], ['cargo', ['--version'], 'Cargo'], ['rustfmt', ['--version'], 'rustfmt']]) result[label] = prerequisite(command, args, label);
    const help = prerequisite(config.codex, ['exec', '--help'], 'Codex exec');
    requireThat(['--ignore-user-config', '--ephemeral', '--strict-config', '--json', '--sandbox'].every(flag => help.includes(flag)), 'HOST_CLI_VERSION', 'The native CLI lacks required per-invocation flags. Update it separately before this check.');
    const login = spawnSync(config.codex, ['login', 'status'], { stdio: 'ignore', timeout: 15_000 });
    requireThat(!login.error && login.status === 0, 'HOST_LOGIN', 'An existing native Codex login is required. This verifier does not log in, reset, or inspect credentials.');
    requireThat(await exists(path.resolve(config.plugin)), 'HOST_RUNTIME', 'The --plugin directory is missing. Supply an already prepared native Codex plugin.');
    requireThat(await exists(path.resolve(config.jar)), 'HOST_JAR', 'The --jar file is missing. Supply the existing pinned TLC JAR.');
    const pluginSource = await realpath(path.resolve(config.plugin));
    const jarSource = await realpath(path.resolve(config.jar));
    requireThat((await lstat(pluginSource)).isDirectory() && (await lstat(jarSource)).isFile(), 'HOST_PREREQUISITE', 'Supply a prepared plugin directory and a regular pinned JAR file.');
    requireThat(await exists(path.join(pluginSource, 'runtime/node_modules/typescript/package.json')), 'HOST_RUNTIME', 'Prepare the standalone native plugin runtime before verification; no setup or install runs here.');
    const platform = await json(path.join(pluginSource, 'runtime/runtime-platform.json'));
    requireThat(platform.version === 1 && platform.platform === process.platform && platform.arch === process.arch, 'HOST_RUNTIME', 'The prepared plugin platform/architecture does not match this host.');
    const analyzer = path.join(pluginSource, 'runtime/bin/sgd-rust-bindings');
    requireThat(await access(analyzer, constants.X_OK).then(() => true, () => false), 'HOST_RUNTIME', 'The prepared native Rust analyzer is missing or not executable.');
    state.scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sgd-codex-host-')));
    const scratch = state.scratch;
    await cp(pluginSource, path.join(scratch, 'plugin'), { recursive: true });
    await cp(jarSource, path.join(scratch, 'tla2tools.jar'));
    await cp(fixture, path.join(scratch, 'app'), { recursive: true });
    const expected = await identities(path.join(scratch, 'app'));
    requireThat(!(await exists(path.join(scratch, 'app/generated'))), 'HOST_FIXTURE', 'The original fixture must not contain generated output.');
    const plugin = path.join(scratch, 'plugin');
    for (const file of await files(plugin)) if ((await lstat(file)).isSymbolicLink()) requireThat(inside(plugin, await realpath(file)), 'HOST_RUNTIME', 'The copied runtime has a symlink outside the isolated plugin.');
    assert.equal((await json(path.join(plugin, 'runtime/node_modules/typescript/package.json'))).version, '7.0.2');
    const expectedPlugin = await identities(plugin);
    await save(path.join(output, 'sources.json'), { fixture: expected, plugin: expectedPlugin, jarSha256: digest(await readFile(path.join(scratch, 'tla2tools.jar'))), runtimePlatform: platform, runtimePackage: await json(path.join(plugin, 'runtime/package.json')) });
    const server = (await json(path.join(plugin, '.mcp.json'))).mcpServers?.sgd;
    requireThat(server?.command === 'node' && Array.isArray(server.args) && server.args.length === 2 && server.args[1] === 'mcp' && !server.env, 'HOST_MANIFEST', 'Expected the prepared plugin manifest to declare its local Node SGD MCP launcher.');
    const cwd = path.resolve(plugin, server.cwd ?? '.');
    const launcher = path.resolve(cwd, server.args[0]);
    requireThat(inside(plugin, cwd) && inside(plugin, launcher) && await exists(launcher), 'HOST_MANIFEST', 'The MCP launcher must remain inside the copied plugin.');
    const prepared = promptFor(scratch);
    const args = ['-a', 'never', '--strict-config', '-c', `mcp_servers.sgd.command=${JSON.stringify(server.command)}`, '-c', `mcp_servers.sgd.args=${JSON.stringify([launcher, 'mcp'])}`, '-c', `mcp_servers.sgd.cwd=${JSON.stringify(cwd)}`, '-c', `mcp_servers.sgd.enabled_tools=${JSON.stringify(allowedTools)}`, '-c', 'mcp_servers.sgd.tools.sgd_build.approval_mode="approve"', '-c', 'mcp_servers.sgd.tools.sgd_visualize.approval_mode="approve"', 'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', scratch, '--json', '--color', 'never', '-'];
    await save(path.join(output, 'invocation.json'), { command: config.codex, args, modelOverride: false, freshGeneratedOutputAbsent: true });
    await writeFile(path.join(output, 'prompt.txt'), prepared.text);
    requireThat(!state.interrupted, 'HOST_INTERRUPTED', `Interrupted by ${state.interrupted} before native execution.`);
    console.log(`Running one native Codex workflow. Evidence: ${output}`);
    const executed = await runNative(config.codex, args, prepared.text, output, state, prepared.commands);
    result.process = executed.result;
    const messages = executed.events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message');
    await writeFile(path.join(output, 'final.txt'), redact(messages.at(-1)?.item.text ?? ''));
    requireThat(!executed.result.timedOut, 'HOST_TIMEOUT', `The single native workflow exceeded 360 seconds; its process group was stopped. Evidence: ${output}`);
    requireThat(!state.interrupted, 'HOST_INTERRUPTED', `Interrupted by ${state.interrupted}.`);
    requireThat(!executed.result.unscopedAction, 'HOST_ACTION', 'The agent attempted an unscoped action. Its arguments/output and related prose were omitted from retained evidence.');
    observedFailures(executed.events, prepared.commands);
    requireThat(executed.result.exitCode === 0 && !executed.result.invalidJson, 'HOST_PROCESS', 'Native Codex failed or returned invalid JSONL. Inspect process.json and stderr.log.');
    assert.deepEqual(await identities(path.join(scratch, 'app'), ['generated', 'target', 'ts-check.js']), expected, 'The original fixture file set or source bytes changed.');
    assert.deepEqual(await identities(plugin), expectedPlugin, 'The copied prepared plugin file set or bytes changed.');
    result.observed = await inspectEvidence(executed.events, scratch, expected, prepared.commands);
    result.status = 'passed';
  } catch (error) {
    result.failure = { code: error.code ?? 'HOST_VERIFICATION', message: redact(error.message) };
  } finally {
    if (state.scratch) {
      try {
        await stopGroup(state.pid);
        const active = spawnSync('pgrep', ['-f', state.scratch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')], { encoding: 'utf8' });
        requireThat(active.status === 1, 'HOST_CLEANUP', 'An owned-scratch process remains live or liveness is uncertain; scratch was preserved.');
        requireThat((await lstat(state.scratch)).isDirectory(), 'HOST_CLEANUP', 'The owned scratch root changed; scratch was preserved.');
        requireThat((await lstat(path.join(state.scratch, 'app'))).isDirectory(), 'HOST_CLEANUP', 'The owned app root changed; scratch was preserved.');
        for (const [source, destination] of result.process?.unscopedAction ? [] : [['app/generated', 'generated'], ['native', 'native'], ['pele', 'pele']]) if (await exists(path.join(state.scratch, source))) {
          await identities(path.join(state.scratch, source));
          await cp(path.join(state.scratch, source), path.join(output, destination), { recursive: true, filter: file => !['node_modules', 'target', 'dist'].includes(path.basename(file)) });
        }
        const measured = spawnSync('du', ['-sk', state.scratch], { encoding: 'utf8' });
        requireThat(measured.status === 0, 'HOST_CLEANUP', 'Could not measure the owned scratch tree; scratch was preserved.');
        result.cleanup = { removedBytes: Number(measured.stdout.trim().split(/\s+/)[0]) * 1024, scratchRetained: false };
        await rm(state.scratch, { recursive: true });
      } catch (error) {
        result.status = 'failed';
        result.failure ??= { code: 'HOST_CLEANUP', message: redact(error.message) };
        result.cleanup = { removedBytes: 0, scratchRetained: true, scratch: state.scratch, reason: redact(error.message) };
      }
    } else result.cleanup = { removedBytes: 0, scratchRetained: false };
    const disk = await exists('/System/Volumes/Data') ? '/System/Volumes/Data' : os.tmpdir();
    const free = spawnSync('df', ['-h', disk], { encoding: 'utf8' });
    result.cleanup.freeSpace = free.status === 0 ? free.stdout.trim() : 'unavailable';
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
    await save(path.join(output, 'result.json'), result);
    const archive = `${output}.archive.tmp`;
    const archived = spawnSync('tar', ['-czf', archive, '-C', output, '.'], { encoding: 'utf8' });
    if (archived.status === 0) await rename(archive, path.join(output, 'evidence.tgz'));
    else { result.status = 'failed'; result.failure ??= { code: 'HOST_ARCHIVE', message: redact(archived.stderr ?? 'tar failed') }; if (await exists(archive)) await rm(archive); await save(path.join(output, 'result.json'), result); }
    console.log(JSON.stringify({ status: result.status, result: path.join(output, 'result.json'), failure: result.failure ?? null, cleanup: result.cleanup }, null, 2));
    if (result.status !== 'passed') process.exitCode = 1;
  }
}

export { commandArgv, shellCommand };
if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`${error.code ?? 'HOST_ARGUMENT'}: ${redact(error.message)}`); process.exitCode = 1; });
}
