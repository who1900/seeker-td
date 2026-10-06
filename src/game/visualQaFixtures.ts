import type { BattleState, Enemy, EnemyId, TowerId } from './types';
import { CELL_PX, ENEMIES, TOWERS, UPGRADE_GRAPH } from './data';
import { cellToWorld, createGame, enhanceTower, placeTower, promoteTower, startWave, towerStats } from './engine';

export const QA_TOWER_IDS: readonly TowerId[] = [
  'canon', 'dualCanon', 'machineGun',
  'simpleLaser', 'bouncingLaser', 'straightLaser',
  'mortar', 'mineLayer', 'rocketLauncher',
  'glueTower', 'glueGun', 'teleporter',
];

export const QA_ENEMY_IDS: readonly EnemyId[] = [
  'soldier', 'blob', 'sprinter', 'flyer', 'healer',
  'brute', 'shieldbearer', 'splitter', 'swarm', 'support', 'boss',
];

export type QaDensity = 'cluster' | 'spaced';
export const QA_DENSITIES: readonly QaDensity[] = ['cluster', 'spaced'];
export const QA_DENSITY_DESCRIPTIONS: Record<QaDensity, string> = {
  cluster: 'Six selected enemies and two soldier peers; arrivals every 0.75 seconds.',
  spaced: 'One selected enemy at route progress 6.5; selected-type arrivals every 2.5 seconds, no peers.',
};

export const QA_FIXTURE_DESCRIPTION =
  'QA-only: local gold and inflated enemy HP, default spawn grace, real engine combat. '
  + 'Density selects a cluster or one initial enemy; 48 queued arrivals follow. '
  + 'Rebuild by calling buildVisualQaFixture with the selected tower, zero-based enhancement level, enemy and density.';

export function buildVisualQaFixture(
  towerId: TowerId,
  level: number = 0,
  enemyId: EnemyId = 'soldier',
  density: QaDensity = 'cluster',
): BattleState {
  if (!QA_TOWER_IDS.includes(towerId) || !QA_ENEMY_IDS.includes(enemyId)) {
    throw new RangeError('Unknown visual QA tower or enemy');
  }
  if (!QA_DENSITIES.includes(density)) throw new RangeError('Unknown visual QA density');
  const selectedLevel = Math.max(0, Math.min(TOWERS[towerId].maxLevel - 1,
    Number.isFinite(level) ? Math.floor(level) : 0));
  const state = createGame();
  state.gold = 10_000_000; // Only this isolated state; never store or balance data.
  const baseId = QA_TOWER_IDS[Math.floor(QA_TOWER_IDS.indexOf(towerId) / 3) * 3];
  if (!placeTower(state, baseId, { x: state.entry.x - 1, y: 7 })) {
    throw new Error('Visual QA tower placement failed');
  }
  const tower = state.towers[0];
  while (tower.towerId !== towerId) {
    if (!UPGRADE_GRAPH[tower.towerId] || !promoteTower(state, tower.uid)) {
      throw new Error('Visual QA tower promotion failed');
    }
  }
  for (let i = 0; i < selectedLevel; i++) {
    if (!enhanceTower(state, tower.uid)) throw new Error('Visual QA enhancement failed');
  }
  startWave(state);
  const path = state.currentPath?.map(cellToWorld);
  if (!path || path.length < 10) throw new Error('Visual QA route unavailable');

  // QA HP sustains repeated attacks even at maximum enhancement; native speed/resistance stay intact.
  const healthModifier = Math.max(100, towerStats(tower).damage * 1000 / ENEMIES[enemyId].hp);
  state.time = 2;
  state.spawnElapsed = 2;
  const ids: EnemyId[] = density === 'spaced'
    ? [enemyId] : [...Array<EnemyId>(6).fill(enemyId), 'soldier', 'soldier'];
  state.enemies = ids.map((id, i): Enemy => {
    const spec = ENEMIES[id];
    const progress = density === 'spaced' ? 6.5 : 5.5 + i * 0.25;
    const pathIdx = Math.floor(progress) + 1;
    const pathProgress = progress - Math.floor(progress);
    const from = path[pathIdx - 1];
    const to = path[pathIdx];
    const enemy: Enemy = {
      uid: String(state.uidCounter++), id,
      hp: spec.hp * healthModifier, maxHp: spec.hp * healthModifier,
      speed: spec.speed * CELL_PX,
      pos: { x: from.x + (to.x - from.x) * pathProgress, y: from.y + (to.y - from.y) * pathProgress },
      waveIndex: state.waveIndex, spawnedAt: 0,
      healthModifier, reward: spec.reward,
      paletteVariant: 0, visualScale: Math.max(0.6, Math.min(1.35, spec.visualScale ?? 1)),
    };
    if (spec.flying) {
      enemy.flyProgress = progress / (path.length - 1);
    } else {
      enemy.path = path.map(point => ({ ...point }));
      enemy.pathIdx = pathIdx;
      enemy.pathProgress = pathProgress;
    }
    if (spec.heals) enemy.healCooldown = spec.healInterval ?? 5;
    return enemy;
  });
  state.spawnQueue = Array.from({ length: 48 }, (_, i) => {
    const id = density === 'cluster' && i % 4 === 3 ? 'soldier' : enemyId;
    return { id, delay: state.spawnElapsed + (density === 'spaced' ? 2.5 : 0.75) * (i + 1),
      waveIndex: state.waveIndex, healthModifier, reward: ENEMIES[id].reward };
  });
  return state;
}
