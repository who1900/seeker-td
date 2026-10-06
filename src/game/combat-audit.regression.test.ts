import { createGame, placeTower, sellTower, enhanceTower, getEnhanceCost, setTargeting,
  setTargetLock, tick, cellToWorld, worldToCell, towerStats } from './engine';
import { CELL_PX, ENEMIES, TOWERS } from './data';
import { determineGlueTargets } from './combatStatus';
import type { BattleState, Enemy, EnemyId, Vec2 } from './types';

let cases = 0;
const failures: string[] = [];
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function near(actual: number, expected: number, message: string) {
  check(Math.abs(actual - expected) < 1e-7, `${message}: ${actual} != ${expected}`);
}
function samePosition(a: Vec2, b: Vec2, message: string) {
  near(a.x, b.x, `${message} x`);
  near(a.y, b.y, `${message} y`);
}
function distance(a: Vec2, b: Vec2) { return Math.hypot(a.x - b.x, a.y - b.y); }
function test(name: string, body: () => void) {
  cases++;
  try { body(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : error}`); }
}
function ground(state: BattleState, id: EnemyId = 'soldier', index = 1, progress = 0): Enemy {
  const path = state.currentPath!.map(cellToWorld);
  const from = path[index - 1], to = path[index];
  const enemy: Enemy = { uid: `audit-${state.uidCounter++}`, id, hp: 1e8, maxHp: 1e8,
    speed: ENEMIES[id].speed * CELL_PX,
    pos: { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress },
    path, pathIdx: index, pathProgress: progress, waveIndex: 0, healthModifier: 1 };
  state.enemies.push(enemy);
  return enemy;
}
function remaining(enemy: Enemy): number {
  const path = enemy.path!;
  let result = distance(enemy.pos, path[enemy.pathIdx!]);
  for (let i = enemy.pathIdx! + 1; i < path.length; i++) result += distance(path[i - 1], path[i]);
  return result;
}
function validFuture(state: BattleState, enemy: Enemy) {
  const path = enemy.path!;
  for (let i = enemy.pathIdx!; i < path.length; i++) {
    const a = worldToCell(path[i - 1]), b = worldToCell(path[i]);
    check(!state.grid[b.y][b.x], 'route enters tower cell');
    check(Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1, 'route skips grid cells');
    if (a.x !== b.x && a.y !== b.y) {
      check(!state.grid[a.y][b.x] && !state.grid[b.y][a.x], 'route cuts blocked diagonal corner');
    }
  }
  samePosition(path[path.length - 1], cellToWorld(state.exit), 'route exit');
}

for (const cycles of [100, 1000]) test(`F01: ${cycles} free off-route build/sell cycles equal control`, () => {
  const state = createGame(), control = createGame();
  const enemy = ground(state), baseline = ground(control);
  for (let i = 0; i < 28; i++) { tick(state, .05); tick(control, .05); }
  const dt = cycles === 100 ? .025 : .0025;
  let maxPath = enemy.path!.length;
  for (let i = 0; i < cycles; i++) {
    const before = { ...enemy.pos }, progress = enemy.pathProgress;
    check(placeTower(state, 'canon', { x: 0, y: 19 }), 'off-route placement rejected');
    samePosition(enemy.pos, before, 'build position');
    near(enemy.pathProgress!, progress!, 'build segment progress');
    state.towers[0].cooldown = 1e6;
    tick(state, dt); tick(control, dt);
    samePosition(enemy.pos, baseline.pos, 'post-build control progress');
    const beforeSell = { ...enemy.pos };
    sellTower(state, state.towers[0].uid);
    samePosition(enemy.pos, beforeSell, 'sell position');
    tick(state, dt); tick(control, dt);
    samePosition(enemy.pos, baseline.pos, 'post-sell control progress');
    maxPath = Math.max(maxPath, enemy.path!.length);
    check(state.gold === 500, 'build/sell not free');
    check(state.enemies.includes(enemy), 'fixture leaked before all cycles');
  }
  check(maxPath <= 2 * state.gridW * state.gridH, `unbounded path history: ${maxPath}`);
  check(enemy.pos.y > 6 * CELL_PX, 'zero-cost movement stall');
});

test('F01: oversized traveled history is bounded without shortening maximum teleport rewind', () => {
  const state = createGame(3, 5);
  const enemy = ground(state, 'soldier', 1, .25);
  const loop = [{ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }].map(cellToWorld);
  const history = Array.from({ length: 100 }, () => loop).flat();
  enemy.path = [...history, ...enemy.path!];
  enemy.pathIdx = history.length + 1;
  const before = { ...enemy.pos }, next = { ...enemy.path[enemy.pathIdx] };
  const maxRewind = Math.max(...Object.values(TOWERS).map(spec =>
    (spec.teleportBack ?? 0) + (spec.teleportPerLevel ?? 0) * (spec.maxLevel - 1))) * CELL_PX;
  check(placeTower(state, 'canon', { x: 2, y: 3 }), 'history fixture build');
  state.towers[0].cooldown = 1e6;
  const historyLimit = Math.max(state.gridW * state.gridH, 1 + Math.ceil(maxRewind / CELL_PX));
  check(enemy.path.length <= historyLimit + state.gridW * state.gridH, 'old history was not pruned');
  samePosition(enemy.pos, before, 'pruned position');
  samePosition(enemy.path[enemy.pathIdx], next, 'pruned forward anchor');
  near(enemy.pathProgress!, .25, 'pruned segment progress');
  let retainedDistance = distance(enemy.path[enemy.pathIdx - 1], enemy.pos);
  for (let i = 1; i < enemy.pathIdx; i++) retainedDistance += distance(enemy.path[i - 1], enemy.path[i]);
  check(retainedDistance >= maxRewind, 'history cap nerfed maximum teleport distance');
  tick(state, .05);
  near(enemy.pos.y, before.y + enemy.speed * .05, 'pruned route movement');
  sellTower(state, state.towers[0].uid);
  validFuture(state, enemy);
});

test('F01: actual route block preserves transit, reroutes safely and selling restores shortcut', () => {
  const state = createGame();
  const enemy = ground(state, 'soldier', 2, .4);
  const from = { ...enemy.path![1] }, next = { ...enemy.path![2] };
  const before = { ...enemy.pos }, oldRemaining = remaining(enemy);
  check(placeTower(state, 'canon', { x: state.entry.x, y: 5 }), 'route block rejected');
  state.towers[0].cooldown = 1e6;
  samePosition(enemy.pos, before, 'reroute birth position');
  samePosition(enemy.path![enemy.pathIdx! - 1], from, 'reroute segment start');
  samePosition(enemy.path![enemy.pathIdx!], next, 'reroute forward anchor');
  near(enemy.pathProgress!, .4, 'reroute progress');
  check(remaining(enemy) > oldRemaining, 'blocking route did not cause detour');
  validFuture(state, enemy);
  tick(state, .05);
  near(enemy.pos.y, before.y + enemy.speed * .05, 'reroute went backward');
  const detourRemaining = remaining(enemy);
  sellTower(state, state.towers[0].uid);
  check(remaining(enemy) < detourRemaining, 'selling failed to restore shortcut');
  validFuture(state, enemy);
  check(placeTower(state, 'canon', { x: state.entry.x, y: 5 }), 'second actual block rejected');
  state.towers[0].cooldown = 1e6;
  for (let i = 0; i < 500 && state.enemies.includes(enemy); i++) {
    const prior = { ...enemy.pos };
    tick(state, .05);
    if (state.enemies.includes(enemy)) {
      check(distance(prior, enemy.pos) <= enemy.speed * .05 + 1e-7, 'rerouting jumped');
      validFuture(state, enemy);
    }
  }
  check(!state.enemies.includes(enemy) && state.lives === 19, 'rerouted mob did not exit once');
});

test('F01: diagonal transit remains forward after build/sell and corner cells stay reserved', () => {
  const state = createGame();
  state.gold = 1e5;
  check(placeTower(state, 'canon', { x: state.entry.x, y: 5 }), 'diagonal fixture block');
  const path = state.currentPath!;
  const index = path.findIndex((p, i) => i > 0 && p.x !== path[i - 1].x && p.y !== path[i - 1].y);
  check(index > 0, 'missing diagonal in actual A* route');
  const enemy = ground(state, 'soldier', index, .2);
  state.towers.forEach(tower => { tower.cooldown = 1e6; });
  const from = path[index - 1], to = path[index], before = { ...enemy.pos };
  check(!placeTower(state, 'canon', { x: to.x, y: from.y }), 'diagonal corner placement accepted');
  check(placeTower(state, 'canon', { x: 0, y: 19 }), 'diagonal off-route placement');
  tick(state, .01);
  const length = distance(cellToWorld(from), cellToWorld(to));
  near(enemy.pos.x, before.x + (to.x - from.x) * CELL_PX * enemy.speed * .01 / length, 'diagonal x');
  near(enemy.pos.y, before.y + (to.y - from.y) * CELL_PX * enemy.speed * .01 / length, 'diagonal y');
  sellTower(state, state.towers[state.towers.length - 1].uid);
  validFuture(state, enemy);
});

function mixed(rerouted = false) {
  const state = createGame();
  state.gold = 1e6;
  check(placeTower(state, 'canon', { x: 5, y: 10 }), 'targeting fixture tower');
  const tower = state.towers[0];
  tower.cooldown = 1e6;
  setTargetLock(state, tower.uid, false);
  const soldier = ground(state, 'soldier', 11, 0);
  soldier.speed = 0;
  const entry = cellToWorld(state.entry), exit = cellToWorld(state.exit);
  const flyer: Enemy = { uid: `audit-${state.uidCounter++}`, id: 'flyer', hp: 1e8, maxHp: 1e8,
    speed: 0, flyProgress: .45, pos: { x: entry.x, y: entry.y + (exit.y - entry.y) * .45 } };
  state.enemies.push(flyer);
  if (rerouted) {
    check(placeTower(state, 'canon', { x: 6, y: 13 }), 'targeting real route block');
    state.towers[1].cooldown = 1e6;
    validFuture(state, soldier);
  }
  return { state, tower, soldier, flyer, flightLength: distance(entry, exit) };
}
for (const rerouted of [false, true]) test(`F03: mixed First/Last use remaining pixels, rerouted=${rerouted}`, () => {
  const { state, tower, soldier, flyer, flightLength } = mixed(rerouted);
  check(remaining(soldier) < (1 - flyer.flyProgress!) * flightLength, 'nearer ground fixture');
  setTargeting(state, tower.uid, 'first'); tick(state, .1);
  check(tower.targetUid === soldier.uid, 'First chose farther flyer');
  setTargeting(state, tower.uid, 'last'); tick(state, .1);
  check(tower.targetUid === flyer.uid, 'Last chose nearer ground');
  flyer.flyProgress = .6;
  setTargeting(state, tower.uid, 'first'); tick(state, .1);
  check(tower.targetUid === flyer.uid, 'First failed to choose nearer flyer');
  setTargeting(state, tower.uid, 'last'); tick(state, .1);
  check(tower.targetUid === soldier.uid, 'Last failed to choose farther ground');
});

test('F03: equal remaining distance has stable UID tie-break independent of candidate order', () => {
  const { state, tower, soldier, flyer } = mixed();
  flyer.flyProgress = .5;
  near(remaining(soldier), 10 * CELL_PX, 'tie fixture ground');
  const expected = [soldier.uid, flyer.uid].sort()[0];
  for (const mode of ['first', 'last'] as const) for (const reverse of [false, true]) {
    state.enemies = reverse ? [flyer, soldier] : [soldier, flyer];
    setTargeting(state, tower.uid, mode); tick(state, .1);
    check(tower.targetUid === expected, `${mode} tie changed with candidate order`);
  }
});

test('F04: paid Glue enhance immediately refreshes samples and pending volley coverage', () => {
  const state = createGame();
  state.gold = 10000;
  check(placeTower(state, 'glueTower', { x: 5, y: 10 }), 'glue fixture tower');
  const tower = state.towers[0];
  const oldTargets = JSON.stringify(tower.glueTargets), path = JSON.stringify(state.currentPath);
  const gold = state.gold, value = tower.value, cost = getEnhanceCost(tower);
  tower.glueReleaseAt = state.time;
  check(enhanceTower(state, tower.uid), 'glue enhancement rejected');
  check(state.gold === gold - cost && tower.value === value + cost && tower.level === 1, 'enhance accounting');
  check(JSON.stringify(state.currentPath) === path, 'enhance changed maze');
  const expected = determineGlueTargets(state, tower, towerStats(tower).range);
  check(JSON.stringify(expected) !== oldTargets, 'enhance fixture does not change samples');
  check(JSON.stringify(tower.glueTargets) === JSON.stringify(expected), 'enhanced cache is stale');
  tick(state, 0);
  check(state.glueShots.length === expected.length, 'pending volley used old coverage');
  state.glueShots.forEach((shot, i) => {
    samePosition(shot.to, expected[i], 'enhanced volley target');
    near(shot.intensity, towerStats(tower).slowFactor, 'enhanced glue strength');
  });
});

for (const phase of [0, .05, .5, .95]) for (const externalDeath of [false, true]) {
  test(`F05: splitter teleport phase=${phase}, externalDeath=${externalDeath}`, () => {
    const state = createGame();
    state.gold = 1e6;
    check(placeTower(state, 'teleporter', { x: 4, y: 10 }), 'teleport fixture tower');
    const parent = ground(state, 'splitter', 11, .5);
    parent.speed = 0;
    state.waveIndex = 0;
    state.waveActive = true;
    state.pendingWaveIndices = [0];
    tick(state, .1);
    check(state.teleports.length === 1 && parent.teleportingUntil !== undefined, 'parent not teleporting');
    if (phase) tick(state, phase);
    state.towers[0].cooldown = 1e6;
    const effect = state.teleports[0];
    const pullSpeed = distance(effect.from, effect.to) / (effect.expiresAt - effect.startedAt);
    if (externalDeath) {
      parent.hp = 0;
      tick(state, .001);
    } else {
      check(placeTower(state, 'simpleLaser', { x: 3, y: 10 }), 'lethal laser fixture');
      const laser = state.towers[state.towers.length - 1];
      laser.targetUid = parent.uid;
      parent.hp = 1;
      tick(state, 0);
      laser.cooldown = 1e6;
    }
    const children = state.enemies.filter(enemy => enemy.id === 'swarm');
    check(children.length === ENEMIES.splitter.splitCount && !state.enemies.includes(parent), 'split ownership/count');
    check(state.completedWaves === 0 && state.pendingWaveIndices.includes(0), 'wave cleared before children');
    for (const child of children) {
      samePosition(child.pos, parent.pos, 'child birth position');
      check(child.waveIndex === parent.waveIndex && child.rewardOverride === 0, 'child wave/reward ownership');
      check(child.teleportingUntil === effect.expiresAt, 'child lost active teleport phase');
      check(child.path !== parent.path, 'child route aliases parent');
      const inherited = state.teleports.find(teleport => teleport.targetUid === child.uid);
      check(inherited && inherited.uid !== effect.uid && inherited.sourceTowerUid === effect.sourceTowerUid,
        'child teleport ownership');
    }
    check(!state.teleports.some(teleport => teleport.targetUid === parent.uid), 'dead parent owns teleport');
    const before = children.map(child => ({ ...child.pos }));
    tick(state, .01);
    children.forEach((child, i) => {
      check(distance(child.pos, before[i]) <= pullSpeed * .01 + 1e-7, 'child jumped outside inherited pull speed');
      const progress = (state.time - effect.startedAt) / (effect.expiresAt - effect.startedAt);
      samePosition(child.pos, { x: effect.from.x + (effect.to.x - effect.from.x) * progress,
        y: effect.from.y + (effect.to.y - effect.from.y) * progress }, 'inherited phase interpolation');
    });
    check(placeTower(state, 'canon', { x: 0, y: 19 }), 'unrelated build during child teleport');
    sellTower(state, state.towers[state.towers.length - 1].uid);
    tick(state, effect.expiresAt - state.time + 1e-9);
    for (const child of children) {
      check(child.teleportingUntil === undefined && child.wasTeleported, 'child teleport did not complete');
      samePosition(child.pos, effect.destination, 'child authorized teleport destination');
      validFuture(state, child);
    }
    const landed = children.map(child => ({ ...child.pos }));
    tick(state, .05);
    children.forEach((child, i) => {
      near(distance(child.pos, landed[i]), child.speed * .05, 'child normal speed after teleport');
    });
    near(state.teleports.length, 0, 'child teleport leaked effects');
    for (let i = 0; i < 200 && state.enemies.length; i++) tick(state, .05);
    near(state.completedWaves, 1, 'child wave completion count');
    check(state.enemies.length === 0 && state.lives === 20 - children.length,
      'child route/wave did not finish exactly once');
  });
}

test('combat scope preserves all 12 towers and 11 mobs', () => {
  check(Object.keys(TOWERS).length === 12 && Object.keys(ENEMIES).length === 11, 'roster changed');
});

if (failures.length) throw new Error(failures.join('\n'));
console.log(`combat audit: ${cases} cases passed`);
