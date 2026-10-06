const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
const fixture = readFileSync(`${__dirname}/utility-enhancement-scale.regression.test.cjs`, 'utf8').split('const utility = new Set')[0];
const { api, data, manifest, sprites, drawApi, decoder, decoderAst, compile } = new Function('require', '__dirname', `${fixture};return {api,data,manifest,sprites,drawApi,decoder,decoderAst,compile};`)(require, __dirname);
const positiveBounds = new Function('readFileSync', 'inflateSync', 'check', `${compile(decoder.getText(decoderAst).replace('decoded[index] > 24', 'decoded[index] > 0'))};return pngBounds;`)(readFileSync, require('node:zlib').inflateSync, assert.ok);
const profiles = { glueTower: [[2.2, 2.6], [1.7, 3]], glueGun: [[2.6, 1.8], [1.8, 2.4]], teleporter: [[2.8, 2.8], [3.2, 2.3]] };
const alpha = new Map(), measurements = new Map();
for (const id of Object.keys(profiles)) for (const file of ['enhancement_1.png', 'enhancement_2.png']) alpha.set(`${id}/${file}`, positiveBounds(`${__dirname}/../../public/paper-assets/runtime/towers/${id}/${file}`).bounds);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
let draws = 0, envelopes = 0;
for (const [id, model] of Object.entries(manifest.towers)) {
  const base = sprites.get(`towers/${id}/${model.parts.find(p => ['base.png', 'pedestal.png'].includes(p.file)).file}`);
  for (const cell of [28, 34]) for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) for (const level of [0, 2, 4].filter(level => level < data.TOWERS[id].maxLevel)) {
    const tower = { towerId: id, worldX: 10, worldY: 20, level };
    const pose = api.paperTowerPose(model, base.bounds, tower, angle, .08, cell, base.image.width);
    const before = JSON.stringify({ tower, model, pose }), matrices = [], paths = [];
    const ctx = { globalAlpha: 1, save() {}, restore() {}, transform(...values) { matrices.push(values); }, drawImage(image) { paths.push(image.path); } };
    assert.equal(drawApi.drawPaperTower(ctx, tower, angle, .08, cell, undefined, true), true);
    for (const [index, layer] of pose.parts.entries()) {
      const sprite = sprites.get(`towers/${id}/${layer.part.file}`);
      const expected = api.paperStructuralUpgradeDrawMatrix(id, layer.part, model, sprite,
        api.paperEnhancementDrawMatrix(id, layer.part, model, sprite, layer.matrix), { x: tower.worldX, y: tower.worldY }, cell);
      assert.deepEqual(matrices[index], expected);
      if (!layer.part.file.startsWith('enhancement_')) assert.deepEqual(matrices[index], layer.matrix, 'all non-upgrade matrices unchanged');
    }
    for (const socket of Object.keys(model.sockets)) assert.deepEqual(drawApi.getPaperTowerSocket(tower, angle, .08, cell, socket), api.paperTowerSocket(model, pose, socket));
    assert.equal(JSON.stringify({ tower, model, pose }), before);
    if (profiles[id]) {
      assert.equal(paths.some(path => path.endsWith('enhancement_1.png')), level >= 2);
      assert.equal(paths.some(path => path.endsWith('enhancement_2.png')), level >= 4);
      assert.notDeepEqual(profiles[id][0], profiles[id][1], 'first and second profiles differ');
    }
    draws++;
  }
  if (!profiles[id]) continue;
  for (const cell of [28, 34]) for (let degrees = 0; degrees < 360; degrees++) for (const age of [-1, 0, .04, .08, .12, .16]) {
    const tower = { towerId: id, worldX: 0, worldY: 0, level: 4 };
    const pose = api.paperTowerPose(model, base.bounds, tower, degrees * Math.PI / 180, age, cell, base.image.width);
    for (const layer of pose.parts.filter(layer => layer.part.file.startsWith('enhancement_'))) {
      const key = `${id}/${layer.part.file}`, sprite = sprites.get(`towers/${key}`), second = layer.part.file === 'enhancement_2.png';
      const [sx, sy] = profiles[id][second ? 1 : 0];
      const [l, t, r, b] = sprite.bounds.map((v, index) => v * model.canvas[index % 2] / sprite.image.width);
      const anchor = [Math.max(l, Math.min(r, layer.part.pivot[0])), second ? b : Math.max(t, Math.min(b, layer.part.pivot[1]))];
      const matrix = api.paperEnhancementDrawMatrix(id, layer.part, model, sprite, layer.matrix);
      for (const bounds of [sprite.bounds, alpha.get(key)]) {
        const [left, top, right, bottom] = bounds.map((v, index) => v * model.canvas[index % 2] / sprite.image.width);
        for (const point of [[left, top], [right, top], [right, bottom], [left, bottom]]) {
          const actual = api.transformPaperPoint(matrix, point);
          const reference = api.transformPaperPoint(layer.matrix, [anchor[0] + sx * (point[0] - anchor[0]), anchor[1] + sy * (point[1] - anchor[1])]);
          near(actual.x, reference.x); near(actual.y, reference.y);
          const extent = Math.max(Math.abs(actual.x), Math.abs(actual.y));
          assert.ok(extent <= cell / 2 + 1e-9, `${key}: alpha envelope outside half-cell (${extent}/${cell / 2})`);
          if (cell === 34) {
            const previous = measurements.get(key) ?? { scale: [sx, sy], width: (r - l) * pose.scale * sx, height: (b - t) * pose.scale * sy, maxExtent: 0 };
            previous.maxExtent = Math.max(previous.maxExtent, extent); measurements.set(key, previous);
          }
        }
        envelopes++;
      }
    }
  }
}
console.log(`utility upgrade profiles PASS: ${draws} level0/2/4 renderer cases all12 models; ${envelopes} alpha>0 AND alpha>24 all-angle/recoil envelopes; sockets unchanged`);
console.log('cell34 measurements:', Object.fromEntries([...measurements].map(([key, value]) => [key, Object.fromEntries(Object.entries(value).map(([name, v]) => [name, Array.isArray(v) ? v : Number(v.toFixed(3))]))])));
