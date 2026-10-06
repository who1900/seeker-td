const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const laser = {}, beamGeometry = {};
new Function('exports', compile(readFileSync(`${__dirname}/paperLaserFx.ts`, 'utf8')))(laser);
new Function('exports', compile(readFileSync(`${__dirname}/paperBeamGeometry.ts`, 'utf8')))(beamGeometry);
const text = readFileSync(`${__dirname}/Game.tsx`, 'utf8');
const ast = ts.createSourceFile('Game.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['paperBeamPoints', 'followPaperBeamPoints', 'freezePaperOrigin', 'drawPaperBeam', 'drawPaperDamageEffect', 'drawEffect', 'drawPaperLaserEffects'];
const functions = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text));
assert.equal(functions.length, names.length);
const calls = [], fx = [], legacy = [];
let beamSuccess = true, contactSuccess = true, assetsReady = true;
const game = {};
const assetsAst = ts.createSourceFile('assets.ts', readFileSync(`${__dirname}/paperAssets.ts`, 'utf8'), ts.ScriptTarget.Latest, true);
const preflight = assetsAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'canDrawPaperLaserFx');
const preflightApi = {}, readySprites = new Map();
new Function('exports', 'manifest', 'sprites', compile(preflight.getText(assetsAst)))(preflightApi, { beam_strips: { beam_chain_strip: {} } }, readySprites);
assert.equal(preflightApi.canDrawPaperLaserFx('chain_bounce'), false);
readySprites.set('projectiles/beam_chain_strip.png', {});
assert.equal(preflightApi.canDrawPaperLaserFx('chain_bounce'), false);
readySprites.set('fx_parts/chain_contact.png', {});
assert.equal(preflightApi.canDrawPaperLaserFx('chain_bounce'), true);
assert.equal(preflightApi.canDrawPaperLaserFx('unknown'), false);
new Function('exports', 'PAPER_BEAMS', 'ENGINE_CELL_PX', 'paperLaserRecipe', 'paperLaserFlashOwner', 'capturePaperLaserOriginals', 'canDrawPaperLaserFx', 'drawPaperBeamSegment', 'drawPaperFxSprite',
  `${compile(functions.map(n => n.getText(ast)).join('\n'))}; Object.assign(exports,{drawPaperBeam,drawPaperLaserEffects,drawEffect});`)(game,
  { chain: 'beam_simple_strip', chain_bounce: 'beam_chain_strip', chain_straight: 'beam_pierce_strip' }, 34, laser.paperLaserRecipe, laser.paperLaserFlashOwner, laser.capturePaperLaserOriginals, () => assetsReady,
  (...args) => { calls.push(args.slice(1)); return beamSuccess; }, (...args) => { fx.push(args.slice(1)); return contactSuccess; });
const ctx = new Proxy({ globalAlpha: 1 }, { get(obj, key) { return key in obj ? obj[key] : (...args) => legacy.push([key, ...args]); } });
const viewport = { x: 0, y: 0, width: 340, height: 714 };
const beam = (kind, age, uid = 'beam', points = [{ x: 10, y: 20 }, { x: 100, y: 20 }, { x: 150, y: 50 }]) => ({ uid, kind, towerId: kind === 'chain' ? 'simpleLaser' : kind === 'chain_bounce' ? 'bouncingLaser' : 'straightLaser', sourceTowerUid: 'source', pts: points, x: 10, y: 20, life: .5 - age, maxLife: .5 });
const flash = (parent, node, uid = 'flash') => ({ uid, kind: 'laser_flash', sourceTowerUid: parent.sourceTowerUid, towerId: parent.towerId, x: parent.pts[node].x, y: parent.pts[node].y, life: .12 - (parent.maxLife - parent.life), maxLife: .12 });
const reset = () => { calls.length = 0; fx.length = 0; legacy.length = 0; beamSuccess = contactSuccess = assetsReady = true; };
let cases = 0;
for (const kind of ['chain', 'chain_bounce', 'chain_straight']) for (const age of [0, .03, .06, .09, .119, .12, .18, .24, .49]) for (const reduced of [false, true]) {
  reset(); const effect = beam(kind, age), before = JSON.stringify(effect), contacts = new Set();
  assert.equal(game.drawPaperBeam(ctx, effect, viewport, reduced, contacts), true);
  assert.equal(JSON.stringify(effect), before);
  const recipe = laser.paperLaserRecipe(effect, reduced);
  const baseCalls = calls.filter(call => !call[6]);
  assert.equal(baseCalls.length, recipe.segments.length);
  if (reduced) { assert.equal(baseCalls.length, 2); assert.equal(recipe.thickness, 1); assert.equal(recipe.contactSize, 12); assert.equal(calls.length, 2); }
  if (kind === 'chain_straight') { assert.equal(fx.length, 0); assert.equal(contacts.size, 0); }
  for (const call of calls) { assert.ok(call.slice(3, 5).every(Number.isFinite)); if (call[6]) assert.strictEqual(call[5], viewport); }
  if (kind === 'chain_bounce' && !reduced && age === 0) assert.equal(calls.length, 0);
  if (kind === 'chain_bounce' && !reduced && age === .03) { assert.equal(calls.length, 1); assert.ok(calls[0][2].x > 10 && calls[0][2].x < 100); assert.equal(fx.length, 0); }
  if (kind === 'chain_bounce' && !reduced && age === .18) assert.ok(fx.some(call => call[1] === 150 && call[2] === 50), 'last arrived node gets contact');
  cases++;
}
reset(); const simple = beam('chain', .06, 'simple', [{ x: 10, y: 20 }, { x: 100, y: 20 }]);
game.drawPaperBeam(ctx, simple, viewport); assert.ok(calls[0][3] > 3.4); assert.equal(fx.length, 1);
const enemies = new Map([['live', { hp: 10, pos: { x: 125, y: 35 } }], ['dead', { hp: 0, pos: { x: 999, y: 999 } }]]);
simple.targetUids = ['live'];
const marked = flash(simple, 1), before = JSON.stringify([simple, marked]);
reset(); const cache = new Map();
const result = game.drawPaperLaserEffects(ctx, [simple, marked], enemies, () => ({ x: 12, y: 22 }), viewport, false, cache);
assert.ok(result.suppressed.has(marked.uid)); assert.deepEqual(fx[0].slice(1, 3), [125, 35]);
assert.equal(JSON.stringify([simple, marked]), before);
simple.pts[1] = { x: 125, y: 35 };
reset(); assert.ok(game.drawPaperLaserEffects(ctx, [simple, marked], enemies, () => null, viewport, false, cache).suppressed.has(marked.uid), 'original snapshot survives target movement');
simple.pts[1] = { x: 100, y: 20 };
for (const target of ['dead', 'missing']) {
  reset(); const fallback = { ...simple, targetUids: [target] };
  game.drawPaperLaserEffects(ctx, [fallback], enemies, () => null, viewport, false);
  assert.deepEqual(calls[0][1], simple.pts[0]); assert.deepEqual(calls[0][2], simple.pts[1]);
}
const originCache = new Map();
const frozen = game.freezePaperOrigin(originCache, 'sold', simple.pts[0], { x: 12, y: 22 });
assert.strictEqual(game.freezePaperOrigin(originCache, 'sold', simple.pts[0], null), frozen);
reset(); const other = beam('chain', .06, 'other', [{ x: 10, y: 20 }, { x: 200, y: 50 }]);
assert.ok(game.drawPaperLaserEffects(ctx, [simple, other, marked, flash(other, 1, 'otherFlash')], enemies, () => null, viewport, false).suppressed.size === 2, 'two simultaneous shots disambiguated by original coordinates');
reset(); assert.equal(game.drawPaperLaserEffects(ctx, [simple, { ...simple, uid: 'duplicate' }, marked], enemies, () => null, viewport, false).suppressed.size, 0, 'ambiguous parent retained');
for (const changed of [{ ...marked, sourceTowerUid: 'orphan' }, { ...marked, towerId: 'bouncingLaser' }, { ...marked, x: 333 }, { ...marked, life: .01 }]) {
  reset(); assert.equal(game.drawPaperLaserEffects(ctx, [simple, changed], enemies, () => null, viewport, false).suppressed.size, 0);
}
for (const failed of ['beam', 'contact']) {
  reset(); if (failed === 'beam') beamSuccess = false; else contactSuccess = false;
  const failedResult = game.drawPaperLaserEffects(ctx, [simple, marked], enemies, () => null, viewport, false);
  assert.equal(failedResult.suppressed.size, 0);
  game.drawEffect(ctx, marked); assert.ok(fx.some(call => call[0] === 'hit_laser_mark'), 'legacy flash still rendered on replacement failure');
}
reset(); const bounce = beam('chain_bounce', .03), pending = flash(bounce, 2);
assert.equal(game.drawPaperLaserEffects(ctx, [bounce, pending], enemies, () => null, viewport, false).suppressed.size, 1, 'verified pending node owns early legacy flash without stale contact');
assert.equal(fx.length, 0);
for (const age of [0, .03, .06, .09, .119]) {
  reset(); const effect = beam('chain_bounce', age), flashes = [flash(effect, 1, 'one'), flash(effect, 2, 'two')];
  const result = game.drawPaperLaserEffects(ctx, [effect, ...flashes], enemies, () => null, viewport, false);
  assert.equal(result.suppressed.size, 2, 'arrived or preflight-owned pending nodes have one presentation owner');
}
reset(); assetsReady = false;
assert.equal(game.drawPaperLaserEffects(ctx, [bounce, pending], enemies, () => null, viewport, false).suppressed.size, 0, 'missing assets retain pending legacy');
for (const bad of [{ ...simple, life: NaN }, { ...simple, maxLife: 0 }, { ...simple, pts: [{ x: Infinity, y: 0 }, { x: 1, y: 1 }] }, { ...simple, life: -.1 }]) {
  reset(); assert.equal(laser.paperLaserRecipe(bad), null); game.drawPaperLaserEffects(ctx, [bad], enemies, () => null, viewport, false); assert.equal(calls.length + fx.length + legacy.length, 0);
}
game.drawPaperLaserEffects(ctx, [], enemies, () => null, viewport, false, cache); assert.equal(cache.size, 0);
const manifest = JSON.parse(readFileSync(`${__dirname}/../../public/paper-assets/manifest.json`, 'utf8'));
const strip = manifest.beam_strips.beam_pierce_strip;
const full = beamGeometry.paperBeamTiles(strip, { width: 128, height: 32 }, [0, 9, 128, 23], { x: -100, y: 50 }, { x: 3300, y: 50 }, 6.8, viewport);
const sweep = beamGeometry.paperBeamTiles(strip, { width: 128, height: 32 }, [0, 9, 128, 23], { x: -100, y: 50 }, { x: 3300, y: 50 }, 6.8, viewport, [.25, .5]);
const fullLength = full.tiles.reduce((sum, tile) => sum + tile.width, 0);
assert.ok(Math.abs(sweep.from.x - (full.from.x + fullLength * .25)) < 1e-8);
assert.ok(Math.abs(sweep.tiles.reduce((sum, tile) => sum + tile.width, 0) - fullLength * .25) < 1e-8);
assert.ok(text.includes('laserPresentation.suppressed.has(e.uid)') && text.includes('reducedMotionRef.current, laserOriginalPoints.current'));
assert.ok(/tick\(gs, enginePlan\.dt\);\s*capturePaperLaserOriginals\(gs\.effects, laserOriginalPoints\.current\);/.test(text), 'snapshot captured immediately after every engine substep');
require.extensions['.ts'] = (module, file) => module._compile(compile(readFileSync(file, 'utf8')), file);
const engine = require('./engine.ts');
const random = Math.random;
Math.random = () => .5;
try {
  const state = engine.createGame(14, 12); state.gold = 1e9;
  assert.ok(engine.placeTower(state, 'bouncingLaser', { x: 5, y: 2 }));
  const pos = engine.cellToWorld({ x: 6, y: 2 });
  for (let index = 0; index < 3; index++) {
    const position = { x: pos.x, y: pos.y + index * 8 };
    state.enemies.push({ uid: `real-${index}`, id: 'soldier', hp: 1e9, maxHp: 1e9, speed: 40,
      pos: position, path: [{ ...position }, engine.cellToWorld(state.exit)], pathIdx: 1, pathProgress: 0 });
  }
  const realCache = new Map();
  for (const dt of [.1, .005, .005, .005]) { engine.tick(state, dt); laser.capturePaperLaserOriginals(state.effects, realCache); }
  const actualBeam = state.effects.find(effect => effect.kind === 'chain_bounce');
  const actualFlashes = state.effects.filter(effect => effect.kind === 'laser_flash');
  assert.ok(actualBeam && actualFlashes.length === 3);
  assert.notDeepEqual(actualBeam.pts.slice(1), actualFlashes.map(effect => ({ x: effect.x, y: effect.y })), 'engine projectStatus moved nodes before first render');
  const stateBefore = JSON.stringify(state);
  reset(); const realResult = game.drawPaperLaserEffects(ctx, state.effects, new Map(state.enemies.map(enemy => [enemy.uid, enemy])), () => null, viewport, false, realCache);
  assert.equal(realResult.suppressed.size, 3, 'real multistep engine original snapshots retain exact flash association');
  assert.equal(JSON.stringify(state), stateBefore);
} finally { Math.random = random; }
console.log(`paper laser FX PASS: ${cases} recorded Game recipe frames; association/ambiguity/assets/moving/fallback/reducedMotion/invalid/sweep range`);
