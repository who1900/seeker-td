import { strict as assert } from 'node:assert';
import { createGame, placeTower, tick, cellToWorld } from './engine';
import { CELL_PX, TOWER_ORDER, TOWERS } from './data';
import type { BattleState, Enemy, TowerId } from './types';

function fixture(id: TowerId, grace = 1) {
  const state = createGame(12, 21, grace);
  state.gold = 1e9;
  assert.ok(placeTower(state, id, { x: 5, y: 2 }));
  state.towers[0].targetingMode = 'strongest';
  if (id === 'rocketLauncher') {
    tick(state, 1);
    state.time = 0;
  }
  state.soundQueue = [];
  return state;
}
function flight(state: BattleState, seconds = 2) {
  state.towers.forEach(tower => { tower.cooldown = 100; });
  for (let i = 0; i < seconds * 64; i++) tick(state, 1 / 64);
}
function enemy(state: BattleState, spawnedAt: number | undefined, hp = 1e8): Enemy {
  const pos = cellToWorld({ x: 6, y: 2 });
  const mob: Enemy = { uid: `fixture-${state.enemies.length}`, id: 'soldier', hp, maxHp: hp,
    pos: { ...pos }, speed: 0, spawnedAt, waveIndex: 0,
    path: [cellToWorld(state.entry), pos, cellToWorld(state.exit)], pathIdx: 2, pathProgress: 0 };
  state.enemies.push(mob);
  return mob;
}

const random = Math.random;
const towerSnapshot = JSON.stringify(TOWERS);
Math.random = () => 0.5;
try {
  assert.equal(createGame().spawnTargetGraceSeconds, 1);
  assert.equal(createGame(12, 21, 0).spawnTargetGraceSeconds, 0);
  for (const invalid of [-1, NaN, Infinity, -Infinity]) {
    assert.throws(() => createGame(12, 21, invalid), RangeError);
    const state = createGame();
    state.spawnTargetGraceSeconds = invalid;
    assert.throws(() => tick(state, 0.1), RangeError);
    assert.equal(state.time, 0, 'validation mutated engine time');
  }
  for (const id of TOWER_ORDER) {
    if (id === 'mineLayer') {
      const mineState = fixture(id);
      for (let i = 0; i < 192; i++) tick(mineState, 1 / 64);
      mineState.towers[0].cooldown = 100;
      const mine = mineState.mines.find(item => item.landed)!;
      assert.ok(mine, 'mine prepares without enemy, independently of targeting grace');
      const protectedMob = enemy(mineState, mineState.time);
      protectedMob.pos = { ...mine.pos };
      protectedMob.path = [{ ...mine.pos }, cellToWorld(mineState.exit)];
      protectedMob.pathIdx = 1;
      protectedMob.pathProgress = 0;
      flight(mineState, .5);
      assert.equal(protectedMob.hp, protectedMob.maxHp, 'prepared mine bypassed grace');
      assert.ok(mineState.mines.some(item => item.uid === mine.uid));
      const frozen = JSON.stringify(mineState);
      mineState.paused = true;
      tick(mineState, 100);
      mineState.paused = false;
      assert.equal(JSON.stringify(mineState), frozen, 'pause aged grace or mine trigger');
      flight(mineState, .625);
      assert.ok(protectedMob.hp < protectedMob.maxHp, 'prepared mine did not trigger after grace');
      for (const timestamp of [undefined, 0]) {
        const ready = fixture(id, timestamp === 0 ? 0 : 100);
        for (let i = 0; i < 192; i++) tick(ready, 1 / 64);
        const landed = ready.mines.find(item => item.landed)!;
        assert.ok(landed);
        const eligible = enemy(ready, timestamp === 0 ? ready.time : undefined);
        eligible.pos = { ...landed.pos };
        eligible.path = [{ ...landed.pos }, cellToWorld(ready.exit)];
        eligible.pathIdx = 1;
        flight(ready, .125);
        assert.ok(eligible.hp < eligible.maxHp, 'mine legacy/grace0 incorrectly protected');
      }
      continue;
    }
    const state = fixture(id);
    const fresh = enemy(state, 0);
    const before = { hp: fresh.hp, pos: { ...fresh.pos } };
    tick(state, 0);
    assert.equal(fresh.hp, before.hp, `${id} damaged protected spawn`);
    assert.deepEqual(fresh.pos, before.pos);
    assert.equal(fresh.slowUntil, undefined);
    assert.equal(state.projectiles.length, 0);
    assert.equal(state.effects.length, 0);
    assert.equal(state.towers[0].lastFireTime, undefined);
    state.time = 0.999;
    tick(state, 0);
    assert.equal(state.towers[0].lastFireTime, undefined, `${id} fired before boundary`);
    state.time = 1;
    tick(state, .125);
    if (id === 'glueTower') for (let i = 0; i < 52; i++) tick(state, 1 / 64);
    assert.ok(state.towers[0].lastFireTime !== undefined, `${id} did not fire after grace and refresh`);
    assert.ok(state.effects.length + state.projectiles.length > 0);

    const mixed = fixture(id);
    mixed.time = 2;
    const eligible = enemy(mixed, 0);
    const protectedMob = enemy(mixed, 2, 1e6);
    const protectedPos = { ...protectedMob.pos };
    tick(mixed, .125);
    if (id === 'glueTower') for (let i = 0; i < 52; i++) tick(mixed, 1 / 64);
    assert.equal(protectedMob.hp, protectedMob.maxHp, `${id} secondary hit bypassed grace`);
    assert.equal(protectedMob.slowUntil, undefined, `${id} AoE slow bypassed grace`);
    assert.deepEqual(protectedMob.pos, protectedPos, `${id} teleported protected spawn`);
    assert.ok(mixed.towers[0].lastFireTime !== undefined, `${id} failed to attack eligible mob`);
    if (id === 'bouncingLaser') {
      assert.equal(mixed.effects.find(effect => effect.kind === 'chain_bounce')!.pts!.length, 2,
        'protected spawn became a chain intermediate node');
    }
    if (id === 'teleporter') {
      assert.equal(mixed.teleports.length, 1, 'missing authoritative phase');
      flight(mixed, .125);
      assert.notDeepEqual(eligible.pos, protectedPos);
    }

    const immediate = fixture(id, 0);
    enemy(immediate, 0);
    tick(immediate, .125);
    if (id === 'glueTower') for (let i = 0; i < 52; i++) tick(immediate, 1 / 64);
    assert.ok(immediate.towers[0].lastFireTime !== undefined, `${id} grace=0 incorrectly protected after refresh`);
    const legacy = fixture(id, 100);
    enemy(legacy, undefined);
    tick(legacy, .125);
    if (id === 'glueTower') for (let i = 0; i < 52; i++) tick(legacy, 1 / 64);
    assert.ok(legacy.towers[0].lastFireTime !== undefined, `${id} legacy mob incorrectly protected`);
  }

  const spawned = fixture('canon');
  spawned.time = 5;
  spawned.spawnQueue = [{ id: 'soldier', delay: 0, waveIndex: 0 }];
  spawned.spawning = true;
  tick(spawned, 0);
  const moving = spawned.enemies[0];
  assert.equal(moving.spawnedAt, 5);
  const initial = { ...moving.pos };
  tick(spawned, 0.25);
  assert.ok(Math.hypot(moving.pos.x - initial.x, moving.pos.y - initial.y) > 0, 'grace stopped movement');
  const clock = spawned.time;
  spawned.paused = true;
  tick(spawned, 100);
  assert.equal(spawned.time, clock);
  assert.equal(spawned.towers[0].lastFireTime, undefined, 'pause expired grace');
  spawned.paused = false;
  tick(spawned, 0.25);
  assert.equal(spawned.towers[0].lastFireTime, undefined);
  spawned.spawnTargetGraceSeconds = 0;
  tick(spawned, .125);
  assert.equal(spawned.towers[0].lastFireTime, spawned.time, 'runtime grace configuration ignored');

  const flying = fixture('canon');
  const flyer = enemy(flying, 0);
  flyer.id = 'flyer';
  flyer.flyProgress = 0.1;
  flyer.path = undefined;
  tick(flying, 0);
  assert.equal(flyer.hp, flyer.maxHp, 'flyer bypassed grace');
  flying.time = 1;
  tick(flying, .125);
  flight(flying);
  assert.ok(flyer.hp < flyer.maxHp);

  for (const timestamp of [0, undefined]) {
    const split = fixture('canon');
    split.time = 2;
    const parent = enemy(split, timestamp, 1);
    parent.id = 'splitter';
    parent.speed = 0;
    tick(split, .125);
    flight(split);
    assert.equal(split.enemies.length, 2);
    for (const child of split.enemies) {
      assert.equal(child.spawnedAt, timestamp, 'split grants a new grace window');
      child.speed = 0;
    }
    split.towers[0].cooldown = 0;
    split.enemies.forEach(child => {
      child.pos = cellToWorld({ x: 6, y: 2 });
      child.path = [{ ...child.pos }, cellToWorld(split.exit)];
      child.pathIdx = 1;
      child.pathProgress = 0;
    });
    tick(split, .125);
    flight(split);
    assert.ok(split.enemies.length < 2 || split.enemies.some(child => child.hp < child.maxHp), 'split children gained immunity');
  }
  assert.equal(JSON.stringify(TOWERS), towerSnapshot, 'grace changed tower balance');
  assert.equal(CELL_PX, 28);
  console.log('spawn grace regression checks passed (provisional SeekDef 1s deviation; tower stats unchanged)');
} finally {
  Math.random = random;
}
