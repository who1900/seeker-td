const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const fixture = readFileSync(`${__dirname}/utility-enhancement-scale.regression.test.cjs`, 'utf8').split('const utility = new Set')[0];
const { api, data, manifest, sprites, drawApi } = new Function('require', '__dirname', `${fixture};return {api,data,manifest,sprites,drawApi};`)(require, __dirname);
const profiles = {
  canon: [[1.35, 2.1], [1.25, 1.65]], dualCanon: [[.95, .65], [1.1, 1.45]], machineGun: [[.8, .9], [2.5, 2]],
  simpleLaser: [[.9, .65], [1.7, 2.2]], bouncingLaser: [[2, 1.45], [2.2, 1.6]], straightLaser: [[.8, .7], [1.8, 2.3]],
  mortar: [[1.15, 3], [1.05, 1.7]], mineLayer: [[.7, 1.8], [1.05, 3.3]], rocketLauncher: [[.9, .7], [1.35, 1.9]],
};
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const diagnostics = new Map();
let draws = 0, envelopes = 0, sockets = 0;
for (const [id, model] of Object.entries(manifest.towers)) {
  const base = sprites.get(`towers/${id}/${model.parts.find(part => ['base.png', 'pedestal.png'].includes(part.file)).file}`);
  const levels = (profiles[id] ? [0, 2, 5] : [0, 2, 4]).filter(level => level < data.TOWERS[id].maxLevel);
  assert.equal(levels.length, 3, `${id}: second enhancement must be reachable`);
  for (const cell of [28, 34]) for (let degrees = 0; degrees < 360; degrees += profiles[id] ? 1 : 90) for (const age of [-1, 0, .04, .08, .12, .16]) for (const level of levels) {
    const tower = { towerId: id, worldX: 10, worldY: 20, level };
    const angle = degrees * Math.PI / 180;
    const pose = api.paperTowerPose(model, base.bounds, tower, angle, age, cell, base.image.width);
    const before = JSON.stringify(pose), matrices = [], paths = [];
    const ctx = { globalAlpha: 1, save() {}, restore() {}, transform(...values) { matrices.push(values); }, drawImage(image) { paths.push(image.path); } };
    assert.equal(drawApi.drawPaperTower(ctx, tower, angle, age, cell, undefined, true), true);
    assert.equal(matrices.length, pose.parts.length);
    assert.equal(paths.some(path => path.endsWith('enhancement_1.png')), level >= 2);
    assert.equal(paths.some(path => path.endsWith('enhancement_2.png')), level >= (profiles[id] ? 5 : 4));
    for (const [index, layer] of pose.parts.entries()) {
      const sprite = sprites.get(`towers/${id}/${layer.part.file}`);
      if (!layer.part.file.startsWith('enhancement_')) {
        assert.deepEqual(matrices[index], layer.matrix, 'base/aim/primary parts retain exact pose matrices');
        assert.strictEqual(api.paperStructuralUpgradeDrawMatrix(id, layer.part, model, sprite, layer.matrix, { x: 10, y: 20 }, cell), layer.matrix);
        continue;
      }
      if (!profiles[id]) {
        assert.strictEqual(api.paperStructuralUpgradeDrawMatrix(id, layer.part, model, sprite, layer.matrix, { x: 10, y: 20 }, cell), layer.matrix);
        assert.deepEqual(matrices[index], api.paperEnhancementDrawMatrix(id, layer.part, model, sprite, layer.matrix));
        continue;
      }
      const stage = layer.part.file === 'enhancement_2.png' ? 1 : 0;
      const [sx, sy] = profiles[id][stage], [l, t, r, b] = sprite.alphaBounds.map((v, axis) => v * model.canvas[axis % 2] / sprite.image.width);
      const anchor = [Math.max(l, Math.min(r, layer.part.pivot[0])), stage ? b : Math.max(t, Math.min(b, layer.part.pivot[1]))];
      const corners = [[l, t], [r, t], [r, b], [l, b]];
      const requested = corners.map(point => api.transformPaperPoint(layer.matrix, [anchor[0] + sx * (point[0] - anchor[0]), anchor[1] + sy * (point[1] - anchor[1])]));
      const original = corners.map(point => api.transformPaperPoint(layer.matrix, point));
      const cap = (Math.hypot(matrices[index][0], matrices[index][1]) / Math.hypot(layer.matrix[0], layer.matrix[1]) - 1) / (sx - 1);
      assert.ok(cap >= -1e-8 && cap <= 1 + 1e-8, 'bounded delta-to-identity factor');
      const anchorOriginal = api.transformPaperPoint(layer.matrix, anchor), anchorDrawn = api.transformPaperPoint(matrices[index], anchor);
      near(anchorOriginal.x, anchorDrawn.x); near(anchorOriginal.y, anchorDrawn.y);
      const allowed = Math.max(cell / 2, ...original.map(point => Math.max(Math.abs(point.x - 10), Math.abs(point.y - 20))));
      const key = `${id}/${layer.part.file}`;
      const visibleWidth = (r - l) * Math.hypot(matrices[index][0], matrices[index][1]);
      const visibleHeight = (b - t) * Math.hypot(matrices[index][2], matrices[index][3]);
      if (cell === 34) assert.ok(Math.max(visibleWidth, visibleHeight) >= 3 && Math.min(visibleWidth, visibleHeight) >= 1.5 && visibleWidth * visibleHeight >= 8, 'bounded readable envelope floor, not visual acceptance');
      const entry = diagnostics.get(key) ?? { requested: [sx, sy], capMin: 1, capMax: 0, alphaMax34: 0, oldMax34: 0, width34: visibleWidth * 34 / cell, height34: visibleHeight * 34 / cell };
      for (const [i, point] of corners.entries()) {
        const actual = api.transformPaperPoint(matrices[index], point);
        near(actual.x, original[i].x + (requested[i].x - original[i].x) * cap); near(actual.y, original[i].y + (requested[i].y - original[i].y) * cap);
        assert.ok(Math.max(Math.abs(actual.x - 10), Math.abs(actual.y - 20)) <= allowed + 1e-8, `${key} strict alpha no expansion beyond original overshoot/halfcell`);
        if (cell === 34) {
          entry.alphaMax34 = Math.max(entry.alphaMax34, Math.max(Math.abs(actual.x - 10), Math.abs(actual.y - 20)));
          entry.oldMax34 = Math.max(entry.oldMax34, Math.max(Math.abs(original[i].x - 10), Math.abs(original[i].y - 20)));
        }
      }
      entry.capMin = Math.min(entry.capMin, cap); entry.capMax = Math.max(entry.capMax, cap); diagnostics.set(key, entry);
      near(Math.hypot(matrices[index][0], matrices[index][1]) / Math.hypot(matrices[index][2], matrices[index][3]), (1 + cap * (sx - 1)) / (1 + cap * (sy - 1)));
      envelopes++;
    }
    for (const socket of Object.keys(model.sockets)) {
      assert.deepEqual(drawApi.getPaperTowerSocket(tower, angle, age, cell, socket), api.paperTowerSocket(model, pose, socket)); sockets++;
    }
    assert.equal(JSON.stringify(pose), before);
    draws++;
  }
}
const id = 'canon', model = manifest.towers[id], part = model.parts.find(part => part.file === 'enhancement_1.png');
for (const entry of diagnostics.values()) { near(entry.capMin, entry.capMax); assert.ok(entry.capMin > .01, 'profile must not silently collapse to identity'); }
const sprite = sprites.get(`towers/${id}/${part.file}`), matrix = [1, 0, 0, 1, 0, 0];
for (const bad of [{ ...sprite, alphaBounds: [NaN, 0, 1, 1] }, { ...sprite, alphaBounds: [-1, 0, 1, 1] }, { ...sprite, alphaBounds: undefined }]) assert.strictEqual(api.paperStructuralUpgradeDrawMatrix(id, part, model, bad, matrix, { x: 0, y: 0 }, 34), matrix);
assert.strictEqual(api.paperStructuralUpgradeDrawMatrix(id, part, model, sprite, matrix, { x: NaN, y: 0 }, 34), matrix);
assert.strictEqual(api.paperStructuralUpgradeDrawMatrix(id, part, model, sprite, matrix, { x: 0, y: 0 }, 0), matrix);
const actualPose = api.paperTowerPose(model, sprites.get('towers/canon/base.png').bounds, { towerId: id, worldX: 0, worldY: 0, level: 2 }, 0, 0, 34, 256);
const actualMatrix = actualPose.parts.find(layer => layer.part.file === part.file).matrix;
for (const unknown of ['unknown', '__proto__', 'constructor', 'toString']) assert.strictEqual(api.paperStructuralUpgradeDrawMatrix(unknown, part, model, sprite, actualMatrix, { x: 0, y: 0 }, 34), actualMatrix, 'non-own profile/calibration ID returns identical matrix without throwing');
assert.strictEqual(api.paperStructuralUpgradeDrawMatrix(id, part, model, { ...sprite, alphaBounds: [111, 97, 146, 113] }, actualMatrix, { x: 0, y: 0 }, 34), actualMatrix, 'unvalidated PNG bounds fail safe to identity');
const changedModel = { ...model, parts: model.parts.map(layer => layer.file === 'barrel.png' ? { ...layer, parent: 'base' } : layer) };
assert.strictEqual(api.paperStructuralUpgradeDrawMatrix(id, part, changedModel, sprite, actualMatrix, { x: 0, y: 0 }, 34), actualMatrix, 'unvalidated assembly topology fail safe');
const helperSource = readFileSync(`${__dirname}/paperGeometry.ts`, 'utf8').split('export function paperStructuralUpgradeDrawMatrix')[1].split('export function paperLaserArticulationDrawMatrix')[0];
assert.ok(!helperSource.includes('paperTowerPose(') && !helperSource.includes('degrees') && !helperSource.includes('recoil of'), 'no render-time cap geometry search');
assert.ok(readFileSync(`${__dirname}/paperAssets.ts`, 'utf8').includes('sprites.set(path, { image, bounds: [left, top, right, bottom], alphaBounds })'));
console.log(`structural upgrade profiles PASS: ${draws} recorded valid-level draws; ${envelopes} actual PNG alpha>0 envelopes; ${sockets} all12 socket checks; utilities unchanged`);
console.log('cell34 per-layer diagnostics:', Object.fromEntries([...diagnostics].map(([key, value]) => [key, Object.fromEntries(Object.entries(value).map(([name, v]) => [name, Array.isArray(v) ? v : Number(v.toFixed(4))]))])));
