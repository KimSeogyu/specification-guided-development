import { validateExecutableGraph, type OwnedBackendInput, type FiniteValue } from '../finite-types.js';
import type { GeneratedFile } from '../types.js';

/** Experimental pure transition core. This is not a private live-state owner or an async port driver. */
export function generateBendCore(input: OwnedBackendInput): GeneratedFile[] {
  const graph = validateExecutableGraph(input.automaton);
  if (!/^[A-Z][A-Za-z0-9]*$/.test(input.className)) throw new Error('BND101: invalid domain name');
  const nodes = [...graph.nodes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const actions = [...graph.actions].sort();
  if (nodes.length * actions.length > 4096) throw new Error('BND101: experimental Bend core supports at most 4096 state/action cases');
  const variables = [...graph.variables].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const prefix = `Sgd${input.className}`;
  const stateType = `${prefix}State`;
  const eventType = `${prefix}Event`;
  const resultType = `${prefix}Result`;
  const scalarType = `${prefix}Scalar`;
  const fieldType = `${prefix}Field`;
  const stateConstructor = (index: number): string => `${prefix}S${index}`;
  const eventConstructor = (index: number): string => `${prefix}E${index}`;
  const ids = new Map(nodes.map((node, index) => [node.id, index]));
  const indexOf = (id: string): number => {
    const index = ids.get(id);
    if (index === undefined) throw new Error('BND101: missing concrete state');
    return index;
  };
  const initial = graph.initial[0];
  if (initial === undefined) throw new Error('BND101: missing initial state');
  // Explicit scalar constructors avoid injecting source text or relying on a
  // different language's string-escape grammar. Integers remain decimal text.
  const stringValue = (value: string): string => [...value].reverse().reduce((tail, char) => {
    const point = char.codePointAt(0);
    if (point === undefined) throw new Error('BND101: invalid Unicode scalar');
    return `SCon{Chr{${point}}, ${tail}}`;
  }, 'SNil{}');
  const scalar = (value: FiniteValue, qualifier = ''): string => {
    switch (value.kind) {
      case 'string': return `${qualifier}${prefix}Text{${stringValue(value.value)}}`;
      case 'boolean': return `${qualifier}${prefix}Flag{${value.value ? 'True{}' : 'False{}'}}`;
      case 'integer': return `${qualifier}${prefix}Integer{${stringValue(value.value)}}`;
      default: { const exhaustive: never = value; return exhaustive; }
    }
  };
  const valuation = (node: typeof nodes[number], qualifier = ''): string => `[${variables.map(variable => {
    const value = node.values[variable.name];
    if (value === undefined) throw new Error('BND101: missing model variable');
    return `${qualifier}${fieldType}{${stringValue(variable.name)}, ${scalar(value, qualifier)}}`;
  }).join(', ')}]`;
  const cases = nodes.flatMap((node, state) => actions.map((event, action) => {
    const edge = graph.edges.find(item => item.from === node.id && item.event === event);
    const next = edge === undefined ? state : indexOf(edge.to);
    return { state, action, event, from: node.id, to: nodes[next]?.id, accepted: edge !== undefined,
      next, code: next * 2 + (edge === undefined ? 0 : 1) };
  }));
  const result = (item: typeof cases[number], qualifier = ''): string =>
    `${qualifier}${prefix}${item.accepted ? 'Accepted' : 'Rejected'}{${qualifier}${stateConstructor(item.next)}{}}`;
  const domain = `# Generated experimental pure Bend core; no state ownership or effect adapter is implied.
import Base

type ${stateType} is Data:
${nodes.map((_, index) => `  ${stateConstructor(index)}{}`).join('\n')}

type ${eventType} is Data:
${actions.map((_, index) => `  ${eventConstructor(index)}{}`).join('\n')}

type ${resultType} is Data:
  ${prefix}Accepted{state: ${stateType}}
  ${prefix}Rejected{state: ${stateType}}

type ${scalarType} is Data:
  ${prefix}Text{value: String}
  ${prefix}Flag{value: Bool}
  ${prefix}Integer{decimal: String}

type ${fieldType} is Data:
  ${fieldType}{name: String, value: ${scalarType}}

def initial() -> ${stateType}:
  ${stateConstructor(indexOf(initial))}{}

def step(state: ${stateType}, event: ${eventType}) -> ${resultType}:
  match state:
${nodes.map((_, state) => `    case ${stateConstructor(state)}{}:
      match event:
${cases.filter(item => item.state === state).map(item => `        case ${eventConstructor(item.action)}{}:
          ${result(item)}`).join('\n')}`).join('\n')}

def read(state: ${stateType}) -> List<${fieldType}>:
  match state:
${nodes.map((node, index) => `    case ${stateConstructor(index)}{}:
      ${valuation(node)}`).join('\n')}

def state_index(state: ${stateType}) -> U32:
  match state:
${nodes.map((_, index) => `    case ${stateConstructor(index)}{}:
      ${index}`).join('\n')}

def result_code(result: ${resultType}) -> U32:
  match result:
    case ${prefix}Accepted{state}:
      ((2 * state_index(state)) + 1 : U32)
    case ${prefix}Rejected{state}:
      (2 * state_index(state) : U32)
`;
  const laws = `# Expected decisions and valuations are derived from the controlled finite graph.
# Keep this file fixed when testing changes to domain.bend.
import Base
import ./domain.bend as Domain

law initial:
  {Domain.initial() == Domain.${stateConstructor(indexOf(initial))}{} : Domain.${stateType}}

${cases.map(item => `law transition_${item.state}_${item.action}:
  {Domain.step(Domain.${stateConstructor(item.state)}{}, Domain.${eventConstructor(item.action)}{}) == ${result(item, 'Domain.')} : Domain.${resultType}}
`).join('\n')}
${nodes.map((node, index) => `law valuation_${index}:
  {Domain.read(Domain.${stateConstructor(index)}{}) == ${valuation(node, 'Domain.')} : List<Domain.${fieldType}>}
`).join('\n')}`;
  const proof = `import ./LAWS.bend as Laws

def Laws.initial():
  {==}

${cases.map(item => `def Laws.transition_${item.state}_${item.action}():
  {==}
`).join('\n')}
${nodes.map((_, index) => `def Laws.valuation_${index}():
  {==}
`).join('\n')}`;
  const runner = `import Base
import ./domain.bend as Domain

def main() -> List<U32>:
  [${cases.map(item => `Domain.result_code(Domain.step(Domain.${stateConstructor(item.state)}{}, Domain.${eventConstructor(item.action)}{}))`).join(', ')}]
`;
  return [
    { path: 'domain.bend', content: domain },
    { path: 'LAWS.bend', content: laws },
    { path: 'PROOF.bend', content: proof },
    { path: 'cases.bend', content: runner },
    { path: 'model.json', content: JSON.stringify({ kind: 'experimental-bend-core', model: graph,
      stateType, eventType, resultType, states: nodes.map((node, index) => ({ id: node.id, constructor: stateConstructor(index) })),
      actions: actions.map((name, index) => ({ name, constructor: eventConstructor(index) })), cases,
      limits: ['pure explicit-state functions', 'constructors are public; not a private live owner', 'no DI port driver',
        'Bend parser/translation/native backends remain trust boundaries', 'untyped JS/FFI inputs require separate validation'] }, null, 2) + '\n' },
    { path: 'README.md', content: `# Experimental Bend domain core\n\nGenerated from an exact finite TLA+/TLC graph. Run \`bend PROOF.bend --verdict\`, then \`bend cases.bend\`. Emit JavaScript with \`bend domain.bend -o domain.mjs\` or a native test executable with \`bend cases.bend -o cases\`.\n\nThe laws check the initial state, every state/action decision, and all modeled variable values. Rejection preserves the supplied state. Keep laws unchanged while reviewing implementation changes. These finite checks do not prove the text generator itself or Bend's native backend.\n\nThis core is pure: callers supply state explicitly, and constructors are public. It is not the TypeScript domain's private state owner and does not generate injected effect orchestration. Do not treat unchecked JavaScript constructor objects as typed Bend values. Integer model values are preserved as decimal strings.\n` },
  ];
}
