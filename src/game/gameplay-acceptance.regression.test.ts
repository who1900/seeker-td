import { createGame, startWave, tick, cellToWorld } from './engine';
import { CELL_PX, ENEMIES, TOWERS } from './data';
import type { Enemy, EnemyId, TowerId } from './types';

let assertions = 0;
let cases = 0;
const failures: string[] = [];
function check(value: unknown, message: string): void {
  assertions++;
  if (!value) throw new Error(message);
}
function test(name: string, body: () => void) {
  cases++;
  try { body(); } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function enemy(uid: string, x: number, y: number, spawnedAt?: number): Enemy {
  return {
    uid, id: 'soldier', hp: 1e9, maxHp: 1e9, speed: 0,
    pos: { x, y }, waveIndex: 0, spawnedAt,
    path: [{ x: x - CELL_PX, y }, { x, y }, { x: x + CELL_PX, y }],
    pathIdx: 1, pathProgress: 1,
  };
}
function fixture(id: TowerId) {
  const state = createGame();
  state.time = 10;
  const cell = { x: id === 'glueTower' ? 5 : 4, y: 5 };
  const pos = cellToWorld(cell);
  const tower = {
    uid: `tower-${id}`, towerId: id, cell, level: 0, value: 0,
    targetingMode: 'closest' as const, cooldown: 0, worldX: pos.x, worldY: pos.y,
  };
  state.towers.push(tower);
  if (id === 'rocketLauncher') {
    tick(state, 1);
    state.time = 10;
  }
  if (id === 'mineLayer') {
    state.time = 7;
    for (let i = 0; i < 192; i++) tick(state, 1 / 64);
    state.towers[0].cooldown = 100;
  }
  return { state, tower: state.towers[0], pos };
}
function advance(state: ReturnType<typeof createGame>, seconds: number) {
  for (let i = 0; i < seconds * 64; i++) tick(state, 1 / 64);
}
function resolveImpact(state: ReturnType<typeof createGame>, id: TowerId, fresh?: Enemy) {
  state.towers.forEach(tower => { tower.cooldown = 100; });
  if (TOWERS[id].damageType === 'Glue') {
    for (let i = 0; i < 64; i++) {
      if (fresh) fresh.spawnedAt = state.time;
      tick(state, 1 / 64);
    }
  } else if (id === 'teleporter') advance(state, 1);
  else if (id === 'mortar') {
    advance(state, 1.375);
    if (fresh) fresh.spawnedAt = state.time;
    advance(state, .125);
  } else if (id === 'rocketLauncher') {
    advance(state, .125);
    if (fresh) fresh.spawnedAt = state.time;
    advance(state, .75);
  } else if (id === 'mineLayer') advance(state, .125);
  else if (TOWERS[id].damageType === 'Bullet') advance(state, .5);
}
function position(state: ReturnType<typeof createGame>, id: TowerId, pos: { x: number; y: number }) {
  return id === 'mineLayer' ? state.mines.find(m => m.landed)!.pos
    : { x: pos.x + CELL_PX * (id === 'glueTower' ? 1 : 2), y: pos.y };
}
function unchanged(en: Enemy, x: number) {
  check(en.hp === 1e9, 'protected HP changed');
  check(!en.hitFlash && en.slowUntil === undefined, 'protected hit/slow applied');
  check(en.pos.x === x && en.pathIdx === 1 && en.pathProgress === 1,
    'protected enemy teleported');
}
function affected(id: TowerId, en: Enemy, x: number) {
  if (TOWERS[id].damageType === 'Glue') check((en.glueSpeedMultiplier ?? 1) < 1, 'eligible target not slowed');
  else if (id === 'teleporter') check(en.pos.x < x, 'eligible target not teleported');
  else check(en.hp < 1e9, 'eligible target not damaged');
}

test('default grace and provenance', () => {
  const state = createGame();
  check(state.spawnTargetGraceSeconds === 1, 'default grace must be 1 second');
  check(state.leakedWaveIndices.length === 0, 'initial leak provenance must be empty');
});

for (const id of Object.keys(TOWERS) as TowerId[]) {
  for (const mode of ['protected', 'boundary', 'legacy', 'zero'] as const) {
    test(`${id}: primary ${mode}`, () => {
      const { state, tower, pos } = fixture(id);
      if (mode === 'zero') state.spawnTargetGraceSeconds = 0;
      const targetPos = position(state, id, pos);
      const x = targetPos.x;
      const en = enemy('target', x, targetPos.y, mode === 'legacy' ? undefined : mode === 'boundary' ? 9 : 10);
      state.enemies = [en];
      tick(state, .125);
      if (id === 'glueTower' && mode !== 'protected') advance(state, .8125);
      if (mode === 'protected') {
        unchanged(en, x);
        if (id === 'mineLayer') {
          advance(state, .5);
          unchanged(en, x);
        } else check(tower.lastFireTime === undefined && state.shots.length === 0,
          'protected-only target fired');
      } else {
        if (id !== 'mineLayer') check(tower.lastFireTime !== undefined, 'eligible shot presentation absent');
        resolveImpact(state, id);
        affected(id, en, x);
      }
    });
  }
  test(`${id}: fresh beside eligible target`, () => {
    const { state, tower, pos } = fixture(id);
    const targetPos = position(state, id, pos);
    const freshX = targetPos.x;
    const fresh = enemy('fresh', freshX, targetPos.y, 10);
    const valid = enemy('valid', targetPos.x, targetPos.y, 8);
    state.enemies = [fresh, valid];
    tick(state, .125);
    if (id === 'glueTower') advance(state, .8125);
    if (id !== 'mineLayer') check(tower.lastFireTime !== undefined, 'valid target did not fire');
    resolveImpact(state, id, fresh);
    unchanged(fresh, freshX);
    affected(id, valid, targetPos.x);
  });
}

for (const id of ['bouncingLaser', 'straightLaser', 'mortar', 'mineLayer', 'rocketLauncher'] as TowerId[]) {
  test(`${id}: non-vacuous secondary protection`, () => {
    const { state, pos } = fixture(id);
    const targetPos = position(state, id, pos);
    const primary = enemy('primary', targetPos.x, targetPos.y, 8);
    const fresh = enemy('fresh-secondary', targetPos.x + CELL_PX * .25, targetPos.y, 10);
    const collateral = enemy('eligible-secondary', targetPos.x + CELL_PX * .5, targetPos.y, 8);
    state.enemies = [primary, fresh, collateral];
    tick(state, .125);
    resolveImpact(state, id, fresh);
    unchanged(fresh, targetPos.x + CELL_PX * .25);
    check(primary.hp < 1e9 && collateral.hp < 1e9, 'secondary branch not exercised');
  });
}

for (const id of Object.keys(ENEMIES) as EnemyId[]) {
  test(`${id}: ordinary spawn timestamp and paused clock`, () => {
    const state = createGame();
    state.time = 12.5;
    state.waveIndex = 0;
    state.waveActive = state.spawning = true;
    state.pendingWaveIndices = [0];
    state.spawnQueue = [{ id, delay: 0, waveIndex: 0 }];
    state.paused = true;
    tick(state, 50);
    check(state.time === 12.5 && state.enemies.length === 0 && state.spawnElapsed === 0,
      'pause advanced clock or spawned enemy');
    state.paused = false;
    tick(state, .25);
    check(state.enemies.length === 1 && state.enemies[0].spawnedAt === 12.75,
      'ordinary spawn timestamp is not current simulation time');
    const born = state.enemies[0].spawnedAt;
    state.paused = true;
    tick(state, 100);
    check(state.time === 12.75 && state.enemies[0].spawnedAt === born, 'paused grace aged');
  });
}

for (const born of [1, 10, undefined]) {
  test(`split children inherit timestamp ${String(born)} and old wave`, () => {
    const state = createGame();
    state.time = 10;
    state.waveIndex = 3;
    const parent = enemy('split-parent', 140, 140, born);
    parent.id = 'splitter';
    parent.hp = 0;
    parent.waveIndex = 1;
    state.enemies = [parent];
    tick(state, 0);
    check(state.enemies.length === ENEMIES.splitter.splitCount, 'split branch not exercised');
    for (const child of state.enemies) {
      check(child.spawnedAt === born, 'split child grace refreshed or lost');
      check(child.waveIndex === 1, 'split child attributed to latest wave');
    }
  });
}

function leak(uid: string, waveIndex?: number): Enemy {
  const en = enemy(uid, 140, 140, 1);
  en.waveIndex = waveIndex;
  en.pathIdx = en.path!.length;
  return en;
}
test('real overlapping starts retain queue provenance and prevent premature clear', () => {
  const state = createGame();
  startWave(state);
  advance(state, 5);
  const oldCount = state.spawnQueue.length;
  const oldLiveUids = state.enemies.map(en => en.uid);
  startWave(state);
  check(state.waveIndex === 1 && state.pendingWaveIndices.includes(0), 'overlap not started');
  check(state.spawnQueue.filter(en => en.waveIndex === 0).length === oldCount, 'old spawn queue lost');
  check(oldLiveUids.every(uid => state.enemies.some(en => en.uid === uid && en.waveIndex === 0)),
    'old live enemies lost on overlap');
  tick(state, 0);
  check(state.completedWaves === 0, 'queued old wave cleared early');
});
test('old-wave leaks deduplicate and persist across new starts and restored lives', () => {
  const state = createGame();
  startWave(state);
  advance(state, 5);
  startWave(state);
  state.enemies = [leak('old-a', 0), leak('old-b', 0)];
  const lives = state.lives;
  tick(state, 0);
  check(state.lives === lives - 2, 'leak fixture did not lose lives');
  check(state.leakedWaveIndices.length === 1 && state.leakedWaveIndices[0] === 0,
    'old leaks attributed to latest wave or duplicated');
  state.lives = lives;
  state.gameOver = false;
  advance(state, 5);
  startWave(state);
  check(state.leakedWaveIndices.length === 1 && state.leakedWaveIndices[0] === 0,
    'new start/restoration erased leak history');
});
test('simultaneous overlap leaks include both waves and legacy current-wave fallback', () => {
  const state = createGame();
  state.waveIndex = 4;
  state.enemies = [leak('old', 2), leak('latest', 4), leak('legacy')];
  tick(state, 0);
  check(state.leakedWaveIndices.length === 2 && state.leakedWaveIndices.includes(2)
    && state.leakedWaveIndices.includes(4), 'simultaneous/legacy leak provenance wrong');
});
test('split children hold old overlapping wave open until actually removed', () => {
  const state = createGame();
  state.waveIndex = 1;
  state.waveActive = true;
  state.pendingWaveIndices = [0, 1];
  const parent = enemy('old-split', 140, 140, 1);
  parent.id = 'splitter';
  parent.hp = 0;
  state.enemies = [parent];
  tick(state, 0);
  check(!state.clearedWaveIndices.includes(0) && state.clearedWaveIndices.includes(1),
    'old split wave cleared while children alive');
  state.enemies.forEach(en => { en.hp = 0; });
  tick(state, 0);
  check(state.completedWaves === 2 && state.clearedWaveIndices.includes(0), 'old wave did not clear');
  tick(state, 0);
  check(state.completedWaves === 2, 'clear counted twice');
});

if (failures.length) throw new Error(`Gameplay acceptance: ${failures.length}/${cases} failed\n${failures.join('\n')}`);
console.log(`Gameplay acceptance passed: ${cases} cases, ${assertions} assertions (12 towers, 11 spawn sets).`);
