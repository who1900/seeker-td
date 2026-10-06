const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
const fixture = readFileSync(`${__dirname}/utility-enhancement-scale.regression.test.cjs`, 'utf8').split('const utility = new Set')[0];
const { api, data, manifest, sprites, drawApi, compile } = new Function('require', '__dirname',
  fixture + ';return {api,data,manifest,sprites,drawApi,compile};')(require, __dirname);
const late = {};
new Function('exports', compile(readFileSync(`${__dirname}/paperLateUpgrade.ts`, 'utf8')))(late);
const helper = late.paperLateUpgradeDrawCommands;
const pngFixture = readFileSync(`${__dirname}/soldier-back-palette.regression.test.cjs`, 'utf8').split('const palettes =')[0];
const { png, canvas } = new Function('require', '__dirname', pngFixture + ';return {png,canvas};')(require, __dirname);
const path = 'towers/rocketLauncher/enhancement_2.png', model = manifest.towers.rocketLauncher;
const image = png(`${__dirname}/../../public/paper-assets/runtime/${path}`);
const originalData = new Uint8ClampedArray(image.data);
const sprite = sprites.get(path), base = sprites.get('towers/rocketLauncher/base.png');
const part = model.parts.find(p => p.file === 'enhancement_2.png');
function record(tower, angle, age, cell, reduced = true) {
  const calls = [], stack = [];
  const ctx = { globalAlpha: 1, matrix: null,
    save() { stack.push([this.globalAlpha, this.matrix]); },
    restore() { [this.globalAlpha, this.matrix] = stack.pop(); },
    transform(...matrix) { this.matrix = matrix; },
    drawImage(image, ...args) { calls.push({ path: image.path, matrix: this.matrix, args, alpha: this.globalAlpha }); } };
  assert.equal(drawApi.drawPaperTower(ctx, tower, angle, age, cell, undefined, reduced), true);
  assert.equal(stack.length, 0); assert.equal(ctx.globalAlpha, 1);
  return calls;
}
function calibrated(tower, angle, age, cell) {
  const pose = api.paperTowerPose(model, base.bounds, tower, angle, age, cell, 256);
  const layer = pose.parts.find(p => p.part.file === part.file);
  const matrix = api.paperStructuralUpgradeDrawMatrix(tower.towerId, part, model, sprite, layer.matrix,
    { x: tower.worldX, y: tower.worldY }, cell);
  return { pose, matrix };
}
const pixels = [];
for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
  const alpha = image.data[(y * image.width + x) * 4 + 3];
  if (alpha) pixels.push({ x, y, alpha });
}
assert.equal(pixels.length, 404);
const bounds = cutoff => {
  const selected = pixels.filter(p => p.alpha > cutoff);
  return [Math.min(...selected.map(p => p.x)), Math.min(...selected.map(p => p.y)),
    Math.max(...selected.map(p => p.x + 1)), Math.max(...selected.map(p => p.y + 1))];
};
assert.deepEqual(bounds(0), sprite.alphaBounds); assert.deepEqual(bounds(24), sprite.bounds);
let cases = 0, envelopes = 0, socketChecks = 0;
for (const cell of [28, 34]) for (let degrees = 0; degrees < 360; degrees++) for (const age of [-1, 0, .04, .08, .12, .16]) {
  const angle = degrees * Math.PI / 180;
  for (const level of [9, 10, 14]) {
    const tower = { towerId: 'rocketLauncher', level, worldX: 10, worldY: 20 };
    const { pose, matrix } = calibrated(tower, angle, age, cell), before = JSON.stringify({ tower, model, pose });
    delete sprite.lateUpgrade;
    const baseline = record(tower, angle, age, cell);
    sprite.lateUpgrade = helper;
    const actual = record(tower, angle, age, cell);
    const commands = helper(tower, part, model, sprite, matrix, cell);
    if (level === 9) { assert.equal(commands, null); assert.deepEqual(actual, baseline); }
    else {
      assert.equal(commands.length, 2);
      assert.deepEqual(actual.filter(c => c.path !== path), baseline.filter(c => c.path !== path));
      assert.deepEqual(actual.filter(c => c.path === path), commands.map(c => ({ path, matrix: c.matrix,
        args: [...c.source, ...c.destination], alpha: 1 })));
      assert.deepEqual(record(tower, angle, age, cell, false), actual, 'late pose is static, reduced motion does not change crops');
      assert.deepEqual(commands.map(c => c.source), [[87, 127, 16, 26], [153, 127, 16, 26]]);
      for (const cutoff of [0, 24]) {
        const limit = [tower.worldX - cell / 2, tower.worldY - cell / 2,
          tower.worldX + cell / 2, tower.worldY + cell / 2];
        for (const pixel of pixels.filter(p => p.alpha > cutoff)) {
          const matches = commands.filter(c => pixel.x >= c.source[0] && pixel.x < c.source[0] + c.source[2]
            && pixel.y >= c.source[1] && pixel.y < c.source[1] + c.source[3]);
          assert.equal(matches.length, 1, 'every actual alpha pixel drawn exactly once, no clipping');
          const command = matches[0];
          for (const point of [[pixel.x, pixel.y], [pixel.x + 1, pixel.y], [pixel.x + 1, pixel.y + 1], [pixel.x, pixel.y + 1]]) {
            const p = api.transformPaperPoint(command.matrix, point.map(v => v * 2));
            assert.ok(p.x >= limit[0] - 1e-9 && p.x <= limit[2] + 1e-9 && p.y >= limit[1] - 1e-9 && p.y <= limit[3] + 1e-9,
              `alpha>${cutoff}: complete shoulder stays inside gameplay-cell footprint`);
          }
        }
        envelopes++;
      }
      for (const command of commands) {
        const determinant = command.matrix[0] * command.matrix[3] - command.matrix[1] * command.matrix[2];
        assert.ok(Math.abs(determinant - 3 * matrix[0] * matrix[3]) < 1e-12,
          'only E2 shoulder area increases threefold; never whole-model scaling');
        const visible = pixels.filter(p => p.alpha > 24 && p.x >= command.source[0]
          && p.x < command.source[0] + command.source[2]);
        const points = visible.flatMap(p => [[p.x, p.y], [p.x + 1, p.y + 1]])
          .map(p => api.transformPaperPoint(command.matrix, p.map(v => v * 2)));
        const width = Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x));
        const height = Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y));
        assert.ok(width >= cell * .35 && height >= cell * .35,
          'visible shoulder spans at least 35% of cell per axis, not a 2px ornament; not visual acceptance');
      }
    }
    for (const socket of Object.keys(model.sockets)) {
      assert.deepEqual(drawApi.getPaperTowerSocket(tower, angle, age, cell, socket), api.paperTowerSocket(model, pose, socket)); socketChecks++;
    }
    assert.equal(JSON.stringify({ tower, model, pose }), before); cases++;
  }
}
for (const [id, currentModel] of Object.entries(manifest.towers)) for (let level = 0; level < data.TOWERS[id].maxLevel; level++) {
  if (id === 'rocketLauncher' && level >= 10) continue;
  const tower = { towerId: id, level, worldX: 10, worldY: 20 };
  for (const cell of [28, 34]) for (const angle of [0, Math.PI / 2]) {
    delete sprite.lateUpgrade; const baseline = record(tower, angle, .08, cell, false);
    sprite.lateUpgrade = helper; assert.deepEqual(record(tower, angle, .08, cell, false), baseline);
  }
  for (const layer of currentModel.parts) if (id !== 'rocketLauncher') assert.equal(helper(tower, layer, currentModel, sprite, [1, 0, 0, 1, 0, 0], 34), null);
}
const tower = { towerId: 'rocketLauncher', level: 10, worldX: 10, worldY: 20 };
const { matrix } = calibrated(tower, 0, -1, 34);
for (const level of [-1, 0, 9, 15, 10.5, NaN]) assert.equal(helper({ ...tower, level }, part, model, sprite, matrix, 34), null);
for (const bad of [{ ...sprite, alphaBounds: undefined }, { ...sprite, alphaBounds: [88, 127, 169, 153] },
  { ...sprite, bounds: [91, 129, 166, 150] }, { ...sprite, image: { width: 512, height: 512 } }]) assert.equal(helper(tower, part, model, bad, matrix, 34), null);
for (const bad of [[1, 0, 0, 1, 0, 0], matrix.map((v, i) => i === 4 ? v + .1 : v), [NaN, ...matrix.slice(1)]]) {
  assert.equal(helper(tower, part, model, sprite, bad, 34), null);
}
for (const cell of [0, -1, NaN]) assert.equal(helper(tower, part, model, sprite, matrix, cell), null);
assert.equal(helper(tower, part, { ...model, parts: model.parts.map(p => p.file === 'base.png' ? { ...p, rotates: true } : p) }, sprite, matrix, 34), null);
sprite.lateUpgrade = () => null;
const fallback = record(tower, 0, -1, 34); delete sprite.lateUpgrade;
assert.deepEqual(fallback, record(tower, 0, -1, 34), 'calibration fallback draws exact baseline');
assert.deepEqual(image.data, originalData, 'PNG pixels/alpha untouched');
const assetsSource = readFileSync(`${__dirname}/paperAssets.ts`, 'utf8');
const ast = ts.createSourceFile('paperAssets.ts', assetsSource, ts.ScriptTarget.Latest, true);
const loadSource = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'load').getText(ast);
const loaded = new Map();
const load = new Function('sprites', 'document', 'Image', 'paperUrl', 'tintedPart', 'paperLateUpgradeDrawCommands',
  compile(loadSource) + ';return load;')(loaded, { createElement: () => canvas() }, class {
    set src(path) { Object.assign(this, png(`${__dirname}/../../public/paper-assets/runtime/${path}`), { path }); queueMicrotask(() => this.onload()); }
  }, p => p, () => { throw Error('unexpected Soldier prewarm'); }, helper);
load(path).then(async () => {
  assert.equal(loaded.get(path).lateUpgrade, helper, 'actual loader attaches only calibrated asset callback');
  assert.deepEqual(loaded.get(path).alphaBounds, sprite.alphaBounds);
  assert.equal(helper(tower, part, model, loaded.get(path), matrix, 34).length, 2);
  sprites.set(path, loaded.get(path));
  const actualLoadedDraw = record(tower, 0, -1, 34).filter(c => c.path === path);
  assert.deepEqual(actualLoadedDraw, helper(tower, part, model, loaded.get(path), matrix, 34).map(c => ({
    path, matrix: c.matrix, args: [...c.source, ...c.destination], alpha: 1,
  })), 'actual load -> actual renderer uses the two complete cropped shoulders');
  await load('towers/rocketLauncher/base.png');
  assert.equal(loaded.get('towers/rocketLauncher/base.png').lateUpgrade, undefined, 'non-E2 assets never receive late drawing callback');
  console.log(`Rocket late upgrade PASS: ${cases} full-angle/recoil/cell28/34 level9/10/14 recorded draws; ${envelopes} actual-PNG alpha>0/>24 envelopes; ${socketChecks} exact sockets; lower/other11 baseline, crops, calibration fallback and actual loader preserved. Visual acceptance PENDING.`);
}).catch(error => { console.error(error); process.exitCode = 1; });
