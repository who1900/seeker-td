import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
import { createGame, tick, placeTower, cellToWorld } from './engine';
import { launchGlue } from './combatStatus';
import { CELL_PX } from './data';
import { createPaperWalkClock, PAPER_WALK_ENTRY_CAP, PAPER_WALK_SEGMENT_CAP } from './paperWalkClock';
import { paperEnemyWalkPhaseDelta } from './paperGeometry';
import type { Enemy, BattleState } from './types';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const increment = (a: number, b: number) => (b - a + Math.PI * 2) % (Math.PI * 2);
function fixture(flyer = false) {
  const game = createGame(); game.gold = 1e6;
  const enemy: Enemy = { uid: 'gait', id: flyer ? 'flyer' : 'soldier', hp: 1e6, maxHp: 1e6, speed: 28,
    pos: cellToWorld(game.entry), ...(flyer ? { flyProgress: 0 } : { path: game.currentPath!.map(cellToWorld), pathIdx: 1, pathProgress: 0 }) };
  game.enemies.push(enemy);
  const clock = createPaperWalkClock(); clock.sync(game);
  return { game, enemy, clock };
}
const step = ({ game, clock }: ReturnType<typeof fixture>, dt: number) => {
  const pre = JSON.stringify(game), snapshot = clock.snapshot(game);
  assert.equal(JSON.stringify(game), pre, 'snapshot does not mutate engine');
  tick(game, dt); const post = JSON.stringify(game); clock.capture(game, snapshot);
  assert.equal(JSON.stringify(game), post, 'capture does not mutate engine');
};
const expected = (enemy: Enemy, distance: number) => paperEnemyWalkPhaseDelta(enemy.id, enemy.speed, distance)! % (Math.PI * 2);
{
  const f = fixture(), x = f.enemy.pos.x, y = f.enemy.pos.y;
  f.enemy.path = [{ x, y }, { x: x + 28, y }, { x: x + 28, y }, { x: x + 28, y: y + 28 }, { x: x + 56, y: y + 28 }];
  const phase = f.clock.phase(f.enemy)!; step(f, 2);
  near(increment(phase, f.clock.phase(f.enemy)!), expected(f.enemy, 56));
  assert.ok(Math.hypot(f.enemy.pos.x - x, f.enemy.pos.y - y) < 56, 'L-route is not endpoint chord');
  assert.equal(f.clock.diagnostics.segmentVisits, 4);
}
{
  const f = fixture(), base = f.clock.phase(f.enemy)!;
  step(f, .05); near(increment(base, f.clock.phase(f.enemy)!), expected(f.enemy, 1.4));
  const phase = f.clock.phase(f.enemy)!;
  f.enemy.slowUntil = 10; f.enemy.slowFactor = 2;
  near(f.clock.phase(f.enemy)!, phase); step(f, .05);
  near(increment(phase, f.clock.phase(f.enemy)!), expected(f.enemy, .7));
  const support: Enemy = { ...f.enemy, uid: 'aura', id: 'support', pos: { ...f.enemy.pos }, path: f.enemy.path, speed: 0 };
  f.game.enemies.push(support);
  const slow = f.clock.phase(f.enemy)!; step(f, .05);
  near(increment(slow, f.clock.phase(f.enemy)!), expected(f.enemy, .84));
  f.enemy.slowUntil = f.game.time; support.hp = 0;
  const restored = f.clock.phase(f.enemy)!; step(f, .05);
  near(increment(restored, f.clock.phase(f.enemy)!), expected(f.enemy, 1.4));
  assert.equal(f.clock.phase(support), undefined, 'dead cleanup');
}
{
  const f = fixture(); assert.ok(placeTower(f.game, 'glueGun', { x: 4, y: 2 }));
  const tower = f.game.towers[0]; tower.cooldown = 100;
  f.enemy.speed = 0;
  launchGlue(f.game, tower, { ...f.enemy.pos }, 2, 10);
  for (let i = 0; i < 30 && !f.game.gluePatches.length; i++) step(f, .05);
  assert.ok(f.game.gluePatches.length > 0, 'actual launched glue created authoritative patch');
  for (let i = 0; i < 5 && !f.game.gluePatches.some(p => p.enemyUids.includes(f.enemy.uid)); i++) step(f, .05);
  assert.ok(f.game.gluePatches.some(p => p.enemyUids.includes(f.enemy.uid)), 'actual patch membership refresh');
  f.enemy.speed = 28; const phase = f.clock.phase(f.enemy)!; const pos = { ...f.enemy.pos };
  step(f, .05);
  const moved = Math.hypot(f.enemy.pos.x - pos.x, f.enemy.pos.y - pos.y);
  assert.ok(moved < 1.4 && moved > 0, 'actual patch slows authoritative movement');
  near(increment(phase, f.clock.phase(f.enemy)!), expected(f.enemy, moved));
}
{
  const f = fixture(true), phase = f.clock.phase(f.enemy)!;
  f.enemy.speedEffects = [{ uid: 'stun', kind: 'laserStun', sourceTowerUid: 'laser', startedAt: 0, expiresAt: .1, multiplier: .05 }];
  const pos = { ...f.enemy.pos }; step(f, .05);
  assert.ok(Math.hypot(f.enemy.pos.x - pos.x, f.enemy.pos.y - pos.y) > 0, 'engine stun remains residual movement');
  near(f.clock.phase(f.enemy)!, phase); assert.equal(f.clock.diagnostics.stunSkipped, 1);
  step(f, .05); near(increment(phase, f.clock.phase(f.enemy)!), expected(f.enemy, 1.4));
  f.enemy.stunUntil = f.game.time + .1;
  const legacy = f.clock.phase(f.enemy)!; step(f, .05); near(f.clock.phase(f.enemy)!, legacy);
  step(f, .05); near(increment(legacy, f.clock.phase(f.enemy)!), expected(f.enemy, 1.4));
  f.game.paused = true; const before = JSON.stringify(f.game), paused = f.clock.phase(f.enemy)!;
  step(f, 1); near(f.clock.phase(f.enemy)!, paused); assert.equal(JSON.stringify(f.game), before);
}
for (const flyer of [false, true]) {
  const f = fixture(flyer); assert.ok(placeTower(f.game, 'teleporter', { x: 5, y: 2 }));
  f.game.towers[0].targetRefreshRemaining = 0;
  if (!flyer) {
    f.enemy.pos = cellToWorld({ x: 5, y: 1 });
    const { x, y } = f.enemy.pos;
    f.enemy.path = [{ x, y: y - 7 }, { x, y }, { x, y: y + 300 }]; f.enemy.pathIdx = 1; f.enemy.pathProgress = 1;
  }
  const phase = f.clock.phase(f.enemy)!; step(f, .05);
  assert.equal(f.game.teleports.length, 1, 'actual teleporter started after normal movement');
  near(increment(phase, f.clock.phase(f.enemy)!), expected(f.enemy, 1.4));
  if (!flyer) assert.ok(Math.hypot(f.game.teleports[0].from.x - f.game.teleports[0].destination.x,
    f.game.teleports[0].from.y - f.game.teleports[0].destination.y) < CELL_PX, 'actual short teleport, not distance threshold');
  const frozen = f.clock.phase(f.enemy)!;
  for (let i = 0; i < 20; i++) { step(f, .05); near(f.clock.phase(f.enemy)!, frozen); }
  assert.equal(f.game.teleports.length, 0); assert.equal(f.enemy.wasTeleported, true);
  step(f, .05); assert.notEqual(f.clock.phase(f.enemy), frozen, 'wasTeleported marker never freezes future gait');
}
{
  const f = fixture(); step(f, .2);
  const phase = f.clock.phase(f.enemy)!, oldPath = f.enemy.path;
  assert.ok(placeTower(f.game, 'canon', { x: 6, y: 4 })); f.game.towers[0].cooldown = 100;
  assert.notEqual(f.enemy.path, oldPath, 'actual placeTower rerouted');
  near(f.clock.phase(f.enemy)!, phase); step(f, .05);
  near(increment(phase, f.clock.phase(f.enemy)!), expected(f.enemy, 1.4),);
  const snapshot = f.clock.snapshot(f.game); f.enemy.path = f.enemy.path!.map(p => ({ ...p })); tick(f.game, .05);
  const unchanged = f.clock.phase(f.enemy)!; f.clock.capture(f.game, snapshot);
  near(f.clock.phase(f.enemy)!, unchanged); assert.equal(f.clock.diagnostics.unresolved, 1, 'midtick route change reanchors without bogus distance');
  const restored = JSON.parse(JSON.stringify(f.game)) as BattleState;
  f.clock.sync(restored); const e = restored.enemies[0], seeded = f.clock.phase(e)!;
  near(seeded, [...e.uid].reduce((n, c) => n + c.charCodeAt(0), 0) % (Math.PI * 2));
  near(f.clock.phase(f.enemy)!, seeded,);
  const s = f.clock.snapshot(restored); tick(restored, .05); f.clock.capture(restored, s);
  near(increment(seeded, f.clock.phase(e)!), expected(e, 1.4));
}
{
  const f = fixture(), pos = { ...f.enemy.pos }, phase = f.clock.phase(f.enemy)!;
  f.enemy.path = Array.from({ length: 100 }, () => ({ ...pos })).concat([{ x: pos.x, y: pos.y + 100 }]);
  step(f, .05); near(f.clock.phase(f.enemy)!, phase);
  assert.equal(f.clock.diagnostics.unresolved, 1); assert.equal(f.clock.diagnostics.segmentVisits, 0);
  assert.equal(f.game.enemies.length, 1); assert.equal(PAPER_WALK_SEGMENT_CAP, 64);
  const enemies = Array.from({ length: 2050 }, (_, i) => ({ ...f.enemy, uid: `cap${i}` }));
  f.game.enemies = enemies; f.clock.sync(f.game);
  assert.equal(f.clock.size, PAPER_WALK_ENTRY_CAP); assert.equal(f.clock.diagnostics.overflow, 2);
  const overflowPhase = f.clock.phase(enemies[2049])!;
  assert.equal(f.game.enemies.length, 2050);
  f.game.time += 100; f.clock.sync(f.game);
  near(f.clock.phase(enemies[2049])!, overflowPhase,);
  const overflowEnemy = enemies[2049]; f.game.enemies = [overflowEnemy]; f.clock.sync(f.game);
  near(f.clock.phase(overflowEnemy)!, overflowPhase,);
  assert.equal(f.game.enemies.length, 1);
  const baseline = f.clock.phase(overflowEnemy)!;
  const snap = f.clock.snapshot(f.game); tick(f.game, .05); f.clock.capture(f.game, snap);
  near(increment(baseline, f.clock.phase(overflowEnemy)!), expected(overflowEnemy, 1.4));
}
{
  const f = fixture(); step(f, .1); const phase = f.clock.phase(f.enemy)!;
  const shot = f.clock.snapshot(f.game); f.enemy.pos.x += 10; tick(f.game, .05); f.clock.capture(f.game, shot);
  near(increment(phase, f.clock.phase(f.enemy)!), expected(f.enemy, 1.4));
  assert.equal(f.clock.diagnostics.unresolved, 0, 'engine corrected external position; only actual cursor movement counted');
  const snap = f.clock.snapshot(f.game); tick(f.game, .05); f.enemy.pos.x += 1; const before = f.clock.phase(f.enemy)!;
  f.clock.capture(f.game, snap); near(f.clock.phase(f.enemy)!, before); assert.equal(f.clock.diagnostics.unresolved, 1);
  f.game.time = -1; f.clock.sync(f.game);
  near(f.clock.phase(f.enemy)!, [...f.enemy.uid].reduce((n, c) => n + c.charCodeAt(0), 0) % (Math.PI * 2));
  const invalid = f.clock.snapshot(f.game); f.game.time = NaN; f.clock.capture(f.game, invalid);
  assert.ok(Number.isFinite(f.clock.phase(f.enemy)));
}
{
  const source = readFileSync('src/game/Game.tsx', 'utf8');
  const start = source.indexOf('        for (let i = 0; i < enginePlan.steps');
  const end = source.indexOf('        hadLeakRef.current', start);
  assert.ok(start > 0 && end > start);
  const execute = new Function('gs', 'enginePlan', 'wasActive', 'paperWalkClockRef', 'tick', 'capturePaperLaserOriginals', 'laserOriginalPoints',
    'runHasVictory', 'run', 'clockStartedRef', ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText);
  const batch = fixture(), single = fixture();
  const a = batch.clock.phase(batch.enemy)!, b = single.clock.phase(single.enemy)!;
  let captures = 0;
  execute(batch.game, { steps: 4, dt: .05 }, false, { current: batch.clock }, tick, () => { captures++; }, { current: new Map() },
    () => false, { config: { mode: 'waves', waveLimit: 100, durationMinutes: 10 } }, { current: true });
  for (let i = 0; i < 4; i++) step(single, .05);
  assert.equal(captures, 4); near(increment(a, batch.clock.phase(batch.enemy)!), increment(b, single.clock.phase(single.enemy)!));
  near(batch.enemy.pos.y, single.enemy.pos.y);
}
console.log('Paper walk clock PASS: actual engine L-route/zero segments, glue/aura/stun expiry, short/flyer teleport, reroute/restore, bounded fallback and executable Game4substeps');
