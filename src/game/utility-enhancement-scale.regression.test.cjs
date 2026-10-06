const { strict: assert } = require('node:assert');
const { readFileSync } = require('node:fs');
const { inflateSync } = require('node:zlib');
const ts = require('typescript');
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const decoderSource = readFileSync(`${__dirname}/paperGeometry.regression.test.ts`, 'utf8');
const decoderAst = ts.createSourceFile('test.ts', decoderSource, ts.ScriptTarget.Latest, true);
const decoder = decoderAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'pngBounds');
assert.ok(decoder);
const pngBounds = new Function('readFileSync', 'inflateSync', 'check', `${compile(decoder.getText(decoderAst))}; return pngBounds;`)(readFileSync, inflateSync, (ok, message) => assert.ok(ok, message));
const alphaBounds = new Function('readFileSync', 'inflateSync', 'check', `${compile(decoder.getText(decoderAst).replace('decoded[index] > 24', 'decoded[index] > 0'))}; return pngBounds;`)(readFileSync, inflateSync, (ok, message) => assert.ok(ok, message));
const data = {};
new Function('exports', compile(readFileSync(`${__dirname}/data.ts`, 'utf8')))(data);
const api = {};
new Function('exports', 'require', compile(readFileSync(`${__dirname}/paperGeometry.ts`, 'utf8')))(api, () => data);
const manifest = JSON.parse(readFileSync(`${__dirname}/../../public/paper-assets/manifest.json`, 'utf8'));
const sprites = new Map();
for (const [id, model] of Object.entries(manifest.towers)) for (const part of model.parts) {
  const path = `towers/${id}/${part.file}`;
  const png = pngBounds(`${__dirname}/../../public/paper-assets/runtime/${path}`);
  sprites.set(path, { image: { path, width: png.width, height: png.width }, bounds: png.bounds, alphaBounds: alphaBounds(`${__dirname}/../../public/paper-assets/runtime/${path}`).bounds });
}
const source = readFileSync(`${__dirname}/paperAssets.ts`, 'utf8');
const ast = ts.createSourceFile('paperAssets.ts', source, ts.ScriptTarget.Latest, true);
const names = ['towerGeometry', 'drawPaperTower', 'getPaperTowerSocket'];
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
assert.equal(functions.length, 3);
const drawApi = {};
new Function('exports', 'manifest', 'sprites', 'paperTowerPose', 'paperTowerSocket', 'paperEnhancementDrawMatrix', 'paperStructuralUpgradeDrawMatrix', 'paperLaserArticulationDrawMatrix', 'paperSkinColor', 'tintedTowerPart', compile(functions.map(node => node.getText(ast)).join('\n')))(
  drawApi, manifest, sprites, api.paperTowerPose, api.paperTowerSocket, api.paperEnhancementDrawMatrix, api.paperStructuralUpgradeDrawMatrix, api.paperLaserArticulationDrawMatrix, () => null, () => { throw Error('unexpected tint'); });
const utility = new Set(['glueTower', 'glueGun', 'teleporter']);
const maximum = new Map();
const profiles = { glueTower: [[2.2, 2.6], [1.7, 3]], glueGun: [[2.6, 1.8], [1.8, 2.4]], teleporter: [[2.8, 2.8], [3.2, 2.3]] };
let draws = 0, envelopes = 0;
for (const [id, model] of Object.entries(manifest.towers)) {
  const base = model.parts.find(part => ['base.png', 'pedestal.png'].includes(part.file));
  const baseSprite = sprites.get(`towers/${id}/${base.file}`);
  for (let level = 0; level < data.TOWERS[id].maxLevel; level++) for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const tower = { towerId: id, worldX: 0, worldY: 0, level };
    const pose = api.paperTowerPose(model, baseSprite.bounds, tower, angle, .08, 34, baseSprite.image.width);
    const before = JSON.stringify({ tower, model, pose });
    const matrices = [], paths = [], stack = [];
    const ctx = { globalAlpha: 1, save() { stack.push(this.globalAlpha); }, restore() { this.globalAlpha = stack.pop(); },
      transform(...values) { matrices.push(values); }, drawImage(image) { paths.push(image.path); } };
    assert.equal(drawApi.drawPaperTower(ctx, tower, angle, .08, 34), true);
    assert.equal(matrices.length, pose.parts.length);
    for (const [i, part] of pose.parts.entries()) {
      const sprite = sprites.get(`towers/${id}/${part.part.file}`);
      const actual = api.paperEnhancementDrawMatrix(id, part.part, model, sprite, part.matrix);
      const structural = api.paperStructuralUpgradeDrawMatrix(id, part.part, model, sprite, actual, { x: tower.worldX, y: tower.worldY }, 34);
      assert.deepEqual(matrices[i], api.paperLaserArticulationDrawMatrix(id, part.part, structural, .08));
      assert.equal(paths[i], sprite.image.path);
      if (!utility.has(id) || !part.part.file.startsWith('enhancement_')) assert.strictEqual(actual, part.matrix);
      else {
        const [sx, sy] = profiles[id][part.part.file === 'enhancement_2.png' ? 1 : 0];
        assert.equal(actual[0], part.matrix[0] * sx);
        assert.equal(actual[3], part.matrix[3] * sy);
      }
    }
    for (const socket of Object.keys(model.sockets)) {
      assert.deepEqual(drawApi.getPaperTowerSocket(tower, angle, .08, 34, socket), api.paperTowerSocket(model, pose, socket));
    }
    assert.equal(JSON.stringify({ tower, model, pose }), before);
    assert.equal(stack.length, 0);
    draws++;
  }
  if (!utility.has(id)) continue;
  for (const cell of [28, 34]) for (let degrees = 0; degrees < 360; degrees++) for (const shotAge of [-1, 0, .04, .08, .12, .16]) {
    const tower = { towerId: id, worldX: 0, worldY: 0, level: 4 };
    const pose = api.paperTowerPose(model, baseSprite.bounds, tower, degrees * Math.PI / 180, shotAge, cell, baseSprite.image.width);
    for (const part of pose.parts.filter(part => part.part.file.startsWith('enhancement_'))) {
      const sprite = sprites.get(`towers/${id}/${part.part.file}`);
      const [left, top, right, bottom] = sprite.bounds.map((value, index) => value * model.canvas[index % 2] / (index % 2 ? sprite.image.height : sprite.image.width));
      const [sx, sy] = profiles[id][part.part.file === 'enhancement_2.png' ? 1 : 0];
      const anchor = { x: Math.max(left, Math.min(right, part.part.pivot[0])), y: part.part.file === 'enhancement_2.png' ? bottom : Math.max(top, Math.min(bottom, part.part.pivot[1])) };
      const matrix = api.paperEnhancementDrawMatrix(id, part.part, model, sprite, part.matrix);
      const originalAnchor = api.transformPaperPoint(part.matrix, [anchor.x, anchor.y]);
      const enlargedAnchor = api.transformPaperPoint(matrix, [anchor.x, anchor.y]);
      assert.ok(Math.hypot(originalAnchor.x - enlargedAnchor.x, originalAnchor.y - enlargedAnchor.y) < 1e-12, 'attachment anchor displacement is zero');
      assert.ok(anchor.x + sx * (left - anchor.x) <= left && anchor.x + sx * (right - anchor.x) >= right);
      assert.ok(anchor.y + sy * (top - anchor.y) <= top && anchor.y + sy * (bottom - anchor.y) >= bottom, 'enlarged alpha rectangle contains original attachment envelope');
      for (const corner of [[left, top], [right, top], [right, bottom], [left, bottom]]) {
        const point = api.transformPaperPoint(matrix, corner);
        const extent = Math.max(Math.abs(point.x), Math.abs(point.y));
        assert.ok(extent <= cell / 2, `${id}/${part.part.file}: alpha envelope crossed cell`);
        if (cell === 34) maximum.set(id, Math.max(maximum.get(id) ?? 0, extent));
      }
      envelopes++;
    }
  }
}
const identity = [1, 0, 0, 1, 0, 0];
const sample = manifest.towers.glueGun.parts.find(part => part.file === 'enhancement_1.png');
const sprite = sprites.get('towers/glueGun/enhancement_1.png');
assert.strictEqual(api.paperEnhancementDrawMatrix('glueGun', sample, manifest.towers.glueGun, { ...sprite, bounds: [NaN, 0, 1, 1] }, identity), identity);
assert.strictEqual(api.paperEnhancementDrawMatrix(undefined, sample, manifest.towers.glueGun, sprite, identity), identity);
console.log(`utility enhancement scale PASS: ${draws} actual-PNG draw cases; ${envelopes} rotated/recoil alpha envelopes; fixed clamped attachment anchors`);
console.log('cell34 half extents:', Object.fromEntries([...maximum].map(([id, value]) => [id, value.toFixed(2)])));
