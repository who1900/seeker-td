const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
const api = {};
new Function('exports', ts.transpileModule(readFileSync(`${__dirname}/healthArcLayout.ts`, 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText)(api);
const overlap = (a, b) => a.x < b.x + b.width + 2 && a.x + a.width + 2 > b.x
  && a.y < b.y + b.height + 2 && a.y + a.height + 2 > b.y;
const orient = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
const crossing = (a, b) => orient(a.from, a.to, b.from) * orient(a.from, a.to, b.to) < 0
  && orient(b.from, b.to, a.from) * orient(b.from, b.to, a.to) < 0;
let frames = 0;
for (const cell of [28, 34]) {
  const world = { x: 0, y: 0, width: cell * 12, height: cell * 21 };
  const items = Array.from({ length: 8 }, (_, i) => ({ uid: `mob${i}`, x: cell * 6,
    y: cell * (5 + i * .18), radius: cell * (i ? .45 : .8), stroke: i ? 1 : 1.5, boss: !i,
    bodyPoint: { x: cell * 6, y: cell * (5 + i * .18) } }));
  const before = JSON.stringify(items);
  let result = api.layoutHealthArcs(items, world, 1, 0, cell);
  assert.equal(result.diagnostics.unresolved, 0);
  assert.equal(result.diagnostics.leaderUnresolved, 0);
  assert.equal(result.diagnostics.budgetExhausted, false);
  const offsets = [...result.state].map(([uid, p]) => [uid, p.dx, p.dy]);
  const boxes = items.map(a => { const p = result.placements.get(a.uid); return api.healthArcStrokeBounds(a, p.dx, p.dy); });
  for (let i = 0; i < items.length; i++) {
    const p = result.placements.get(items[i].uid);
    assert.ok(Math.hypot(p.dx, p.dy) <= cell, 'ordinary density uses near alternatives, not 2.4-cell fallback');
    if (p.leader) assert.deepEqual(p.leader.from, items[i].bodyPoint);
    for (let j = i + 1; j < items.length; j++) {
      assert.equal(overlap(boxes[i], boxes[j]), false, 'independent rectangle collision oracle');
      const q = result.placements.get(items[j].uid);
      if (p.leader && q.leader) assert.equal(crossing(p.leader, q.leader), false, 'independent leader crossing oracle');
      for (const [line, box] of [[p.leader, boxes[j]], [q.leader, boxes[i]]]) {
        if (!line) continue;
        for (let t = 0; t <= 100; t++) {
          const x = line.from.x + (line.to.x - line.from.x) * t / 100;
          const y = line.from.y + (line.to.y - line.from.y) * t / 100;
          assert.ok(x < box.x - 1 || x > box.x + box.width + 1 || y < box.y - 1 || y > box.y + box.height + 1,
            'independent leader samples avoid other HP tracks');
        }
      }
    }
  }
  for (let frame = 1; frame <= 90; frame++) {
    const moved = items.map(a => ({ ...a, y: a.y + frame * .05, bodyPoint: { ...a.bodyPoint, y: a.bodyPoint.y + frame * .05 }, targeted: frame % 2 === 0 }));
    const prior = JSON.stringify([...result.state]);
    const previous = result.state;
    result = api.layoutHealthArcs(moved.reverse(), world, 1, frame / 60, cell, previous);
    assert.equal(JSON.stringify([...previous]), prior);
    assert.deepEqual([...result.state].map(([uid, p]) => [uid, p.dx, p.dy]), offsets);
    assert.equal(result.diagnostics.unresolved, 0);
    assert.equal(result.diagnostics.leaderUnresolved, 0);
    frames++;
  }
  for (const x of [cell * .6, world.width - cell * .6]) {
    const edge = items.map(a => ({ ...a, x, y: a.y - cell * 4, bodyPoint: { x, y: a.bodyPoint.y - cell * 4 } }));
    const r = api.layoutHealthArcs(edge, world, 1, 0, cell);
    for (const a of edge) {
      const p = r.placements.get(a.uid), b = api.healthArcStrokeBounds(a, p.dx, p.dy);
      assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.width <= world.width && b.y + b.height <= world.height);
      if (p.leader) assert.deepEqual(p.leader.from, a.bodyPoint);
    }
  }
  assert.equal(JSON.stringify(items), before);
  const stress = api.layoutHealthArcs(Array.from({ length: 2050 }, (_, i) => ({ ...items[0], uid: `stress${i}` })), world, 1, 0, cell);
  assert.equal(stress.placements.size, 2050, 'no individual indicators dropped');
  assert.equal(stress.state.size, api.HEALTH_ARC_LAYOUT_CAP);
  assert.ok(stress.diagnostics.unresolved > 0 && stress.diagnostics.leaderUnresolved > 0);
  assert.ok(stress.diagnostics.comparisons <= api.HEALTH_ARC_COMPARISON_BUDGET);
  assert.ok(stress.diagnostics.binVisits <= api.HEALTH_ARC_BIN_BUDGET);
  assert.ok(stress.diagnostics.queries <= api.HEALTH_ARC_LAYOUT_CAP * 82);
  if (stress.diagnostics.budgetExhausted) for (const placement of stress.placements.values()) {
    assert.equal(placement.unresolved, true);
    if (placement.leader) assert.equal(placement.leaderUnresolved, true, 'exhausted association checks remain unknown/unresolved');
  }
  const invalidWorld = api.layoutHealthArcs(items, { ...world, width: NaN }, 1, 0, cell);
  assert.equal(invalidWorld.diagnostics.unresolved, items.length);
  const invalid = api.layoutHealthArcs([{ ...items[0], bodyPoint: { x: NaN, y: 1 } }], world, 1, 0, cell);
  assert.equal(invalid.state.size, 0);
  assert.equal(invalid.placements.get(items[0].uid).unresolved, true);
  console.log(`cell${cell} dense-column8 resolved, max displacement <1cell; stress ${JSON.stringify(stress.diagnostics)}`);
}
console.log(`dense health regression PASS: ${frames} stable frames, edges, body association, unresolved stress`);
