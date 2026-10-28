import { createHash } from 'node:crypto';
import { formatRustSource, rustfmtConfig } from '../rust-format.js';
import type { DomainBinding } from '../domain-types.js';
import { validateDomainBinding } from '../domain-validation.js';
import { validateExecutableGraph, type FiniteValue, type OwnedBackendInput } from '../finite-types.js';
import type { GeneratedFile } from '../types.js';

const rustKeywords = new Set(['as', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'extern', 'false',
  'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return',
  'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while',
  'async', 'await', 'dyn', 'abstract', 'become', 'box', 'do', 'final', 'gen', 'macro', 'override', 'priv',
  'typeof', 'unsized', 'virtual', 'yield', 'try', 'union', 'macro_rules', '_']);
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function identifier(value: string, kind: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || rustKeywords.has(value)) {
    throw new Error(`TLC208: ${kind} ${JSON.stringify(value)} is not a supported Rust identifier`);
  }
  return value;
}

function rustString(value: string): string {
  let result = '"';
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined || (code >= 0xd800 && code <= 0xdfff)) throw new Error('TLC208: invalid Unicode scalar');
    if (character === '"') result += '\\"';
    else if (character === '\\') result += '\\\\';
    else if (code < 32 || code === 127) result += `\\u{${code.toString(16)}}`;
    else result += character;
  }
  return `${result}"`;
}

function valueExpression(value: FiniteValue): string {
  switch (value.kind) {
    case 'string': return `Value::String(${rustString(value.value)})`;
    case 'boolean': return `Value::Boolean(${value.value})`;
    case 'integer': return `Value::Integer(${rustString(value.value)})`;
  }
}

/** Generate a private per-object Rust authority and captured asynchronous ports. */
export function renderDomainRust(input: OwnedBackendInput & { domain: DomainBinding; retainedVariable?: string }): GeneratedFile[] {
  const graph = validateExecutableGraph(input.automaton);
  const plan = validateDomainBinding({ automaton: graph, domain: input.domain });
  if (input.retainedVariable !== undefined) {
    const variable = graph.variables.find(item => item.name === input.retainedVariable);
    if (variable?.kind !== 'boolean' || graph.nodes.some(node => {
      const value = node.values[input.retainedVariable ?? ''];
      return value?.kind !== 'boolean' || value.value !== true;
    })) throw new Error('TLC208: retained Rust variable must be Boolean TRUE in every graph state');
  }
  if (!/^[A-Z][A-Za-z0-9]*$/.test(input.className)) throw new Error('TLC208: invalid Rust domain className');
  const className = `${input.className}Domain`;
  for (const operation of plan.operations) {
    identifier(operation.name, 'operation');
    identifier(operation.port, 'port');
    if (['new', 'read', 'send', 'transition', 'into', 'try_into', 'payload', 'into_parts'].includes(operation.name)) {
      throw new Error(`TLC208: reserved Rust operation ${operation.name}`);
    }
  }
  const nodes = [...graph.nodes].sort((a, b) => compare(a.id, b.id));
  const events = [...graph.actions].sort(compare);
  const ports = [...new Set(plan.operations.map(operation => operation.port))].sort(compare);
  const associatedTypes = new Set(['Payload', ...ports.flatMap((_, i) => [`Port${i}Input`, `Port${i}Output`, `Port${i}Error`])]);
  for (const port of ports) if (associatedTypes.has(port)) throw new Error(`TLC208: Rust port ${port} collides with a generated associated type`);
  const nodeIndex = new Map(nodes.map((node, i) => [node.id, i]));
  const eventIndex = new Map(events.map((event, i) => [event, i]));
  const portIndex = new Map(ports.map((port, i) => [port, i]));
  const index = (map: Map<string, number>, key: string): number => {
    const found = map.get(key);
    if (found === undefined) throw new Error(`TLC208: unknown Rust graph identity ${JSON.stringify(key)}`);
    return found;
  };
  const initial = graph.initial[0];
  if (initial === undefined) throw new Error('TLC208: Rust graph has no initial state');
  const rawEdges = graph.edges.map(edge => [index(nodeIndex, edge.from), index(eventIndex, edge.event), index(nodeIndex, edge.to)] as const);
  const edges = [...new Map(rawEdges.map(edge => [edge.join(','), edge])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const roles = plan.operations.map(operation => [index(eventIndex, operation.start), index(eventIndex, operation.success), index(eventIndex, operation.failure)] as const);
  const values = nodes.map((node, i) => `static VALUES_${i}: &[(&str, Value)] = &[\n${[...graph.variables].sort((a, b) => compare(a.name, b.name)).map(variable => {
    const value = node.values[variable.name];
    if (value === undefined) throw new Error(`TLC208: missing Rust graph value ${variable.name}`);
    return `    (${rustString(variable.name)}, ${valueExpression(value)}),`;
  }).join('\n')}\n];`).join('\n');
  const portTraits = ports.map((port, i) => `    type Port${i}Input;\n    type Port${i}Output;\n    type Port${i}Error;\n    fn ${port}(&self, input: Self::Port${i}Input) -> impl Future<Output = Result<Self::Port${i}Output, Self::Port${i}Error>>;`).join('\n');
  const syncPortTraits = ports.map((port, i) => `    type Port${i}Input;\n    type Port${i}Output;\n    type Port${i}Error;\n    fn ${port}(&mut self, payload: &Self::Payload, input: Self::Port${i}Input) -> Result<Self::Port${i}Output, Self::Port${i}Error>;`).join('\n');
  const methods = plan.operations.map((operation, i) => {
    const p = index(portIndex, operation.port);
    return `    pub async fn ${operation.name}(&mut self, input: P::Port${p}Input) -> OperationResult<P::Port${p}Output, P::Port${p}Error> {\n        if self.machine.revision > u64::MAX - 2 { return OperationResult::Refused(TransitionError::RevisionExhausted); }\n        let start = match self.machine.transition(OPERATION_ROLES[${i}].0) { Ok(receipt) => receipt, Err(error) => return OperationResult::Refused(error) };\n        let outcome = <P as Ports>::${operation.port}(&self.ports, input).await;\n        let completion_event = if outcome.is_ok() { OPERATION_ROLES[${i}].1 } else { OPERATION_ROLES[${i}].2 };\n        match self.machine.transition(completion_event) {\n            Ok(completion) => OperationResult::Completed { outcome, start, completion },\n            Err(error) => OperationResult::CompletionRejected { outcome, start, error },\n        }\n    }`;
  }).join('\n');
  const syncMethods = plan.operations.map((operation, i) => {
    const p = index(portIndex, operation.port);
    return `    pub fn ${operation.name}(&mut self, input: P::Port${p}Input) -> SyncOperation<P::Port${p}Output, P::Port${p}Error> {\n        if self.machine.revision > u64::MAX - 2 { return SyncOperation { status: OperationResult::Refused(TransitionError::RevisionExhausted), snapshot: self.machine.read() }; }\n        let start = match self.machine.transition(OPERATION_ROLES[${i}].0) { Ok(receipt) => receipt, Err(error) => return SyncOperation { status: OperationResult::Refused(error), snapshot: self.machine.read() } };\n        let outcome = <P as SyncPorts>::${operation.port}(&mut self.ports, &self.payload, input);\n        let completion_event = if outcome.is_ok() { OPERATION_ROLES[${i}].1 } else { OPERATION_ROLES[${i}].2 };\n        let status = match self.machine.transition(completion_event) {\n            Ok(completion) => OperationResult::Completed { outcome, start, completion },\n            Err(error) => OperationResult::CompletionRejected { outcome, start, error },\n        };\n        SyncOperation { status, snapshot: self.machine.read() }\n    }`;
  }).join('\n');
  const publicEvents = plan.publicEvents.map(event => index(eventIndex, event));
  const packageHash = createHash('sha256').update(graph.name).digest('hex').slice(0, 12);
  const asyncSection = input.retainedVariable === undefined ? `\n\npub trait Ports {\n${portTraits}\n}\n\npub struct ${className}<P: Ports> { machine: Machine, ports: P }\nimpl<P: Ports> ${className}<P> {\n    pub fn new(ports: P) -> Self { Self { machine: Machine::new(), ports } }\n    pub fn read(&self) -> Snapshot { self.machine.read() }\n    pub fn send(&mut self, event: PublicEvent) -> Result<Receipt, TransitionError> { self.machine.transition(event.index()) }\n${methods}\n}` : '';
  const source = `// Generated from a checked finite model. Do not edit.\n#![forbid(unsafe_code)]\n${input.retainedVariable === undefined ? 'use std::future::Future;\n' : ''}\npub const MODEL: &str = ${rustString(graph.name)};\npub const MODEL_REVISION: &str = ${rustString(graph.source.dotSha256)};\nconst INITIAL_STATE: usize = ${index(nodeIndex, initial)};\nconst TRANSITIONS: &[(usize, usize, usize)] = &[\n${edges.map(edge => `    (${edge[0]}, ${edge[1]}, ${edge[2]}),`).join('\n')}\n];\nconst OPERATION_ROLES: &[(usize, usize, usize)] = &[\n${roles.map(role => `    (${role[0]}, ${role[1]}, ${role[2]}),`).join('\n')}\n];\n\n#[derive(Clone, Copy, Debug, Eq, PartialEq)]\npub enum Value { String(&'static str), Boolean(bool), Integer(&'static str) }\n${values}\n\n#[derive(Clone, Copy, Debug, Eq, PartialEq)]\npub struct Snapshot { pub node_id: &'static str, pub revision: u64, pub values: &'static [(&'static str, Value)] }\n#[derive(Clone, Copy, Debug, Eq, PartialEq)]\npub struct Receipt { pub before: Snapshot, pub after: Snapshot }\n#[derive(Clone, Copy, Debug, Eq, PartialEq)]\npub enum TransitionError { Disabled, RevisionExhausted }\n#[derive(Debug)]\npub enum OperationResult<T, E> { Refused(TransitionError), Completed { outcome: Result<T, E>, start: Receipt, completion: Receipt }, CompletionRejected { outcome: Result<T, E>, start: Receipt, error: TransitionError } }\n#[must_use = "the operation result contains its observed status and snapshot"]\n#[derive(Debug)]\npub struct SyncOperation<T, E> { status: OperationResult<T, E>, snapshot: Snapshot }\nimpl<T, E> SyncOperation<T, E> {\n    pub fn status(&self) -> &OperationResult<T, E> { &self.status }\n    pub fn snapshot(&self) -> &Snapshot { &self.snapshot }\n    pub fn into_parts(self) -> (OperationResult<T, E>, Snapshot) { (self.status, self.snapshot) }\n}\n\n#[derive(Clone, Copy, Debug, Eq, PartialEq)]\npub enum PublicEvent { ${publicEvents.map(i => `Event${i}`).join(', ')} }\nimpl PublicEvent {\n    pub fn from_model_name(name: &str) -> Option<Self> { match name {\n${publicEvents.map(i => `        ${rustString(events[i] ?? '')} => Some(Self::Event${i}),`).join('\n')}\n        _ => None,\n    } }\n    fn index(self) -> usize { match self { ${publicEvents.map(i => `Self::Event${i} => ${i},`).join(' ')} } }\n}\n\nstruct Machine { state: usize, revision: u64 }\nimpl Machine {\n    fn new() -> Self { Self { state: INITIAL_STATE, revision: 0 } }\n    fn read(&self) -> Snapshot {\n        let (node_id, values) = match self.state {\n${nodes.map((node, i) => `            ${i} => (${rustString(node.id)}, VALUES_${i}),`).join('\n')}\n            _ => unreachable!("invalid private graph state"),\n        };\n        Snapshot { node_id, revision: self.revision, values }\n    }\n    fn transition(&mut self, event: usize) -> Result<Receipt, TransitionError> {\n        let next = TRANSITIONS.iter().find(|(state, action, _)| *state == self.state && *action == event).map(|(_, _, target)| *target).ok_or(TransitionError::Disabled)?;\n        let revision = self.revision.checked_add(1).ok_or(TransitionError::RevisionExhausted)?;\n        let before = self.read();\n        self.state = next;\n        self.revision = revision;\n        Ok(Receipt { before, after: self.read() })\n    }\n}${asyncSection}\n\npub trait SyncPorts {\n    type Payload;\n${syncPortTraits}\n}\n\npub struct ${input.className}SyncDomain<P: SyncPorts> { machine: Machine, ports: P, payload: P::Payload }\nimpl<P: SyncPorts> ${input.className}SyncDomain<P> {\n    pub fn new(ports: P, payload: P::Payload) -> Self { Self { machine: Machine::new(), ports, payload } }\n    pub fn read(&self) -> Snapshot { self.machine.read() }\n    pub fn payload(&self) -> &P::Payload { &self.payload }\n    pub fn into_parts(self) -> (P::Payload, P, Snapshot) { let snapshot = self.machine.read(); (self.payload, self.ports, snapshot) }\n    pub fn send(&mut self, event: PublicEvent) -> Result<Receipt, TransitionError> { self.machine.transition(event.index()) }\n${syncMethods}\n}\n`;
  const readme = `# Generated Rust domain\n\nThis dependency-free Rust 2021 crate owns one finite state per instance. Generation requires Rust 1.92.0 and its matching rustfmt; the generated rustfmt.toml fixes formatting settings. ${input.retainedVariable === undefined ? `Implement \`Ports\` and pass it to \`${className}::new\` for asynchronous operations. ` : ''}Implement \`SyncPorts\` and pass ports plus an owned payload to \`${input.className}SyncDomain::new\` for synchronous operations. A sync port borrows the payload, receives a separate input, and returns a \`Result\`. Public events exclude operation roles.\n\nThe sync owner keeps its payload from construction through every ordinary operation return, including refusal and port failure. \`payload()\` borrows it; \`into_parts()\` consumes the owner and returns the payload, ports, and final snapshot. Payload fields with interior mutability can still change. Panic, abort, caller drop, unsafe code, and external effects are outside this guarantee. ${input.retainedVariable === undefined ? 'This owner does not automatically bind payload residency to a model variable. ' : `The checked Boolean model variable \`${input.retainedVariable}\` is true in every reachable graph state; the non-retaining async owner is omitted. `}\n\n${input.retainedVariable === undefined ? 'Dropping an async operation future after it starts, or a panic, can leave the owner pending. ' : ''}This code does not establish cancellation, persistence, effect atomicity, eventual completion, application-wide coverage, or correctness of external effects. The graph is finite. The generated Rust, artifact checker, rustfmt, and Rust compiler remain trust boundaries separate from the Lean graph proof.\n`;

  return [
    { path: 'Cargo.toml', content: `[package]\nname = "sgd-domain-${packageHash}"\nversion = "0.1.0"\nedition = "2021"\npublish = false\n` },
    { path: 'src/lib.rs', content: source },
    { path: 'README.md', content: readme.replace(/[ \t]+$/gm, '') },
  ];
}

/** Emit canonical Rust with the verified formatter version and local configuration. */
export function generateDomainRust(input: OwnedBackendInput & { domain: DomainBinding; retainedVariable?: string }): GeneratedFile[] {
  return [...renderDomainRust(input).map(file => file.path === 'src/lib.rs'
    ? { ...file, content: formatRustSource(file.content) } : file),
  { path: 'rustfmt.toml', content: rustfmtConfig }];
}
