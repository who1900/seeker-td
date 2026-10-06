const { strict: assert } = require('node:assert');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const geometryExports = {};
new Function('exports', 'require', compile(readFileSync(`${__dirname}/paperGeometry.ts`, 'utf8')))(geometryExports, name => {
  assert.equal(name, './data');
  return { CELL_PX: 28 };
});
const source = readFileSync(`${__dirname}/paperAssets.ts`, 'utf8');
const ast = ts.createSourceFile('paperAssets.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = ['enemyGeometry', 'createPaperEnemyFrame', 'getPaperEnemyVisibleBounds', 'drawPaperEnemy'];
const selected = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
assert.equal(selected.length, 4);
const manifest = JSON.parse(readFileSync(`${__dirname}/../../public/paper-assets/manifest.json`, 'utf8'));
const sprites = new Map();
for (const [id, model] of Object.entries(manifest.mobs)) {
  for (const view of id === 'soldier' ? ['front', 'back'] : ['front']) {
    for (const key of ['shadow', ...Object.keys(model.pivots)]) {
      sprites.set(`mobs/${id}/${view}/${key}.png`, {
        image: { width: model.canvas[0], height: model.canvas[1] },
        bounds: [8, 12, model.canvas[0] - 9, model.canvas[1] - 11],
      });
    }
  }
}
let poses = 0;
const exportsMock = {};
new Function('exports', 'manifest', 'sprites', 'paperEnemyPose', 'tintedPart', compile(selected.map(node => node.getText(ast)).join('\n')))(
  exportsMock, manifest, sprites, (...args) => { poses++; return geometryExports.paperEnemyPose(...args); },
  (path, variant) => ({ path, variant }));
function context() {
  const calls = [];
  const stack = [];
  return { calls, globalAlpha: .8, filter: 'none',
    save() { stack.push([this.globalAlpha, this.filter]); calls.push(['save']); },
    restore() { [this.globalAlpha, this.filter] = stack.pop(); calls.push(['restore']); },
    transform(...args) { calls.push(['matrix', ...args]); },
    drawImage(...args) { calls.push(['draw', this.globalAlpha, this.filter, ...args]); },
  };
}
let checks = 0;
for (const id of Object.keys(manifest.mobs)) for (const heading of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
  for (const moving of [true, false]) for (const variant of [0, 1, 2, 3]) {
    const enemy = { id, uid: `test-${id}`, hp: 10, pos: { x: 42, y: 71 }, speed: 28,
      paletteVariant: variant, visualScale: 1 + variant * .04, hitFlash: variant === 1 ? .1 : 0 };
    const before = JSON.stringify(enemy);
    const baseline = context();
    const drawn = exportsMock.drawPaperEnemy(baseline, enemy, 1.7, heading, moving, 28);
    const bounds = exportsMock.getPaperEnemyVisibleBounds(enemy, 1.7, heading, moving, 28);
    const frame = exportsMock.createPaperEnemyFrame();
    const cached = context();
    const count = poses;
    assert.equal(exportsMock.drawPaperEnemy(cached, enemy, 1.7, heading, moving, 28, frame), drawn);
    assert.deepEqual(exportsMock.getPaperEnemyVisibleBounds(enemy, 1.7, heading, moving, 28, frame), bounds);
    assert.deepEqual(cached.calls, baseline.calls, 'matrices, layer order, tint, alpha and hit status unchanged');
    assert.equal(poses - count, 1, 'draw and bounds share one actual pose');
    assert.equal(JSON.stringify(enemy), before);
    const nextFrame = exportsMock.createPaperEnemyFrame();
    exportsMock.getPaperEnemyVisibleBounds(enemy, 1.7, heading, moving, 28, nextFrame);
    assert.equal(poses - count, 2, 'identical next frame still recomputes');
    enemy.pos.x += 3;
    enemy.paletteVariant = (variant + 1) % 4;
    const changed = exportsMock.getPaperEnemyVisibleBounds(enemy, 2, -heading, !moving, 32, frame);
    assert.deepEqual(changed, exportsMock.getPaperEnemyVisibleBounds(enemy, 2, -heading, !moving, 32), 'changed inputs never reuse stale pose');
    checks++;
  }
}
const game = readFileSync(`${__dirname}/Game.tsx`, 'utf8');
const drawStart = game.indexOf('  const draw = useCallback(() => {');
assert.ok(game.indexOf('const paperEnemyFrame = createPaperEnemyFrame();', drawStart) > drawStart);
assert.equal((game.match(/createPaperEnemyFrame\(\)/g) || []).length, 1, 'one local frame factory, no persistent ref/cache');
assert.match(game, /moving && !statuses\.stunned, ENGINE_CELL_PX, frame, reducedMotion/);
assert.match(game, /motion\.movedAt < \.1 && !statuses\.stunned, ENGINE_CELL_PX, paperEnemyFrame, reducedMotionRef\.current/);
assert.match(source, /function createPaperEnemyFrame\(\) \{\s*const geometries = new WeakMap/);
console.log(`enemy frame regression: passed (${checks} actual-pose cases)`);
