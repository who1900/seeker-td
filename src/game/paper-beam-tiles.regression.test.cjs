const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { inflateSync } = require('node:zlib');
const ts = require('typescript');
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const api = {};
new Function('exports', compile(readFileSync(`${__dirname}/paperBeamGeometry.ts`, 'utf8')))(api);
const decoderAst = ts.createSourceFile('test.ts', readFileSync(`${__dirname}/paperGeometry.regression.test.ts`, 'utf8'), ts.ScriptTarget.Latest, true);
const decoder = decoderAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'pngBounds');
const pngBounds = new Function('readFileSync', 'inflateSync', 'check', `${compile(decoder.getText(decoderAst))};return pngBounds;`)(readFileSync, inflateSync, assert.ok);
const manifest = JSON.parse(readFileSync(`${__dirname}/../../public/paper-assets/manifest.json`, 'utf8'));
const sprites = new Map();
for (const id of Object.keys(manifest.beam_strips)) {
  const path = `projectiles/${id}.png`, file = `${__dirname}/../../public/paper-assets/runtime/${path}`;
  const png = pngBounds(file), bytes = readFileSync(file);
  sprites.set(path, { image: { path, width: png.width, height: bytes.readUInt32BE(20) }, bounds: png.bounds });
}
const assets = ts.createSourceFile('assets.ts', readFileSync(`${__dirname}/paperAssets.ts`, 'utf8'), ts.ScriptTarget.Latest, true);
const draw = assets.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'drawPaperBeam');
const renderer = {};
new Function('exports', 'manifest', 'sprites', 'paperBeamTiles', compile(draw.getText(assets)))(renderer, manifest, sprites, api.paperBeamTiles);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
let cases = 0;
for (const [id, strip] of Object.entries(manifest.beam_strips)) {
  const path = `projectiles/${id}.png`, sprite = sprites.get(path);
  for (const length of [.1, 1, 10, 34, 100, 3400]) for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const from = { x: -20, y: 30 }, to = { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length };
    for (const viewport of [undefined, { x: 0, y: 0, width: 340, height: 714 }]) {
      const plan = api.paperBeamTiles(strip, sprite.image, sprite.bounds, from, to, 4, viewport);
      const calls = [], translations = [], rotations = [], stack = [];
      const ctx = { globalAlpha: .8, save() { stack.push(this.globalAlpha); }, restore() { this.globalAlpha = stack.pop(); },
        translate(...p) { translations.push(p); }, rotate(a) { rotations.push(a); }, drawImage(...args) { calls.push(args); } };
      assert.equal(renderer.drawPaperBeam(ctx, path, from, to, 4, .5, viewport), !!plan);
      near(ctx.globalAlpha, .8); assert.equal(stack.length, 0);
      if (!plan) { assert.equal(calls.length, 0); continue; }
      assert.deepEqual(translations[0], [plan.from.x, plan.from.y]); near(rotations[0], plan.angle);
      assert.equal(calls.length, plan.tiles.length);
      const scale = 4 / (strip.height ?? (sprite.bounds[3] - sprite.bounds[1]) / (sprite.image.height / strip.canvas[1]));
      let end = 0;
      for (const [i, tile] of plan.tiles.entries()) {
        assert.deepEqual(calls[i], [sprite.image, tile.sx, tile.sy, tile.sw, tile.sh, tile.x, tile.y, tile.width, tile.height]);
        near(tile.x, end); end += tile.width;
        assert.ok(tile.sx >= -1e-9 && tile.sx + tile.sw <= sprite.image.width + 1e-9);
        near(tile.width / tile.sw, scale / (sprite.image.width / strip.canvas[0]));
        near(tile.height / tile.sh, scale / (sprite.image.height / strip.canvas[1]));
      }
      const margin = plan.tiles[0].height / 2;
      const visible = viewport ? Math.hypot(viewport.width + margin * 2, viewport.height + margin * 2) : length;
      assert.ok(calls.length <= Math.ceil(visible / ((strip.tile_range_x[1] - strip.tile_range_x[0]) * scale)) + 3);
      if (!viewport) near(end, length);
      else {
        const finish = { x: plan.from.x + Math.cos(plan.angle) * end, y: plan.from.y + Math.sin(plan.angle) * end };
        for (const p of [plan.from, finish]) assert.ok(p.x >= -margin - 1e-8 && p.x <= 340 + margin + 1e-8 && p.y >= -margin - 1e-8 && p.y <= 714 + margin + 1e-8);
      }
      cases++;
    }
  }
  const short = api.paperBeamTiles(strip, sprite.image, sprite.bounds, { x: 0, y: 0 }, { x: 1, y: 0 }, 4);
  assert.equal(short.tiles.length, strip.tile_range_x[0] ? 2 : 1);
  const clipped = api.paperBeamTiles(strip, sprite.image, sprite.bounds, { x: -100, y: 100 }, { x: 3300, y: 100 }, 4, { x: 0, y: 0, width: 340, height: 714 });
  const margin = clipped.tiles[0].height / 2;
  near(clipped.from.x, -margin); near(clipped.tiles.reduce((sum, t) => sum + t.width, 0), 340 + margin * 2);
  const nominal = strip.height ?? (sprite.bounds[3] - sprite.bounds[1]) / (sprite.image.height / strip.canvas[1]);
  const scale = 4 / nominal, period = (strip.tile_range_x[1] - strip.tile_range_x[0]) * scale;
  const offset = (100 - margin - strip.tile_range_x[0] * scale) % period;
  near(clipped.tiles[0].sx, (strip.tile_range_x[0] + offset / scale) * sprite.image.width / strip.canvas[0]);
  const band = api.paperBeamTiles(strip, sprite.image, sprite.bounds, { x: -100, y: 100 }, { x: 3300, y: 100 }, 4, { x: 0, y: 0, width: 340, height: 714 }, [.25, .5]);
  const bandCalls = [], bandTranslations = [];
  const bandCtx = { globalAlpha: 1, save() {}, restore() {}, translate(...args) { bandTranslations.push(args); }, rotate() {}, drawImage(...args) { bandCalls.push(args); } };
  assert.equal(renderer.drawPaperBeam(bandCtx, path, { x: -100, y: 100 }, { x: 3300, y: 100 }, 4, 1, { x: 0, y: 0, width: 340, height: 714 }, [.25, .5]), true);
  near(bandTranslations[0][0], -margin + (340 + 2 * margin) * .25);
  near(band.tiles.reduce((sum, tile) => sum + tile.width, 0), (340 + 2 * margin) * .25);
  for (const [index, tile] of band.tiles.entries()) assert.deepEqual(bandCalls[index].slice(1), [tile.sx, tile.sy, tile.sw, tile.sh, tile.x, tile.y, tile.width, tile.height]);
  assert.equal(renderer.drawPaperBeam({}, path, { x: 0, y: 0 }, { x: 100, y: 0 }, 4, 1, undefined, [NaN, .5]), false);
  const grazing = api.paperBeamTiles(strip, sprite.image, sprite.bounds, { x: -100, y: -margin * .5 }, { x: 3300, y: -margin * .5 }, 4, { x: 0, y: 0, width: 340, height: 714 });
  assert.ok(grazing, 'visible thickness retained when centerline is outside viewport');
  let grazingDraws = 0;
  const grazingCtx = { globalAlpha: 1, save() {}, restore() {}, translate() {}, rotate() {}, drawImage() { grazingDraws++; } };
  assert.equal(renderer.drawPaperBeam(grazingCtx, path, { x: -100, y: -margin * .5 }, { x: 3300, y: -margin * .5 }, 4, 1, { x: 0, y: 0, width: 340, height: 714 }), true);
  assert.equal(grazingDraws, grazing.tiles.length);
  const cropped = api.paperBeamTiles(strip, sprite.image, sprite.bounds, { x: 0, y: 0 }, { x: (strip.canvas[0] + (strip.tile_range_x[1] - strip.tile_range_x[0]) * .37) * scale, y: 0 }, 4);
  const lastMiddle = cropped.tiles[strip.tile_range_x[1] < strip.canvas[0] ? cropped.tiles.length - 2 : cropped.tiles.length - 1];
  near(lastMiddle.sx, strip.tile_range_x[0] * sprite.image.width / strip.canvas[0]);
  near(lastMiddle.sw, (strip.tile_range_x[1] - strip.tile_range_x[0]) * .37 * sprite.image.width / strip.canvas[0]);
  const offscreenCalls = [];
  assert.equal(renderer.drawPaperBeam({ drawImage(...args) { offscreenCalls.push(args); } }, path, { x: -100, y: -margin - 1 }, { x: 3300, y: -margin - 1 }, 4, 1, { x: 0, y: 0, width: 340, height: 714 }), false);
  assert.equal(offscreenCalls.length, 0, 'offscreen no-plan produces no strip draw calls');
  if (strip.link_interval) {
    const long = api.paperBeamTiles(strip, sprite.image, sprite.bounds, { x: 0, y: 0 }, { x: 1000, y: 0 }, 4);
    for (const tile of long.tiles.slice(0, -1)) near(tile.width / ((strip.tile_range_x[1] - strip.tile_range_x[0]) / strip.link_interval), strip.link_interval * scale);
  }
  for (const bad of [{ ...strip, canvas: [0, 64] }, { ...strip, tile_range_x: [32, Infinity] }, { ...strip, link_interval: 0 }, { ...strip, height: NaN }])
    assert.equal(api.paperBeamTiles(bad, sprite.image, sprite.bounds, { x: 0, y: 0 }, { x: 10, y: 0 }, 4), null);
  for (const length of [0, Infinity, NaN]) assert.equal(renderer.drawPaperBeam({}, path, { x: 0, y: 0 }, { x: length, y: 0 }, 4), false);
  assert.equal(api.paperBeamTiles(strip, sprite.image, sprite.bounds, { x: 0, y: 0 }, { x: 1e12, y: 0 }, 4), null);
}
const gameText = readFileSync(`${__dirname}/Game.tsx`, 'utf8');
const gameAst = ts.createSourceFile('Game.tsx', gameText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const gameBeam = gameAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'drawPaperBeam');
const gameApi = {}, segments = [];
const laser = {};
new Function('exports', compile(readFileSync(`${__dirname}/paperLaserFx.ts`, 'utf8')))(laser);
new Function('exports', 'PAPER_BEAMS', 'ENGINE_CELL_PX', 'drawPaperBeamSegment', 'paperLaserRecipe', 'drawPaperFxSprite', `${compile(gameBeam.getText(gameAst))};exports.draw=drawPaperBeam;`)(gameApi,
  { chain: 'beam_simple_strip', chain_bounce: 'beam_chain_strip', chain_straight: 'beam_pierce_strip' }, 34, (...args) => { segments.push(args); return true; }, laser.paperLaserRecipe, () => true);
const viewport = { x: 0, y: 0, width: 340, height: 714 };
for (const kind of ['chain', 'chain_bounce', 'chain_straight']) {
  segments.length = 0;
  const effect = { kind, life: .25, maxLife: .5, pts: [{ x: 0, y: 0 }, { x: 100, y: 50 }, { x: 200, y: 100 }] };
  const before = JSON.stringify(effect);
  assert.equal(gameApi.draw({}, effect, viewport), true);
  assert.equal(segments.length, 2);
  assert.strictEqual(segments[0][6], kind === 'chain_straight' ? viewport : undefined);
  assert.equal(segments[0][5], .5);
  assert.equal(JSON.stringify(effect), before);
}
assert.ok(gameText.includes('width: gs.gridW * ENGINE_CELL_PX, height: gs.gridH * ENGINE_CELL_PX'));
assert.ok(gameText.includes('if (drawPaperDamageEffect(ctx, e, viewport, reducedMotion, contacts)) return true;'), 'no-plan retains existing legacy canvas-clipped fallback, not a second strip renderer');
console.log(`paper beam tiles PASS: ${cases} actual-PNG recorded renderer cases, caps/crop/continuity, chain spacing, viewport phase and Game wiring`);
