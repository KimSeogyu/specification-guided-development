import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { generateVisualization } from '../src/visualize.js';
import type { Automaton } from '../src/types.js';

class Control {
  value = '0';
  textContent = '';
  private readonly listeners = new Map<string, () => void>();
  addEventListener(event: string, listener: () => void): void { this.listeners.set(event, listener); }
  dispatch(event: string): void {
    const listener = this.listeners.get(event);
    assert.ok(listener, `Registered ${event} listener`);
    listener();
  }
}

function explorer({ resizeObserver = true } = {}) {
  const models: Automaton[] = ['Architecture', 'ReleaseGate'].map(name => ({
    version: 1, name, stateVariable: 'phase', states: ['Draft', 'Released'], initialStates: ['Draft'],
    transitions: [{ from: 'Draft', event: 'Publish', to: 'Released' }],
    source: { dotSha256: 'test', stateCount: 2, edgeCount: 1 },
  }));
  const html = generateVisualization(models).find(file => file.path === 'index.html')?.content;
  assert.ok(html);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'Execute the actual generated explorer script');
  const widths = [...html.matchAll(/<svg\b[^>]*\bviewBox="([^"]+)"[^>]*>/g)].map(match => {
    const width = Number(match[1]?.split(/\s+/)[2]);
    assert.ok(Number.isFinite(width) && width > 0, 'Use actual Pele intrinsic geometry');
    return width;
  });
  assert.equal(widths.length, models.length + 1);
  const figures = widths.map((width, index) => {
    const svg = { viewBox: { baseVal: { width } }, style: { width: '', height: '' } };
    const viewport = {
      clientWidth: width * (index === 0 ? .5 : .6) + 44,
      paddingLeft: '18px', paddingRight: '26px',
      querySelector(selector: string) { assert.equal(selector, 'svg'); return svg; },
    };
    return {
      hidden: index !== 0, dataset: { index: String(index) }, viewport, svg,
      querySelector(selector: string) { assert.equal(selector, '.viewport'); return viewport; },
    };
  });
  const controls = new Map(['#model', '#zoom', '#in', '#out', '#fit', '#search'].map(id => [id, new Control()]));
  const frames: (() => void)[] = [];
  const windowListeners = new Map<string, () => void>();
  let observedResize: () => void = () => assert.fail('ResizeObserver was not registered');
  const observed = new Set();
  runInNewContext(script, {
    document: {
      querySelector(selector: string) {
        if (selector === '.diagram:not([hidden])') return figures.find(figure => !figure.hidden);
        const control = controls.get(selector);
        assert.ok(control, `Known generated control ${selector}`);
        return control;
      },
      querySelectorAll(selector: string) {
        if (selector === '.diagram') return figures;
        assert.equal(selector, '.viewport');
        return figures.map(figure => figure.viewport);
      },
    },
    getComputedStyle: (viewport: { paddingLeft: string; paddingRight: string }) => viewport,
    requestAnimationFrame(callback: () => void) { frames.push(callback); return frames.length; },
    window: { addEventListener(event: string, listener: () => void) { windowListeners.set(event, listener); } },
    ...(resizeObserver ? { ResizeObserver: class {
      constructor(callback: () => void) { observedResize = callback; }
      observe(viewport: unknown) { observed.add(viewport); }
    } } : {}),
  });
  function control(id: string): Control {
    const value = controls.get(id);
    assert.ok(value);
    return value;
  }
  return {
    figures, observed,
    zoomLabel: () => control('#zoom').textContent,
    select(index: number) { control('#model').value = String(index); control('#model').dispatch('change'); },
    click(id: 'in' | 'out' | 'fit') { control(`#${id}`).dispatch('click'); },
    resize() {
      if (resizeObserver) observedResize();
      else { const listener = windowListeners.get('resize'); assert.ok(listener); listener(); }
      while (frames.length) frames.shift()?.();
    },
  };
}

test('generated explorer fits the overview and newly selected models before any Fit click', () => {
  const page = explorer();
  const [overview, model] = page.figures;
  assert.ok(overview && model);
  assert.equal(Number.parseFloat(overview.svg.style.width), overview.viewport.clientWidth - 44);
  assert.equal(page.zoomLabel(), '50%');
  assert.equal(page.observed.size, page.figures.length);
  page.select(1);
  assert.equal(overview.hidden, true);
  assert.equal(model.hidden, false);
  assert.equal(Number.parseFloat(model.svg.style.width), model.viewport.clientWidth - 44);
  assert.equal(page.zoomLabel(), '60%');
});

test('responsive fit follows container resizing while each model retains its manual zoom choice', () => {
  const page = explorer();
  const [overview, model] = page.figures;
  assert.ok(overview && model);
  overview.viewport.clientWidth = overview.svg.viewBox.baseVal.width * .4 + 44;
  page.resize();
  assert.equal(page.zoomLabel(), '40%');
  page.click('in');
  assert.equal(page.zoomLabel(), '50%');
  const manualWidth = overview.svg.style.width;
  overview.viewport.clientWidth = overview.svg.viewBox.baseVal.width * .3 + 44;
  page.resize();
  assert.equal(overview.svg.style.width, manualWidth);
  page.select(1);
  assert.equal(page.zoomLabel(), '60%');
  model.viewport.clientWidth = model.svg.viewBox.baseVal.width * .8 + 44;
  page.resize();
  assert.equal(page.zoomLabel(), '80%');
  page.click('out');
  assert.equal(page.zoomLabel(), '64%');
  page.select(0);
  assert.equal(page.zoomLabel(), '50%');
  assert.equal(overview.svg.style.width, manualWidth);
  page.click('fit');
  assert.equal(page.zoomLabel(), '30%');
  overview.viewport.clientWidth = overview.svg.viewBox.baseVal.width * .5 + 44;
  page.resize();
  assert.equal(page.zoomLabel(), '50%');
  page.select(1);
  assert.equal(page.zoomLabel(), '64%');
});

test('window resize fallback retains fit and manual zoom behavior without ResizeObserver', () => {
  const page = explorer({ resizeObserver: false });
  const overview = page.figures[0];
  assert.ok(overview);
  overview.viewport.clientWidth = overview.svg.viewBox.baseVal.width * .7 + 44;
  page.resize();
  assert.equal(page.zoomLabel(), '70%');
  page.click('out');
  assert.equal(page.zoomLabel(), '56%');
  const manualWidth = overview.svg.style.width;
  overview.viewport.clientWidth = overview.svg.viewBox.baseVal.width * .5 + 44;
  page.resize();
  assert.equal(overview.svg.style.width, manualWidth);
});

test('fit handles narrow panels without a 25% floor, and zoom buttons retain their direction', () => {
  const page = explorer();
  const overview = page.figures[0];
  assert.ok(overview);
  overview.viewport.clientWidth = overview.svg.viewBox.baseVal.width * .1 + 44;
  page.resize();
  assert.equal(page.zoomLabel(), '10%');
  assert.equal(Number.parseFloat(overview.svg.style.width), overview.viewport.clientWidth - 44);
  page.click('out');
  assert.equal(page.zoomLabel(), '8%');
  page.click('in');
  assert.equal(page.zoomLabel(), '10%');
  page.click('fit');
  overview.viewport.clientWidth = overview.svg.viewBox.baseVal.width * 8 + 44;
  page.resize();
  assert.equal(page.zoomLabel(), '100%');
  page.click('in');
  assert.equal(page.zoomLabel(), '125%');
});
