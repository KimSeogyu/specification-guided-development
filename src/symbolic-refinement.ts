import { lstat, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { recordSchema } from './schema-record.js';
import { inspectSymbolicOrbits, sameSymbolicValue, stepSymbolic, type SymbolicState } from './symbolic-semantics.js';
import { symbolicFiniteValueKey, symbolicInputDefinitions, validateSymbolicModel, type SymbolicInput, type SymbolicInputFrameValue, type SymbolicModel, type SymbolicValue } from './symbolic-types.js';

const Identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).refine(name => name !== '__proto__');
export const SymbolicErasureBindingSchema = z.object({
  version: z.literal(1),
  variables: recordSchema(Identifier, Identifier),
  inputs: recordSchema(Identifier, Identifier),
  actions: recordSchema(Identifier, Identifier),
}).strict();
export type SymbolicErasureBinding = z.infer<typeof SymbolicErasureBindingSchema>;
const fail: (message: string) => never = message => { throw new Error(`TLC304: ${message}`); };

function exactMapping(mapping: Record<string, string>, keys: string[], destinations: string[], label: string): void {
  if (Object.keys(mapping).length !== keys.length || keys.some(key => !Object.hasOwn(mapping, key)) ||
    Object.values(mapping).some(value => !destinations.includes(value)) || new Set(Object.values(mapping)).size !== keys.length) {
    fail(`${label} must map every source exactly once to distinct declared destinations`);
  }
}

function representativeInputs(model: SymbolicModel, state: SymbolicState): SymbolicInput[] {
  const parameters = symbolicInputDefinitions(model);
  let frames: Record<string, SymbolicInputFrameValue>[] = [{}];
  for (const parameter of parameters) {
    const atoms = [...new Set(Object.values(state).flatMap(value => value.kind === 'data' && value.domain === parameter.domain ? [value.value] : []))];
    let fresh = '@sgd/fresh';
    while (atoms.includes(fresh)) fresh += '/fresh';
    const choices: readonly SymbolicInputFrameValue[] = parameter.kind === 'finite' ? parameter.values : [...atoms, fresh];
    frames = frames.flatMap(frame => choices.map(value => ({ ...frame, [parameter.parameter]: value })));
  }
  if (model.version !== 1) return frames;
  const parameter = parameters[0] ?? fail('missing abstract input');
  return frames.map(frame => {
    const value = frame[parameter.parameter];
    return typeof value === 'string' ? value : fail('missing opaque representative input');
  });
}

/** Check a complete enabled-input erasure under the admitted equality/copy grammar. */
export function verifySymbolicErasure(input: { abstract: unknown; concrete: unknown; binding: unknown }) {
  const abstract = validateSymbolicModel(input.abstract);
  const concrete = validateSymbolicModel(input.concrete);
  const parsed = SymbolicErasureBindingSchema.safeParse(input.binding);
  if (!parsed.success) fail('invalid erasure binding');
  const binding = parsed.data;
  const abstractInputs = symbolicInputDefinitions(abstract);
  const concreteInputs = symbolicInputDefinitions(concrete);
  const abstractActions = [...new Set(abstract.branches.map(branch => branch.action))].sort();
  const concreteActions = [...new Set(concrete.branches.map(branch => branch.action))].sort();
  exactMapping(binding.variables, abstract.variables, concrete.variables, 'variable projection');
  exactMapping(binding.inputs, abstractInputs.map(parameter => parameter.parameter), concreteInputs.map(parameter => parameter.parameter), 'input projection');
  exactMapping(binding.actions, concreteActions, abstractActions, 'action projection');
  if (Object.values(binding.actions).length !== abstractActions.length) fail('action projection must be a bijection over observable actions');
  const domains = new Map<string, string>();
  for (const parameter of abstractInputs) {
    const source = concreteInputs.find(candidate => candidate.parameter === binding.inputs[parameter.parameter]);
    if (!source) fail('missing projected input parameter');
    if (source.kind !== parameter.kind) fail('projected input kinds differ');
    if (source.kind === 'finite' && parameter.kind === 'finite') {
      const keys = source.values.map(symbolicFiniteValueKey);
      if (keys.length !== parameter.values.length || parameter.values.some((value, index) => symbolicFiniteValueKey(value) !== keys[index])) fail('projected finite input vocabularies differ');
    } else if (source.kind === 'opaque' && parameter.kind === 'opaque') domains.set(source.domain, parameter.domain);
  }
  const projectValue = (value: SymbolicValue): SymbolicValue => {
    if (value.kind !== 'data') return value;
    const domain = domains.get(value.domain) ?? fail('a projected state contains data from an erased domain');
    return { ...value, domain };
  };
  const projectState = (state: SymbolicState): SymbolicState => Object.fromEntries(abstract.variables.map(variable => {
    const concreteVariable = binding.variables[variable] ?? fail('missing projected variable');
    const value = state[concreteVariable] ?? fail('missing concrete state variable');
    return [variable, projectValue(value)];
  }));
  const sameState = (left: SymbolicState, right: SymbolicState): boolean => abstract.variables.every(variable => {
    const a = left[variable]; const b = right[variable];
    return a !== undefined && b !== undefined && sameSymbolicValue(a, b);
  });
  const projectInput = (value: SymbolicInput): SymbolicInput => {
    const first = concreteInputs[0] ?? fail('missing concrete input');
    const frame = typeof value === 'string' ? { [first.parameter]: value } : value;
    const projected = Object.fromEntries(abstractInputs.map(parameter => {
      const concreteParameter = binding.inputs[parameter.parameter] ?? fail('missing projected input');
      return [parameter.parameter, frame[concreteParameter] ?? fail('missing concrete input value')];
    }));
    if (abstract.version !== 1) return projected;
    const parameter = abstractInputs[0] ?? fail('missing abstract input');
    const projectedValue = projected[parameter.parameter];
    return typeof projectedValue === 'string' ? projectedValue : fail('missing projected opaque input value');
  };
  if (!sameState(abstract.initial, projectState(concrete.initial))) fail('projected initial state differs from the abstract model');
  // Each model checks its own complete variable tuple for square-action stuttering.
  inspectSymbolicOrbits(abstract);
  const proof = inspectSymbolicOrbits(concrete);
  let checkedCases = 0;
  let acceptedCases = 0;
  let disabledCases = 0;
  for (const [index, state] of proof.states.entries()) for (const frame of representativeInputs(concrete, state)) {
    if (++checkedCases > 250_000) fail('erasure case limit exceeded; no partial verification is permitted');
    // Use the same representative for state and input. Independently renaming
    // the projected state here would change its equality with this input.
    const high = stepSymbolic(abstract, projectState(state), projectInput(frame));
    const low = stepSymbolic(concrete, state, frame);
    if (high.kind !== low.kind) fail(`enabled-input decision differs in concrete orbit ${index}`);
    if (low.kind === 'ambiguous' || high.kind === 'ambiguous') fail('ambiguous dispatch cannot establish erasure');
    if (low.kind === 'disabled' && high.kind === 'disabled') { disabledCases++; continue; }
    if (low.kind !== 'accepted' || high.kind !== 'accepted') fail('inconsistent erasure decision');
    if (binding.actions[low.action] !== high.action) fail(`observable action differs in concrete orbit ${index}`);
    if (!sameState(high.state, projectState(low.state))) fail(`complete projected successor differs in concrete orbit ${index}`);
    acceptedCases++;
  }
  return {
    version: 1 as const, kind: 'symbolic-enabled-input-erasure' as const,
    scope: 'admitted-equality-copy-orbits' as const,
    abstract: { name: abstract.name, semanticSha256: abstract.source.semanticSha256 },
    concrete: { name: concrete.name, semanticSha256: concrete.source.semanticSha256 },
    binding, concreteOrbitCount: proof.states.length, checkedCases, acceptedCases, disabledCases,
  };
}

export async function verifySymbolicErasureFiles(input: { abstract: string; concrete: string; binding: string }) {
  async function json(path: string): Promise<unknown> {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 16 * 1024 * 1024) fail('erasure inputs must be regular files no larger than 16 MiB');
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  }
  const [abstract, concrete, binding] = await Promise.all([json(input.abstract), json(input.concrete), json(input.binding)]);
  return verifySymbolicErasure({ abstract, concrete, binding });
}
