import { validateDomainBinding } from './domain-validation.js';
import type { DomainBinding } from './domain-types.js';
import { validateExecutableGraph, type ExactFiniteAutomaton } from './finite-types.js';

export interface RustDomainFacts {
  initial: number;
  transitions: Array<readonly [number, number, number]>;
  operationRoles: Array<readonly [number, number, number]>;
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const tupleKey = (row: readonly [number, number, number]): string => row.join(',');
const compareTuple = (a: readonly [number, number, number], b: readonly [number, number, number]): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function fail(message: string): never {
  throw new Error(`TLC208: generated Rust domain artifact ${message}`);
}

function integer(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return fail('contains an invalid index');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fail('contains an index outside the safe integer range');
  return parsed;
}

/** Parse only the emitted numeric declaration format; reject all other shapes. */
function oneMatch(source: string, expression: RegExp, name: string): RegExpMatchArray {
  const matches = [...source.matchAll(expression)];
  const match = matches[0];
  if (matches.length !== 1 || match === undefined) return fail(`must contain exactly one ${name} declaration`);
  return match;
}

function rows(source: string, name: 'TRANSITIONS' | 'OPERATION_ROLES'): Array<readonly [number, number, number]> {
  const pattern = new RegExp(`^const ${name}: &\\[\\(usize, usize, usize\\)\\] = &\\[\\n([\\s\\S]*?)^\\];$`, 'gm');
  const body = oneMatch(source, pattern, name)[1];
  if (body === undefined) return fail(`has an incomplete ${name} declaration`);
  if (body === '') return [];
  if (!body.endsWith('\n')) return fail(`has an invalid ${name} declaration`);
  return body.slice(0, -1).split('\n').map(line => {
    const match = /^    \((0|[1-9][0-9]*), (0|[1-9][0-9]*), (0|[1-9][0-9]*)\),$/.exec(line);
    if (!match || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
      return fail(`has an unsupported ${name} entry`);
    }
    return [integer(match[1]), integer(match[2]), integer(match[3])] as const;
  });
}

/**
 * Check facts extracted from the emitted Rust file against the graph that Lean
 * receives. This is a deliberately narrow textual format check, not a Rust
 * parser, a proof of executable semantics, or protection against arbitrary
 * source replacement. The emitted file and this checker remain trusted code.
 */
export function extractRustDomainFacts(input: {
  source: string; automaton: ExactFiniteAutomaton; domain: DomainBinding;
}): RustDomainFacts {
  const graph = validateExecutableGraph(input.automaton);
  const { domain } = validateDomainBinding({ automaton: graph, domain: input.domain });
  const nodes = graph.nodes.map(node => node.id).sort(compare);
  const events = [...graph.actions].sort(compare);
  const nodeIndex = new Map(nodes.map((name, index) => [name, index]));
  const eventIndex = new Map(events.map((name, index) => [name, index]));
  const node = (name: string): number => nodeIndex.get(name) ?? fail('refers to an unknown graph state');
  const event = (name: string): number => eventIndex.get(name) ?? fail('refers to an unknown graph action');
  const expectedInitial = node(graph.initial[0] ?? fail('has no initial state'));
  const expectedTransitions = [...new Map(graph.edges.map(edge => {
    const row = [node(edge.from), event(edge.event), node(edge.to)] as const;
    return [tupleKey(row), row] as const;
  })).values()].sort(compareTuple);
  const expectedRoles = domain.operations.map(operation =>
    [event(operation.start), event(operation.success), event(operation.failure)] as const);

  const initialText = oneMatch(input.source, /^const INITIAL_STATE: usize = (0|[1-9][0-9]*);$/gm, 'INITIAL_STATE')[1];
  if (initialText === undefined) return fail('has no initial index');
  const initial = integer(initialText);
  const transitions = rows(input.source, 'TRANSITIONS');
  const operationRoles = rows(input.source, 'OPERATION_ROLES');
  if (initial !== expectedInitial || JSON.stringify(transitions) !== JSON.stringify(expectedTransitions) ||
      JSON.stringify(operationRoles) !== JSON.stringify(expectedRoles)) {
    return fail('numeric data does not match the model and domain binding');
  }
  return { initial, transitions, operationRoles };
}

function requireOnce(source: string, snippet: string, description: string): void {
  if (source.split(snippet).length !== 2) fail(`does not contain exactly one supported ${description}`);
}

function rustLiteral(value: string): string {
  let result = '"';
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined || (code >= 0xd800 && code <= 0xdfff)) return fail('has invalid Unicode data');
    if (character === '"') result += '\\"';
    else if (character === '\\') result += '\\\\';
    else if (code < 32 || code === 127) result += `\\u{${code.toString(16)}}`;
    else result += character;
  }
  return `${result}"`;
}

/**
 * Check the emitted executable dispatch and operation calls as well as numeric
 * declarations. This checks specific source shapes using trusted text matching;
 * it does not establish whole-file Rust semantics or exclude hidden code.
 */
export function checkRustDomainArtifact(input: {
  source: string; automaton: ExactFiniteAutomaton; domain: DomainBinding; className: string;
}): RustDomainFacts {
  const facts = extractRustDomainFacts(input);
  const graph = validateExecutableGraph(input.automaton);
  const plan = validateDomainBinding({ automaton: graph, domain: input.domain });
  const ports = [...new Set(plan.operations.map(operation => operation.port))].sort(compare);
  const nodes = [...graph.nodes].sort((a, b) => compare(a.id, b.id));
  const events = [...graph.actions].sort(compare);
  const publicEvents = plan.publicEvents.map(event => events.indexOf(event));
  const source = input.source;
  requireOnce(source, '#![forbid(unsafe_code)]', 'unsafe-code prohibition');
  requireOnce(source, `pub struct ${input.className}Domain<P: Ports> { state: usize, revision: u64, ports: P }`, 'private domain state');
  requireOnce(source, '    pub fn new(ports: P) -> Self { Self { state: INITIAL_STATE, revision: 0, ports } }', 'initial state constructor');
  requireOnce(source, `    fn transition(&mut self, event: usize) -> Result<Receipt, TransitionError> {
        let next = TRANSITIONS.iter().find(|(state, action, _)| *state == self.state && *action == event).map(|(_, _, target)| *target).ok_or(TransitionError::Disabled)?;
        let revision = self.revision.checked_add(1).ok_or(TransitionError::RevisionExhausted)?;
        let before = self.read();
        self.state = next;
        self.revision = revision;
        Ok(Receipt { before, after: self.read() })
    }`, 'transition implementation');
  requireOnce(source, '    pub fn send(&mut self, event: PublicEvent) -> Result<Receipt, TransitionError> { self.transition(event.index()) }', 'public event dispatch');
  requireOnce(source, `pub enum PublicEvent { ${publicEvents.map(index => `Event${index}`).join(', ')} }`, 'public event set');
  requireOnce(source, `impl PublicEvent {
    pub fn from_model_name(name: &str) -> Option<Self> { match name {
${publicEvents.map(index => `        ${rustLiteral(events[index] ?? fail('has unknown public event'))} => Some(Self::Event${index}),`).join('\n')}
        _ => None,
    } }
    fn index(self) -> usize { match self { ${publicEvents.map(index => `Self::Event${index} => ${index},`).join(' ')} } }
}`, 'public event binding');
  for (const [index, node] of nodes.entries()) {
    const entries = [...graph.variables].sort((a, b) => compare(a.name, b.name)).map(variable => {
      const value = node.values[variable.name];
      if (value === undefined) return fail('has an incomplete valuation');
      const encoded = value.kind === 'boolean' ? `Value::Boolean(${value.value})`
        : value.kind === 'string' ? `Value::String(${rustLiteral(value.value)})`
        : `Value::Integer(${rustLiteral(value.value)})`;
      return `    (${rustLiteral(variable.name)}, ${encoded}),`;
    }).join('\n');
    requireOnce(source, `static VALUES_${index}: &[(&str, Value)] = &[\n${entries}\n];`, `state ${node.id} values`);
  }
  requireOnce(source, `    pub fn read(&self) -> Snapshot {
        let (node_id, values) = match self.state {
${nodes.map((node, index) => `            ${index} => (${rustLiteral(node.id)}, VALUES_${index}),`).join('\n')}
            _ => unreachable!("invalid private graph state"),
        };
        Snapshot { node_id, revision: self.revision, values }
    }`, 'snapshot binding');
  for (const [index, operation] of plan.operations.entries()) {
    const port = ports.indexOf(operation.port);
    if (port < 0) fail('references an unclassified port');
    requireOnce(source, `    pub async fn ${operation.name}(&mut self, input: P::Port${port}Input) -> OperationResult<P::Port${port}Output, P::Port${port}Error> {
        if self.revision > u64::MAX - 2 { return OperationResult::Refused(TransitionError::RevisionExhausted); }
        let start = match self.transition(OPERATION_ROLES[${index}].0) { Ok(receipt) => receipt, Err(error) => return OperationResult::Refused(error) };
        let outcome = <P as Ports>::${operation.port}(&self.ports, input).await;
        let completion_event = if outcome.is_ok() { OPERATION_ROLES[${index}].1 } else { OPERATION_ROLES[${index}].2 };
        match self.transition(completion_event) {
            Ok(completion) => OperationResult::Completed { outcome, start, completion },
            Err(error) => OperationResult::CompletionRejected { outcome, start, error },
        }
    }`, `operation ${operation.name}`);
  }
  return facts;
}
