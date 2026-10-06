const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { inflateSync } = require('node:zlib');
const ts = require('typescript');
const compile = code => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const read = path => readFileSync(`${__dirname}/${path}`, 'utf8');
function exportsOf(source, requireMock) {
  const exports = {}; new Function('exports', 'require', compile(source))(exports, requireMock); return exports;
}
const data = exportsOf(read('../game/data.ts'), () => { throw new Error('Unexpected data dependency'); });
const geometry = exportsOf(read('../game/paperGeometry.ts'), () => data);
const manifest = JSON.parse(read('../../public/paper-assets/manifest.json'));
const paletteTest = ts.createSourceFile('palette.cjs', read('../game/soldier-back-palette.regression.test.cjs'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const decoder = paletteTest.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'png');
assert.ok(decoder, 'reuse existing actual PNG decoder');
const png = new Function('readFileSync', 'inflateSync', 'assert', `${decoder.getText(paletteTest)}; return png;`)(readFileSync, inflateSync, assert);
const sprites = new Map();
for (const [id, model] of Object.entries(manifest.mobs)) for (const view of id === 'soldier' ? ['front', 'back'] : ['front']) {
  for (const part of ['shadow', ...Object.keys(model.pivots)].filter(key => view !== 'back' || !key.startsWith('arm_'))) {
    const path = `mobs/${id}/${view}/${part}.png`;
    const image = png(`${__dirname}/../../public/paper-assets/runtime/${path}`);
    sprites.set(path, { image: { ...image, path }, bounds: image.bounds });
  }
}
const assets = ts.createSourceFile('assets.ts', read('../game/paperAssets.ts'), ts.ScriptTarget.Latest, true);
const functions = assets.statements.filter(node => ts.isFunctionDeclaration(node)
  && ['enemyGeometry', 'createPaperEnemyFrame', 'drawPaperEnemy', 'getPaperEnemyVisibleBounds'].includes(node.name?.text));
assert.equal(functions.length, 4);
const actual = new Function('exports', 'manifest', 'sprites', 'paperEnemyPose', 'tintedPart',
  compile(functions.map(node => node.getText(assets)).join('\n')) + '; return exports;')({}, manifest, sprites,
  geometry.paperEnemyPose, (path, variant) => ({ ...sprites.get(path).image, variant }));
const ids = Object.keys(manifest.mobs), forwarded = [];
const bridge = { ...actual,
  drawPaperEnemy: (...args) => { forwarded.push(['draw', ...args.slice(2)]); return actual.drawPaperEnemy(...args); },
  getPaperEnemyVisibleBounds: (...args) => { forwarded.push(['bounds', ...args.slice(1)]); return actual.getPaperEnemyVisibleBounds(...args); },
};
const moduleSource = read('MobMotionReview.tsx');
const api = exportsOf(moduleSource, name => {
  if (name === 'react') return {};
  if (name === 'react/jsx-runtime') return {};
  if (name.endsWith('/data')) return data;
  if (name.endsWith('/paperAssets')) return bridge;
  if (name.endsWith('/visualQaFixtures')) return { QA_ENEMY_IDS: ids };
  if (name.endsWith('.css')) return {};
  throw new Error(name);
});
function context() {
  const calls = [], stack = [];
  return { calls, globalAlpha: 1, filter: 'none',
    save() { stack.push([this.globalAlpha, this.filter]); },
    restore() { [this.globalAlpha, this.filter] = stack.pop(); },
    clearRect(...args) { calls.push(['clear', ...args]); },
    transform(...args) { calls.push(['matrix', ...args]); },
    drawImage(image, ...args) { calls.push(['draw', image.path, image.variant, ...args]); },
  };
}
let poses = 0;
for (const id of ids) for (const cell of [28, 34]) for (const palette of [0, 1, 2, 3]) {
  for (const back of id === 'soldier' ? [false, true] : [false]) for (const phase of [0, 1 / 12, .375]) {
    for (const [system, manual, frozen] of [[false, false, false], [true, false, false], [false, true, false], [false, false, true]]) {
      const ctx = context();
      assert.equal(api.renderReviewPose(ctx, id, cell, phase, palette, back, system, manual, frozen), true);
      const [drawArgs, boundsArgs] = forwarded.splice(0);
      assert.deepEqual(drawArgs.slice(1), boundsArgs.slice(1), 'body and health share all pose inputs/frame/reduced flag');
      const heading = back ? -Math.PI / 2 : Math.PI / 2;
      assert.equal(drawArgs[2], heading); assert.equal(drawArgs[3], !(system || manual || frozen));
      assert.equal(drawArgs.at(-1), system || manual);
      const spec = data.ENEMIES[id], enemy = { id, uid: `review-${id}`, pos: { x: 32, y: 32 }, speed: spec.speed * 28,
        paletteVariant: palette, visualScale: Math.max(.6, Math.min(1.35, spec.visualScale ?? 1)), hp: spec.hp, maxHp: spec.hp };
      const direct = context(); actual.drawPaperEnemy(direct, enemy, phase, heading, !(system || manual || frozen), cell,
        actual.createPaperEnemyFrame(), system || manual);
      assert.deepEqual(ctx.calls.slice(1), direct.calls, 'actual PNG paths/matrices/order/variant unchanged; no enlargement');
      assert.ok(ctx.calls.filter(call => call[0] === 'draw').every(call => call[2] === palette));
      if (system || manual || frozen) {
        const later = context(); api.renderReviewPose(later, id, cell, phase + 100, palette, back, system, manual, frozen);
        forwarded.splice(0); assert.deepEqual(later.calls, ctx.calls, 'reduced/stationary phase invariant');
      }
      poses++;
    }
  }
}
assert.deepEqual([NaN, 0, 1, 2, 4].map(api.reviewDpr), [1, 1, 1, 2, 3]);
assert.deepEqual(api.reviewMotion(true, false, false), { reduced: true, moving: false });
for (const id of ids) {
  const first = context(), stepped = context();
  api.renderReviewPose(first, id, 28, 0, 0, false, false, false, false);
  api.renderReviewPose(stepped, id, 28, 1 / 12, 0, false, false, false, false);
  assert.notDeepEqual(first.calls, stepped.calls, `${id}: normal Step changes actual pose`);
}
forwarded.splice(0);
const pending = new Map(), cancelled = [], clock = { phase: 2 };
let sequence = 0, draws = 0;
const request = callback => { pending.set(++sequence, callback); return sequence; };
const cancel = handle => { pending.delete(handle); cancelled.push(handle); };
const tick = now => { assert.equal(pending.size, 1, 'one bounded rAF'); const [id, callback] = pending.entries().next().value;
  pending.delete(id); callback(now); return callback; };
let stop = api.startReviewClock(clock, request, cancel, () => { draws++; return true; });
tick(1000); tick(1083); assert.ok(Math.abs(clock.phase - 2.083) < 1e-9);
const stale = tick(100000); assert.ok(Math.abs(clock.phase - 2.183) < 1e-9, 'long frames bounded');
stop(); assert.equal(pending.size, 0); const paused = clock.phase; stale(200000); assert.equal(clock.phase, paused);
clock.phase += 1 / 12; const stepped = clock.phase;
stop = api.startReviewClock(clock, request, cancel, () => true);
tick(300000); assert.equal(clock.phase, stepped, 'resume/control change excludes paused wall time');
stop(); assert.equal(pending.size, 0);
api.startReviewClock(clock, request, cancel, () => false); tick(300100); assert.equal(pending.size, 0, 'error stops loop');
assert.ok(draws === 3 && cancelled.length === 2);

// Execute component effects and cleanup with deterministic browser/hook surfaces.
let states = [], refs = [], effects = [], stateIndex = 0, refIndex = 0;
const React = {
  useState(initial) { const index = stateIndex++; if (!(index in states)) states[index] = initial;
    return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
  useRef(initial) { const index = refIndex++; return refs[index] ??= { current: initial }; },
  useEffect(effect) { effects.push(effect); },
};
const jsx = (type, props) => ({ type, props });
let mediaHandler, visibilityHandler, observerCallback, disconnected = false;
global.window = { matchMedia: () => ({ matches: false, addEventListener: (_, fn) => { mediaHandler = fn; },
  removeEventListener: (_, fn) => { assert.equal(fn, mediaHandler); mediaHandler = null; } }), devicePixelRatio: 4 };
global.document = { visibilityState: 'visible', addEventListener: (_, fn) => { visibilityHandler = fn; },
  removeEventListener: (_, fn) => { assert.equal(fn, visibilityHandler); visibilityHandler = null; } };
global.IntersectionObserver = class { constructor(fn) { observerCallback = fn; } observe() {} disconnect() { disconnected = true; } };
global.requestAnimationFrame = request; global.cancelAnimationFrame = cancel;
let status = 'ready', renderCount = 0;
const component = exportsOf(moduleSource, name => {
  if (name === 'react') return React;
  if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
  if (name.endsWith('/data')) return data;
  if (name.endsWith('/paperAssets')) return { ...bridge, usePaperAssets: () => status,
    drawPaperEnemy: (...args) => { renderCount++; return actual.drawPaperEnemy(...args); } };
  if (name.endsWith('/visualQaFixtures')) return { QA_ENEMY_IDS: ids };
  return {};
}).default;
function mount(expanded) {
  stateIndex = 0; refIndex = 0; effects = [];
  const tree = component({ expanded });
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.props?.ref) {
      const target = node.type === 'canvas' ? { width: 64, height: 64, getContext: () => ({ ...context(), setTransform() {} }) } : {};
      if (typeof node.props.ref === 'function') node.props.ref(target); else node.props.ref.current = target;
    }
    const children = node.props?.children; (Array.isArray(children) ? children.flat(Infinity) : [children]).forEach(visit);
  };
  visit(tree); return effects;
}
const initial = mount(false); const cleanupMedia = initial[0](), cleanupVisibility = initial[1](); initial[2]();
assert.equal(renderCount, 0);
observerCallback([{ isIntersecting: true }]);
let current = mount(true); current[2](); assert.equal(renderCount, 22, '22 actual poses, no extra draw for bounds');
states[2] = true; current = mount(true); let cleanupClock = current[2](); assert.equal(pending.size, 1);
tick(10); assert.equal(renderCount, 66); cleanupClock(); assert.equal(pending.size, 0);
const componentPhase = refs[3].current.phase;
document.visibilityState = 'hidden'; visibilityHandler(); current = mount(true); current[2](); assert.equal(pending.size, 0);
assert.equal(refs[3].current.phase, componentPhase, 'hidden phase does not advance');
status = 'loading'; states[6] = true; current = mount(true); current[2](); assert.equal(pending.size, 0);
assert.equal(refs[3].current.phase, componentPhase, 'asset suspension preserves phase');
status = 'ready'; current = mount(false); current[2](); assert.equal(pending.size, 0);
assert.equal(refs[3].current.phase, componentPhase, 'closed section preserves phase');
document.visibilityState = 'visible'; states[5] = true;
const beforeReduced = renderCount; current = mount(true); current[2]();
assert.equal(renderCount - beforeReduced, 22, 'system reduced motion still renders every mob at both cells');
assert.equal(pending.size, 0); assert.equal(refs[3].current.phase, componentPhase);
cleanupMedia(); cleanupVisibility(); assert.ok(disconnected && !visibilityHandler && !mediaHandler);
console.log(`mob motion review PASS: ${poses} actual-PNG recorded poses; 22/frame; clock/step/pause/control continuity/error/cancel/visibility/ready/reduced lifecycle`);
