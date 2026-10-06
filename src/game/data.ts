import type { TowerSpec, EnemySpec, WaveSpec, TowerId, EnemyId } from './types';

// ── Economy constants ─────────────────────────────────────────────────────
export const START_GOLD = 500;
export const START_LIVES = 20;
export const AGING_FACTOR = 0.97;
export const WAVE_BASE_HEALTH = 300; // soldier hp at w1
export const CELL_PX = 28; // pixels per grid cell
// Spawn targeting grace lasts 1s.
export const DEFAULT_SPAWN_TARGET_GRACE_SECONDS = 1.0;

// ── Damage multipliers ────────────────────────────────────────────────────
export function damageMul(
  dmgType: string,
  weak: string[],
  strong: string[]
): number {
  if (weak.includes(dmgType)) return 3.0;
  if (strong.includes(dmgType)) return 0.33;
  return 1.0;
}

// ── Tower roster ──────────────────────────────────────────────────────────
export const TOWERS: Record<TowerId, TowerSpec> = {
  canon: {
    id: 'canon', name: 'Canon', cost: 100, damage: 100, range: 2.5, reload: 1.0,
    damageType: 'Bullet', maxLevel: 10, enhanceCost: 50, enhanceBase: 1.2, upgradeLevel: 1,
    dmgPerLevel: 40, rangePerLevel: 0.05, reloadPerLevel: 0.05,
    upgradeCostToNext: 5600,
  },
  dualCanon: {
    id: 'dualCanon', name: 'Dual Canon', cost: 5700, damage: 3400, range: 3.0, reload: 0.5,
    damageType: 'Bullet', maxLevel: 10, enhanceCost: 470, enhanceBase: 1.4, upgradeLevel: 2,
    dmgPerLevel: 160, rangePerLevel: 0.05, reloadPerLevel: 0.03,
    upgradeCostToNext: 88500,
    shotsPerFire: 1,
  },
  machineGun: {
    id: 'machineGun', name: 'Machine Gun', cost: 94200, damage: 20000, range: 3.5, reload: 0.15,
    damageType: 'Bullet', maxLevel: 15, enhanceCost: 750, enhanceBase: 1.5, upgradeLevel: 3,
    dmgPerLevel: 120, rangePerLevel: 0.05, reloadPerLevel: 0.005,
    upgradeCostToNext: null,
  },
  simpleLaser: {
    id: 'simpleLaser', name: 'Simple Laser', cost: 150, damage: 230, range: 3.0, reload: 1.5,
    damageType: 'Laser', maxLevel: 10, enhanceCost: 50, enhanceBase: 1.2, upgradeLevel: 1,
    dmgPerLevel: 40, rangePerLevel: 0.05, reloadPerLevel: 0.10,
    upgradeCostToNext: 7000,
  },
  bouncingLaser: {
    id: 'bouncingLaser', name: 'Bouncing Laser', cost: 7150, damage: 4300, range: 3.0, reload: 1.5,
    damageType: 'Laser', maxLevel: 10, enhanceCost: 580, enhanceBase: 1.4, upgradeLevel: 2,
    dmgPerLevel: 160, rangePerLevel: 0.05, reloadPerLevel: 0.10,
    upgradeCostToNext: 96450,
    bounces: 4, bounceRange: 2.0,
  },
  straightLaser: {
    id: 'straightLaser', name: 'Straight Laser', cost: 103600, damage: 44000, range: 3.0, reload: 3.0,
    damageType: 'Laser', maxLevel: 15, enhanceCost: 950, enhanceBase: 1.5, upgradeLevel: 3,
    dmgPerLevel: 410, rangePerLevel: 0.07, reloadPerLevel: 0.07,
    upgradeCostToNext: null,
    pierces: true,
  },
  mortar: {
    id: 'mortar', name: 'Mortar', cost: 250, damage: 100, range: 2.5, reload: 2.0,
    damageType: 'Explosive', maxLevel: 10, enhanceCost: 125, enhanceBase: 1.2, upgradeLevel: 1,
    dmgPerLevel: 60, rangePerLevel: 0.05, reloadPerLevel: 0.05,
    upgradeCostToNext: 10000,
    splashRadius: 1.5, splashPerLevel: 0.05,
  },
  mineLayer: {
    id: 'mineLayer', name: 'Mine Layer', cost: 10250, damage: 3100, range: 2.5, reload: 2.5,
    damageType: 'Explosive', maxLevel: 10, enhanceCost: 750, enhanceBase: 1.4, upgradeLevel: 2,
    dmgPerLevel: 270, rangePerLevel: 0, reloadPerLevel: 0.05,
    upgradeCostToNext: 102850,
    splashRadius: 2.0, splashPerLevel: 0.05,
    placesMines: true,
  },
  rocketLauncher: {
    id: 'rocketLauncher', name: 'Rocket Launcher', cost: 113100, damage: 48000, range: 3.0, reload: 3.0,
    damageType: 'Explosive', maxLevel: 15, enhanceCost: 950, enhanceBase: 1.5, upgradeLevel: 3,
    dmgPerLevel: 410, rangePerLevel: 0.10, reloadPerLevel: 0.07,
    upgradeCostToNext: null,
    splashRadius: 1.7, splashPerLevel: 0.05,
    tracking: true,
  },
  glueTower: {
    id: 'glueTower', name: 'Glue Tower', cost: 500, damage: 0, range: 1.5, reload: 2.0,
    damageType: 'Glue', maxLevel: 5, enhanceCost: 100, enhanceBase: 1.2, upgradeLevel: 1,
    dmgPerLevel: 0, rangePerLevel: 0.10, reloadPerLevel: 0,
    upgradeCostToNext: 800,
    slowFactor: 1.2, slowFactorPerLevel: 0.2, slowDuration: 1.5, aoeRadius: 1.0,
  },
  glueGun: {
    id: 'glueGun', name: 'Glue Gun', cost: 1300, damage: 0, range: 2.5, reload: 3.0,
    damageType: 'Glue', maxLevel: 5, enhanceCost: 200, enhanceBase: 1.2, upgradeLevel: 2,
    dmgPerLevel: 0, rangePerLevel: 0.20, reloadPerLevel: 0,
    upgradeCostToNext: 1700,
    slowFactor: 1.2, slowFactorPerLevel: 0.3, slowDuration: 2.5, aoeRadius: 1.0,
  },
  teleporter: {
    id: 'teleporter', name: 'Teleporter', cost: 3000, damage: 0, range: 3.5, reload: 5.0,
    damageType: 'None', maxLevel: 5, enhanceCost: 2000, enhanceBase: 1.2, upgradeLevel: 3,
    dmgPerLevel: 0, rangePerLevel: 0, reloadPerLevel: 0.5,
    upgradeCostToNext: null,
    teleportBack: 15, teleportPerLevel: 5,
  },
};

// Ordered list for UI (tower picker) — all 12, used internally
export const TOWER_ORDER: TowerId[] = [
  'canon', 'dualCanon', 'machineGun',
  'simpleLaser', 'bouncingLaser', 'straightLaser',
  'mortar', 'mineLayer', 'rocketLauncher',
  'glueTower', 'glueGun', 'teleporter',
];

// Only the 4 base towers are directly buyable; the rest are upgrade-only
export const BASE_TOWER_ORDER: TowerId[] = ['canon', 'simpleLaser', 'mortar', 'glueTower'];

// Upgrade graph: towerId -> next tier towerId
export const UPGRADE_GRAPH: Partial<Record<TowerId, TowerId>> = {
  canon: 'dualCanon',
  dualCanon: 'machineGun',
  simpleLaser: 'bouncingLaser',
  bouncingLaser: 'straightLaser',
  mortar: 'mineLayer',
  mineLayer: 'rocketLauncher',
  glueTower: 'glueGun',
  glueGun: 'teleporter',
};

// ── Enemy roster ──────────────────────────────────────────────────────────
export const ENEMIES: Record<EnemyId, EnemySpec> = {
  soldier: {
    id: 'soldier', name: 'Soldier', hp: 300, speed: 1.0, reward: 10,
    weakAgainst: [], strongAgainst: [],
  },
  blob: {
    id: 'blob', name: 'Blob', hp: 600, speed: 0.5, reward: 20,
    weakAgainst: ['Explosive'], strongAgainst: ['Bullet'],
  },
  sprinter: {
    id: 'sprinter', name: 'Sprinter', hp: 200, speed: 3.0, reward: 15,
    weakAgainst: ['Explosive'], strongAgainst: ['Laser'],
  },
  flyer: {
    id: 'flyer', name: 'Flyer', hp: 400, speed: 1.3, reward: 30,
    weakAgainst: ['Laser', 'Bullet'], strongAgainst: ['Glue'],
    flying: true,
  },
  healer: {
    id: 'healer', name: 'Healer', hp: 400, speed: 1.2, reward: 30,
    weakAgainst: ['Laser', 'Bullet'], strongAgainst: [],
    heals: true, healRadius: 0.7, healPct: 0.10, healInterval: 5,
  },
  boss: {
    id: 'boss', name: 'Warlord', hp: 4000, speed: 0.5, reward: 300,
    weakAgainst: [], strongAgainst: ['Glue'],
  },
  brute: {
    id: 'brute', name: 'Brute', hp: 1200, speed: 0.65, reward: 35,
    weakAgainst: [], strongAgainst: [], visualScale: 1.18,
  },
  shieldbearer: {
    id: 'shieldbearer', name: 'Shieldbearer', hp: 650, speed: 0.85, reward: 25,
    weakAgainst: ['Explosive'], strongAgainst: ['Bullet', 'Laser'], visualScale: 1.08,
  },
  splitter: {
    id: 'splitter', name: 'Splitter', hp: 450, speed: 1.0, reward: 24,
    weakAgainst: ['Laser'], strongAgainst: [], splitInto: 'swarm', splitCount: 2,
  },
  swarm: {
    id: 'swarm', name: 'Swarm', hp: 90, speed: 2.6, reward: 4,
    weakAgainst: ['Explosive'], strongAgainst: [], visualScale: 0.65,
  },
  support: {
    id: 'support', name: 'Support', hp: 350, speed: 1.0, reward: 25,
    weakAgainst: ['Laser'], strongAgainst: [], speedAuraRadius: 1.5, speedAuraMultiplier: 1.2,
  },
};

// ── Base waves: ordered individual entries, not temporal spawn groups ──
function formation(id: EnemyId, count: number, delay: number) {
  return Array.from({ length: count }, (_, index) => ({
    id, count: 1, delay: index === 0 ? delay : 0, offset: index === 0 ? 0 : 1.1, pathIndex: 0,
  }));
}

export const WAVES: WaveSpec[] = [
  { waveReward: 100, extend: 2, maxExtend: 8, enemies: [...formation('soldier', 6, 9)] },
  { waveReward: 100, extend: 2, maxExtend: 4, enemies: [...formation('soldier', 6, 9), ...formation('soldier', 6, 9)] },
  { waveReward: 120, extend: 1, maxExtend: 4, enemies: [...formation('soldier', 6, 9), ...formation('blob', 6, 6)] },
  { waveReward: 120, extend: 1, maxExtend: 3, enemies: [...formation('soldier', 6, 9), ...formation('blob', 6, 6), ...formation('soldier', 6, 9)] },
  { waveReward: 150, extend: 1, maxExtend: 3, enemies: [...formation('sprinter', 6, 10), ...formation('soldier', 6, 2), ...formation('blob', 6, 2)] },
  { waveReward: 150, extend: 1, maxExtend: 3, enemies: [...formation('soldier', 6, 9), ...formation('sprinter', 6, 2), ...formation('blob', 6, 2)] },
  { waveReward: 170, extend: 1, maxExtend: 4, enemies: [...formation('flyer', 5, 9), ...formation('soldier', 6, 9)] },
  { waveReward: 170, extend: 1, maxExtend: 3, enemies: [...formation('sprinter', 6, 9), ...formation('blob', 6, 4), ...formation('flyer', 6, 9)] },
  { waveReward: 190, extend: 1, maxExtend: 2, enemies: [...formation('sprinter', 9, 9), ...formation('blob', 9, 2), ...formation('flyer', 9, 4)] },
  { waveReward: 190, extend: 1, maxExtend: 2, enemies: [...formation('healer', 6, 9), ...formation('sprinter', 9, 4), ...formation('blob', 9, 9)] },
  { waveReward: 240, extend: 1, maxExtend: 4, enemies: [...formation('healer', 6, 9), ...formation('healer', 6, 9)] },
  { waveReward: 240, extend: 1, maxExtend: 4, enemies: [...formation('healer', 6, 9), ...formation('sprinter', 9, 9)] },
  { waveReward: 240, extend: 1, maxExtend: 3, enemies: [...formation('healer', 4, 9), ...formation('soldier', 6, 2), ...formation('healer', 4, 9), ...formation('soldier', 6, 2)] },
  { waveReward: 240, extend: 1, maxExtend: 3, enemies: [...formation('healer', 4, 9), ...formation('blob', 6, 2), ...formation('flyer', 6, 2)] },
  { waveReward: 300, extend: 1, maxExtend: 2, enemies: [...formation('blob', 6, 9), ...formation('healer', 4, 2), ...formation('soldier', 9, 2), ...formation('flyer', 9, 2), ...formation('sprinter', 9, 2), ...formation('healer', 4, 2)] },
];

// ── Canvas shape mapping (damageType → canvas drawing style) ─────────────
export const TOWER_SHAPES: Record<string, { shape: string; color: string }> = {
  canon:         { shape: 'circle',   color: '#2b2b2b' },
  dualCanon:     { shape: 'circle',   color: '#595959' },
  machineGun:    { shape: 'circle',   color: '#8a4a4a' },
  simpleLaser:   { shape: 'diamond',  color: '#595959' },
  bouncingLaser: { shape: 'diamond',  color: '#2b2b2b' },
  straightLaser: { shape: 'diamond',  color: '#8a4a4a' },
  mortar:        { shape: 'pentagon', color: '#595959' },
  mineLayer:     { shape: 'pentagon', color: '#2b2b2b' },
  rocketLauncher:{ shape: 'pentagon', color: '#8a4a4a' },
  glueTower:     { shape: 'hex',      color: '#6b7a5a' },
  glueGun:       { shape: 'hex',      color: '#4a6a5a' },
  teleporter:    { shape: 'star',     color: '#a58a4a' },
};

export const ENEMY_SHAPES: Record<string, { shape: string; color: string }> = {
  soldier:  { shape: 'circle',   color: '#595959' },
  blob:     { shape: 'circle',   color: '#6b7a5a' }, // larger circle drawn bigger
  sprinter: { shape: 'triangle', color: '#2b2b2b' },
  flyer:    { shape: 'triangle', color: '#4a5a8a' }, // elevated, shadow below
  healer:   { shape: 'circle',   color: '#8a6b4a' },
  boss:     { shape: 'hex',      color: '#1a1a1a' }, // large dark hexagon
  brute:    { shape: 'square',   color: '#66584b' },
  shieldbearer: { shape: 'hex',  color: '#526779' },
  splitter: { shape: 'diamond', color: '#79638a' },
  swarm:    { shape: 'triangle', color: '#827044' },
  support:  { shape: 'circle',   color: '#487567' },
};
