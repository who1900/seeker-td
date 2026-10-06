const { strict: assert } = require('node:assert');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
const helperSource = readFileSync(`${__dirname}/enemyReadability.ts`, 'utf8');
const api = {};
new Function('exports', ts.transpileModule(helperSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText)(api);
const layoutApi = {};
new Function('exports', ts.transpileModule(readFileSync(`${__dirname}/healthArcLayout.ts`, 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText)(layoutApi);
for (const ratio of [0, .00001, .01, .1, .5, 1]) {
  const arc = api.enemyHealthArc(ratio);
  assert.equal(arc.start, -5 * Math.PI / 6);
  assert.equal(arc.end, -Math.PI / 6);
  assert.equal(arc.fillEnd, ratio === 1 ? arc.end : arc.start + (arc.end - arc.start) * ratio);
  assert.ok(Math.abs(arc.end - arc.start - 2 * Math.PI / 3) < 1e-15);
  assert.ok(arc.fillEnd >= arc.start && arc.fillEnd <= arc.end);
}
for (const ratio of [NaN, Infinity, -Infinity, -.01, 1.01]) assert.equal(api.enemyHealthArc(ratio), null);
assert.equal(api.enemyHealthArc(0).fillEnd, api.enemyHealthArc(0).start, 'no minimum-length lie');
function luminance(hex) {
  const channels = hex.match(/[a-f\d]{2}/gi).map(value => parseInt(value, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
const contrast = (luminance('f6f5f0') + .05) / (luminance('8a4a4a') + .05);
assert.ok(contrast >= 3, `active arc contrast ${contrast}`);
assert.ok((luminance('f6f5f0') + .05) / (luminance('73766d') + .05) >= 3, 'body association ink contrast');
const source = readFileSync(`${__dirname}/Game.tsx`, 'utf8');
const start = source.indexOf('    // Health is a separate pass:');
const end = source.indexOf('    // Projectiles', start);
assert.ok(start >= 0 && end > start);
const pass = new Function('ctx', 'gs', 'targetedEnemyUids', 'healthAnchors', 'enemyVisualStatuses',
  'enemyHealthPresentation', 'enemyHealthArc', 'layoutHealthArcs', 'healthArcLayoutRef', 'cp', 'ENGINE_CELL_PX', 'scale',
  ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText);
const enemies = [
  { uid: 'boss-full', id: 'boss', hp: 100, maxHp: 100 },
  { uid: 'boss-low', id: 'boss', hp: 1, maxHp: 100 },
  { uid: 'damaged-shield', id: 'shieldbearer', hp: 50, maxHp: 100 },
  { uid: 'relevant', id: 'soldier', hp: 100, maxHp: 100 },
  { uid: 'quiet-full', id: 'soldier', hp: 100, maxHp: 100 },
  { uid: 'dead', id: 'boss', hp: 0, maxHp: 100 },
  { uid: 'invalid', id: 'boss', hp: NaN, maxHp: 100 },
];
const anchors = new Map(enemies.map((enemy, index) => [enemy.uid, { x: 10 * index, y: 20, radius: 15 + index }]));
const before = JSON.stringify({ enemies, anchors: [...anchors] });
const strokes = [];
const leaders = [];
const dots = [];
const events = [];
let pending;
let saves = 0;
const ctx = { save() { saves++; }, restore() { saves--; }, beginPath() { pending = null; },
  moveTo(x, y) { this.from = { x, y }; }, lineTo(x, y) { this.to = { x, y }; },
  arc(...args) { pending = args; }, fill() { dots.push(pending); events.push('dot'); }, stroke() {
    events.push(pending ? 'hp' : 'leader');
    if (pending) strokes.push({ args: pending, color: this.strokeStyle, width: this.lineWidth, cap: this.lineCap });
    else leaders.push({ from: this.from, to: this.to, color: this.strokeStyle, width: this.lineWidth });
  } };
const layoutRef = { current: new Map() };
const targets = new Set(['relevant']);
const eligibleAnchors = new Map([...anchors].filter(([uid]) => enemies.slice(0, 4).some(e => e.uid === uid)));
const draw = (drawEnemies = enemies, drawAnchors = eligibleAnchors, time = 0, statuses = () => ({}), cp = 34) =>
  pass(ctx, { enemies: drawEnemies, time, gridW: 12, gridH: 21 }, targets, drawAnchors, statuses,
    api.enemyHealthPresentation, api.enemyHealthArc, layoutApi.layoutHealthArcs, layoutRef, cp, 28, cp / 28);
draw();
assert.equal(strokes.length, 8, 'every visible enemy gets its own track and fill, bosses always visible');
assert.equal(saves, 0);
for (const [index, enemy] of enemies.slice(0, 4).entries()) {
  const track = strokes[index * 2], fill = strokes[index * 2 + 1];
  const anchor = anchors.get(enemy.uid), arc = api.enemyHealthArc(enemy.hp / enemy.maxHp);
  const offset = layoutRef.current.get(enemy.uid);
  assert.deepEqual(track.args, [anchor.x + offset.dx, anchor.y + offset.dy, anchor.radius, arc.start, arc.end]);
  assert.deepEqual(fill.args, [anchor.x + offset.dx, anchor.y + offset.dy, anchor.radius, arc.start, arc.fillEnd]);
  assert.equal(track.width, .75);
  assert.equal(track.color, 'rgba(89,89,89,0.25)');
  assert.equal(fill.color, '#8a4a4a');
  assert.equal(fill.cap, 'butt');
  assert.equal(fill.width, enemy.id === 'boss' ? 1.5 : 1);
}
assert.equal(JSON.stringify({ enemies, anchors: [...anchors] }), before, 'HP, actor position and anchor never mutated');
assert.equal(layoutRef.current.size, 4, 'only existing eligible anchors enter layout');
assert.ok(leaders.length > 0, 'fixture exercises actual translated indicators');
assert.equal(dots.length, leaders.length, 'each leader has a body attachment dot');
assert.ok(events.slice(events.indexOf('hp')).every(event => event === 'hp'), 'all leaders/dots under all HP arcs');
for (const leader of leaders) {
  assert.ok([...eligibleAnchors.values()].some(a => a.x === leader.from.x && a.y === leader.from.y), 'attached to actual visible body center');
  assert.ok(Math.abs(leader.width * 34 / 28 - 1) < 1e-12, 'leader one display pixel');
  assert.equal(leader.color, '#73766d');
}
const prior = layoutRef.current;
const priorBefore = JSON.stringify([...prior]);
strokes.length = 0;
draw(enemies, eligibleAnchors, .1);
assert.equal(JSON.stringify([...prior]), priorBefore, 'previous layout state not mutated');
assert.equal(strokes.length, 8);
strokes.length = 0;
const offworld = new Map([...eligibleAnchors].map(([uid, a]) => [uid, { ...a, x: -1000 }]));
draw(enemies, offworld, .2);
assert.equal(strokes.length, 8, 'unresolved/offworld retains every individual track and fill');
strokes.length = 0;
const statusEnemies = ['slowed', 'stunned', 'teleporting', 'hit'].map((uid, i) =>
  ({ uid, id: 'soldier', hp: 100, maxHp: 100, hitFlash: i === 3 ? 1 : 0 }));
const statusAnchors = new Map(statusEnemies.map((e, i) => [e.uid, { x: 50 + i * 50, y: 100, radius: 8 }]));
draw(statusEnemies, statusAnchors, .3, e => ({ [e.uid]: true }));
assert.equal(strokes.length, 8, 'unchanged slow/stun/teleport/hit visibility');
assert.equal(layoutRef.current.size, 4);
draw([], new Map(), .4);
assert.equal(layoutRef.current.size, 0, 'dead/ineligible UID cleanup');
assert.ok(source.includes('const healthArcLayoutRef = useRef<HealthArcLayoutState>(new Map())'));
assert.ok(source.includes('cp / ENGINE_CELL_PX, gs.time, ENGINE_CELL_PX, healthArcLayoutRef.current'));
for (const cp of [28, 34]) {
  const column = Array.from({ length: 8 }, (_, i) => ({ uid: `column${i}`, id: i ? 'soldier' : 'boss', hp: 25, maxHp: 100 }));
  const columnAnchors = new Map(column.map((e, i) => [e.uid, { x: 168, y: 140 + i * 28 * .18, radius: 28 * (i ? .45 : .8) }]));
  layoutRef.current = new Map();
  for (let frame = 0; frame < 30; frame++) {
    strokes.length = leaders.length = dots.length = events.length = 0;
    const moved = new Map([...columnAnchors].map(([uid, a]) => [uid, { ...a, y: a.y + frame * .05 }]));
    draw(column, moved, frame / 60, () => ({}), cp);
    assert.equal(strokes.length, 16, 'all individual track/fill ratios drawn');
    assert.equal(leaders.length, dots.length);
    assert.ok(events.slice(events.indexOf('hp')).every(event => event === 'hp'));
    for (const [i, enemy] of column.entries()) {
      const a = moved.get(enemy.uid), offset = layoutRef.current.get(enemy.uid);
      assert.deepEqual(strokes[i * 2].args.slice(0, 3), [a.x + offset.dx, a.y + offset.dy, a.radius]);
      assert.equal(strokes[i * 2 + 1].args[4], api.enemyHealthArc(.25).fillEnd);
      if (offset.dx || offset.dy) {
        const leader = leaders.find(l => l.from.x === a.x && l.from.y === a.y);
        assert.ok(leader, 'actual Game associates each displaced arc with its own body');
        assert.deepEqual(leader.to, { x: a.x + offset.dx, y: a.y - a.radius + offset.dy });
        assert.ok(dots.some(dot => dot[0] === a.x && dot[1] === a.y && dot[2] === 1.25 / (cp / 28)));
      }
    }
    assert.equal(saves, 0);
  }
}
console.log(`health arc regression: passed; active/field contrast ${contrast.toFixed(2)}:1`);
