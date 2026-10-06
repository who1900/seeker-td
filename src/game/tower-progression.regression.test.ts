import { TOWERS } from './data';
import { createGame, placeTower, enhanceTower, promoteTower, getEnhanceCost,
  towerStats, upgradeTower, sellTower, tick } from './engine';
import type { TowerId } from './types';

let checks = 0;
function check(value: unknown, message: string) {
  checks++;
  if (!value) throw new Error(message);
}
const expected: Record<TowerId, [number, number, number, number, number, number]> = {
  canon: [1.2, 10, 1, 50, 100, 40],
  dualCanon: [1.4, 10, 2, 470, 3400, 160],
  machineGun: [1.5, 15, 3, 750, 20000, 120],
  simpleLaser: [1.2, 10, 1, 50, 230, 40],
  bouncingLaser: [1.4, 10, 2, 580, 4300, 160],
  straightLaser: [1.5, 15, 3, 950, 44000, 410],
  mortar: [1.2, 10, 1, 125, 100, 60],
  mineLayer: [1.4, 10, 2, 750, 3100, 270],
  rocketLauncher: [1.5, 15, 3, 950, 48000, 410],
  glueTower: [1.2, 5, 1, 100, 0, 0],
  glueGun: [1.2, 5, 2, 200, 0, 0],
  teleporter: [1.2, 5, 3, 2000, 0, 0],
};
const promotions: Partial<Record<TowerId, [TowerId, number]>> = {
  canon: ['dualCanon', 5600], dualCanon: ['machineGun', 88500],
  simpleLaser: ['bouncingLaser', 7000], bouncingLaser: ['straightLaser', 96450],
  mortar: ['mineLayer', 10000], mineLayer: ['rocketLauncher', 102850],
  glueTower: ['glueGun', 800], glueGun: ['teleporter', 1700],
};
for (const id of Object.keys(expected) as TowerId[]) {
  const [base, max, tier, cost0, damage0, increment] = expected[id];
  const state = createGame();
  state.gold = 1e9;
  check(placeTower(state, id, { x: 3, y: 4 }), `${id}: place`);
  const tower = state.towers[0];
  check(tower.level === 0, `${id}: initial level`);
  check(TOWERS[id].enhanceBase === base && TOWERS[id].maxLevel === max
    && TOWERS[id].upgradeLevel === tier, `${id}: source constants`);
  let damage = damage0;
  for (let level = 0; level < max - 1; level++) {
    check(towerStats(tower).damage === damage, `${id}: damage at ${level}`);
    const factor = Math.fround(Math.pow(Math.fround(base), level));
    const cost = Math.floor(Math.fround(cost0 * factor) + .5);
    check(getEnhanceCost(tower) === cost, `${id}: cost at ${level}`);
    const gold = state.gold;
    const value = tower.value;
    state.gold = cost - 1;
    check(!enhanceTower(state, tower.uid) && tower.level === level && tower.value === value,
      `${id}: unaffordable mutation`);
    state.gold = gold;
    check(enhanceTower(state, tower.uid), `${id}: enhance ${level}`);
    check(state.gold === gold - cost && tower.value === value + cost, `${id}: enhance ledger`);
    damage = Math.fround(damage + Math.fround(increment * factor));
  }
  check(tower.level === max - 1 && getEnhanceCost(tower) === -1
    && !enhanceTower(state, tower.uid), `${id}: max enhancements`);
  check(towerStats(tower).damage === damage, `${id}: final geometric damage`);
  if (id === 'glueTower' || id === 'glueGun') {
    check(towerStats(tower).slowFactor === 1.2 + (id === 'glueTower' ? .2 : .3) * (max - 1),
      `${id}: glue intensity progression`);
  }
  if (!promotions[id]) check(!promoteTower(state, tower.uid), `${id}: final tier promotion`);
}
for (const id of Object.keys(promotions) as TowerId[]) {
  const [next, cost] = promotions[id]!;
  for (const level of [0, 2, expected[id][1] - 1]) {
    const state = createGame();
    state.gold = 1e9;
    placeTower(state, id, { x: 3, y: 4 });
    const tower = state.towers[0];
    tower.level = level;
    tower.value = 321;
    tower.targetingMode = 'closest';
    tower.cooldown = 99;
    tower.lastFireTime = 5;
    state.gold = cost - 1;
    check(!promoteTower(state, tower.uid) && tower.towerId === id && tower.value === 321,
      `${id}: rejected promotion mutation`);
    state.gold = cost;
    check(promoteTower(state, tower.uid), `${id}: promote any level ${level}`);
    check(tower.towerId === next && tower.level === 0 && tower.cooldown === 0,
      `${id}: new-tier reset/readiness`);
    check(state.gold === 0 && tower.value === 321 + cost && tower.targetingMode === 'closest',
      `${id}: preserve aged value and targeting`);
    check(towerStats(tower).damage === expected[next][4], `${id}: old enhancements survived`);
    const before = tower.value;
    const gold = state.gold;
    sellTower(state, tower.uid);
    check(state.gold === gold + before && state.towers.length === 0,
      `${id}: sell current aged value`);
  }
}
const legacy = createGame();
legacy.gold = 1e9;
placeTower(legacy, 'canon', { x: 3, y: 4 });
const tower = legacy.towers[0];
check(upgradeTower(legacy, tower.uid) && tower.towerId === 'canon' && tower.level === 1,
  'legacy wrapper enhances before max');
tower.level = 9;
check(upgradeTower(legacy, tower.uid) && tower.towerId === 'dualCanon' && tower.level === 0,
  'legacy wrapper promotes at max');
check(TOWERS.dualCanon.shotsPerFire === 1, 'DualCanon fires one alternating shot per reload');
const cadence = createGame();
cadence.gold = 1e9;
placeTower(cadence, 'dualCanon', { x: 3, y: 4 });
const dual = cadence.towers[0];
const target = {
  uid: 'cadence-target', id: 'soldier' as const, hp: 1e9, maxHp: 1e9, speed: 0,
  pos: { x: dual.worldX + 70, y: dual.worldY },
  path: [{ x: dual.worldX, y: dual.worldY }, { x: dual.worldX + 70, y: dual.worldY }],
  pathIdx: 1, pathProgress: 1,
};
cadence.enemies = [target];
check(dual.lastFireTime === undefined, 'DualCanon has no fire event before first tick');
tick(cadence, 0);
check(dual.lastFireTime === undefined && cadence.projectiles.length === 0, 'DualCanon must wait for initial Aimer refresh');
tick(cadence, .125);
check(dual.lastFireTime === .125 && cadence.projectiles.length === 1,
  'DualCanon first reload emits exactly one shot');
const firstProjectileUid = cadence.projectiles[0].uid;
tick(cadence, .25);
check(dual.lastFireTime === .125 && cadence.projectiles.every(p => p.uid === firstProjectileUid),
  'DualCanon fired before reload');
tick(cadence, .234375);
check(dual.lastFireTime === .125, 'DualCanon fired just before reload boundary');
tick(cadence, .015625);
check(dual.lastFireTime === .625
  && cadence.projectiles.filter(p => p.uid !== firstProjectileUid).length === 1,
  'DualCanon second reload emits exactly one shot');
console.log(`Tower progression passed: ${checks} checks, 12 source-defined models, 24 promotions.`);
