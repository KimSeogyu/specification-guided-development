import { z } from 'zod';

const PhaseSchema = z.enum(['sany', 'xml', 'tlc', 'source-admission', 'executable-graph']);
export const TlcFailureSchema = z.union([
  z.object({ kind: z.literal('timeout'), phase: PhaseSchema, evidence: z.object({ kind: z.literal('owned-deadline') }).strict() }).strict(),
  z.object({ kind: z.literal('invariant_violation'), phase: z.literal('tlc'), invariant: z.string().regex(/^[A-Za-z_][A-Za-z_0-9]*$/),
    evidence: z.object({ kind: z.literal('pinned-tlc-message'), code: z.union([z.literal(2107), z.literal(2110)]) }).strict() }).strict(),
  z.object({ kind: z.literal('parse_error'), phase: z.literal('sany'),
    evidence: z.object({ kind: z.literal('sany-error-summary'), stage: z.enum(['syntax', 'semantic']) }).strict() }).strict(),
  z.object({ kind: z.literal('parse_error'), phase: z.literal('tlc'),
    evidence: z.object({ kind: z.literal('pinned-tlc-message'), code: z.union([z.literal(2171), z.literal(3002)]) }).strict() }).strict(),
  z.object({ kind: z.literal('unknown'), phase: PhaseSchema }).strict(),
]);
export type TlcFailure = z.infer<typeof TlcFailureSchema>;
export type TlcPhase = z.infer<typeof PhaseSchema>;

export const TlcFailureDiagnosticSchema = z.object({
  schema: z.literal('sgd-tlc-failure-v1'),
  failure: TlcFailureSchema,
  counterexample: z.object({ status: z.literal('not-retained') }).strict(),
}).strict();
export type TlcFailureDiagnostic = z.infer<typeof TlcFailureDiagnosticSchema>;

/** The controlled runner removes its private snapshots on every outcome. */
export class TlcFailureError extends Error {
  readonly diagnostic: TlcFailureDiagnostic;

  constructor(message: string, failure: TlcFailure, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TlcFailureError';
    this.diagnostic = { schema: 'sgd-tlc-failure-v1', failure, counterexample: { status: 'not-retained' } };
  }
}

interface ToolMessage { code: number; severity: number; body: string }
type ToolMessages = { kind: 'valid'; messages: ToolMessage[] } | { kind: 'invalid' };
const errorCodes = new Set([2107, 2110, 2111, 2121, 2146, 2171, 3002]);

/** Parse the pinned MP.java line protocol. Never recover past a broken frame. */
function parseToolMessages(log: string): ToolMessages {
  const messages: ToolMessage[] = [];
  let open: { code: number; severity: number; lines: string[] } | undefined;
  for (const line of log.split(/\r?\n/)) {
    const start = /^@!@!@STARTMSG ([1-9][0-9]*):([0-4]) @!@!@$/.exec(line);
    if (start !== null) {
      if (open !== undefined) return { kind: 'invalid' };
      open = { code: Number(start[1]), severity: Number(start[2]), lines: [] };
      continue;
    }
    const end = /^@!@!@ENDMSG ([1-9][0-9]*) @!@!@$/.exec(line);
    if (end !== null) {
      if (open === undefined || Number(end[1]) !== open.code) return { kind: 'invalid' };
      if (errorCodes.has(open.code) && open.severity !== 1
        || [2216, 2217].includes(open.code) && open.severity !== 4
        || [2193, 2199].includes(open.code) && open.severity !== 0) return { kind: 'invalid' };
      messages.push({ code: open.code, severity: open.severity, body: open.lines.join('\n') });
      open = undefined;
      continue;
    }
    if (line.includes('@!@!@')) return { kind: 'invalid' };
    if (open !== undefined) open.lines.push(line);
    else if (line !== '' && !/^Parsing file .+$/.test(line)
      && !/^Semantic processing of module [A-Za-z_][A-Za-z_0-9]*$/.test(line)
      && !/^\*{6} SANY2 Version 2\.1 created 24 February 2014$/.test(line)) return { kind: 'invalid' };
  }
  return open === undefined ? { kind: 'valid', messages } : { kind: 'invalid' };
}

/** Normal exit, input rechecks, valid graph and publication are separate mandatory gates. */
export function hasCleanTlcCompletion(log: string): boolean {
  const parsed = parseToolMessages(log);
  if (parsed.kind === 'invalid' || /(?:^|\n)(?:Error:|Warning:)/.test(log)) return false;
  if (parsed.messages.some(message => message.severity !== 0)) return false;
  const completed = parsed.messages.filter(message => message.code === 2193);
  const stats = parsed.messages.filter(message => message.code === 2199);
  return completed.length === 1 && completed[0]?.body.startsWith('Model checking completed. No error has been found.\n') === true
    && stats.length === 1 && /^[0-9]+ states generated, [0-9]+ distinct states found, 0 states left on queue\.$/.test(stats[0]?.body ?? '');
}

/** Call only for this invocation's pinned, admitted controlled subprocess output. */
export function classifyControlledTlcFailure(input: {
  phase: TlcPhase; stdout: string; stderr: string; ownedDeadline: boolean; processExited: boolean; invariants: readonly string[];
}): TlcFailure {
  const { phase } = input;
  if (input.ownedDeadline) return { kind: 'timeout', phase, evidence: { kind: 'owned-deadline' } };
  const unknown: TlcFailure = { kind: 'unknown', phase };
  if (!input.processExited) return unknown;
  const log = (input.stdout + input.stderr).replace(/\r\n/g, '\n');
  if (phase === 'sany') {
    const syntax = /^Could not parse module [A-Za-z_][A-Za-z_0-9]* from file .+$/m.test(log)
      && /^\*\*\* Abort messages: [1-9][0-9]*$/m.test(log);
    const semantic = /^Semantic processing of module [A-Za-z_][A-Za-z_0-9]*$/m.test(log)
      && /^Semantic errors:$/m.test(log) && /^\*\*\* Errors: [1-9][0-9]*$/m.test(log);
    if (syntax === semantic || log.includes('@!@!@')) return unknown;
    return { kind: 'parse_error', phase, evidence: { kind: 'sany-error-summary', stage: syntax ? 'syntax' : 'semantic' } };
  }
  if (phase !== 'tlc') return unknown;
  const parsed = parseToolMessages(log);
  if (parsed.kind === 'invalid' || parsed.messages.some(message => message.code === 2193)) return unknown;
  const candidates = parsed.messages.filter(message => message.severity === 1 && [2107, 2110, 2171, 3002].includes(message.code));
  if (candidates.length !== 1) return unknown;
  const [message] = candidates;
  if (message === undefined) return unknown;
  // 2121 is the pinned error-class trace heading, not a second policy failure.
  const companions = parsed.messages.filter(other => other !== message && other.severity !== 0);
  if (companions.some(other => message.code !== 2110
    || !(other.severity === 4 && [2216, 2217].includes(other.code)
      || other.severity === 1 && other.code === 2121 && other.body === 'The behavior up to this point is:'))
    || companions.filter(other => other.code === 2121).length > 1) return unknown;
  if (message.code === 2107 || message.code === 2110) {
    const name = (message.code === 2107
      ? /^Invariant ([A-Za-z_][A-Za-z_0-9]*) is violated by the initial state:\n[\s\S]+$/
      : /^Invariant ([A-Za-z_][A-Za-z_0-9]*) is violated\.$/).exec(message.body)?.[1];
    if (name === undefined || !input.invariants.includes(name)) return unknown;
    return { kind: 'invariant_violation', phase, invariant: name, evidence: { kind: 'pinned-tlc-message', code: message.code } };
  }
  if ((message.code === 2171 || message.code === 3002) && (message.code === 3002
    ? message.body === 'Parsing or semantic analysis failed.'
    : message.body.startsWith('Parsing or semantic analysis failed.'))) {
    return { kind: 'parse_error', phase, evidence: { kind: 'pinned-tlc-message', code: message.code } };
  }
  return unknown;
}
