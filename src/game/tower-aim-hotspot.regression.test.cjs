const { strict: assert } = require('node:assert');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
const source = readFileSync(`${__dirname}/Game.tsx`, 'utf8');
const ast = ts.createSourceFile('Game.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const aim = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'towerVisualAim');
assert.ok(aim);
const exportsMock = {};
new Function('exports', ts.transpileModule(aim.getText(ast), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(exportsMock);
const start = source.indexOf('      let nearest: Enemy | undefined;');
const end = source.indexOf('      motion.angle = paperRenderedAngle(', start);
assert.ok(start >= 0 && end > start);
const newAim = new Function('tower', 'enemiesByUid', 'gs', 'motion', 'towerVisualAim',
  ts.transpileModule(`${source.slice(start, end)}\nreturn desired;`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText);
function oldAim(tower, map, enemies, angle) {
  let nearest;
  let distance = Infinity;
  for (const enemy of enemies) {
    const d = Math.hypot(enemy.pos.x - tower.worldX, enemy.pos.y - tower.worldY);
    if (enemy.hp > 0 && d < distance) { distance = d; nearest = enemy; }
  }
  const fallback = nearest ? Math.atan2(nearest.pos.y - tower.worldY, nearest.pos.x - tower.worldX) + Math.PI / 2 : angle;
  return exportsMock.towerVisualAim(tower, map, fallback);
}
let checks = 0;
const enemy = (uid, hp, x, y) => ({ uid, hp, pos: { x, y } });
const populations = [
  [], [enemy('live', 10, 0, 10)],
  [enemy('dead', 0, 0, 1), enemy('live', 10, 0, 10)],
  [enemy('first', 10, 10, 0), enemy('live', 10, -10, 0)],
  [enemy('live', 10, NaN, 10), enemy('other', 10, 4, 5)],
  [enemy('dead', -1, 2, 3)],
];
for (const enemies of populations) {
  const map = new Map(enemies.map(e => [e.uid, e]));
  for (const targetUid of [undefined, 'live', 'dead', 'sold-or-missing']) {
    for (const aimAngle of [undefined, NaN, Infinity, -Infinity, 0, .7, -Math.PI]) {
      for (const angle of [0, .4, -2, NaN]) {
        const tower = { worldX: 0, worldY: 0, targetUid, aimAngle };
        const before = JSON.stringify({ tower, enemies });
        const expected = oldAim(tower, map, enemies, angle);
        let scans = 0;
        const iterable = { *[Symbol.iterator]() { scans++; yield* enemies; } };
        const actual = newAim(tower, map, { enemies: iterable }, { angle }, exportsMock.towerVisualAim);
        assert.ok(Object.is(actual, expected), `angle changed: ${targetUid}, ${aimAngle}, ${angle}`);
        const target = targetUid ? map.get(targetUid) : undefined;
        assert.equal(scans, (target && target.hp > 0) || Number.isFinite(aimAngle) ? 0 : 1);
        assert.equal(JSON.stringify({ tower, enemies }), before, 'no authority mutation');
        checks++;
      }
    }
  }
}
const valid = enemy('live', 10, 2, 3);
const mustNotScan = { [Symbol.iterator]() { throw new Error('authoritative aim scanned enemies'); } };
for (const tower of [
  { worldX: 0, worldY: 0, targetUid: 'live', aimAngle: NaN },
  { worldX: 0, worldY: 0, targetUid: 'missing', aimAngle: 0 },
]) newAim(tower, new Map([['live', valid]]), { enemies: mustNotScan }, { angle: .8 }, exportsMock.towerVisualAim);
console.log(`tower aim hotspot regression: passed (${checks} angle/scan cases)`);
