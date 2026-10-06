import { strict as assert } from 'node:assert';
import { createGame, placeTower, tick, worldToCell } from './engine';
import { CELL_PX, ENEMIES, TOWERS, TOWER_ORDER } from './data';
import { findPath } from './pathfinding';
import type { BattleState, Enemy, EnemyId, Vec2 } from './types';

const DURATION = 120;
const DT = 0.05;
const MOB_IDS = Object.keys(ENEMIES) as EnemyId[];
const RANDOM = Math.random;
const originalData = JSON.stringify({ TOWERS, ENEMIES });
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
function finite(...values: number[]) { assert.ok(values.every(Number.isFinite), 'non-finite model value'); }
function point(point: Vec2, state: BattleState) {
  finite(point.x, point.y);
  assert.ok(point.x >= 0 && point.x < state.gridW * CELL_PX);
  assert.ok(point.y >= 0 && point.y < state.gridH * CELL_PX);
}

// Observe native pushes, including enemies born and killed within a single tick.
function observeSpawns(state: BattleState, onSpawn: (enemy: Enemy) => void) {
  const wrap = (array: Enemy[]) => new Proxy(array, {
    get(target, property, receiver) {
      if (property === 'push') return (...enemies: Enemy[]) => {
        enemies.forEach(onSpawn);
        return target.push(...enemies);
      };
      return Reflect.get(target, property, receiver);
    },
  });
  let enemies = wrap(state.enemies);
  Object.defineProperty(state, 'enemies', { configurable: true,
    get: () => enemies, set: (next: Enemy[]) => { enemies = wrap(next); } });
}

function auditModels(state: BattleState) {
  finite(state.time, state.gold, state.creditsEarned, state.lives);
  assert.ok(state.enemies.length <= 156, 'unbounded enemies');
  assert.ok(state.spawnQueue.length <= 132, 'unbounded spawn queue');
  assert.ok(state.projectiles.length <= 200, 'unbounded projectiles');
  assert.ok(state.effects.length <= 1000, 'unbounded effects');
  assert.ok(state.particles.length <= 200, 'unbounded particles');
  assert.ok(state.soundQueue.length <= 32, 'unbounded sound queue');
  const uids = [...state.enemies, ...state.towers, ...state.projectiles, ...state.effects].map(item => item.uid);
  assert.equal(new Set(uids).size, uids.length, 'duplicate model uid');
  for (const enemy of state.enemies) {
    point(enemy.pos, state);
    finite(enemy.hp, enemy.maxHp, enemy.speed, enemy.visualScale!, enemy.paletteVariant!);
    assert.ok(enemy.hp > 0 && enemy.hp <= enemy.maxHp && enemy.speed > 0);
    assert.ok(enemy.visualScale! >= 0.6 && enemy.visualScale! <= 1.35);
    assert.ok(Number.isInteger(enemy.paletteVariant) && enemy.paletteVariant! >= 0 && enemy.paletteVariant! <= 3);
    assert.equal(enemy.waveIndex, 29);
    if (enemy.flyProgress !== undefined) {
      finite(enemy.flyProgress);
      assert.ok(enemy.flyProgress >= 0 && enemy.flyProgress < 1);
      assert.equal(enemy.path, undefined);
    } else {
      assert.ok(enemy.path && enemy.path.length >= 2 && enemy.path.length <= state.gridW * state.gridH);
      assert.ok(Number.isInteger(enemy.pathIdx) && enemy.pathIdx! >= 1 && enemy.pathIdx! < enemy.path!.length);
      finite(enemy.pathProgress!);
      assert.ok(enemy.pathProgress! >= 0 && enemy.pathProgress! <= 1);
      const from = enemy.path![enemy.pathIdx! - 1];
      const to = enemy.path![enemy.pathIdx!];
      if (enemy.teleportingUntil === undefined) {
        near(enemy.pos.x, from.x + (to.x - from.x) * enemy.pathProgress!);
        near(enemy.pos.y, from.y + (to.y - from.y) * enemy.pathProgress!);
      } else {
        const phase = state.teleports.find(item => item.targetUid === enemy.uid);
        assert.ok(phase, 'off-route pull has no authoritative teleport phase');
        const progress = (state.time - phase.startedAt) / (phase.expiresAt - phase.startedAt);
        near(enemy.pos.x, phase.from.x + (phase.to.x - phase.from.x) * progress);
        near(enemy.pos.y, phase.from.y + (phase.to.y - phase.from.y) * progress);
      }
      for (const waypoint of enemy.path!) {
        point(waypoint, state);
        const cell = worldToCell(waypoint);
        assert.equal(state.grid[cell.y][cell.x], false, 'path traverses blocked cell');
      }
    }
  }
  for (const projectile of state.projectiles) {
    point(projectile.from, state);
    point(projectile.to, state);
    finite(projectile.progress, projectile.speed, projectile.life, projectile.damage);
    assert.ok(projectile.progress >= 0 && projectile.progress <= 1 && projectile.life > 0);
    assert.ok(state.towers.some(tower => tower.uid === projectile.sourceTowerUid));
  }
  for (const effect of state.effects) {
    point({ x: effect.x, y: effect.y }, state);
    finite(effect.life, effect.maxLife);
    assert.ok(effect.life > 0 && effect.life <= effect.maxLife);
    if (effect.pts) for (const position of effect.pts) finite(position.x, position.y);
    if (effect.kind !== 'heal') assert.ok(state.towers.some(tower => tower.uid === effect.sourceTowerUid));
  }
  for (const particle of state.particles) finite(particle.x, particle.y, particle.vx, particle.vy, particle.life, particle.r);
}

Math.random = () => 0.5;
try {
  const state = createGame();
  state.gold = 1e9;
  state.lives = 1000;
  state.creditsEarned = 150000;
  let towerIndex = 0;
  for (const y of [3, 6, 9, 12, 15]) for (const x of [2, 4, 8, 10]) {
    assert.ok(placeTower(state, TOWER_ORDER[towerIndex++ % TOWER_ORDER.length], { x, y }), `layout blocked ${x},${y}`);
  }
  assert.equal(state.towers.length, 20);
  assert.equal(new Set(state.towers.map(tower => tower.towerId)).size, 12);
  // Fixed terrain walls force a serpentine route past both sides of the tower layout.
  for (const [index, y] of [4, 7, 10, 13, 16, 19].entries()) {
    const gap = index % 2 === 0 ? 3 : 9;
    for (let x = 0; x < state.gridW; x++) state.grid[y][x] = x !== gap;
  }
  state.currentPath = findPath(state.grid, state.entry, state.exit);
  assert.ok(state.currentPath && state.currentPath.length > state.gridH, 'maze has no genuine routed detour');
  state.waveIndex = 29;
  state.pendingWaveIndices = [29];
  state.waveActive = true;
  state.isBossWave = true;
  state.spawning = true;
  state.spawnQueue = MOB_IDS.flatMap((id, typeIndex) => Array.from({ length: 12 }, (_, index) => ({
    id, delay: typeIndex * 0.25 + index * 0.65, waveIndex: 29,
    healthModifier: 20000, reward: ENEMIES[id].reward,
  }))).sort((a, b) => a.delay - b.delay);
  assert.equal(state.spawnQueue.length, 132);
  state.soundQueue = [];
  const spawned = new Map<string, Enemy>();
  const primaryCounts = new Map<EnemyId, number>();
  let bornThisTick: Enemy[] = [];
  observeSpawns(state, enemy => {
    assert.ok(!spawned.has(enemy.uid), 'duplicate spawn');
    spawned.set(enemy.uid, enemy);
    bornThisTick.push(enemy);
    // One low-HP splitter fixture exercises real damage/death even alongside healers.
    if (enemy.id === 'splitter' && !primaryCounts.has('splitter')) enemy.hp = enemy.maxHp = 1;
    if (enemy.rewardOverride === undefined) primaryCounts.set(enemy.id, (primaryCounts.get(enemy.id) ?? 0) + 1);
  });
  let payout = 0;
  let splits = 0;
  let children = 0;
  let moved = 0;
  let teleports = 0;
  const activatedTowerTypes = new Set<string>();
  const peaks = { enemies: 0, projectiles: 0, effects: 0, particles: 0 };
  for (let step = 0; step < DURATION / DT; step++) {
    bornThisTick = [];
    const previous = state.enemies.map(enemy => ({ enemy, pos: { ...enemy.pos } }));
    const beforeGold = state.gold;
    const beforeCredits = state.creditsEarned;
    const beforeLives = state.lives;
    const previousEffectUids = new Set(state.effects.map(effect => effect.uid));
    const previousTeleportTargets = new Set(state.teleports.map(phase => phase.targetUid));
    tick(state, DT);
    assert.equal(state.gameOver, false, 'test fixture ended before 120 seconds');
    const survivors = new Set(state.enemies.map(enemy => enemy.uid));
    const removed = [...previous.map(item => item.enemy), ...bornThisTick].filter(enemy => !survivors.has(enemy.uid));
    const killed = removed.filter(enemy => enemy.hp <= 0);
    const expectedReward = killed.reduce((sum, enemy) => sum + (enemy.rewardOverride ?? ENEMIES[enemy.id].reward), 0);
    near(state.gold - beforeGold, expectedReward);
    near(state.creditsEarned - beforeCredits, expectedReward);
    near(beforeLives - state.lives, removed.filter(enemy => enemy.hp > 0).length);
    payout += expectedReward;
    const deadSplitters = killed.filter(enemy => ENEMIES[enemy.id].splitInto && enemy.rewardOverride === undefined);
    const newbornChildren = bornThisTick.filter(enemy => enemy.rewardOverride !== undefined);
    assert.equal(newbornChildren.length, deadSplitters.length * 2, 'split count mismatch');
    deadSplitters.forEach((parent, index) => {
      const offspring = newbornChildren.slice(index * 2, index * 2 + 2);
      for (const child of offspring) {
        assert.equal(child.id, 'swarm');
        assert.equal(child.rewardOverride, 0);
        assert.equal(child.waveIndex, parent.waveIndex);
        assert.deepEqual(child.pos, parent.pos, 'child jumped at birth');
        assert.deepEqual(child.path, parent.path);
        assert.equal(child.pathIdx, parent.pathIdx);
        assert.equal(child.pathProgress, parent.pathProgress);
      }
    });
    splits += deadSplitters.length;
    children += newbornChildren.length;
    const teleportEffects = state.effects.filter(effect => effect.kind === 'teleport' && !previousEffectUids.has(effect.uid));
    teleports += teleportEffects.length;
    for (const { enemy, pos } of previous) {
      if (!survivors.has(enemy.uid)) continue;
      const movement = distance(pos, enemy.pos);
      const limit = enemy.speed * 1.2 * DT + 1e-7;
      const intentional = previousTeleportTargets.has(enemy.uid) || state.teleports.some(phase => phase.targetUid === enemy.uid)
        || teleportEffects.some(effect => distance(enemy.pos, effect) < 1e-7
        && state.towers.some(tower => tower.uid === effect.sourceTowerUid
          && distance(pos, { x: tower.worldX, y: tower.worldY }) <= TOWERS.teleporter.range * CELL_PX + limit));
      assert.ok(movement <= limit || intentional, `unintentional jump ${enemy.id}:${enemy.uid}`);
      assert.ok(movement > 1e-10 || intentional, `path lock ${enemy.id}:${enemy.uid}`);
      if (movement > 1e-10) moved++;
    }
    if (step % 20 === 0) for (const enemy of state.enemies) {
      if (enemy.flyProgress === undefined) assert.ok(findPath(state.grid, worldToCell(enemy.pos), state.exit), 'active mob has no exit route');
    }
    auditModels(state);
    for (const visual of [...state.projectiles, ...state.effects]) {
      const source = state.towers.find(tower => tower.uid === visual.sourceTowerUid);
      if (source) activatedTowerTypes.add(source.towerId);
    }
    for (const key of Object.keys(peaks) as (keyof typeof peaks)[]) peaks[key] = Math.max(peaks[key], state[key].length);
    state.soundQueue = [];
  }
  near(state.time, DURATION);
  assert.equal(state.spawnQueue.length, 0);
  for (const id of MOB_IDS) assert.equal(primaryCounts.get(id), 12, `${id} never fully activated`);
  for (const id of TOWER_ORDER) assert.ok(activatedTowerTypes.has(id), `${id} emitted no attack/pulse model`);
  assert.ok(moved > 0 && teleports > 0 && splits > 0, 'movement/teleport/split audits were vacuous');
  assert.equal(children, splits * 2);
  assert.ok(payout <= 12 * MOB_IDS.reduce((sum, id) => sum + ENEMIES[id].reward, 0), 'unbounded split payout');
  assert.equal(JSON.stringify({ TOWERS, ENEMIES }), originalData, 'fixture mutated production tuning');
  console.log('HEADLESS dense battle PASS: 120s, 20 towers, 12 tower types, 11 mob types × 12; not a visual audit');
  console.log(JSON.stringify({ seed: 0.5, stepSeconds: DT, lowHpSplitterFixture: true,
    moved, teleports, splits, children, payout, peaks, remaining: state.enemies.length }));
} finally {
  Math.random = RANDOM;
}
