import { createGame, getWave, startWave, tick, placeTower, cellToWorld,
  canStartNextWave, getNextWaveWait, getEarlyWaveBonus } from './engine';
import { WAVES } from './data';
import type { BattleState, Enemy, EnemyId } from './types';

// Independent wave lifecycle fixtures. Offset is distance, not time.
type Group = [EnemyId, number, number]; // name, count, delay before formation
type SourceWave = [number, number, number, Group[]]; // reward, extend, maxExtend, formations
const source: SourceWave[] = [
  [100, 2, 8, [['soldier', 6, 9]]],
  [100, 2, 4, [['soldier', 6, 9], ['soldier', 6, 9]]],
  [120, 1, 4, [['soldier', 6, 9], ['blob', 6, 6]]],
  [120, 1, 3, [['soldier', 6, 9], ['blob', 6, 6], ['soldier', 6, 9]]],
  [150, 1, 3, [['sprinter', 6, 10], ['soldier', 6, 2], ['blob', 6, 2]]],
  [150, 1, 3, [['soldier', 6, 9], ['sprinter', 6, 2], ['blob', 6, 2]]],
  [170, 1, 4, [['flyer', 5, 9], ['soldier', 6, 9]]],
  [170, 1, 3, [['sprinter', 6, 9], ['blob', 6, 4], ['flyer', 6, 9]]],
  [190, 1, 2, [['sprinter', 9, 9], ['blob', 9, 2], ['flyer', 9, 4]]],
  [190, 1, 2, [['healer', 6, 9], ['sprinter', 9, 4], ['blob', 9, 9]]],
  [240, 1, 4, [['healer', 6, 9], ['healer', 6, 9]]],
  [240, 1, 4, [['healer', 6, 9], ['sprinter', 9, 9]]],
  [240, 1, 3, [['healer', 4, 9], ['soldier', 6, 2], ['healer', 4, 9], ['soldier', 6, 2]]],
  [240, 1, 3, [['healer', 4, 9], ['blob', 6, 2], ['flyer', 6, 2]]],
  [300, 1, 2, [['blob', 6, 9], ['healer', 4, 2], ['soldier', 9, 2], ['flyer', 9, 2], ['sprinter', 9, 2], ['healer', 4, 2]]],
];
const speed: Partial<Record<EnemyId, number>> = { soldier: 1, blob: .5, sprinter: 3, flyer: 1.3, healer: 1.2 };
const health: Partial<Record<EnemyId, number>> = { soldier: 300, blob: 600, sprinter: 200, flyer: 400, healer: 400 };
const rewards: Partial<Record<EnemyId, number>> = { soldier: 10, blob: 20, sprinter: 15, flyer: 30, healer: 30 };
let checks = 0;
let cases = 0;
const failures: string[] = [];
function check(value: unknown, message: string) {
  checks++;
  if (!value) throw new Error(message);
}
function near(actual: number, expected: number, message: string, tolerance = 1e-5) {
  check(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${message}: ${actual} != ${expected}`);
}
function test(name: string, body: () => void) {
  cases++;
  try { body(); } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function schedule(index: number) {
  const [, extend, maxExtend, groups] = source[index % 15];
  const repeat = 1 + Math.min(Math.floor(index / 15) * extend, maxExtend);
  const entries: { id: EnemyId; delay: number; scheduledDelay: number; offset: number }[] = [];
  let elapsed = 0;
  let first = true;
  for (let copy = 0; copy < repeat; copy++) for (const [id, count, delay] of groups) {
    if (!first) elapsed += delay;
    first = false;
    for (let n = 0; n < count; n++) entries.push({ id, scheduledDelay: elapsed,
      offset: n * 1.1, delay: elapsed + n * 1.1 / speed[id]! });
  }
  return entries.sort((a, b) => a.delay - b.delay);
}
function advance(state: BattleState, seconds: number) {
  for (let i = 0; i < seconds * 64; i++) tick(state, 1 / 64);
}
function killWave(state: BattleState, index: number) {
  state.spawnQueue = state.spawnQueue.filter(entry => entry.waveIndex !== index);
  for (const enemy of state.enemies) if (enemy.waveIndex === index) {
    enemy.hp = 0;
    enemy.rewardOverride = 0;
  }
  tick(state, 0);
}
function fixtureEnemy(state: BattleState, waveIndex: number, reward: number): Enemy {
  const pos = cellToWorld(state.entry);
  return { uid: `wave-fixture-${state.uidCounter++}`, id: 'soldier', hp: 100, maxHp: 100,
    speed: 0, pos, path: [pos, cellToWorld(state.exit)], pathIdx: 1, pathProgress: 0,
    waveIndex, reward };
}

for (let index = 0; index < 15; index++) {
  test(`original wave ${index + 1}: source entries/count/reward/extend`, () => {
    const [reward, extend, maxExtend, groups] = source[index];
    const wave = WAVES[index];
    check(wave.waveReward === reward && wave.extend === extend && wave.maxExtend === maxExtend,
      'source metadata mismatch');
    const expectedEntries = groups.flatMap(([id, count, delay]) => Array.from({ length: count }, (_, n) => ({
      id, count: 1, delay: n === 0 ? delay : 0, offset: n === 0 ? 0 : 1.1,
    })));
    check(wave.enemies.length === expectedEntries.length, 'source enemy count mismatch');
    wave.enemies.forEach((entry, n) => {
      const expected = expectedEntries[n];
      check(entry.id === expected.id && entry.count === 1, 'source entry/order mismatch');
      near(entry.delay ?? 0, expected.delay, 'source delay');
      near(entry.offset ?? 0, expected.offset, 'source offset');
    });
    const generated = getWave(index, 0);
    check(!generated.isBossWave && !generated.enemies.some(en => en.id === 'boss'), 'extra boss in original15');
    check(generated.waveReward === reward, 'first-iteration reward changed');
  });
  test(`original wave ${index + 1}: one-entrance arrival schedule adaptation`, () => {
    const state = createGame();
    state.waveIndex = index - 1;
    startWave(state);
    const expected = schedule(index);
    check(state.spawnQueue.length === expected.length, 'scheduled count mismatch');
    state.spawnQueue.forEach((entry, n) => {
      check(entry.id === expected[n].id && entry.waveIndex === index, 'schedule order/provenance mismatch');
      near(entry.delay, expected[n].delay, 'entry-arrival time (offset / speed)');
      near(entry.scheduledDelay ?? NaN, expected[n].scheduledDelay, 'original temporal delay');
      near(entry.offset ?? NaN, expected[n].offset, 'original accumulated spatial offset');
    });
  });
}
for (const index of [15, 16, 17, 29, 30, 60, 120, 149]) {
  test(`cycle/extensions at index ${index}: canonical portion and cap`, () => {
    const state = createGame();
    state.waveIndex = index - 1;
    startWave(state);
    const expected = schedule(index);
    const generated = getWave(index, 0);
    check(generated.enemies.slice(0, expected.length).every(entry => speed[entry.id] !== undefined)
      && generated.enemies.slice(0, expected.length).reduce((sum, entry) => sum + entry.count, 0)
        === expected.length, 'canonical repeated prefix count/cap mismatch');
    const remaining = state.spawnQueue.map(entry => `${entry.id}:${entry.delay.toFixed(4)}`);
    for (const entry of expected) {
      const found = remaining.indexOf(`${entry.id}:${entry.delay.toFixed(4)}`);
      check(found >= 0, 'canonical repeated schedule entry missing');
      remaining.splice(found, 1);
    }
    check(generated.waveReward === source[index % 15][0] * (Math.floor(index / 15) + 1),
      'wave reward iteration multiplier mismatch');
  });
}
test('first start does not pay new reward or age; completion pays earned reward once', () => {
  const state = createGame();
  state.gold = 1000;
  placeTower(state, 'canon', { x: 2, y: 2 });
  state.towers[0].cooldown = 1e6;
  const gold = state.gold;
  const value = state.towers[0].value;
  startWave(state);
  check(!canStartNextWave(state) && getNextWaveWait(state) === 5, 'readiness API after start');
  check(state.gold === gold && state.creditsEarned === 0, 'first start grants reward');
  check(state.towers[0].value === value, 'start aged tower');
  killWave(state, 0);
  check(state.gold === gold + 100 && state.creditsEarned === 100, 'completion reward not earned');
  check(state.completedWaves === 1 && state.towers[0].value === 97, 'completion aging/count');
  const snapshot = JSON.stringify(state);
  tick(state, 0);
  check(state.gold === gold + 100 && state.towers[0].value === 97, 'completion paid/aged twice');
  const restored = JSON.parse(snapshot) as BattleState;
  tick(restored, 0);
  check(restored.gold === gold + 100 && restored.towers[0].value === 97, 'JSON repeated completion');
});
test('readiness is five active simulation seconds; rejection is mutation-free; pause freezes', () => {
  const state = createGame();
  startWave(state);
  let snapshot = JSON.stringify(state);
  startWave(state);
  check(JSON.stringify(state) === snapshot, 'immediate repeated start mutated state');
  state.paused = true;
  snapshot = JSON.stringify(state);
  tick(state, 100);
  startWave(state);
  check(JSON.stringify(state) === snapshot, 'pause expired readiness or admitted wave');
  state.paused = false;
  advance(state, 4.984375);
  snapshot = JSON.stringify(state);
  startWave(state);
  check(JSON.stringify(state) === snapshot, 'start admitted before five seconds');
  tick(state, .015625);
  const restored = JSON.parse(JSON.stringify(state)) as BattleState;
  startWave(restored);
  check(restored.waveIndex === 1, 'ready serialized state rejected at exact boundary');
  check(state.waveIndex === 0, 'JSON readiness copy mutated original');
});
test('spatial offset arrival starts grace at actual entry; formations are not compressed', () => {
  const state = createGame();
  startWave(state);
  tick(state, 0);
  check(state.enemies.length === 1 && state.enemies[0].spawnedAt === 0,
    'first formation compressed or first source delay honored');
  advance(state, 1.09375);
  check(state.enemies.length === 1, 'second offset enemy entered before traveling 1.1 cells');
  state.paused = true;
  const snapshot = JSON.stringify(state);
  tick(state, 100);
  check(JSON.stringify(state) === snapshot, 'paused virtual entrance travel advanced');
  state.paused = false;
  tick(state, .015625);
  check(state.enemies.length === 2, 'second formation enemy missing at arrival');
  const second = state.enemies.find(enemy => enemy.spawnedAt === state.time)!;
  check(!!second && second.spawnedAt === state.time,
    'spawn grace counted from scheduled offscreen birth rather than actual entry');
  const entry = cellToWorld(state.entry);
  near(second.pos.y - entry.y, second.speed * .015625, 'same-tick movement after actual arrival');
  near(second.pos.x, entry.x, 'actual entry x position');
  check(state.enemies[0].pos.y > second.pos.y, 'offscreen formation compressed to one point');
  state.enemies = [second];
  state.gold = 1000;
  check(placeTower(state, 'canon', { x: 5, y: 0 }), 'actual-arrival grace tower fixture');
  tick(state, 0);
  check(state.shots.length === 0 && state.towers[0].lastFireTime === undefined,
    'offset arrival aged grace before entering field');
  advance(state, .984375);
  check(state.shots.length === 0 && state.towers[0].lastFireTime === undefined,
    'actual-arrival enemy became target before full grace');
  tick(state, .015625);
  check(state.towers[0].lastFireTime === state.time
    && state.shots.some(shot => shot.targetUid === second.uid),
    'actual-arrival enemy not eligible at grace boundary');
});
test('enemy kill credits and next-wave reward earned, early bonus alone unearned', () => {
  const state = createGame();
  startWave(state);
  const victim = fixtureEnemy(state, 0, 37);
  victim.hp = 0;
  state.enemies.push(victim);
  const gold = state.gold;
  tick(state, 0);
  check(state.gold === gold + 37 && state.creditsEarned === 37, 'enemy kill not earned exactly');
  tick(state, 0);
  check(state.gold === gold + 37 && state.creditsEarned === 37, 'enemy kill paid twice');
  advance(state, 5);
  const beforeGold = state.gold;
  const beforeCredits = state.creditsEarned;
  const bonus = getEarlyWaveBonus(state);
  startWave(state);
  check(state.gold === beforeGold + 100 + bonus && state.creditsEarned === beforeCredits + 100,
    'wave advancement mixed earned wave reward with unearned early bonus');
  killWave(state, 0);
  check(state.creditsEarned === beforeCredits + 100, 'already paid wave rewarded again');
});
test('early bonus uses live plus queued enemies from ALL waves, but is not earned', () => {
  const state = createGame();
  state.waveIndex = 1;
  state.waveActive = state.spawning = true;
  state.pendingWaveIndices = [0, 1];
  state.waveRewards = { 0: 0, 1: 100 };
  state.rewardedWaveIndices = [0];
  state.enemies = [fixtureEnemy(state, 0, 10), fixtureEnemy(state, 1, 20)];
  state.spawnQueue = [
    { id: 'soldier', delay: 100, waveIndex: 0, reward: 30 },
    { id: 'blob', delay: 100, waveIndex: 1, reward: 40 },
  ];
  const gold = state.gold;
  check(getEarlyWaveBonus(state) === Math.round(3 * Math.pow(100, .6)), 'preview omitted active-wave rewards');
  startWave(state);
  const expectedBonus = Math.round(Math.fround(3 * Math.fround(Math.pow(100, Math.fround(.6)))));
  check(state.gold === gold + 100 + expectedBonus, 'early bonus omitted old/live/queued rewards');
  check(state.creditsEarned === 100, 'early bonus inflated creditsEarned');
  killWave(state, 1);
  check(state.creditsEarned === 100, 'already advanced wave reward paid twice at completion');
  check(state.rewardedWaveIndices.filter(index => index === 1).length === 1, 'reward provenance duplicated');
});
test('maximum selectable wave limits remain source-scheduled and bounded; endless generation is finite', () => {
  for (const limit of [10, 20, 40]) {
    const state = createGame();
    for (let index = 0; index < limit; index++) {
      startWave(state);
      check(state.waveIndex === index && state.spawnQueue.length <= 250,
        `mode wave limit ${limit}: admission/count`);
      killWave(state, index);
      check(state.completedWaves === index + 1, `mode wave limit ${limit}: completion`);
      if (index + 1 < limit) advance(state, 5);
    }
    check(state.completedWaves === limit && state.waveIndex === limit - 1,
      `mode wave limit ${limit}: only completed waves count`);
  }
  for (const index of [999, 999999, Number.MAX_SAFE_INTEGER - 1]) {
    const wave = getWave(index, 1e12);
    check(wave.enemies.reduce((sum, entry) => sum + entry.count, 0) <= 250,
      'endless maximum generation unbounded');
    check(Number.isFinite(wave.waveReward) && Number.isFinite(wave.healthModifier),
      'endless maximum generation nonfinite');
  }
});
test('completion-only aging once per overlapping wave including out-of-order completion', () => {
  const state = createGame();
  state.gold = 1e6;
  placeTower(state, 'canon', { x: 2, y: 2 });
  state.towers[0].value = 1000;
  state.towers[0].cooldown = 1e6;
  startWave(state);
  advance(state, 5);
  startWave(state);
  check(state.towers[0].value === 1000, 'overlapping start aged tower');
  killWave(state, 1);
  check(state.completedWaves === 1 && state.towers[0].value === 970, 'latest clear aging/count');
  check(!state.clearedWaveIndices.includes(0), 'old queued wave cleared early');
  killWave(state, 0);
  check(state.completedWaves === 2 && state.towers[0].value === 941, 'old clear aging/count');
  tick(state, 0);
  check(state.towers[0].value === 941, 'overlap aged twice');
});
test('terminal defeat/victory and paused start do not admit/pay/age', () => {
  for (const flag of ['gameOver', 'victory', 'paused'] as const) {
    const state = createGame();
    state[flag] = true;
    const snapshot = JSON.stringify(state);
    startWave(state);
    check(JSON.stringify(state) === snapshot, `${flag} admitted a wave`);
    if (flag !== 'paused') {
      tick(state, 10);
      check(JSON.stringify(state) === snapshot, `${flag} advanced terminal simulation`);
    }
  }
});
test('invalid/max wave inputs reject without partially paying or mutating admission', () => {
  for (const index of [-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    let rejected = false;
    try { getWave(index, 0); } catch (error) { rejected = error instanceof RangeError; }
    check(rejected, 'invalid wave index accepted');
  }
  for (const credits of [-1, NaN, Infinity]) {
    let rejected = false;
    try { getWave(0, credits); } catch (error) { rejected = error instanceof RangeError; }
    check(rejected, 'invalid earned credits accepted');
  }
});
test('actual spawn HP uses wave total health denominator; snapshots survive economy changes', () => {
  for (const index of [0, 2, 4, 9, 14]) for (const credits of [0, 100, 100000]) {
    const state = createGame();
    state.waveIndex = index - 1;
    state.creditsEarned = credits;
    startWave(state);
    const waveHealth = source[index][3].reduce((sum, [id, count]) => sum + health[id]! * count, 0);
    const modifier = Math.max(.5, (20 * credits + .0008 * Math.pow(credits, 1.9)) / waveHealth);
    const rewardModifier = Math.max(1, .4 * Math.sqrt(modifier));
    const queued = state.spawnQueue[0];
    const id = queued.id;
    near(queued.healthModifier ?? NaN, modifier, 'wave health modifier');
    check(queued.reward === Math.round(rewards[id]! * rewardModifier), 'scaled enemy reward');
    state.creditsEarned += 1e8;
    tick(state, 0);
    const actual = state.enemies.find(enemy => enemy.id === id)!;
    check(!!actual, 'first entry delay incorrectly honored');
    near(actual.maxHp, health[id]! * modifier, 'spawn snapshot HP');
    check(actual.reward === queued.reward && actual.spawnedAt === state.time, 'spawn reward/timestamp snapshot');
  }
});

if (failures.length) throw new Error(`Wave lifecycle: ${failures.length}/${cases} failed\n${failures.join('\n')}`);
console.log(`Wave lifecycle passed: ${cases} cases, ${checks} checks; 15 wave fixtures, one-entrance distance offsets.`);
