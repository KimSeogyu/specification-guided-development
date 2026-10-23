import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SaxesParser } from 'saxes';
import { AutomatonSchema, type Automaton, type GeneratedFile } from '../src/types.js';
import { generateVisualization } from '../src/visualize.js';

interface SvgLine { text: string; y: number }
interface SvgText { text: string; lines: SvgLine[] }

function readSvg(svg: string): { attributes: Record<string, string>; texts: SvgText[] } {
  const parser = new SaxesParser({ xmlns: false });
  let attributes: Record<string, string> | undefined;
  const texts: SvgText[] = [];
  let current: SvgText | undefined;
  let line: SvgLine | undefined;
  parser.on('opentag', tag => {
    if (tag.name === 'svg') attributes = tag.attributes;
    if (tag.name === 'text') current = { text: '', lines: [] };
    if (tag.name === 'tspan' && current) {
      line = { text: '', y: Number(tag.attributes.y) };
      current.lines.push(line);
    }
  });
  parser.on('text', value => {
    if (current) current.text += value;
    if (line) line.text += value;
  });
  parser.on('closetag', tag => {
    if (tag.name === 'tspan') line = undefined;
    if (tag.name === 'text' && current) {
      texts.push(current);
      current = undefined;
    }
  });
  parser.write(svg).close();
  assert.ok(attributes, 'Pele emitted an SVG root');
  return { attributes, texts };
}

function file(files: GeneratedFile[], path: string): string {
  const generated = files.find(entry => entry.path === path);
  assert.ok(generated, `Generated ${path}`);
  return generated.content;
}

function model(events: string[]): Automaton {
  return AutomatonSchema.parse({
    version: 1, name: 'Observed transitions', stateVariable: 'state', states: ['x', 'y'], initialStates: ['x'],
    transitions: [
      ...events.map(event => ({ from: 'x', event, to: 'x' })),
      { from: 'x', event: 'Exit', to: 'y' },
      { from: 'y', event: 'Wait', to: 'y' },
    ],
    source: { dotSha256: 'test', stateCount: 2, edgeCount: events.length + 2 },
  });
}

test('Pele lays out every self-transition alternative without losing identical observations or inventing model states', () => {
  const events = ['Same / input a0', 'Clash / input a1', 'Clash / input a1', 'Clash / input a2'];
  const input = model(events);
  const files = generateVisualization([input]);
  const svg = readSvg(file(files, 'structure.svg'));
  const alternatives = svg.texts.find(text => text.lines.map(line => line.text).join(' ').includes('Annotation: 4 self transitions'));
  assert.ok(alternatives, 'The annotation is a measured Pele node, not overlapping edge labels');
  assert.deepEqual(alternatives.lines.map(line => line.text).filter(text => /^\d+\. /.test(text)),
    events.map((event, index) => `${index + 1}. ${event}`));
  for (let index = 1; index < alternatives.lines.length; index++) {
    const previous = alternatives.lines[index - 1];
    const current = alternatives.lines[index];
    assert.ok(previous && current && current.y - previous.y >= 16, 'Each observation has its own readable line');
  }
  assert.deepEqual(JSON.parse(file(files, 'models.json')), [input]);
  const html = file(files, 'index.html');
  const rows = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1];
  assert.ok(rows);
  assert.equal(rows.match(/<tr>/g)?.length, input.transitions.length);
  assert.equal(rows.match(/<td>Clash \/ input a1<\/td>/g)?.length, 2);
  assert.match(rows, /<td>x<\/td><td>Exit<\/td><td>y<\/td>/);
  assert.match(html, /annotations, not model states/);
});

test('one long self-transition and entity-like input text remain fully visible in intrinsic SVG geometry', () => {
  const event = `Same / input ${'x'.repeat(300)} a'b &#39; #39; &apos; "quoted" | <br/>`;
  const files = generateVisualization([model([event])]);
  const svg = readSvg(file(files, 'structure.svg'));
  const annotation = svg.texts.find(text => text.text.includes('Annotation: 1 self transition'));
  assert.ok(annotation);
  const displayed = annotation.lines.map(line => line.text).join(' ');
  assert.ok(displayed.includes(`1. ${event}`), displayed);
  assert.ok(Number(svg.attributes.width) > 2_000, 'Pele includes the full unbroken input in the SVG width');
  assert.equal(svg.attributes.viewBox?.split(' ')[2], svg.attributes.width);
  assert.doesNotMatch(svg.attributes.style ?? '', /max-width\s*:/, 'The explorer controls the width without a responsive clamp');
  assert.doesNotMatch(file(files, 'structure.svg'), /<br\//, 'Input markup stays text');
});

test('literal Unicode sentinel patterns survive Pele rendering without entity or quote substitution', () => {
  for (const input of ['ﬂ°', '¶ß', 'ﬂ°amp¶ß', 'ﬂ°°39¶ß', 'ﬂ°ﬂ°amp¶ß¶ß', 'ﬂ°quot¶ß #39; &#39; &apos;', 'ﬂ°°64258¶ß']) {
    const event = `Same / input ${input}`;
    const files = generateVisualization([model([event])]);
    const svg = readSvg(file(files, 'structure.svg'));
    const annotation = svg.texts.find(text => text.text.includes('Same'));
    assert.ok(annotation);
    const displayed = annotation.lines.map(line => line.text).join(' ');
    assert.ok(displayed.includes(`1. ${event}`), JSON.stringify({ event, displayed }));
    assert.deepEqual(JSON.parse(file(files, 'models.json')), [model([event])]);
  }
});
