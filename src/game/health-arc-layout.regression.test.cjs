const { strict: assert } = require('node:assert');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
const api = {};
new Function('exports', ts.transpileModule(readFileSync(`${__dirname}/healthArcLayout.ts`, 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText)(api);
const world = { x: 0, y: 0, width: 12 * 28, height: 21 * 28 };
const anchor = (uid, x = 100, y = 100, radius = 2) => ({ uid, x, y, radius, stroke: 1 });
const run = (items, time = 0, state, scale = 1) => api.layoutHealthArcs(items, world, scale, time, 28, state);
const offset = p => [p.dx, p.dy];
const items = [anchor('b'), { ...anchor('a'), boss: true, stroke: 1.5 }, anchor('c')];
const before = JSON.stringify(items);
let result = run(items);
assert.equal(JSON.stringify(items), before);
assert.deepEqual(offset(result.placements.get('a')), [0, 0]);
assert.ok([...result.placements.values()].every(p => !p.unresolved));
assert.deepEqual([...run([...items].reverse()).placements].sort(), [...result.placements].sort());
const switched = run(items.map(a => ({ ...a, targeted: a.uid === 'c', boss: false })), .1, result.state);
for (const a of items) assert.deepEqual(offset(switched.placements.get(a.uid)), offset(result.placements.get(a.uid)));
const stateBefore = JSON.stringify([...result.state]);
run(items, .2, result.state);
assert.equal(JSON.stringify([...result.state]), stateBefore);
for (const a of items) {
  const p = result.placements.get(a.uid);
  assert.ok(Math.hypot(p.dx, p.dy) <= api.HEALTH_ARC_MAX_OFFSET * 28);
  const b = api.healthArcStrokeBounds(a, p.dx, p.dy);
  for (let i = 0; i <= 120; i++) {
    const angle = -5 * Math.PI / 6 + i * Math.PI / 180;
    const x = a.x + p.dx + Math.cos(angle) * a.radius;
    const y = a.y + p.dy + Math.sin(angle) * a.radius;
    assert.ok(x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height);
  }
  if (p.leader) assert.deepEqual(p.leader.to, { x: a.x + p.dx, y: a.y - a.radius + p.dy });
  assert.equal(b.width, Math.sqrt(3) * a.radius + a.stroke);
}
const separate = run([anchor('a'), anchor('b', 120)]);
const collision = [anchor('a'), anchor('b')];
const first = run(collision, 1, separate.state);
const early = run(collision, 1.149, first.state);
assert.deepEqual(offset(early.placements.get('b')), [0, 0]);
const resolved = run(collision, 1.15, early.state);
assert.notDeepEqual(offset(resolved.placements.get('b')), [0, 0]);
assert.equal(resolved.placements.get('b').unresolved, false);
assert.deepEqual(offset(run(collision, 1.15, first.state).placements.get('b')),
  offset(resolved.placements.get('b')), 'hysteresis independent of intermediate frame count');
assert.deepEqual(offset(run(collision, .5, first.state).placements.get('b')), [0, 0]);
let moving = resolved;
for (let i = 0; i < 60; i++) {
  moving = run(collision.map(a => ({ ...a, x: a.x + i * .1, y: a.y + i * .1 })), 2 + i / 60, moving.state);
  assert.deepEqual(offset(moving.placements.get('b')), offset(resolved.placements.get('b')));
}
const edge = run([anchor('edge', 1, 2)]);
const eb = api.healthArcStrokeBounds(anchor('edge', 1, 2), ...offset(edge.placements.get('edge')));
assert.ok(eb.x >= 0 && eb.y >= 0);
const impossible = run([anchor('huge', 0, 0, 1000)]);
assert.equal(impossible.placements.get('huge').unresolved, true);
assert.deepEqual(offset(impossible.placements.get('huge')), [0, 0]);
const dense = run(Array.from({ length: 2050 }, (_, i) => anchor(`uid${i}`, 100, 100, 15)));
assert.equal(dense.placements.size, 2050);
assert.equal(dense.state.size, 2048);
assert.ok([...dense.placements.values()].some(p => p.unresolved));
for (const size of [128, 2048]) {
  const cluster = Array.from({ length: size }, (_, i) => anchor(`dense${i}`, 100, 100, 15));
  const layout = run(cluster);
  assert.equal(layout.placements.size, size);
  assert.ok(layout.diagnostics.queries <= size * 82);
  assert.ok(layout.diagnostics.comparisons <= api.HEALTH_ARC_COMPARISON_BUDGET);
  assert.ok(layout.diagnostics.binVisits <= api.HEALTH_ARC_BIN_BUDGET);
  for (const p of layout.placements.values()) assert.ok(Math.hypot(p.dx, p.dy) <= api.HEALTH_ARC_MAX_OFFSET * 28);
  console.log(`dense${size}: ${JSON.stringify(layout.diagnostics)}`);
}
const spread = run(Array.from({ length: 128 }, (_, i) => anchor(`spread${i}`, 12 + (i % 10) * 30, 20 + Math.floor(i / 10) * 30)));
assert.ok([...spread.placements.values()].every(p => !p.unresolved));
assert.ok(spread.diagnostics.comparisons < 128 * 4);
const giants = run(Array.from({ length: 2048 }, (_, i) => anchor(`giant${i}`, 1e100, 1e100, 1e100)));
assert.equal(giants.placements.size, 2048);
assert.ok(giants.diagnostics.binVisits <= api.HEALTH_ARC_BIN_BUDGET);
assert.ok(giants.diagnostics.comparisons <= api.HEALTH_ARC_COMPARISON_BUDGET);
assert.ok([...giants.placements.values()].every(p => p.unresolved));
const oversized = run(Array.from({ length: 2048 }, (_, i) => anchor(`oversized${i}`, 168, 1100, 1000)));
assert.equal(oversized.diagnostics.budgetExhausted, true);
assert.ok(oversized.diagnostics.binVisits <= api.HEALTH_ARC_BIN_BUDGET);
assert.ok(oversized.diagnostics.comparisons <= api.HEALTH_ARC_COMPARISON_BUDGET);
assert.ok([...oversized.placements.values()].every(p => p.unresolved));
const mixed = Array.from({ length: 128 }, (_, i) => ({ ...anchor(`mixed${i}`, 15 + (i * 17 % 300),
  20 + (i * 43 % 550), 2 + i % 12), stroke: i % 3 ? 1 : 1.5 }));
const mixedLayout = run(mixed);
assert.equal(mixedLayout.diagnostics.budgetExhausted, false);
for (const a of mixed) {
  const p = mixedLayout.placements.get(a.uid), box = api.healthArcStrokeBounds(a, p.dx, p.dy);
  const outside = box.x < 0 || box.y < 0 || box.x + box.width > world.width || box.y + box.height > world.height;
  const collision = mixed.some(b => {
    if (a.uid === b.uid) return false;
    const q = mixedLayout.placements.get(b.uid), other = api.healthArcStrokeBounds(b, q.dx, q.dy);
    return box.x < other.x + other.width + 2 && box.x + box.width + 2 > other.x
      && box.y < other.y + other.height + 2 && box.y + box.height + 2 > other.y;
  });
  assert.equal(p.unresolved, outside || collision, `broadphase matches independent allpairs ${a.uid}`);
}
for (const invalid of [NaN, Infinity, -Infinity]) {
  assert.deepEqual(offset(run([anchor('bad', invalid)]).placements.get('bad')), [0, 0]);
  assert.equal(run([anchor('bad')], invalid).state.size, 0);
  assert.equal(run([anchor('bad')], 0, undefined, invalid).state.size, 0);
}
assert.equal(run([], 3, moving.state).state.size, 0);
assert.equal(run([anchor('a')], 3, moving.state).state.size, 1);
const track = api.healthArcStrokeBounds({ ...anchor('boss', 20, 20, 10), stroke: 1.5 });
assert.equal(track.y, 9.25);
assert.equal(track.height, 6.5);
const narrowGap = [anchor('a'), anchor('b', 106)];
assert.deepEqual(offset(run(narrowGap, 0, undefined, 2).placements.get('b')), [0, 0]);
assert.notDeepEqual(offset(run(narrowGap, 0, undefined, .5).placements.get('b')), [0, 0]);
const lowerEdge = anchor('lower', world.width - 1, world.height + 1);
const lower = run([lowerEdge]).placements.get('lower');
const lowerBounds = api.healthArcStrokeBounds(lowerEdge, lower.dx, lower.dy);
assert.ok(lowerBounds.x + lowerBounds.width <= world.width && lowerBounds.y + lowerBounds.height <= world.height);
const external = { ...anchor('hp'), hp: 1, maxHp: 100, ratio: .01, visible: true };
const externalBefore = JSON.stringify(external);
run([external]);
assert.equal(JSON.stringify(external), externalBefore);
assert.equal(run([{ ...anchor('overflow'), x: Number.MAX_VALUE, radius: Number.MAX_VALUE }]).state.size, 0);
console.log('health arc layout regression PASS: geometry, movement, hysteresis, priority, edges, invalid, cap and cleanup');
