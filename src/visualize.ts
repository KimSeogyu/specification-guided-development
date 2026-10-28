import { readFile } from 'node:fs/promises';
import { render } from 'pele';
import { AutomatonSchema, type Automaton, type GeneratedFile } from './types.js';
import { FiniteGraphSchema, type ExactFiniteAutomaton, type FiniteValue } from './finite-types.js';
import { z } from 'zod';
import { SymbolicModelSchema, symbolicInputDefinitions, symbolicInputs, validateSymbolicModel, type SymbolicInput, type SymbolicModel, type SymbolicValue } from './symbolic-types.js';
import { SymbolicWitnessSchema, type SymbolicWitnessGraph } from './symbolic-witness.js';
import { inspectSymbolicOrbits } from './symbolic-semantics.js';

type Model = Automaton | ExactFiniteAutomaton | SymbolicWitnessGraph | SymbolicModel;

function finiteValue(value: FiniteValue | SymbolicValue): string {
  switch (value.kind) {
    case 'string': return JSON.stringify(value.value);
    case 'boolean': return value.value ? 'TRUE' : 'FALSE';
    case 'integer': return value.value;
    case 'data': return `data(${value.domain}, ${JSON.stringify(value.value)})`;
  }
}

/** Rendering captions contain every variable; the original typed IR is saved in models.json. */
function displayModel(model: Model): Automaton {
  if (!('kind' in model)) return model;
  if (model.kind === 'symbolic-owned') {
    const proof = inspectSymbolicOrbits(model);
    const inputCaption = (input: SymbolicInput): string => typeof input === 'string' ? input : symbolicInputs(model).map(({ parameter, domain }) => {
      const value = input[parameter];
      if (value === undefined) throw new Error('TLC105: incomplete symbolic input frame');
      return `${parameter}[${domain}] = ${typeof value === 'string' ? JSON.stringify(value) : finiteValue(value)}`;
    }).join(', ');
    const captions = proof.states.map((state, index) => `s${index}\n${model.variables.map(variable => {
      const value = state[variable];
      if (!value) throw new Error('TLC105: incomplete orbit state');
      return `${variable} = ${finiteValue(value)}`;
    }).join('\n')}`);
    const caption = (index: number): string => captions[index] ?? (() => { throw new Error('TLC105: unknown orbit state'); })();
    return { version: 1, name: `${model.name} · symbolic relation`, stateVariable: 'orbit', states: captions, initialStates: [caption(0)],
      transitions: proof.edges.map(edge => ({ from: caption(edge.from), event: `${edge.action} / input ${inputCaption(edge.input)}`, to: caption(edge.to) })),
      source: { dotSha256: model.source.semanticSha256, stateCount: proof.states.length, edgeCount: proof.edges.length } };
  }
  const captions = new Map(model.nodes.map(node => [node.id, `${node.id}\n${model.variables.map(variable => {
    const name = typeof variable === 'string' ? variable : variable.name;
    const value = node.values[name];
    if (value === undefined) throw new Error('TLC105: incomplete concrete state');
    return `${name} = ${finiteValue(value)}`;
  }).join('\n')}`]));
  const caption = (id: string): string => {
    const value = captions.get(id);
    if (value === undefined) throw new Error('TLC105: unknown concrete node');
    return value;
  };
  return {
    version: 1, name: model.kind === 'symbolic-witness' ? `${model.name} · finite TLC witness` : model.name, stateVariable: 'concreteNode',
    states: model.nodes.map(node => caption(node.id)), initialStates: model.initial.map(caption),
    transitions: model.edges.map(edge => ({ from: caption(edge.from), event: edge.event, to: caption(edge.to) })), source: model.source,
  };
}

function scope(model: Model, view: Automaton): string {
  if (!('kind' in model)) return `${model.source.stateCount} concrete states · ${model.states.length} projected states · ${model.transitions.length} projected edges`;
  if (model.kind === 'symbolic-owned') {
    const inputs = model.version === 3 ? ` Inputs: ${symbolicInputDefinitions(model).map(input => input.kind === 'opaque'
      ? `${input.parameter} in opaque ${input.domain}`
      : `${input.parameter} in finite ${input.domain} {${input.values.map(finiteValue).join(', ')}}`).join(', ')}. Every finite choice is checked with the retained and fresh opaque input classes.`
      : model.version === 2 ? ` Inputs: ${symbolicInputs(model).map(({ parameter, domain }) => `${parameter} in ${domain}`).join(', ')}. Domains are disjoint; input classes are checked as complete tuples.` : '';
    return `${view.states.length} equality/copy orbits · ${view.transitions.length} input-class edges.${inputs} Atom names are local to each state and can change after renaming. This view covers the supported symbolic relation, not arbitrary TLA+.`;
  }
  if (model.kind === 'symbolic-witness') return `${model.nodes.length} configured finite witness states · ${model.edges.length} edges · complete tagged valuations. Pinned DOT omits action arguments; input-verification.json records the separate per-input TLC oracle.`;
  return `${model.nodes.length} full concrete states · ${model.edges.length} concrete edges · all scalar variables retained`;
}

function escape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

const mermaidEscapes: ReadonlyMap<string, string> = new Map([
  ['&', '&amp;'], ['<', '&lt;'], ['>', '&gt;'], ['"', '&quot;'], ["'", '&apos;'], ['#', '&num;'],
  // Pele's entity sentinel starts with this ligature. Reconstruct it only in the final decode.
  ['ﬂ', '#64258;'], ['\n', ' '], ['\r', ' '],
]);

function label(text: string): string {
  return text.replace(/[&<>"'#ﬂ\n\r]/g, character => mermaidEscapes.get(character) ?? character);
}

export function toMermaid(inputModels: Model[]): string {
  const models = inputModels.map(displayModel);
  const names = new Set<string>();
  for (const model of models) {
    if (names.has(model.name)) throw new Error(`TLC105: duplicate model name ${model.name}`);
    names.add(model.name);
  }
  const lines = ['flowchart LR', 'classDef initial fill:#d5f3e8,stroke:#247a65,stroke-width:2px',
    'classDef selfTransitions fill:#fff8df,stroke:#8c7839,stroke-dasharray:4 3'];
  models.forEach((model, mi) => {
    lines.push(`subgraph M${mi}["${label(model.name)}"]`);
    model.states.forEach((state, si) => {
      lines.push(`M${mi}S${si}["${label(state)}"]${model.initialStates.includes(state) ? ':::initial' : ''}`);
    });
    const selfTransitions = new Map<string, string[]>();
    for (const edge of model.transitions) {
      if (edge.from !== edge.to) continue;
      const events = selfTransitions.get(edge.from) ?? [];
      events.push(edge.event);
      selfTransitions.set(edge.from, events);
    }
    const drawnSelfTransitions = new Set<string>();
    for (const edge of model.transitions) {
      const from = model.states.indexOf(edge.from);
      const to = model.states.indexOf(edge.to);
      if (from < 0 || to < 0) throw new Error('TLC105: transition references an unknown state');
      let caption = label(edge.event);
      if (edge.from === edge.to) {
        if (drawnSelfTransitions.has(edge.from)) continue;
        drawnSelfTransitions.add(edge.from);
        const events = selfTransitions.get(edge.from) ?? [edge.event];
        const choices = [`Annotation: ${events.length} self transition${events.length === 1 ? '' : 's'}`,
          ...events.map((event, index) => `${index + 1}. ${label(event)}`)].join('<br/>');
        lines.push(`M${mi}L${from}["${choices}"]:::selfTransitions`);
        lines.push(`M${mi}S${from} -.-|"lists transitions"| M${mi}L${from}`);
        caption = 'self';
      }
      lines.push(`M${mi}S${from} -->|"${caption}"| M${mi}S${to}`);
    }
    lines.push('end');
  });
  models.forEach((model, mi) => {
    if (!model.parent) return;
    const pi = models.findIndex(parent => parent.name === model.parent?.model);
    const parent = models[pi];
    if (!parent) return;
    const si = parent.states.indexOf(model.parent.state);
    if (si < 0) throw new Error(`TLC105: unknown parent state ${model.parent.state}`);
    const first = model.initialStates[0] ?? model.states[0];
    if (!first) throw new Error('TLC105: model has no states');
    lines.push(`M${pi}S${si} -.->|"contains model"| M${mi}S${model.states.indexOf(first)}`);
  });
  return lines.join('\n') + '\n';
}

export function generateVisualization(inputModels: Model[]): GeneratedFile[] {
  const models = inputModels.map(displayModel);
  if (models.length === 0) throw new Error('TLC105: supply at least one automaton');
  const overview = toMermaid(models);
  const diagrams = [
    { name: 'All models', source: overview },
    ...models.map(model => ({ name: model.name, source: toMermaid([model]) })),
  ].map((diagram, i) => ({ ...diagram, ...render(diagram.source, { idPrefix: `tlc${i}-`, links: false, images: false, maxWidth: 1400, responsive: false }) }));
  const overviewDiagram = diagrams[0];
  if (!overviewDiagram) throw new Error('TLC105: no diagram was rendered');
  const options = diagrams.map((diagram, i) => `<option value="${i}">${escape(diagram.name)}</option>`).join('');
  const figures = diagrams.map((diagram, i) => `<figure class="diagram" data-index="${i}"${i === 0 ? '' : ' hidden'}>
    <figcaption>${escape(diagram.name)}</figcaption><div class="viewport" tabindex="0" aria-label="${escape(diagram.name)} diagram. Scroll to explore.">${diagram.svg}</div></figure>`).join('');
  const tables = models.map((model, index) => `<article><h2>${escape(model.name)}</h2>
    <p>${escape(scope(inputModels[index] ?? model, model))}</p>
    ${model.parent ? `<p>Part of ${escape(model.parent.model)} / ${escape(model.parent.state)}. This is a structural link.</p>` : ''}
    <table><caption>${escape(model.name)} transition relation</caption><thead><tr><th scope="col">From</th><th scope="col">Action</th><th scope="col">To</th></tr></thead>
    <tbody>${model.transitions.map(edge => `<tr><td>${escape(edge.from)}</td><td>${escape(edge.event)}</td><td>${escape(edge.to)}</td></tr>`).join('')}</tbody></table></article>`).join('');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>sgd · Model explorer</title><style>
:root{color-scheme:light;font-family:system-ui,sans-serif;color:#18332d;background:#f5f5ef;--pele-bg:#fffefa;--pele-fg:#18332d;--pele-accent:#247a65;--pele-font:system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0}header,main,footer{max-width:1440px;margin:auto;padding:24px 32px}header{border-bottom:1px solid #d9dfd5}h1{font-size:clamp(26px,4vw,42px);margin:8px 0}h2{font-size:22px}.eyebrow{letter-spacing:.14em;font-size:12px;text-transform:uppercase}p{line-height:1.6;color:#4b625a}.toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:0 0 18px}button,select,input{font:inherit;padding:10px 14px;border:1px solid #acbeb3;border-radius:7px;background:#fffefa;color:inherit;min-height:44px}button{cursor:pointer}button:focus-visible,select:focus-visible,input:focus-visible,.viewport:focus-visible{outline:3px solid #247a65;outline-offset:3px}.diagram,article{margin:0 0 24px;background:#fffefa;border:1px solid #d9dfd5;border-radius:12px;overflow:hidden}figcaption{font-size:14px;padding:14px 18px;border-bottom:1px solid #e6e9e0}.viewport{overflow:auto;max-height:75vh;padding:20px;min-height:180px}.viewport svg{display:block;max-width:none}.diagram[hidden]{display:none}article{padding:20px}table{border-collapse:collapse;width:100%;text-align:left}th,td{padding:10px 12px;border-bottom:1px solid #e6e9e0}caption{text-align:left;margin:12px 0;font-size:14px;color:#4b625a}.scope{border-left:3px solid #247a65;padding-left:16px;max-width:900px}.skip{position:absolute;top:-100px}.skip:focus{top:0;background:white;padding:12px}footer{font-size:13px;color:#4b625a}@media(max-width:600px){header,main,footer{padding:20px 16px}article{overflow:auto}}@media print{.toolbar{display:none}.viewport{max-height:none;overflow:visible}.viewport svg{max-width:100%;height:auto}}
.viewport{scrollbar-gutter:stable}
@media screen{@supports not (scrollbar-gutter:stable){.viewport{overflow-y:scroll}}}
</style></head><body><a class="skip" href="#content">Skip to models</a><header><span class="eyebrow">Specification Guided Development / specification compiler</span><h1>Model explorer</h1>
<p>Architecture and behavior, rendered from one automaton representation with Pele.</p></header><main id="content" tabindex="-1">
<div class="toolbar"><label for="model">View</label><select id="model">${options}</select><button id="out" type="button" aria-label="Zoom out">−</button><button id="in" type="button" aria-label="Zoom in">+</button><button id="fit" type="button">Fit</button><span id="zoom" aria-live="polite">100%</span></div>
${figures}<p class="scope">Read each model's scope below. Exact finite models retain every supported scalar variable. Symbolic relations show equality/copy orbits; their data atom names are local to each state. Configured TLC witnesses keep their finite model values and omit event arguments in ordinary DOT. Projected graphs can hide guards. Green nodes are initial states. A self loop with a transition card represents every numbered alternative in that card, including observations that leave state unchanged. Yellow dashed cards are annotations, not model states. Dashed links connect annotations or show containment; they do not establish refinement. Inspect verification.json and input-verification.json for verification scope. Live-object authority does not establish persistent identity, effect atomicity, or liveness.</p>
<label for="search">Filter transition rows</label> <input id="search" type="search" placeholder="State or action">${tables}</main><footer>Generated by Specification Guided Development · Pele renderer · No network connection is required to view this file.</footer>
<script>
const selector=document.querySelector('#model');const manualScales=new WeakMap();let scale=1;
function zoom(){
  const figure=document.querySelector('.diagram:not([hidden])');const box=figure?.querySelector('.viewport');const svg=box?.querySelector('svg');
  if(figure&&box&&svg){
    const width=svg.viewBox.baseVal.width;const style=getComputedStyle(box);
    const available=box.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
    scale=manualScales.get(figure)??(available>0?Math.min(1,available/width):1);
    svg.style.width=(width*scale)+'px';svg.style.height='auto';
  }
  document.querySelector('#zoom').textContent=Math.round(scale*100)+'%';
}
function adjustZoom(factor){const figure=document.querySelector('.diagram:not([hidden])');if(figure){manualScales.set(figure,Math.max(Number.MIN_VALUE,Math.min(4,scale*factor)));zoom();}}
selector.addEventListener('change',()=>{for(const figure of document.querySelectorAll('.diagram'))figure.hidden=figure.dataset.index!==selector.value;zoom();});
document.querySelector('#in').addEventListener('click',()=>adjustZoom(1.25));document.querySelector('#out').addEventListener('click',()=>adjustZoom(1/1.25));
document.querySelector('#fit').addEventListener('click',()=>{const figure=document.querySelector('.diagram:not([hidden])');if(figure)manualScales.delete(figure);zoom();});
let fitFrame=0;function scheduleFit(){if(!fitFrame)fitFrame=requestAnimationFrame(()=>{fitFrame=0;zoom();});}
if(typeof ResizeObserver==='function'){const observer=new ResizeObserver(scheduleFit);for(const box of document.querySelectorAll('.viewport'))observer.observe(box);}else window.addEventListener('resize',scheduleFit);
document.querySelector('#search').addEventListener('input',event=>{const query=event.target.value.toLowerCase();for(const row of document.querySelectorAll('tbody tr'))row.hidden=!row.textContent.toLowerCase().includes(query);});zoom();
</script></body></html>\n`;
  return [
    { path: 'index.html', content: html.replace(/[ \t]+\n/g, '\n') },
    { path: 'structure.svg', content: overviewDiagram.svg },
    { path: 'structure.mmd', content: overview },
    { path: 'models.json', content: JSON.stringify(inputModels, null, 2) + '\n' },
  ];
}

export async function loadAutomaton(path: string): Promise<Model> {
  const input: unknown = JSON.parse(await readFile(path, 'utf8'));
  const program = SymbolicModelSchema.safeParse(input);
  if (program.success) return validateSymbolicModel(program.data);
  return z.union([FiniteGraphSchema, AutomatonSchema, SymbolicWitnessSchema]).parse(input);
}
