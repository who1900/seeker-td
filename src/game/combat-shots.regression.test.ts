import { createGame, placeTower, sellTower, promoteTower, tick } from './engine';
import { CELL_PX } from './data';
import type { BattleState, Enemy, TowerId } from './types';

let assertions = 0;
let cases = 0;
const failures: string[] = [];
function check(value: unknown, message: string) {
  assertions++;
  if (!value) throw new Error(message);
}
function test(name: string, body: () => void) {
  cases++;
  try { body(); } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function fixture(id: TowerId) {
  const state = createGame();
  state.gold = 1e9;
  check(placeTower(state, id, { x: 5, y: 3 }), 'fixture placement');
  state.towers[0].targetingMode = 'closest';
  return state;
}
function mob(state: BattleState, x: number, y: number, hp = 1e9): Enemy {
  const en: Enemy = {
    uid: `combat-${state.enemies.length}`, id: 'soldier', hp, maxHp: hp,
    speed: 0, pos: { x, y },
    path: [{ x, y }, { x, y: y + 100 }], pathIdx: 1, pathProgress: 0,
  };
  state.enemies.push(en);
  return en;
}
function advance(state: BattleState, seconds: number) {
  const steps = Math.round(seconds * 64);
  for (let i = 0; i < steps; i++) tick(state, 1 / 64);
}
function stopFiring(state: BattleState) {
  state.towers.forEach(tower => { tower.cooldown = 1e6; });
}
const originalRandom = Math.random;
Math.random = () => 0;
try {
  for (const id of ['canon', 'dualCanon', 'machineGun', 'mortar'] as TowerId[]) {
    test(`${id}: launch does not damage; flight impacts once`, () => {
      const state = fixture(id);
      const tower = state.towers[0];
      const en = mob(state, tower.worldX + 2 * CELL_PX, tower.worldY);
      tick(state, .125);
      check(en.hp === en.maxHp, 'launch damaged target');
      check(state.shots.length === 1, 'expected one authoritative launched shot');
      const shot = state.shots[0];
      if (id !== 'mortar') check(shot.speed === (id === 'machineGun' ? 8 : 4) * CELL_PX,
        'source movement speed mismatch');
      stopFiring(state);
      advance(state, 1 / 64);
      check(en.hp === en.maxHp, 'damage before flight arrival');
      advance(state, 2);
      check(en.hp < en.maxHp, 'flight did not damage');
      const hp = en.hp;
      advance(state, 2);
      check(en.hp === hp && !state.shots.some(p => p.uid === shot.uid), 'shot applied twice/leaked');
    });
  }
  test('Canon flight progress and pause freeze', () => {
    const state = fixture('canon');
    const tower = state.towers[0];
    const en = mob(state, tower.worldX + 2 * CELL_PX, tower.worldY);
    tick(state, .125);
    stopFiring(state);
    const shot = state.shots[0];
    check(!!shot, 'missing CanonShot');
    advance(state, .125);
    const traveled = Math.hypot(shot.pos.x - shot.from.x, shot.pos.y - shot.from.y);
    check(traveled > 0 && traveled < 2 * CELL_PX && en.hp === en.maxHp, 'flight did not travel');
    const snapshot = JSON.stringify(state);
    state.paused = true;
    const pausedSnapshot = JSON.stringify(state);
    tick(state, 100);
    check(JSON.stringify(state) === pausedSnapshot, 'pause moved/expired shot');
    state.paused = false;
    check(JSON.stringify(state) === snapshot, 'pause resume mutated simulation');
    advance(state, 1);
    check(en.hp === en.maxHp - 100, 'Canon arrival damage not exactly once');
  });
  test('Cleared cosmetic views regenerate; serialized authority still hits', () => {
    const state = fixture('canon');
    const tower = state.towers[0];
    mob(state, tower.worldX + 2 * CELL_PX, tower.worldY);
    tick(state, .125);
    stopFiring(state);
    const shotUid = state.shots[0].uid;
    state.projectiles = [];
    const restored = JSON.parse(JSON.stringify(state)) as BattleState;
    tick(restored, 1 / 64);
    check(restored.shots.some(shot => shot.uid === shotUid), 'cosmetic reset deleted authority');
    check(restored.projectiles.some(p => p.authoritativeUid === shotUid), 'cosmetic views not regenerated');
    advance(restored, 1);
    check(restored.enemies[0].hp === 1e9 - 100, 'JSON roundtrip lost authoritative damage');
    check(state.enemies[0].hp === 1e9, 'serialized copy shared original combat state');
  });
  test('Prepared mines freeze on pause and JSON roundtrip preserves authority', () => {
    const state = fixture('mineLayer');
    advance(state, 3);
    stopFiring(state);
    check(state.mines.some(m => m.landed), 'missing landed mine');
    state.paused = true;
    const snapshot = JSON.stringify(state);
    tick(state, 50);
    check(JSON.stringify(state) === snapshot, 'pause mutated landed mine timing');
    const restored = JSON.parse(snapshot) as BattleState;
    restored.paused = false;
    restored.projectiles = [];
    const mine = restored.mines.find(m => m.landed)!;
    const en = mob(restored, mine.pos.x, mine.pos.y);
    advance(restored, .125);
    check(en.hp < en.maxHp, 'serialized mine lost trigger/damage');
    check(state.mines.some(m => m.uid === mine.uid), 'restored mine mutated original');
  });
  test('Mine flies 1.5 seconds, lands, then waits .1-second trigger check', () => {
    const state = fixture('mineLayer');
    tick(state, 0);
    while (!state.mines.length && state.time < 1) tick(state, 1 / 64);
    check(state.mines.length === 1, 'no authoritative flying mine');
    const mine = state.mines[0];
    stopFiring(state);
    const en = mob(state, mine.to.x, mine.to.y);
    advance(state, 1.484375);
    check(!mine.landed && en.hp === en.maxHp, 'mine landed/exploded early');
    tick(state, .015625);
    check(mine.landed && en.hp === en.maxHp, 'mine landing itself detonated');
    advance(state, .09375);
    check(en.hp === en.maxHp, 'mine checked before .1s');
    tick(state, .015625);
    check(en.hp < en.maxHp && !state.mines.some(m => m.uid === mine.uid), 'mine failed first trigger check');
  });
  test('DualCanon one shot each reload, alternating source side', () => {
    const state = fixture('dualCanon');
    const tower = state.towers[0];
    mob(state, tower.worldX + 2.5 * CELL_PX, tower.worldY);
    tick(state, .125);
    check(state.shots.length === 1, 'dual emits two shots per reload');
    const first = { ...state.shots[0], from: { ...state.shots[0].from } };
    advance(state, .484375);
    check(tower.lastFireTime === .125, 'dual early second emission');
    tick(state, .015625);
    const second = state.shots.find(p => p.uid !== first.uid);
    check(tower.lastFireTime === .625 && !!second, 'dual missing second emission');
    check(first.sourceSocket === 0 && second!.sourceSocket === 1, 'dual barrels did not alternate');
  });
  test('Mortar fixed 1.5 second flight and splash includes flyer', () => {
    const state = fixture('mortar');
    const tower = state.towers[0];
    const en = mob(state, tower.worldX + CELL_PX, tower.worldY);
    const flyer = mob(state, en.pos.x, en.pos.y);
    flyer.id = 'flyer';
    tick(state, .125);
    stopFiring(state);
    const shot = state.shots[0];
    check(!!shot && en.hp === en.maxHp, 'mortar launch impact');
    advance(state, 1.484375);
    check(en.hp === en.maxHp, 'mortar detonated before 1.5s');
    tick(state, .015625);
    check(en.hp < en.maxHp && flyer.hp < flyer.maxHp, 'mortar arrival excludes flyer');
  });
  test('Rocket loads without enemies, cannot fire before 1 second, arrival splash', () => {
    const state = fixture('rocketLauncher');
    const tower = state.towers[0];
    advance(state, .984375);
    check(tower.lastFireTime === undefined, 'rocket fired without enemy');
    const en = mob(state, tower.worldX + 2 * CELL_PX, tower.worldY);
    tick(state, 0);
    check(tower.lastFireTime === undefined && en.hp === en.maxHp, 'rocket skipped load period');
    tick(state, .015625);
    check(tower.lastFireTime === 1 && en.hp === en.maxHp, 'loaded rocket launch contract');
    const rocket = state.shots.find(p => p.kind === 'rocket');
    check(!!rocket && rocket.speed === 2.5 * CELL_PX, 'rocket source speed');
    const flyer = mob(state, en.pos.x, en.pos.y);
    flyer.id = 'flyer';
    stopFiring(state);
    advance(state, 1 / 64);
    check(en.hp === en.maxHp, 'rocket damaged before arrival');
    advance(state, 2);
    check(en.hp < en.maxHp && flyer.hp < flyer.maxHp, 'rocket missing arrival explosion/flyer splash');
  });
  test('MineLayer prepares on path without enemies, cap counts flying and landed', () => {
    const state = fixture('mineLayer');
    const tower = state.towers[0];
    let sawFlying = false;
    for (let i = 0; i < 20 * 64; i++) {
      tick(state, 1 / 64);
      sawFlying ||= state.mines.some(m => !m.landed);
      check(state.mines.length <= 3, 'flying plus landed mines exceeded base cap');
    }
    check(sawFlying, 'cap audit never observed flying mines');
    check(state.mines.length === 3, 'base authoritative mine cap/persistence');
    const before = state.mines.map(p => p.uid).join(',');
    advance(state, 20);
    check(state.mines.map(p => p.uid).join(',') === before, 'prepared mines expired or exceeded cap');
    tower.level = 2;
    advance(state, 10);
    check(state.mines.length === 5, 'enhancement mine cap must be 3+level');
  });
  test('MineLayer with no path section in range does not prepare', () => {
    const state = fixture('mineLayer');
    state.currentPath = [{ x: 11, y: 0 }, { x: 11, y: 20 }];
    advance(state, 10);
    check(state.mines.length === 0 && state.towers[0].lastFireTime === undefined,
      'mine prepared outside reachable path sections');
  });
  test('Mine trigger excludes flyer; ground trigger explosion includes flyer', () => {
    const state = fixture('mineLayer');
    advance(state, 2);
    stopFiring(state);
    const mine = state.mines[0];
    check(!!mine, 'no prepared mine');
    const flyer = mob(state, mine!.to.x, mine!.to.y);
    flyer.id = 'flyer';
    advance(state, .25);
    check(flyer.hp === flyer.maxHp && state.mines.some(p => p.uid === mine!.uid),
      'flyer triggered ground mine');
    const ground = mob(state, mine!.to.x, mine!.to.y);
    advance(state, .125);
    check(ground.hp < ground.maxHp && flyer.hp < flyer.maxHp,
      'ground mine trigger failed or explosion excluded flyer');
    check(!state.mines.some(p => p.uid === mine!.uid), 'detonated mine retained');
  });
  test('Mine trigger radius is .7 cells, not explosion radius', () => {
    const state = fixture('mineLayer');
    advance(state, 2);
    stopFiring(state);
    const mine = state.mines[0];
    check(!!mine, 'no mine');
    const en = mob(state, mine!.to.x + .75 * CELL_PX, mine!.to.y);
    advance(state, .25);
    check(en.hp === en.maxHp && state.mines.some(p => p.uid === mine!.uid), 'mine triggered outside .7');
    en.pos.x = mine!.to.x + .65 * CELL_PX;
    en.path = [{ ...en.pos }, { x: en.pos.x, y: en.pos.y + 100 }];
    advance(state, .125);
    check(en.hp < en.maxHp, 'mine did not trigger inside .7');
  });
  test('Arrival rewards only once despite multiple shots', () => {
    const state = fixture('canon');
    const tower = state.towers[0];
    const en = mob(state, tower.worldX + 2 * CELL_PX, tower.worldY, 1);
    const gold = state.gold;
    tick(state, .125);
    tower.cooldown = 0;
    tick(state, 0);
    stopFiring(state);
    check(state.gold === gold && state.enemies.includes(en), 'launch awarded kill');
    advance(state, 2);
    const rewardGold = state.gold;
    const rewardCredits = state.creditsEarned;
    check(rewardGold > gold && !state.enemies.includes(en), 'arrival kill unpaid');
    advance(state, 4);
    check(state.gold === rewardGold && state.creditsEarned === rewardCredits, 'duplicate reward');
  });
  test('MG fixed-direction first collision may hit a different enemy', () => {
    const state = fixture('machineGun');
    const tower = state.towers[0];
    const target = mob(state, tower.worldX + 3 * CELL_PX, tower.worldY);
    tick(state, .125);
    stopFiring(state);
    const interceptor = mob(state, tower.worldX + 1.5 * CELL_PX, tower.worldY);
    advance(state, .25);
    check(interceptor.hp < interceptor.maxHp && target.hp === target.maxHp,
      'MG ignored first collision or homed onto original target');
  });
  test('Mortar prediction follows motion, inaccuracy bounded by one cell', () => {
    const state = fixture('mortar');
    const tower = state.towers[0];
    const en = mob(state, tower.worldX + CELL_PX, tower.worldY);
    en.speed = CELL_PX;
    tick(state, .125);
    const shot = state.shots[0];
    check(!!shot, 'no mortar prediction shot');
    const predicted = { x: en.pos.x, y: en.pos.y + 1.5 * CELL_PX };
    check(Math.hypot(shot.to.x - predicted.x, shot.to.y - predicted.y) <= CELL_PX + 1e-8,
      'mortar missing prediction or inaccuracy exceeds source radius');
    check(shot.to.y > en.pos.y, 'mortar aimed at current position instead of prediction');
  });
  for (const id of ['mortar', 'rocketLauncher'] as TowerId[]) {
    test(`${id}: fresh collateral protected at impact, mature collateral hit`, () => {
      const state = fixture(id);
      const tower = state.towers[0];
      const primary = mob(state, tower.worldX + CELL_PX, tower.worldY);
      if (id === 'rocketLauncher') advance(state, 1);
      else tick(state, .125);
      stopFiring(state);
      const shot = state.shots.find(p => p.towerId === id);
      check(!!shot && primary.hp === primary.maxHp, 'launch damage/preparation contract');
      if (id === 'mortar') advance(state, 1.375);
      const fresh = mob(state, shot!.to.x, shot!.to.y);
      fresh.spawnedAt = state.time;
      const mature = mob(state, shot!.to.x, shot!.to.y);
      advance(state, .625);
      check(primary.hp < primary.maxHp && mature.hp < mature.maxHp, 'impact branch not exercised');
      check(fresh.hp === fresh.maxHp && !fresh.hitFlash, 'impact splash bypassed fresh-spawn protection');
    });
  }
  test('Prepared mine cleanup on sale/promotion and isolated new game', () => {
    for (const action of ['sell', 'promote'] as const) {
      const state = fixture('mineLayer');
      advance(state, 10);
      const uid = state.towers[0].uid;
      check(state.mines.length > 0, 'cleanup fixture has no mines');
      if (action === 'sell') sellTower(state, uid);
      else check(promoteTower(state, uid), 'promotion rejected');
      check(!state.mines.some(p => p.sourceTowerUid === uid), 'orphaned prepared mines');
      const fresh = createGame();
      check(fresh.shots.length === 0 && fresh.mines.length === 0
        && fresh.projectiles.length === 0 && fresh.effects.length === 0 && fresh.time === 0,
        'new game inherited combat state');
    }
  });
  test('Fresh ground spawn cannot trigger prepared mine during grace', () => {
    const state = fixture('mineLayer');
    advance(state, 2);
    stopFiring(state);
    const mine = state.mines[0];
    check(!!mine, 'no prepared mine');
    const en = mob(state, mine!.to.x, mine!.to.y);
    en.spawnedAt = state.time;
    advance(state, .5);
    check(en.hp === en.maxHp && state.mines.some(p => p.uid === mine!.uid), 'mine bypassed spawn grace');
    advance(state, .625);
    check(en.hp < en.maxHp, 'mine never triggered after grace');
  });
} finally {
  Math.random = originalRandom;
}
if (failures.length) throw new Error(`Combat shots: ${failures.length}/${cases} failed\n${failures.join('\n')}`);
console.log(`Combat shots passed: ${cases} cases, ${assertions} checks.`);
