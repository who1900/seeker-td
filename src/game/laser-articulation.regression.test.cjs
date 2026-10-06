const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { inflateSync } = require('node:zlib');
const ts = require('typescript');
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const geometry = {};
const data = {};
new Function('exports', compile(readFileSync(`${__dirname}/data.ts`, 'utf8')))(data);
new Function('exports', 'require', compile(readFileSync(`${__dirname}/paperGeometry.ts`, 'utf8')))(geometry, () => ({ CELL_PX: 34 }));
const ast = ts.createSourceFile('test.ts', readFileSync(`${__dirname}/paperGeometry.regression.test.ts`, 'utf8'), ts.ScriptTarget.Latest, true);
const decoder = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'pngBounds');
const pngBounds = new Function('readFileSync', 'inflateSync', 'check', `${compile(decoder.getText(ast))};return pngBounds;`)(readFileSync, inflateSync, assert.ok);
const manifest = JSON.parse(readFileSync(`${__dirname}/../../public/paper-assets/manifest.json`, 'utf8'));
const sprites = new Map();
for (const [id, model] of Object.entries(manifest.towers)) for (const part of model.parts) {
  const path = `towers/${id}/${part.file}`;
  const png = pngBounds(`${__dirname}/../../public/paper-assets/runtime/${path}`);
  sprites.set(path, { image: { path, width: png.width, height: png.width }, bounds: png.bounds });
}
const source = ts.createSourceFile('assets.ts', readFileSync(`${__dirname}/paperAssets.ts`, 'utf8'), ts.ScriptTarget.Latest, true);
const functions = source.statements.filter(n => ts.isFunctionDeclaration(n) && ['towerGeometry', 'drawPaperTower', 'getPaperTowerSocket'].includes(n.name?.text));
const renderer = {};
new Function('exports', 'manifest', 'sprites', 'paperTowerPose', 'paperTowerSocket', 'paperEnhancementDrawMatrix', 'paperStructuralUpgradeDrawMatrix', 'paperLaserArticulationDrawMatrix', 'paperSkinColor', 'tintedTowerPart', compile(functions.map(n => n.getText(source)).join('\n')))(renderer, manifest, sprites, geometry.paperTowerPose, geometry.paperTowerSocket, geometry.paperEnhancementDrawMatrix, geometry.paperStructuralUpgradeDrawMatrix, geometry.paperLaserArticulationDrawMatrix, () => null, () => assert.fail('unexpected tint'));
const targets = { simpleLaser: ['reflector_flap.png'], bouncingLaser: ['reflector_flap_1.png', 'reflector_flap_2.png', 'reflector_flap_3.png'], straightLaser: ['vane_left.png', 'vane_right.png'] };
const ages = [-1, 0, .025, .05, .08, .125, .15, .175, .2, .249, .25, .3];
let draws = 0, envelopes = 0, maxRatio = 0, baselineRatio = 0;
const partExtents = new Map();
for (const [id, model] of Object.entries(manifest.towers)) {
  const base = sprites.get(`towers/${id}/${model.parts.find(p => ['base.png', 'pedestal.png'].includes(p.file)).file}`);
  for (const cell of [28, 34]) for (let degrees = 0; degrees < 360; degrees++) for (const age of ages) {
    if (!targets[id] && (degrees % 90 || age !== .08)) continue;
    const tower = { towerId: id, worldX: 0, worldY: 0, level: data.TOWERS[id].maxLevel - 1 };
    const pose = geometry.paperTowerPose(model, base.bounds, tower, degrees * Math.PI / 180, age, cell, base.image.width);
    const before = JSON.stringify(pose);
    for (const reduced of [false, true]) {
      const matrices = [], paths = [];
      const ctx = { globalAlpha: 1, save() {}, restore() {}, transform(...m) { matrices.push(m); }, drawImage(image) { paths.push(image.path); } };
      assert.equal(renderer.drawPaperTower(ctx, tower, degrees * Math.PI / 180, age, cell, undefined, reduced), true);
      assert.equal(matrices.length, pose.parts.length);
      for (const [i, layer] of pose.parts.entries()) {
        const sprite = sprites.get(`towers/${id}/${layer.part.file}`);
        const enhanced = geometry.paperEnhancementDrawMatrix(id, layer.part, model, sprite, layer.matrix);
        const articulated = geometry.paperLaserArticulationDrawMatrix(id, layer.part, enhanced, age, reduced);
        assert.deepEqual(matrices[i], articulated);
        assert.equal(paths[i], sprite.image.path);
        if (!targets[id]?.includes(layer.part.file) || reduced || age <= 0 || age >= .25) assert.strictEqual(articulated, enhanced);
        if (!targets[id]?.includes(layer.part.file)) continue;
        const anchor = geometry.transformPaperPoint(layer.matrix, layer.part.pivot);
        const moved = geometry.transformPaperPoint(articulated, layer.part.pivot);
        assert.ok(Math.hypot(anchor.x - moved.x, anchor.y - moved.y) < 1e-10);
        const [l, t, r, b] = sprite.bounds.map((v, j) => v * model.canvas[j % 2] / sprite.image.width);
        const corners = [[l, t], [r, t], [r, b], [l, b]];
        const restRadius = Math.max(...corners.map(c => { const p = geometry.transformPaperPoint(layer.matrix, c); return Math.hypot(p.x, p.y); }));
        const hingeRadius = Math.max(...corners.map(c => Math.hypot(c[0] - layer.part.pivot[0], c[1] - layer.part.pivot[1]))) * pose.scale;
        for (const corner of [[l, t], [r, t], [r, b], [l, b]]) {
          const p = geometry.transformPaperPoint(articulated, corner);
          const rest = geometry.transformPaperPoint(layer.matrix, corner);
          baselineRatio = Math.max(baselineRatio, Math.max(Math.abs(rest.x), Math.abs(rest.y)) / (cell / 2));
          const ratio = Math.max(Math.abs(p.x), Math.abs(p.y)) / (cell / 2);
          const key = `${id}/${layer.part.file}`;
          const extent = partExtents.get(key) ?? { rest: 0, animated: 0 };
          extent.rest = Math.max(extent.rest, Math.max(Math.abs(rest.x), Math.abs(rest.y)) / (cell / 2));
          extent.animated = Math.max(extent.animated, ratio);
          partExtents.set(key, extent);
          maxRatio = Math.max(maxRatio, ratio);
          assert.ok(Math.hypot(p.x - rest.x, p.y - rest.y) <= 2 * hingeRadius * Math.sin(9 * Math.PI / 180) + 1e-10, 'bounded 18-degree hinge displacement');
          assert.ok(Math.hypot(p.x, p.y) <= restRadius + 2 * hingeRadius * Math.sin(9 * Math.PI / 180) + 1e-10, 'baseline-relative radial envelope');
        }
        envelopes++;
      }
      for (const socket of Object.keys(model.sockets)) assert.deepEqual(renderer.getPaperTowerSocket(tower, degrees * Math.PI / 180, age, cell, socket), geometry.paperTowerSocket(model, pose, socket));
      draws++;
    }
    assert.equal(JSON.stringify(pose), before);
  }
}
const identity = [1, 0, 0, 1, 0, 0];
assert.ok(maxRatio <= baselineRatio + 1e-10, 'aggregate alpha bounding envelope does not exceed baseline maximum');
const angle = (id, file, age) => Math.atan2(...geometry.paperLaserArticulationDrawMatrix(id, manifest.towers[id].parts.find(p => p.file === file), identity, age).slice(0, 2).reverse()) * 180 / Math.PI;
assert.ok(Math.abs(angle('simpleLaser', 'reflector_flap.png', .125) - 16) < 1e-10);
assert.ok(Math.abs(angle('straightLaser', 'vane_left.png', .125) - 18) < 1e-10);
assert.equal(angle('straightLaser', 'vane_left.png', .125), -angle('straightLaser', 'vane_right.png', .125));
const bounce = targets.bouncingLaser.map(file => angle('bouncingLaser', file, .125));
assert.ok(bounce[0] > 0 && bounce[1] < 0 && bounce[2] > 0 && new Set(bounce.map(Math.abs)).size === 3);
for (const age of [NaN, Infinity, -1, 0, .25]) assert.strictEqual(geometry.paperLaserArticulationDrawMatrix('simpleLaser', manifest.towers.simpleLaser.parts.find(p => p.file === 'reflector_flap.png'), identity, age), identity);
for (const pivot of [undefined, [], [NaN, 0]]) assert.strictEqual(geometry.paperLaserArticulationDrawMatrix('simpleLaser', { file: 'reflector_flap.png', pivot }, identity, .125), identity);
const game = readFileSync(`${__dirname}/Game.tsx`, 'utf8');
assert.equal((game.match(/window\.matchMedia\(/g) || []).length, 1);
assert.ok(game.includes("preference.addEventListener('change', update)") && game.includes("preference.removeEventListener('change', update)"));
assert.ok(game.includes('reducedMotion: reducedMotionRef.current') && game.includes('colorOverride, paper.reducedMotion)'));
console.log(`laser articulation PASS: ${draws} recorded draws, ${envelopes} PNG alpha envelopes, half-cell ratio rest=${baselineRatio.toFixed(4)} animated=${maxRatio.toFixed(4)}; all12 sockets unchanged`);
console.log('per-flap half-cell extent diagnostics:', Object.fromEntries([...partExtents].map(([key, value]) => [key, { rest: value.rest.toFixed(6), animated: value.animated.toFixed(6), delta: (value.animated - value.rest).toFixed(6) }])));
