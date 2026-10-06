import { ENEMIES, WAVES } from './data';
import type { BattleState, EnemyId, SpawnEntry, WaveEntry } from './types';

export interface GeneratedWave {
  enemies: WaveEntry[];
  waveReward: number;
  isBossWave: boolean;
  iteration: number;
  extend: number;
  healthModifier: number;
  rewardModifier: number;
  baseHealth: number;
}

export function generateWave(index: number, creditsEarned: number): GeneratedWave {
  if (!Number.isSafeInteger(index) || index < 0 || !Number.isFinite(creditsEarned) || creditsEarned < 0) {
    throw new RangeError('wave index and earned credits must be finite nonnegative values');
  }
  const iteration = Math.floor(index / WAVES.length) + 1;
  const template = WAVES[index % WAVES.length];
  const extend = Math.min((iteration - 1) * template.extend, template.maxExtend);
  let enemies = Array.from({ length: extend + 1 }, () => template.enemies.map(e => ({ ...e }))).flat();
  const isBossWave = index >= WAVES.length && (index + 1) % 10 === 0;
  if (index >= WAVES.length) {
    // SeekDef additions begin after the unmodified first source cycle.
    const originals: EnemyId[] = ['soldier', 'blob', 'sprinter', 'flyer', 'healer'];
    const additions: EnemyId[] = ['brute', 'shieldbearer', 'splitter', 'swarm', 'support'];
    for (const id of originals) {
      if (!enemies.some(e => e.id === id)) enemies.push({ id, count: 2, delay: 4 });
    }
    for (const id of additions.slice(0, Math.min(5, index - WAVES.length + 1))) {
      enemies.push({ id, count: id === 'swarm' ? 6 : 2, delay: 2 });
    }
    if (isBossWave) enemies.push({ id: 'boss', count: 1, delay: 2 });
    let budget = 250;
    enemies = enemies.map(e => {
      const count = Math.min(e.count, budget);
      budget -= count;
      return { ...e, count };
    }).filter(e => e.count > 0);
  }
  const baseHealth = enemies.reduce((sum, e) => sum + ENEMIES[e.id].hp * e.count, 0);
  const damagePossible = 20 * creditsEarned + 8e-4 * Math.pow(creditsEarned, 1.9);
  const healthModifier = Math.max(0.5, damagePossible / baseHealth);
  const rewardModifier = Math.max(1, 0.4 * Math.sqrt(healthModifier));
  return { enemies, waveReward: template.waveReward * iteration, isBossWave, iteration, extend, baseHealth, healthModifier, rewardModifier };
}

export function waveSpawnQueue(wave: GeneratedWave, index: number): SpawnEntry[] {
  let delayTicks = 0;
  let offset = 0;
  let entryIndex = 0;
  const queue: SpawnEntry[] = [];
  for (const entry of wave.enemies) {
    for (let i = 0; i < entry.count; i++) {
      const delay = i === 0 ? entry.delay ?? 0 : 0;
      const stepOffset = i === 0 ? entry.offset ?? 0 : 1.1;
      offset = Math.abs(delay) <= 0.1 ? offset + stepOffset : stepOffset;
      if (entryIndex++ > 0) delayTicks += Math.round(delay * 30);
      const scheduledDelay = delayTicks / 30;
      // One-entrance adaptation: virtual offscreen travel becomes arrival delay in cells/s.
      // It is not an offset-as-seconds conversion; grace starts only upon actual arrival.
      queue.push({ id: entry.id, waveIndex: index, scheduledDelay, offset, pathIndex: entry.pathIndex ?? 0,
        delay: scheduledDelay + offset / ENEMIES[entry.id].speed,
        healthModifier: wave.healthModifier,
        reward: Math.round(ENEMIES[entry.id].reward * wave.rewardModifier) });
    }
  }
  return queue.sort((a, b) => a.delay - b.delay);
}

export function nextWaveWait(state: BattleState): number {
  return Math.max(0, state.nextWaveReadyAt - state.time);
}

export function nextWaveReady(state: BattleState): boolean {
  return !state.gameOver && !state.victory && !state.paused && state.lives > 0 && nextWaveWait(state) <= 1e-10;
}

export function earlyWaveBonus(state: BattleState): number {
  const remaining = state.enemies.reduce((sum, e) => sum + (e.hp > 0 ? e.rewardOverride ?? e.reward ?? ENEMIES[e.id].reward : 0), 0)
    + state.spawnQueue.reduce((sum, e) => sum + (e.reward ?? ENEMIES[e.id].reward), 0);
  return Math.round(3 * Math.pow(remaining, 0.6));
}

export function payWaveReward(state: BattleState, index: number): void {
  if (state.rewardedWaveIndices.includes(index) || state.waveRewards[index] === undefined) return;
  const reward = state.waveRewards[index];
  state.gold += reward;
  state.creditsEarned += reward;
  state.waveRewards[index] = 0;
  state.rewardedWaveIndices.push(index);
}
