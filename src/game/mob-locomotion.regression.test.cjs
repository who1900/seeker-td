const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { inflateSync } = require('node:zlib');
const ts = require('typescript');
const compile = s => ts.transpileModule(s, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const data = {}, geometry = {}, readability = {};
const walkApi = {};
new Function('exports', compile(readFileSync(`${__dirname}/data.ts`, 'utf8')))(data);
new Function('exports', 'require', compile(readFileSync(`${__dirname}/paperGeometry.ts`, 'utf8')))(geometry, name => {
  assert.equal(name, './data'); return data;
});
new Function('exports', compile(readFileSync(`${__dirname}/enemyReadability.ts`, 'utf8')))(readability);
new Function('exports', 'require', compile(readFileSync(`${__dirname}/paperWalkClock.ts`, 'utf8')))(walkApi, name => name === './data' ? data : geometry);
const manifest = JSON.parse(readFileSync(`${__dirname}/../../public/paper-assets/manifest.json`, 'utf8'));
const decoderSource = readFileSync(`${__dirname}/soldier-back-palette.regression.test.cjs`, 'utf8');
const decoderAst = ts.createSourceFile('decoder.js', decoderSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const decoder = decoderAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'png');
const png = new Function('readFileSync', 'inflateSync', 'assert', `${decoder.getText(decoderAst)};return png;`)(readFileSync, inflateSync, assert);
const sprites = new Map();
for (const [id, model] of Object.entries(manifest.mobs)) for (const view of id === 'soldier' ? ['front', 'back'] : ['front']) {
  for (const key of ['shadow', ...Object.keys(model.pivots)].filter(k => view !== 'back' || !k.startsWith('arm_'))) {
    const path = `mobs/${id}/${view}/${key}.png`, image = png(`${__dirname}/../../public/paper-assets/runtime/${path}`);
    const alphaBounds = [image.width, image.height, 0, 0];
    for (let i = 3; i < image.data.length; i += 4) if (image.data[i] > 0) {
      const p = (i - 3) / 4, x = p % image.width, y = Math.floor(p / image.width);
      alphaBounds[0] = Math.min(alphaBounds[0], x); alphaBounds[1] = Math.min(alphaBounds[1], y);
      alphaBounds[2] = Math.max(alphaBounds[2], x + 1); alphaBounds[3] = Math.max(alphaBounds[3], y + 1);
    }
    sprites.set(path, { image: { ...image, path }, bounds: image.bounds, alphaBounds });
  }
}
const assetSource = readFileSync(`${__dirname}/paperAssets.ts`, 'utf8');
const ast = ts.createSourceFile('paperAssets.ts', assetSource, ts.ScriptTarget.Latest, true);
const names = ['enemyGeometry', 'createPaperEnemyFrame', 'getPaperEnemyVisibleBounds', 'drawPaperEnemy'];
const declarations = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text));
assert.equal(declarations.length, 4);
const api = {};
let poseCalls = 0;
let captures;
new Function('exports', 'manifest', 'sprites', 'paperEnemyPose', 'tintedPart', compile(declarations.map(n => n.getText(ast)).join('\n')))(
  api, manifest, sprites, (...args) => { poseCalls++; const pose = geometry.paperEnemyPose(...args); if (captures) captures.push({ args, pose }); return pose; },
  (path, variant) => ({ path, variant }));
const context = () => { const matrices = [], draws = [], stack = [];
  return { matrices, draws, stack, globalAlpha: 1, filter: 'none', save() { stack.push([this.globalAlpha, this.filter]); },
    restore() { [this.globalAlpha, this.filter] = stack.pop(); }, transform(...m) { matrices.push(m); },
    drawImage(image, ...args) { draws.push({ ...image, args, alpha: this.globalAlpha }); } };
};
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const extent = (parts, model, layers) => {
  const points = layers.filter(l => l.key !== 'shadow').flatMap(l => {
    const m = parts.find(p => p.key === l.key).matrix, [x, y, r, b] = l.bounds;
    return [[x, y], [r, y], [r, b], [x, b]].map(p => geometry.transformPaperPoint(m, [p[0] * model.canvas[0] / l.width, p[1] * model.canvas[1] / l.height]));
  });
  const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
  return { x, y, width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y };
};
let poses = 0, envelopes = 0;
const measurements = {};
for (const [id, model] of Object.entries(manifest.mobs)) {
  let maxTravel = 0, expansion = 0, alphaExpansion = 0;
  for (const heading of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
    const view = id === 'soldier' && Math.sin(heading) < 0 ? 'back' : 'front';
    const layers = ['shadow', ...Object.keys(model.pivots)].filter(k => view !== 'back' || !k.startsWith('arm_')).map(key => {
      const s = sprites.get(`mobs/${id}/${view}/${key}.png`); return { key, width: s.image.width, height: s.image.height, bounds: s.bounds };
    });
    const strictLayers = layers.map(l => ({ ...l, bounds: sprites.get(`mobs/${id}/${view}/${l.key}.png`).alphaBounds }));
    for (const cell of [28, 34]) for (const variant of [0, 1, 2, 3]) {
      const enemy = { id, uid: 'walk', pos: { x: 200, y: 250 }, speed: 28, hp: 50, maxHp: 100, paletteVariant: variant, visualScale: data.ENEMIES[id].visualScale ?? 1 };
      const before = JSON.stringify(enemy), idle = geometry.paperEnemyPose(model, layers, enemy, 0, false, cell);
      for (const mode of ['moving', 'idle', 'reduced', 'stun']) for (let step = 0; step < 24; step++) {
        const time = step / 12, moving = mode !== 'idle', reduced = mode === 'reduced';
        const e = mode === 'stun' ? { ...enemy, stunUntil: 100 } : enemy;
        const pose = geometry.paperEnemyPose(model, layers, e, time, moving, cell, reduced);
        assert.ok(pose);
        if (mode !== 'moving') assert.deepEqual(pose, idle, 'idle/reduced/stun exact valid static baseline');
        const ctx = context(), frame = api.createPaperEnemyFrame(), count = poseCalls;
        assert.equal(api.drawPaperEnemy(ctx, e, time, heading, moving, cell, frame, reduced), true);
        const bounds = api.getPaperEnemyVisibleBounds(e, time, heading, moving, cell, frame, reduced);
        assert.equal(poseCalls - count, 1, 'actual body/health share one frame pose including reduced/stun');
        assert.deepEqual(ctx.matrices, pose.parts.map(p => p.matrix));
        assert.deepEqual(bounds, pose.bounds);
        assert.deepEqual(extent(pose.parts, model, layers), bounds);
        const strict = extent(pose.parts, model, strictLayers), staticStrict = extent(idle.parts, model, strictLayers);
        expansion = Math.max(expansion, pose.bounds.width - idle.bounds.width, pose.bounds.height - idle.bounds.height);
        alphaExpansion = Math.max(alphaExpansion, strict.width - staticStrict.width, strict.height - staticStrict.height);
        assert.ok(strict.width <= staticStrict.width + cell * .3 && strict.height <= staticStrict.height + cell * .3, 'strict PNG envelope growth bounded, not half-cell containment claim');
        for (const [i, part] of pose.parts.entries()) {
          assert.ok(part.matrix.every(Number.isFinite));
          assert.equal(ctx.draws[i].path, `mobs/${id}/${view}/${part.key}.png`);
          assert.equal(ctx.draws[i].variant, variant);
          assert.deepEqual(ctx.draws[i].args, [0, 0, ...model.canvas]);
          if (part.key === 'shadow') { assert.deepEqual(part.matrix, idle.parts[i].matrix); continue; }
          near(Math.hypot(part.matrix[0], part.matrix[1]), pose.scale);
          near(part.matrix[0] * part.matrix[3] - part.matrix[1] * part.matrix[2], pose.scale ** 2);
          const pivot = model.pivots[part.key], parent = id === 'healer' && part.key.startsWith('lantern') ? 'lantern'
            : id === 'support' && /^(pole|flag|fold_[12])$/.test(part.key) ? 'pole'
            : id === 'boss' && part.key.startsWith('cape') ? 'cape_part_1' : null;
          if (parent) assert.deepEqual(part.matrix, pose.parts.find(p => p.key === parent).matrix, 'carried/cape layers stay rigid-linked');
          else {
            const p = geometry.transformPaperPoint(part.matrix, pivot), baseline = geometry.transformPaperPoint(idle.parts[i].matrix, pivot);
            near(p.x, baseline.x);
            const body = pose.parts.find(p => /^(body|core)$/.test(p.key));
            near(p.y - baseline.y, body.matrix[5] - idle.parts.find(p => p.key === body.key).matrix[5]);
          }
          const s = sprites.get(`mobs/${id}/${view}/${part.key}.png`), corner = [s.bounds[2] * model.canvas[0] / s.image.width, s.bounds[3] * model.canvas[1] / s.image.height];
          const now = geometry.transformPaperPoint(part.matrix, corner), rest = geometry.transformPaperPoint(idle.parts[i].matrix, corner);
          maxTravel = Math.max(maxTravel, Math.hypot(now.x - rest.x, now.y - rest.y));
        }
        for (const [item, carrier] of id === 'healer' ? [['lantern', 'arm_right']] : id === 'support' ? [['pole', 'arm_right']] : []) {
          const pivot = model.pivots[item], object = pose.parts.find(p => p.key === item), arm = pose.parts.find(p => p.key === carrier);
          const a = geometry.transformPaperPoint(object.matrix, pivot), b = geometry.transformPaperPoint(arm.matrix, pivot);
          near(a.x, b.x); near(a.y, b.y);
        }
        assert.equal(ctx.stack.length, 0);
        poses++; envelopes += 2;
      }
      assert.equal(JSON.stringify(enemy), before);
      const frame = api.createPaperEnemyFrame(), count = poseCalls;
      api.getPaperEnemyVisibleBounds(enemy, .2, heading, true, cell, frame, false);
      api.getPaperEnemyVisibleBounds(enemy, .2, heading, true, cell, frame, true);
      enemy.stunUntil = 10;
      api.getPaperEnemyVisibleBounds(enemy, .2, heading, true, cell, frame, false);
      assert.equal(poseCalls - count, 3, 'frame invalidates reducedMotion and stunUntil');
      api.getPaperEnemyVisibleBounds(enemy, .2, heading, true, cell, frame, false, .25);
      api.getPaperEnemyVisibleBounds(enemy, .2, heading, true, cell, frame, false, 1.25);
      assert.equal(poseCalls - count, 5, 'frame includes optional walkPhase in cache key');
      enemy.stunUntil = undefined;
      const time = .125, seed = [...enemy.uid].reduce((n, c) => n + c.charCodeAt(0), 0);
      const walkPhase = (seed + geometry.paperEnemyWalkPhaseDelta(id, enemy.speed, enemy.speed * time)) % (Math.PI * 2);
      const explicit = geometry.paperEnemyPose(model, layers, enemy, time, true, cell, false, walkPhase);
      const fallback = geometry.paperEnemyPose(model, layers, enemy, time, true, cell);
      explicit.parts.forEach((p, i) => p.matrix.forEach((n, j) => near(n, fallback.parts[i].matrix[j])));
      for (const invalid of [NaN, Infinity, -Infinity]) assert.deepEqual(geometry.paperEnemyPose(model, layers, enemy, time, true, cell, false, invalid), fallback);
    }
  }
  assert.ok(maxTravel > 1, `${id}: meaningful actual-layer displacement, not bob-only`);
  measurements[id] = { travel: +maxTravel.toFixed(3), visibleGrowth: +expansion.toFixed(3), strictGrowth: +alphaExpansion.toFixed(3) };
}
const signatures = Object.entries(manifest.mobs).map(([id, model]) => {
  const layers = Object.keys(model.pivots).map(key => { const s = sprites.get(`mobs/${id}/front/${key}.png`); return { key, width: s.image.width, height: s.image.height, bounds: s.bounds }; });
  return Array.from({ length: 24 }, (_, i) => geometry.paperEnemyPose(model, layers, { id, uid: 'same', pos: { x: 0, y: 0 }, speed: 28 }, i / 12, true, 34).parts
    .map(p => Math.abs(Math.atan2(p.matrix[1], p.matrix[0]))).sort((a, b) => b - a).slice(0, 2).map(n => n.toFixed(4))).flat(2).join(',');
});
assert.equal(new Set(signatures).size, 11, 'all11 distinct temporal rotation signatures independent of part names');
for (const id of ['unknown', '__proto__', 'constructor', 'toString']) {
  assert.equal(api.getPaperEnemyVisibleBounds({ id }, 0, 0, true, 28), null);
  assert.equal(api.drawPaperEnemy({}, { id }, 0, 0, true, 28), false);
}
const gameSource = readFileSync(`${__dirname}/Game.tsx`, 'utf8');
const gameAst = ts.createSourceFile('Game.tsx', gameSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const gameFunctions = ['enemyVisualStatuses', 'drawEnemyCanvas'].map(name => gameAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(gameAst)).join('\n');
const gameApi = new Function('exports', 'ENEMIES', 'ENEMY_SHAPES', 'ENGINE_CELL_PX', 'drawPaperEnemy', 'drawPaperFxSprite',
  `${compile(gameFunctions)};return { drawEnemyCanvas, enemyVisualStatuses };`)({}, data.ENEMIES, data.ENEMY_SHAPES, 28, api.drawPaperEnemy, () => true);
const begin = gameSource.indexOf('    // Enemies\n') >= 0 ? gameSource.indexOf('    // Enemies\n') : gameSource.indexOf('    // Enemies\r\n');
const end = gameSource.indexOf('    // Health is a separate pass:', begin);
assert.ok(begin > 0 && end > begin);
const drawGame = new Function('ctx', 'gs', 'enemyMotion', 'reducedMotionRef', 'createPaperEnemyFrame', 'drawEnemyCanvas',
  'enemyVisualStatuses', 'enemyHealthPresentation', 'enemyHealthAnchor', 'getPaperEnemyVisibleBounds', 'ENGINE_CELL_PX', 'ENEMIES',
  'paperWalkClockRef',
  `${compile(gameSource.slice(begin, end))};return healthAnchors;`);
let gameCases = 0;
for (const mode of ['moving', 'idle', 'reduced', 'stun']) for (const direction of [1, -1]) {
  const enemies = Object.keys(manifest.mobs).map(id => ({ id, uid: `game-${id}`, hp: 50, maxHp: 100, speed: 28,
    pos: { x: 100, y: 150 }, speedEffects: mode === 'stun' ? [{ kind: 'laserStun', startedAt: 0, expiresAt: 10, multiplier: .05 }] : [] }));
  const state = { enemies, towers: [], time: .375, gluePatches: [] }, before = JSON.stringify(state), ctx = context();
  const clock = walkApi.createPaperWalkClock();
  const motion = { current: new Map(enemies.map(e => [e.uid, { x: e.pos.x, y: e.pos.y - (mode === 'idle' ? 0 : direction), heading: 0, movedAt: -100 }])) };
  captures = [];
  const anchors = drawGame(ctx, state, motion, { current: mode === 'reduced' }, api.createPaperEnemyFrame, gameApi.drawEnemyCanvas,
    gameApi.enemyVisualStatuses, readability.enemyHealthPresentation, readability.enemyHealthAnchor, api.getPaperEnemyVisibleBounds, 28, data.ENEMIES,
    { current: clock });
  assert.equal(captures.length, 11, 'executed Game body and health share11 cached poses');
  assert.deepEqual(ctx.matrices, captures.flatMap(c => c.pose.parts.map(p => p.matrix)));
  for (const { args, pose } of captures) {
    const enemy = args[2];
    assert.equal(args[4], mode === 'moving' || mode === 'reduced');
    assert.equal(args[6], mode === 'reduced');
    assert.equal(args[7], clock.phase(enemy), 'actual Game forwards identical seeded phase to body and cached health');
    assert.deepEqual(anchors.get(enemy.uid), readability.enemyHealthAnchor(pose.bounds, {}));
    if (mode !== 'moving') assert.deepEqual(pose, geometry.paperEnemyPose(args[0], args[1], enemy, state.time, false, 28));
    gameCases++;
  }
  assert.equal(JSON.stringify(state), before);
  assert.equal(ctx.stack.length, 0);
  captures = undefined;
}
console.log(`actual Game body/health integration PASS: ${gameCases} cases; reduced/idle/authoritative stun/front-back`);
console.log(`mob locomotion PASS: ${poses} actual-PNG recorded poses/${envelopes} visible+strict envelopes; ${JSON.stringify(measurements)}`);
