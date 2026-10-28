import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainBindingSchema, type DomainBinding } from './domain-types.js';
import { validateExecutableGraph, type ExactFiniteAutomaton } from './finite-types.js';
import { sha256 } from './dot.js';
import type { GeneratedFile } from './types.js';

const leanVersion = '4.35.0';
// The pinned macOS toolchain exceeded a 512 MiB allocation cap during Std startup.
// This is an execution cap, not a claim about resident or peak process memory.
const leanMemoryMiB = 1024;
const protocolFile = fileURLToPath(new URL('../proofs/domain/DomainProtocol.lean', import.meta.url));
const maximumSourceBytes = 8 * 1024 * 1024;
const maximumDiagnosticBytes = 8 * 1024 * 1024;
const allowedAxioms = new Set(['propext', 'Quot.sound']);
const protocolTheorems = [
  'SGD.DomainProtocol.valid_implies_contract',
  'SGD.DomainProtocol.lookup_transition_sound',
  'SGD.DomainProtocol.lookup_none_iff_no_transition',
  'SGD.DomainProtocol.pending_has_unique_outcomes',
  'SGD.DomainProtocol.pending_rejects_other_events',
  'SGD.DomainProtocol.pending_entry_is_owned',
  'SGD.DomainProtocol.completion_cannot_leave_pending',
];
const projectTheorems = [
  'SGD.GeneratedDomain.protocol_valid',
  'SGD.GeneratedDomain.protocol_contract',
  'SGD.GeneratedDomain.lookup_is_transition',
  'SGD.GeneratedDomain.lookup_refusal_exact',
  'SGD.GeneratedDomain.pending_outcomes',
  'SGD.GeneratedDomain.pending_events',
  'SGD.GeneratedDomain.pending_entries',
  'SGD.GeneratedDomain.completion_targets',
];

type ProofStage = 'version' | 'protocol' | 'project';
export interface DomainProofDiagnostic {
  stage: ProofStage;
  exitCode: string | number;
  signal: string | null;
  outputComplete: boolean;
  stdout: string;
  stderr: string;
}

export class DomainProofError extends Error {
  constructor(message: string, readonly diagnostics: readonly DomainProofDiagnostic[], cause?: unknown) {
    super(message.startsWith('TLC208:') ? message : `TLC208: ${message}`, { cause });
    this.name = 'DomainProofError';
  }
}

interface NumericProtocol {
  stateCount: number;
  eventCount: number;
  initial: number;
  edges: Array<{ source: number; event: number; target: number }>;
  operations: Array<{ start: number; success: number; failure: number }>;
}

export interface DomainProofVerification {
  schema: 'sgd-domain-proof-v1';
  profile: 'serial-port-outcomes-v1';
  leanVersion: '4.35.0';
  graphSha256: string;
  bindingSha256: string;
  protocolDataSha256: string;
  trustedModuleSha256: string;
  projectProofSha256: string;
  axioms: string[];
  limits: { threads: 1; memoryMiB: 1024; compilationTimeoutMs: 90000 };
  states: Array<{ index: number; id: string }>;
  events: Array<{ index: number; name: string }>;
  operations: Array<{ index: number; name: string; port: string; start: number; success: number; failure: number }>;
  scope: {
    input: 'exact-finite-graph';
    graphProvenance: 'controlled-TLC-required-by-build-caller';
    proved: 'finite-serial-port-protocol';
    lifetime: 'per-live-owner';
    nativeCompilerCorrespondence: 'not-proved';
    externalEffectCorrectness: 'not-proved';
    persistence: 'not-proved';
  };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function fail(detail: string, diagnostics: readonly DomainProofDiagnostic[] = [], cause?: unknown): never {
  throw new DomainProofError(detail, [...diagnostics], cause);
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function lookup(map: ReadonlyMap<string, number>, key: string, kind: string): number {
  const value = map.get(key);
  if (value === undefined) fail(`unknown ${kind} ${JSON.stringify(key)} in domain proof input`);
  return value;
}

function numericProtocol(graph: ExactFiniteAutomaton, domain: DomainBinding) {
  const states = [...graph.nodes].sort((left, right) => compare(left.id, right.id))
    .map((node, index) => ({ index, id: node.id }));
  const events = [...graph.actions].sort(compare).map((name, index) => ({ index, name }));
  const stateIndex = new Map(states.map(state => [state.id, state.index]));
  const eventIndex = new Map(events.map(event => [event.name, event.index]));
  const initial = graph.initial[0];
  if (initial === undefined) fail('domain proof requires one initial state');
  const operations = domain.operations.map((operation, index) => ({
    index, name: operation.name, port: operation.port,
    start: lookup(eventIndex, operation.start, 'start action'),
    success: lookup(eventIndex, operation.success, 'success action'),
    failure: lookup(eventIndex, operation.failure, 'failure action'),
  }));
  const data: NumericProtocol = {
    stateCount: states.length,
    eventCount: events.length,
    initial: lookup(stateIndex, initial, 'initial state'),
    edges: graph.edges.map(edge => ({ source: lookup(stateIndex, edge.from, 'state'),
      event: lookup(eventIndex, edge.event, 'action'), target: lookup(stateIndex, edge.to, 'state') }))
      .sort((left, right) => left.source - right.source || left.event - right.event || left.target - right.target),
    operations: operations.map(operation => ({ start: operation.start, success: operation.success, failure: operation.failure })),
  };
  return { data, states, events, operations };
}

/** Only internally produced natural-number literals enter Lean source. Names and ports stay JSON data. */
function projectSource(data: NumericProtocol): string {
  const edges = data.edges.map(edge => `    ⟨${edge.source}, ${edge.event}, ${edge.target}⟩`).join(',\n');
  const operations = data.operations.map(operation => `    ⟨${operation.start}, ${operation.success}, ${operation.failure}⟩`).join(',\n');
  return `import DomainProtocol

set_option maxRecDepth 65536
set_option maxHeartbeats 2000000
namespace SGD.GeneratedDomain
open SGD.DomainProtocol

def model : Model := {
  stateCount := ${data.stateCount}
  eventCount := ${data.eventCount}
  initial := ${data.initial}
  edges := [
${edges}]
  operations := [
${operations}]
}

theorem protocol_valid : valid model = true := by decide

theorem protocol_contract : Contract model := valid_implies_contract model protocol_valid

theorem lookup_is_transition (source event target : Nat)
    (found : lookupEdge model.edges source event = some target) :
    Transition model source event target := lookup_transition_sound model source event target found

theorem lookup_refusal_exact (source event : Nat) :
    lookupEdge model.edges source event = none ↔ ¬ ∃ target, Transition model source event target :=
  lookup_none_iff_no_transition model source event

theorem pending_outcomes (operation : Operation) (member : operation ∈ model.operations)
    (state : Nat) (pending : Pending model operation state) :
    (∃ successTarget, Transition model state operation.success successTarget ∧
      ∀ other, Transition model state operation.success other → other = successTarget) ∧
    (∃ failureTarget, Transition model state operation.failure failureTarget ∧
      ∀ other, Transition model state operation.failure other → other = failureTarget) :=
  pending_has_unique_outcomes model protocol_valid operation member state pending

theorem pending_events (operation : Operation) (member : operation ∈ model.operations)
    (state event : Nat) (pending : Pending model operation state)
    (notSuccess : event ≠ operation.success) (notFailure : event ≠ operation.failure) :
    ¬ Enabled model state event :=
  pending_rejects_other_events model protocol_valid operation member state event pending notSuccess notFailure

theorem pending_entries (operation : Operation) (member : operation ∈ model.operations)
    (state : Nat) (pending : Pending model operation state)
    (source event : Nat) (edge : Transition model source event state) : event = operation.start :=
  pending_entry_is_owned model protocol_valid operation member state pending source event edge

theorem completion_targets (operation : Operation) (member : operation ∈ model.operations)
    (source event target : Nat) (edge : Transition model source event target)
    (outcome : event = operation.success ∨ event = operation.failure) :
    Pending model operation source ∧ ¬ AnyPending model target :=
  completion_cannot_leave_pending model protocol_valid operation member source event target edge outcome

end SGD.GeneratedDomain
${projectTheorems.map(theorem => `#print axioms ${theorem}`).join('\n')}
`;
}

function proofEnvironment(home: string, temporary: string, modules: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
    TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    LEAN_PATH: modules, LANG: 'C', LC_ALL: 'C',
  };
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATHEXT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function checkDiagnostics(diagnostic: DomainProofDiagnostic, expected: readonly string[]): string[] {
  const text = `${diagnostic.stdout}\n${diagnostic.stderr}`;
  if (/\b(?:error|warning)(?:\([^\r\n)]*\))?\s*:/i.test(text) || /\bsorryAx\b|\buses [`'"]?sorry\b|\bnative_decide\b|\bPANIC\b|unreachable code has been reached/.test(text)) {
    fail(`Lean ${diagnostic.stage} emitted an error, warning, or disallowed proof dependency:\n${text.slice(-16_384)}`, [diagnostic]);
  }
  const seen = new Map<string, number>();
  const axioms = new Set<string>();
  const pattern = /'([^'\r\n]+)'\s+(does not depend on any axioms|depends on axioms:\s*\[([^\]]*)\])/g;
  for (const match of text.matchAll(pattern)) {
    const name = match[1];
    if (name === undefined) continue;
    seen.set(name, (seen.get(name) ?? 0) + 1);
    for (const axiom of (match[3] ?? '').split(',').map(value => value.trim()).filter(Boolean)) {
      if (!allowedAxioms.has(axiom)) fail(`Lean ${diagnostic.stage} reported disallowed axiom ${axiom}`, [diagnostic]);
      axioms.add(axiom);
    }
  }
  for (const theorem of expected) {
    if (seen.get(theorem) !== 1) fail(`Lean ${diagnostic.stage} did not produce exactly one axiom report for ${theorem}`, [diagnostic]);
  }
  return [...axioms].sort(compare);
}

/** The caller must provide the actual trusted Lean executable, not user Lean source. */
export async function verifyDomainProof(input: {
  automaton: ExactFiniteAutomaton;
  domain: DomainBinding;
  lean: string;
}): Promise<{ files: GeneratedFile[]; verification: DomainProofVerification }> {
  const diagnostics: DomainProofDiagnostic[] = [];
  let directory: string | undefined;
  let primaryFailure: DomainProofError | undefined;
  try {
    const graph = validateExecutableGraph(input.automaton);
    const domain = DomainBindingSchema.parse(input.domain);
    if (!isAbsolute(input.lean)) fail('provide an absolute path to the Lean 4.35.0 executable');
    const executable = await realpath(input.lean);
    if (!(await lstat(executable)).isFile()) fail('the supplied Lean executable must be a regular file');
    const trustedSource = await readFile(protocolFile, 'utf8');
    const protocol = numericProtocol(graph, domain);
    const generatedSource = projectSource(protocol.data);
    if (Buffer.byteLength(generatedSource) > maximumSourceBytes) fail('domain proof source exceeds the supported 8 MiB bound');
    directory = await realpath(await mkdtemp(join(tmpdir(), 'sgd-domain-proof-')));
    const workspace = directory;
    const sources = join(workspace, 'source');
    const modules = join(workspace, 'modules');
    const home = join(workspace, 'home');
    const temporary = join(workspace, 'temporary');
    await Promise.all([sources, modules, home, temporary].map(path => mkdir(path, { mode: 0o700 })));
    const env = proofEnvironment(home, temporary, modules);
    const normalize = (text: string): string => text.replaceAll(workspace, '<proof-workspace>')
      .replaceAll(workspace.replaceAll('\\', '/'), '<proof-workspace>');
    const run = (stage: ProofStage, args: string[], timeout: number): Promise<DomainProofDiagnostic> =>
      new Promise((resolve, reject) => {
        execFile(executable, args, { cwd: sources, env, encoding: 'utf8', timeout,
          maxBuffer: maximumDiagnosticBytes, killSignal: 'SIGKILL', windowsHide: true }, (error, stdout, stderr) => {
          const diagnostic: DomainProofDiagnostic = {
            stage, exitCode: error?.code ?? 0, signal: error?.signal ?? null,
            outputComplete: error?.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            stdout: normalize(stdout), stderr: normalize(stderr),
          };
          diagnostics.push(diagnostic);
          if (error) {
            reject(new DomainProofError(`Lean ${stage} failed (${String(diagnostic.exitCode)}): ${normalize(error.message)}\n${`${diagnostic.stdout}\n${diagnostic.stderr}`.slice(-16_384)}`, [...diagnostics], error));
          } else resolve(diagnostic);
        });
      });
    const version = await run('version', ['--version'], 10_000);
    checkDiagnostics(version, []);
    const versionText = version.stdout.trim();
    if (!/^Lean \(version 4\.35\.0(?:,|\))[^\r\n]*$/.test(versionText)) {
      fail(`Lean ${leanVersion} is required; the supplied executable reported ${JSON.stringify(versionText)}`, diagnostics);
    }
    await writeFile(join(sources, 'DomainProtocol.lean'), trustedSource, { mode: 0o400 });
    await writeFile(join(sources, 'DomainProof.lean'), generatedSource, { mode: 0o400 });
    const moduleResult = await run('protocol', ['--threads=1', `--memory=${leanMemoryMiB}`, '--root=.',
      '-o', join(modules, 'DomainProtocol.olean'), 'DomainProtocol.lean'], 90_000);
    const moduleAxioms = checkDiagnostics(moduleResult, protocolTheorems);
    const projectResult = await run('project', ['--threads=1', `--memory=${leanMemoryMiB}`, '--root=.',
      '-o', join(modules, 'DomainProof.olean'), 'DomainProof.lean'], 90_000);
    const projectAxioms = checkDiagnostics(projectResult, projectTheorems);
    if (trustedSource !== await readFile(protocolFile, 'utf8')) fail('trusted domain proof module changed during verification', diagnostics);
    const verification: DomainProofVerification = {
      schema: 'sgd-domain-proof-v1', profile: 'serial-port-outcomes-v1', leanVersion,
      graphSha256: sha256(JSON.stringify(graph)), bindingSha256: sha256(JSON.stringify(domain)),
      protocolDataSha256: sha256(JSON.stringify(protocol.data)), trustedModuleSha256: sha256(trustedSource),
      projectProofSha256: sha256(generatedSource), axioms: [...new Set([...moduleAxioms, ...projectAxioms])].sort(compare),
      limits: { threads: 1, memoryMiB: leanMemoryMiB, compilationTimeoutMs: 90000 },
      states: protocol.states, events: protocol.events, operations: protocol.operations,
      scope: { input: 'exact-finite-graph', graphProvenance: 'controlled-TLC-required-by-build-caller',
        proved: 'finite-serial-port-protocol', lifetime: 'per-live-owner', nativeCompilerCorrespondence: 'not-proved',
        externalEffectCorrectness: 'not-proved', persistence: 'not-proved' },
    };
    return { verification, files: [
      { path: 'proof/DomainProtocol.lean', content: trustedSource },
      { path: 'proof/DomainProof.lean', content: generatedSource },
      { path: 'proof/lean.log', content: diagnostics.map(entry => JSON.stringify(entry)).join('\n') + '\n', volatile: true },
      { path: 'proof/verification.json', content: JSON.stringify(verification, null, 2) + '\n' },
    ] };
  } catch (error) {
    primaryFailure = error instanceof DomainProofError
      ? new DomainProofError(error.message, [...diagnostics], error)
      : new DomainProofError(`domain proof failed: ${message(error)}`, [...diagnostics], error);
    throw primaryFailure;
  } finally {
    if (directory !== undefined) {
      try { await rm(directory, { recursive: true, force: true }); }
      catch (cleanupError) {
        throw new DomainProofError(`${primaryFailure?.message ?? 'TLC208: domain proof completed'}; owned proof workspace cleanup failed: ${message(cleanupError)}`, [...diagnostics], primaryFailure ?? cleanupError);
      }
    }
  }
}
