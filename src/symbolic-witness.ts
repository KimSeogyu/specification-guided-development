import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { recordSchema } from './schema-record.js';
import { sha256 } from './dot.js';
import { type FiniteValue } from './finite-types.js';
import { parseSanyXml } from './sany-xml.js';
import { sameSymbolicValue, stepSymbolic, type SymbolicState } from './symbolic-semantics.js';
import { parseSymbolicConfig, runSymbolicTlc, type SymbolicTlcEvidence, type TlcConfigScalar, type TlcConfigValue } from './symbolic-tlc.js';
import { SymbolicValueSchema, type SymbolicModel, type SymbolicValue, type SymbolicInputDefinition, symbolicFiniteValueKey, symbolicInputDefinitions, validateSymbolicModel } from './symbolic-types.js';
import { decodeTlcLabel, parseTlcDot } from './tlc-dot.js';

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const Identifier = z.string().regex(identifier).refine(name => name !== '__proto__');
const order = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const fail: (message: string) => never = message => { throw new Error(`TLC303: ${message}`); };
const WitnessBase = z.object({
  kind: z.literal('symbolic-witness'), name: Identifier, variables: z.array(Identifier).min(1),
  nodes: z.array(z.object({ id: Identifier, values: recordSchema(Identifier, SymbolicValueSchema) }).strict()).min(1),
  initial: z.array(Identifier).min(1),
  edges: z.array(z.object({ from: Identifier, event: Identifier, to: Identifier }).strict()),
  source: z.object({ dotSha256: z.string().regex(/^[a-f0-9]{64}$/), stateCount: z.number().int().positive(), edgeCount: z.number().int().nonnegative() }).strict(),
}).strict();
const SingleWitnessSchema = WitnessBase.extend({ version: z.literal(1), domain: Identifier, atoms: z.array(Identifier).min(1) }).strict();
const ProductWitnessSchema = WitnessBase.extend({ version: z.literal(2), domains: recordSchema(Identifier, z.array(Identifier).min(1)) }).strict();
export const SymbolicWitnessSchema = z.discriminatedUnion('version', [SingleWitnessSchema, ProductWitnessSchema]).superRefine((graph, context) => {
  const issue = (path: (string | number)[], message: string): void => context.addIssue({ code: z.ZodIssueCode.custom, path, message });
  const variables = new Set(graph.variables);
  const domains = graph.version === 1 ? { [graph.domain]: graph.atoms } : graph.domains;
  const atomDomains = new Map<string, string>();
  if (variables.size !== graph.variables.length) issue(['variables'], 'Witness variables must be unique');
  if (Object.keys(domains).length === 0 || Object.keys(domains).length > 3) issue(['domains'], 'Witness requires one to three data domains');
  for (const [domain, atoms] of Object.entries(domains)) for (const atom of atoms) {
    if (atomDomains.has(atom) || ['TRUE', 'FALSE', '__proto__'].includes(atom)) issue(['domains', domain], 'Witness atoms must be globally distinct non-Boolean model identifiers');
    atomDomains.set(atom, domain);
  }
  const ids = new Set<string>();
  const valuations = new Set<string>();
  const orderedVariables = [...variables].sort(order);
  for (const [index, node] of graph.nodes.entries()) {
    if (ids.has(node.id)) issue(['nodes', index, 'id'], 'Witness node IDs must be unique');
    ids.add(node.id);
    const keys = Object.keys(node.values);
    if (keys.length !== variables.size || keys.some(variable => !variables.has(variable))) issue(['nodes', index, 'values'], 'Each witness valuation must assign exactly the declared variables');
    for (const [variable, value] of Object.entries(node.values)) {
      if (value.kind === 'data' && atomDomains.get(value.value) !== value.domain) issue(['nodes', index, 'values', variable], 'Witness data must belong to its declared domain and configured atom set');
    }
    const valuation = JSON.stringify(orderedVariables.map(variable => [variable, node.values[variable]]));
    if (valuations.has(valuation)) issue(['nodes', index, 'values'], 'Duplicate complete witness valuation');
    valuations.add(valuation);
  }
  if (new Set(graph.initial).size !== graph.initial.length) issue(['initial'], 'Initial witness IDs must be unique');
  for (const [index, id] of graph.initial.entries()) if (!ids.has(id)) issue(['initial', index], 'Initial witness ID does not name a node');
  const outgoing = new Map<string, string[]>();
  for (const [index, edge] of graph.edges.entries()) {
    if (!ids.has(edge.from)) issue(['edges', index, 'from'], 'Witness edge source does not name a node');
    if (!ids.has(edge.to)) issue(['edges', index, 'to'], 'Witness edge target does not name a node');
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }
  if (graph.source.stateCount !== graph.nodes.length) issue(['source', 'stateCount'], 'Witness state count differs from its nodes');
  if (graph.source.edgeCount !== graph.edges.length) issue(['source', 'edgeCount'], 'Witness edge count differs from its raw edges');
  const reachable = new Set(graph.initial.filter(id => ids.has(id)));
  for (const id of reachable) for (const target of outgoing.get(id) ?? []) if (ids.has(target)) reachable.add(target);
  if (reachable.size !== ids.size) issue(['nodes'], 'Every witness node must be reachable from an initial node');
});
export type SymbolicWitnessGraph = z.infer<typeof SymbolicWitnessSchema>;

function parseValue(text: string, atomDomains: ReadonlyMap<string, string>): SymbolicValue {
  const domain = atomDomains.get(text);
  if (domain !== undefined) return { kind: 'data', domain, value: text };
  if (text === 'TRUE' || text === 'FALSE') return { kind: 'boolean', value: text === 'TRUE' };
  if (/^(?:0|-?[1-9][0-9]*)$/.test(text)) return { kind: 'integer', value: text };
  if (text.startsWith('"')) {
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === 'string') return { kind: 'string', value };
    } catch { /* Unsupported labels are rejected below. */ }
  }
  return fail('witness values must be exact scalars or configured opaque model atoms');
}

function parseValuation(label: string, atomDomains: ReadonlyMap<string, string>): SymbolicState {
  const entries = decodeTlcLabel(label).split('\n').map(line => {
    const match = /^(?:\/\\\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line.trim());
    const name = match?.[1];
    const value = match?.[2];
    if (name === undefined || name === '__proto__' || value === undefined) return fail('expected complete witness assignments');
    return [name, parseValue(value, atomDomains)] satisfies [string, SymbolicValue];
  }).sort(([a], [b]) => order(a, b));
  if (new Set(entries.map(([name]) => name)).size !== entries.length) return fail('duplicate variable in witness valuation');
  return Object.fromEntries(entries);
}

/** This full finite witness keeps model atoms distinct from strings with the same spelling. */
export function importSymbolicDot(input: { dot: string; name: string } & ({ domain: string; atoms: string[] } | { domains: Record<string, string[]> })): SymbolicWitnessGraph {
  const domains = 'domains' in input ? input.domains : { [input.domain]: input.atoms };
  const atomDomains = new Map<string, string>();
  if (Object.keys(domains).length === 0 || Object.keys(domains).length > 3) return fail('witness requires one to three data domains');
  for (const [domain, atoms] of Object.entries(domains)) {
    if (!identifier.test(domain) || domain === '__proto__' || !atoms.length) return fail('invalid configured witness domain');
    for (const atom of atoms) {
      if (!identifier.test(atom) || ['TRUE', 'FALSE', '__proto__'].includes(atom) || atomDomains.has(atom)) return fail('invalid, duplicate, or overlapping configured witness atoms');
      atomDomains.set(atom, domain);
    }
  }
  const raw = parseTlcDot(input.dot);
  const concrete = [...raw.nodes].map(([fingerprint, node]) => ({ fingerprint, initial: node.initial, values: parseValuation(node.label, atomDomains) }))
    .sort((a, b) => order(JSON.stringify(a.values), JSON.stringify(b.values)));
  const first = concrete[0];
  if (!first) return fail('empty witness graph');
  const variables = Object.keys(first.values);
  const valuationKeys = new Set<string>();
  for (const node of concrete) {
    if (JSON.stringify(Object.keys(node.values)) !== JSON.stringify(variables)) return fail('witness nodes omit or add state variables');
    const key = JSON.stringify(node.values);
    if (valuationKeys.has(key)) return fail('duplicate complete witness valuation');
    valuationKeys.add(key);
  }
  const ids = new Map(concrete.map((node, index) => [node.fingerprint, `s${index}`]));
  const nodeId = (fingerprint: string): string => ids.get(fingerprint) ?? fail('missing witness edge endpoint');
  const parsed = SymbolicWitnessSchema.safeParse({
    ...('domains' in input ? { version: 2, domains: Object.fromEntries(Object.entries(domains).sort(([a], [b]) => order(a, b)).map(([domain, atoms]) => [domain, [...atoms].sort(order)])) }
      : { version: 1, domain: input.domain, atoms: [...input.atoms].sort(order) }),
    kind: 'symbolic-witness', name: input.name, variables,
    nodes: concrete.map((node, index) => ({ id: `s${index}`, values: node.values })),
    initial: concrete.filter(node => node.initial).map(node => nodeId(node.fingerprint)).sort(order),
    edges: raw.edges.map(edge => ({ from: nodeId(edge.from), event: edge.event, to: nodeId(edge.to) })).sort((a, b) => order(JSON.stringify(a), JSON.stringify(b))),
    source: { dotSha256: sha256(input.dot), stateCount: raw.nodes.size, edgeCount: raw.edges.length },
  });
  if (!parsed.success) return fail(`invalid full witness graph: ${parsed.error.issues.slice(0, 4).map(issue => issue.message).join('; ')}`);
  const graph = parsed.data;
  const reachable = new Set(graph.initial);
  for (const id of reachable) for (const edge of graph.edges) if (edge.from === id) reachable.add(edge.to);
  if (reachable.size !== graph.nodes.length) return fail('unreachable nodes in witness graph');
  return graph;
}

interface WitnessEvidenceBase {
  kind: 'tlc-finite-input-oracle';
  scope: 'configured-reachable-state-input-product';
  stateCount: number;
  checkedCases: number;
  acceptedCases: number;
  disabledCases: number;
  base: SymbolicTlcEvidence;
  oracle: SymbolicTlcEvidence;
}
export type SymbolicWitnessEvidence = WitnessEvidenceBase & (
  | { domain: string; atoms: string[] }
  | { domains: Record<string, string[]>; inputs: { parameter: string; domain: string }[] }
  | { symbolicIrVersion: 3; inputProfile: 'mixed-finite-opaque-v1'; domains: Record<string, string[]>; inputs: SymbolicInputDefinition[] }
);

function scalarLiteral(value: FiniteValue): string {
  switch (value.kind) {
    case 'string': return JSON.stringify(value.value);
    case 'integer': return value.value;
    case 'boolean': return value.value ? 'TRUE' : 'FALSE';
  }
}

function configLiteral(value: TlcConfigValue): string {
  const scalar = (item: TlcConfigScalar): string => {
    switch (item.kind) {
      case 'model-value': case 'integer': return item.value;
      case 'string': return JSON.stringify(item.value);
      case 'boolean': return item.value ? 'TRUE' : 'FALSE';
    }
  };
  return value.kind === 'set' ? `{${value.values.map(scalar).join(', ')}}` : scalar(value);
}

async function checkedFile(path: string, expected: string): Promise<Buffer> {
  if (!(await lstat(path)).isFile()) return fail('oracle source inputs must be regular non-symlink files');
  const bytes = await readFile(path);
  if (digest(bytes) !== expected) return fail(`oracle input differs from the completed base run: ${basename(path)}`);
  return bytes;
}

/** Ask original TLA+ action bodies about every finite state/input pair; never reconstruct their guards. */
export async function verifySymbolicWitness(input: {
  model: SymbolicModel; run: Awaited<ReturnType<typeof runSymbolicTlc>>; spec: string; config: string; jar: string;
}): Promise<{ witness: SymbolicWitnessGraph; evidence: SymbolicWitnessEvidence; oracleDot: string; oracleLog: string }> {
  const model = validateSymbolicModel(input.model);
  const { run } = input;
  const spec = resolve(input.spec);
  const config = resolve(input.config);
  const jar = resolve(input.jar);
  if (basename(spec) !== `${run.evidence.rootModule}.tla` || sha256(run.dot) !== run.evidence.dotSha256 || sha256(run.xml) !== run.evidence.xmlSha256) return fail('base TLC evidence does not identify the supplied model');
  const semantic = parseSanyXml(run.xml);
  if (semantic.root !== run.evidence.rootModule) return fail('base semantic root differs from completed TLC evidence');
  const configBytes = await checkedFile(config, run.evidence.configSha256);
  if (JSON.stringify(parseSymbolicConfig(configBytes.toString('utf8'))) !== JSON.stringify(run.config)) return fail('base parsed configuration differs from its checked bytes');
  const parameters = symbolicInputDefinitions(model);
  const domains: Record<string, string[]> = Object.fromEntries(parameters.filter(parameter => parameter.kind === 'opaque').map(parameter => {
    const domain = run.config.constants[parameter.domain];
    if (domain?.kind !== 'set' || domain.values.length === 0 || domain.values.some(value => value.kind !== 'model-value')) return fail('witness input domain must contain configured model atoms');
    return [parameter.domain, domain.values.map(value => value.kind === 'model-value' ? value.value : fail('non-atom in witness input domain'))];
  }));
  for (const parameter of parameters) if (parameter.kind === 'finite') {
    const configured = run.config.constants[parameter.domain];
    if (configured?.kind !== 'set') return fail('finite witness input domain must contain its configured scalar vocabulary');
    const values = configured.values.map((value): FiniteValue => {
      switch (value.kind) {
        case 'string': return { kind: 'string', value: value.value };
        case 'integer': return { kind: 'integer', value: value.value };
        case 'boolean': return { kind: 'boolean', value: value.value };
        case 'model-value': return fail('finite witness input domain cannot contain opaque model atoms');
      }
    });
    const configuredKeys = values.map(symbolicFiniteValueKey).sort(order);
    if (new Set(configuredKeys).size !== configuredKeys.length || JSON.stringify(configuredKeys) !== JSON.stringify(parameter.values.map(symbolicFiniteValueKey))) {
      return fail('finite input vocabulary differs from the completed TLC configuration');
    }
  }
  const atoms = Object.values(domains).flat();
  if (new Set(atoms).size !== atoms.length) return fail('configured input domains must be pairwise disjoint');
  const firstParameter = parameters[0] ?? fail('missing input parameter');
  const witnessInput = model.version === 1 ? { domain: firstParameter.domain, atoms: domains[firstParameter.domain] ?? fail('missing input domain') } : { domains };
  const witness = importSymbolicDot({ dot: run.dot, name: model.name, ...witnessInput });
  const inputCount = parameters.reduce((count, parameter) => count * (parameter.kind === 'finite' ? parameter.values.length : (domains[parameter.domain]?.length ?? 0)), 1);
  const checkedCases = witness.nodes.length * inputCount;
  if (!Number.isSafeInteger(checkedCases) || checkedCases > 250_000) return fail('finite input oracle case limit exceeded; no partial verification is permitted');
  if (JSON.stringify(witness.variables) !== JSON.stringify([...model.variables].sort(order))) return fail('symbolic model does not preserve every witness variable');
  const stateKey = (state: SymbolicState): string => JSON.stringify(Object.fromEntries(witness.variables.map(variable => [variable, state[variable]])));
  if (witness.initial.length !== 1 || stateKey(witness.nodes.find(node => node.id === witness.initial[0])?.values ?? {}) !== stateKey(model.initial)) return fail('symbolic Init differs from the original TLC initial state');
  const closureNames = run.evidence.moduleClosure.map(module => module.name);
  if (new Set(closureNames).size !== closureNames.length || !closureNames.includes(basename(spec)) || closureNames.some(name => !/^[A-Za-z_][A-Za-z0-9_]*\.tla$/.test(name))) return fail('invalid base module closure evidence');
  const sources = await Promise.all(run.evidence.moduleClosure.map(async module => ({ ...module, bytes: await checkedFile(join(dirname(spec), module.name), module.sha256) })));
  const jarBytes = await checkedFile(jar, run.evidence.jarSha256);
  const used = new Set([...semantic.symbols.values()].map(symbol => symbol.name));
  for (const name of [...closureNames.map(name => basename(name, '.tla')), ...Object.keys(run.config.constants), ...atoms]) used.add(name);
  let sequence = 0;
  const chooseNames = (index: number) => {
    const module = `SGDOracle${index}`;
    return { module, inputs: parameters.map((_, parameter) => `${module}Input${model.version === 1 ? '' : parameter}`), step: `${module}Step`, action: `${module}Action`, init: `${module}Init`, next: `${module}Next`, aliases: atoms.map((_, atom) => `${module}Atom${atom}`) };
  };
  let names = chooseNames(sequence);
  while (Object.values(names).flat().some(name => used.has(name))) {
    sequence++;
    if (sequence > 10_000) return fail('cannot select collision-free oracle identifiers');
    names = chooseNames(sequence);
  }
  const aliases = new Map(atoms.map((atom, index) => [atom, names.aliases[index] ?? fail('missing oracle atom alias')]));
  const valueLiteral = (value: SymbolicValue): string => value.kind === 'data' ? aliases.get(value.value) ?? fail('unconfigured atom in witness valuation') : scalarLiteral(value);
  const actions = [...new Set(model.branches.map(branch => branch.action))].sort(order);
  if (actions.some(action => !identifier.test(action))) return fail('invalid original action name');
  if (witness.edges.some(edge => !actions.includes(edge.event))) return fail('symbolic IR omits an action observed in the original reachable graph');
  const source = [
    `---------------- MODULE ${names.module} ----------------`, `EXTENDS ${run.evidence.rootModule}`,
    `CONSTANTS ${names.aliases.join(', ')}`, `VARIABLES ${[...names.inputs, names.step, names.action].join(', ')}`,
    `${names.init} ==`, '  /\\ (',
    ...witness.nodes.map(node => `       \\/ (${witness.variables.map(variable => `${variable} = ${valueLiteral(node.values[variable] ?? fail('incomplete witness state'))}`).join(' /\\ ')})`),
    '     )', ...parameters.map((parameter, index) => `  /\\ ${names.inputs[index]} \\in ${parameter.domain}`), `  /\\ ${names.step} = "before"`, `  /\\ ${names.action} = ""`,
    `${names.next} ==`, `  /\\ ${names.step} = "before"`, `  /\\ ${names.step}' = "after"`, `  /\\ UNCHANGED <<${names.inputs.join(', ')}>>`, '  /\\ (',
    ...actions.map(action => `       \\/ (${action}(${names.inputs.join(', ')}) /\\ ${names.action}' = ${JSON.stringify(action)})`),
    '     )', '====================================================', '',
  ].join('\n');
  const oracleConfig = [
    `INIT ${names.init}`, `NEXT ${names.next}`, 'CHECK_DEADLOCK FALSE', 'CONSTANTS',
    ...Object.entries(run.config.constants).map(([name, value]) => `  ${name} = ${configLiteral(value)}`),
    ...atoms.map(atom => `  ${aliases.get(atom) ?? fail('missing atom alias')} = ${atom}`), '',
  ].join('\n');
  const temp = await mkdtemp(join(tmpdir(), 'sgd-symbolic-oracle-'));
  try {
    // Keep the JAR outside the flat TLA+ source directory inspected by the controlled runner.
    const modelDirectory = join(temp, 'models');
    await mkdir(modelDirectory);
    for (const module of sources) await writeFile(join(modelDirectory, module.name), module.bytes, { mode: 0o400 });
    const oracleSpec = join(modelDirectory, `${names.module}.tla`);
    const oracleCfg = join(temp, 'oracle.cfg');
    const oracleJar = join(temp, 'tla2tools.jar');
    await writeFile(oracleSpec, source, { mode: 0o400 });
    await writeFile(oracleCfg, oracleConfig, { mode: 0o400 });
    await writeFile(oracleJar, jarBytes, { mode: 0o400 });
    const verifyOriginalInputs = async (): Promise<void> => {
      await checkedFile(config, run.evidence.configSha256);
      await checkedFile(jar, run.evidence.jarSha256);
      for (const module of sources) await checkedFile(join(dirname(spec), module.name), module.sha256);
    };
    await verifyOriginalInputs();
    const oracleRun = await runSymbolicTlc({ spec: oracleSpec, config: oracleCfg, jar: oracleJar });
    await verifyOriginalInputs();
    for (const module of sources) {
      if (!oracleRun.evidence.moduleClosure.some(copied => copied.name === module.name && copied.sha256 === module.sha256)) return fail('oracle did not use the original checked module closure');
    }
    const oracle = importSymbolicDot({ dot: oracleRun.dot, name: `${model.name}Oracle`, ...witnessInput });
    const expectedVariables = [...witness.variables, ...names.inputs, names.step, names.action].sort(order);
    if (JSON.stringify(oracle.variables) !== JSON.stringify(expectedVariables)) return fail('oracle state inventory differs from the complete original state and observers');
    const oracleNodes = new Map(oracle.nodes.map(node => [node.id, node]));
    const baseStates = new Map(witness.nodes.map(node => [stateKey(node.values), node]));
    const baseNodes = new Map(witness.nodes.map(node => [node.id, node]));
    const edgeKey = (from: SymbolicState, action: string, to: SymbolicState): string => JSON.stringify([stateKey(from), action, stateKey(to)]);
    const baseEdges = new Set(witness.edges.map(edge => edgeKey(baseNodes.get(edge.from)?.values ?? fail('missing base source'), edge.event,
      baseNodes.get(edge.to)?.values ?? fail('missing base successor'))));
    const observedEdges = new Set<string>();
    const seenCases = new Set<string>();
    let acceptedCases = 0;
    let disabledCases = 0;
    for (const initialId of oracle.initial) {
      const initial = oracleNodes.get(initialId) ?? fail('missing oracle initial state');
      const inputFrame = Object.fromEntries(parameters.map((parameter, index) => {
        const observer = names.inputs[index] ?? fail('missing input observer');
        const observedInput = initial.values[observer];
        if (parameter.kind === 'opaque') {
          if (observedInput?.kind !== 'data' || observedInput.domain !== parameter.domain || !domains[parameter.domain]?.includes(observedInput.value)) return fail('oracle initial input is not a configured atom in its domain');
          return [parameter.parameter, observedInput.value];
        }
        if (!observedInput || observedInput.kind === 'data' || !parameter.values.some(value => sameSymbolicValue(value, observedInput))) return fail('oracle initial finite input is outside its configured scalar vocabulary');
        return [parameter.parameter, observedInput];
      }));
      const firstInput = inputFrame[firstParameter.parameter] ?? fail('missing first input value');
      const baseKey = stateKey(initial.values);
      if (!baseStates.has(baseKey)) return fail('oracle initial state is outside the base reachable graph');
      const caseKey = JSON.stringify([baseKey, inputFrame]);
      if (seenCases.has(caseKey)) return fail('duplicate oracle state/input case');
      seenCases.add(caseKey);
      const before = initial.values[names.step];
      const initialAction = initial.values[names.action];
      if (before?.kind !== 'string' || before.value !== 'before' || initialAction?.kind !== 'string' || initialAction.value !== '') return fail('invalid oracle observer initial values');
      const actual = new Map<string, { action: string; state: SymbolicState }>();
      for (const edge of oracle.edges.filter(candidate => candidate.from === initialId)) {
        const target = oracleNodes.get(edge.to) ?? fail('missing oracle successor');
        const phase = target.values[names.step];
        const action = target.values[names.action];
        if (phase?.kind !== 'string' || phase.value !== 'after' || action?.kind !== 'string' || !actions.includes(action.value)) return fail('invalid oracle successor observers');
        for (const observer of names.inputs) {
          const targetInput = target.values[observer];
          const initialInput = initial.values[observer];
          if (!targetInput || !initialInput || !sameSymbolicValue(targetInput, initialInput)) return fail('oracle successor changes an input observer');
        }
        const state = Object.fromEntries(witness.variables.map(variable => [variable, target.values[variable] ?? fail('incomplete original oracle successor')]));
        const observedEdge = edgeKey(initial.values, action.value, state);
        if (!baseEdges.has(observedEdge)) return fail('oracle action is outside the original configured Next relation');
        observedEdges.add(observedEdge);
        actual.set(JSON.stringify([action.value, stateKey(state)]), { action: action.value, state });
      }
      if (actual.size > 1) return fail('original TLA+ has multiple enabled action/results for one state/input');
      const oracleInput = model.version === 1
        ? typeof firstInput === 'string' ? firstInput : fail('single-input oracle requires an opaque input identity')
        : inputFrame;
      const expected = stepSymbolic(model, initial.values, oracleInput);
      if (expected.kind === 'ambiguous') return fail('symbolic IR has multiple enabled branches for one original state/input');
      if (expected.kind === 'disabled') {
        if (actual.size !== 0) return fail('symbolic IR disables an original enabled state/input');
        disabledCases++;
      } else {
        const outcome = [...actual.values()][0];
        if (!outcome || outcome.action !== expected.action || stateKey(outcome.state) !== stateKey(expected.state)) return fail('symbolic action or complete successor differs from the original TLA+ state/input oracle');
        if (!baseStates.has(stateKey(outcome.state))) return fail('original action successor is outside the completed base graph');
        acceptedCases++;
      }
    }
    if (seenCases.size !== checkedCases) return fail('oracle did not cover the complete reachable finite state/input product');
    if (observedEdges.size !== baseEdges.size) return fail('oracle action selection omits part of the original configured Next relation');
    for (const node of oracle.nodes) {
      const phase = node.values[names.step];
      if (phase?.kind !== 'string' || !['before', 'after'].includes(phase.value)) return fail('unexpected oracle observer phase');
      if (phase.value === 'before' && !oracle.initial.includes(node.id)) return fail('noninitial before state in one-step oracle');
      if (phase.value === 'after' && oracle.edges.some(edge => edge.from === node.id)) return fail('one-step oracle contains an outgoing after transition');
    }
    return { witness, evidence: {
      kind: 'tlc-finite-input-oracle', scope: 'configured-reachable-state-input-product',
      ...(model.version === 1 ? { domain: firstParameter.domain, atoms: [...(domains[firstParameter.domain] ?? [])] }
        : model.version === 2 ? { domains, inputs: parameters.map(({ parameter, domain }) => ({ parameter, domain })) }
          : { symbolicIrVersion: 3, inputProfile: 'mixed-finite-opaque-v1', domains, inputs: parameters.map(parameter => ({ ...parameter })) }),
      stateCount: witness.nodes.length, checkedCases, acceptedCases, disabledCases, base: run.evidence, oracle: oracleRun.evidence,
    }, oracleDot: oracleRun.dot, oracleLog: oracleRun.log };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
