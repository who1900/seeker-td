import type { BattleState } from '../game/types';
import { createGame } from '../game/engine';
import type { RunSession } from './runs';

export const CHECKPOINT_ENGINE_VERSION = 'seeker-td-battle-v1';
export type RunCheckpoint = {
  version: 1;
  engineVersion: string;
  runId: string;
  battle: BattleState;
  activeSeconds: number;
  planningSeconds: number;
  clockStarted: boolean;
  backlogSeconds?: number;
  speed: 1 | 2 | 4;
  placedTowerTypes: string[];
  savedAt: number;
};

export class CheckpointRecoveryError extends Error {
  constructor(message = 'Battle checkpoint is invalid or incompatible; original save retained.') {
    super(message);
    this.name = 'CheckpointRecoveryError';
  }
}

const towers = ['canon', 'dualCanon', 'machineGun', 'simpleLaser', 'bouncingLaser', 'straightLaser',
  'mortar', 'mineLayer', 'rocketLauncher', 'glueTower', 'glueGun', 'teleporter'];
const enemies = ['soldier', 'blob', 'sprinter', 'flyer', 'healer', 'brute', 'shieldbearer', 'splitter', 'swarm', 'support', 'boss'];
const targeting = ['first', 'last', 'strongest', 'weakest', 'closest'];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'
  && Object.getPrototypeOf(v) === Object.prototype;
const finite = (v: unknown, min = 0, max = 1e12): v is number => typeof v === 'number'
  && Number.isFinite(v) && v >= min && v <= max;
const integer = (v: unknown, min = 0, max = 1e9) => finite(v, min, max) && Number.isSafeInteger(v);
const vector = (v: unknown) => record(v) && finite(v.x, -1e7, 1e7) && finite(v.y, -1e7, 1e7);
const list = (v: unknown, test: (item: unknown) => boolean, max = 20000): boolean =>
  Array.isArray(v) && v.length <= max && Array.from(v).every(test);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512;
const numericFields = new Set(('x y gold lives waveIndex completedWaves nextWaveReadyAt spawnTargetGraceSeconds spawnElapsed '
  + 'gridW gridH waveBaseHealth creditsEarned speed time uidCounter lifeFlashUntil level value cooldown worldX worldY '
  + 'targetRefreshRemaining glueReleaseAt glueScanRemaining aimAngle lastFireTime nextBarrel mineReleaseAt rocketLoadRemaining '
  + 'damage splashRadius hp maxHp waveIndex spawnedAt rewardOverride reward healthModifier paletteVariant visualScale pathIdx '
  + 'pathProgress flyProgress slowUntil slowFactor healCooldown hitFlash glueSpeedMultiplier stunUntil teleportingUntil '
  + 'multiplier startedAt expiresAt intensity duration launchedAt radius nextObserveAt distance anchorPathIdx anchorPathProgress '
  + 'anchorFlyProgress destinationPathIdx destinationPathProgress destinationFlyProgress progress sourceSocket life nextTriggerAt '
  + 'r maxLife delay bossHpMul offset pathIndex scheduledDelay vx vy').split(' '));
const booleanFields = new Set(('waveActive spawning defaultTargetLock paused gameOver victory prevWaveStillSpawning '
  + 'isBossWave targetLock wasTeleported landed').split(' '));
const vectorFields = new Set(['cell', 'pos', 'from', 'to', 'destination', 'direction', 'entry', 'exit']);
const stringFields = new Set(['uid', 'sourceTowerUid', 'targetUid', 'authoritativeUid', 'gluePathKey', 'mazePathKey', 'mazeGridKey', 'color']);
const indexFields = new Set(['pathIdx', 'anchorPathIdx', 'destinationPathIdx', 'pathIndex', 'waveIndex',
  'level', 'paletteVariant', 'nextBarrel', 'uidCounter', 'gridW', 'gridH', 'completedWaves', 'sourceSocket']);

function safeTree(value: unknown, depth = 0, budget = { left: 500000 }): boolean {
  if (--budget.left < 0 || depth > 24) return false;
  if (value === undefined || value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return finite(value, -8.64e15, 8.64e15);
  if (typeof value === 'string') return value.length <= 100000;
  if (Array.isArray(value)) return value.length <= 20000 && value.every(v => safeTree(v, depth + 1, budget));
  if (!record(value) || Reflect.ownKeys(value).length > 20000) return false;
  return Reflect.ownKeys(value).every(key => {
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) return false;
    const item = descriptor.value;
    if (item !== undefined) {
      if (numericFields.has(key) && !finite(item, -1e12)) return false;
      if (indexFields.has(key) && !integer(item, key === 'waveIndex' ? -1 : 0)) return false;
      if (booleanFields.has(key) && typeof item !== 'boolean') return false;
      if (vectorFields.has(key) && !vector(item)) return false;
      if (stringFields.has(key) && (typeof item !== 'string' || item.length > 100000)) return false;
      if (['pathProgress', 'flyProgress', 'anchorPathProgress', 'anchorFlyProgress', 'destinationPathProgress',
        'destinationFlyProgress'].includes(key) && !finite(item, 0, 1)) return false;
    }
    return safeTree(item, depth + 1, budget);
  });
}

function entity(value: unknown, numbers: string[], vectors: string[], strings: string[] = ['uid']): boolean {
  return record(value) && numbers.every(k => finite(value[k], -1e9))
    && vectors.every(k => vector(value[k])) && strings.every(k => text(value[k]));
}

function validBattle(b: unknown): b is BattleState {
  if (!record(b) || !safeTree(b)) return false;
  const rng = b.combatRandom;
  if (!record(rng) || Object.keys(rng).length !== 4 || rng.algorithm !== 'mulberry32' || rng.version !== 1
    || !integer(rng.state, 0, 0xffffffff) || !integer(rng.cursor, 0, 0xfffffffe)) return false;
  if (!integer(b.gridW, 2, 128) || !integer(b.gridH, 2, 128)
    || !list(b.grid, row => list(row, c => typeof c === 'boolean', b.gridW as number)
      && (row as unknown[]).length === b.gridW, b.gridH as number)
    || (b.grid as unknown[]).length !== b.gridH) return false;
  const cell = (v: unknown) => vector(v) && record(v) && integer(v.x, 0, (b.gridW as number) - 1)
    && integer(v.y, 0, (b.gridH as number) - 1);
  if (!cell(b.entry) || !cell(b.exit) || (b.currentPath !== null && !list(b.currentPath, cell))) return false;
  if (!['gold', 'lives', 'completedWaves', 'uidCounter'].every(k => integer(b[k]))
    || !integer(b.waveIndex, -1) || !['nextWaveReadyAt', 'spawnTargetGraceSeconds', 'spawnElapsed',
      'waveBaseHealth', 'creditsEarned', 'time'].every(k => finite(b[k])) || !finite(b.lifeFlashUntil, -1)
    || ![1, 2, 4].includes(b.speed as number) || !targeting.includes(b.defaultTargetingMode as string)
    || !['waveActive', 'spawning', 'defaultTargetLock', 'paused', 'gameOver', 'victory',
      'prevWaveStillSpawning', 'isBossWave'].every(k => typeof b[k] === 'boolean')) return false;
  if (!['clearedWaveIndices', 'pendingWaveIndices', 'leakedWaveIndices', 'rewardedWaveIndices']
    .every(k => list(b[k], n => integer(n))) || !record(b.waveRewards)
    || !Object.entries(b.waveRewards).every(([k, v]) => /^\d+$/.test(k) && finite(v))
    || !list(b.soundQueue, text, 1000)) return false;
  if (!list(b.towers, t => entity(t, ['level', 'value', 'cooldown', 'worldX', 'worldY'], ['cell']) && record(t)
    && towers.includes(t.towerId as string) && targeting.includes(t.targetingMode as string)
    && cell(t.cell) && integer(t.level, 0, 100) && (t.glueTargets === undefined || list(t.glueTargets, vector))
    && (t.loadedRocket === undefined || record(t.loadedRocket) && finite(t.loadedRocket.damage)
      && finite(t.loadedRocket.splashRadius) && ['Bullet', 'Laser', 'Explosive', 'Glue', 'None'].includes(t.loadedRocket.damageType as string)), 16384)
    || !list(b.enemies, e => entity(e, ['hp', 'maxHp', 'speed'], ['pos']) && record(e)
      && enemies.includes(e.id as string) && (e.path === undefined || list(e.path, vector))
      && (e.pathIdx === undefined || integer(e.pathIdx, 0, (e.path as unknown[] | undefined)?.length ?? 20000))
      && (e.speedEffects === undefined || list(e.speedEffects, s => entity(s,
        ['multiplier', 'startedAt', 'expiresAt'], [], ['uid', 'sourceTowerUid']) && record(s) && s.kind === 'laserStun')))
    || !list(b.spawnQueue, e => record(e) && enemies.includes(e.id as string) && finite(e.delay))) return false;
  const damage = ['Bullet', 'Laser', 'Explosive', 'Glue', 'None'];
  const owned = (v: unknown, nums: string[], points: string[]) => entity(v, nums, points, ['uid', 'sourceTowerUid'])
    && record(v) && towers.includes(v.towerId as string);
  return list(b.projectiles, p => entity(p, ['progress', 'speed', 'damage', 'life'], ['from', 'to'])
      && record(p) && ['bullet', 'laser', 'rocket', 'glue', 'teleport', 'mine'].includes(p.kind as string)
      && damage.includes(p.damageType as string))
    && list(b.shots, s => owned(s, ['damage', 'splashRadius', 'speed', 'launchedAt'], ['from', 'pos', 'to', 'direction'])
      && record(s) && ['cannon', 'machineGun', 'mortar', 'rocket'].includes(s.kind as string) && damage.includes(s.damageType as string))
    && list(b.mines, m => owned(m, ['damage', 'splashRadius', 'launchedAt', 'nextTriggerAt'], ['from', 'pos', 'to'])
      && record(m) && typeof m.landed === 'boolean' && damage.includes(m.damageType as string))
    && list(b.glueShots, g => owned(g, ['speed', 'intensity', 'duration', 'launchedAt'], ['from', 'to', 'pos']))
    && list(b.gluePatches, g => owned(g, ['radius', 'intensity', 'startedAt', 'expiresAt', 'nextObserveAt'], ['pos'])
      && record(g) && list(g.enemyUids, text))
    && list(b.teleports, t => entity(t, ['startedAt', 'expiresAt', 'distance'], ['from', 'to', 'destination'],
      ['uid', 'sourceTowerUid', 'targetUid']) && record(t) && (t.anchorPath === undefined || list(t.anchorPath, vector)))
    && list(b.effects, e => entity(e, ['x', 'y', 'life', 'maxLife'], []) && record(e)
      && ['boom', 'chain', 'ring', 'heal', 'glue', 'teleport', 'laser_flash', 'bullet_spark', 'glue_splat',
        'boom_big', 'chain_bounce', 'chain_straight'].includes(e.kind as string)
      && (e.pts === undefined || list(e.pts, vector)))
    && list(b.particles, p => entity(p, ['x', 'y', 'vx', 'vy', 'life', 'maxLife', 'r'], [], ['color']), 1000);
}

export function validateRunCheckpoint(value: unknown, run?: RunSession | string): value is RunCheckpoint {
  try {
    if (!record(value) || !safeTree(value) || value.version !== 1 || value.engineVersion !== CHECKPOINT_ENGINE_VERSION
      || typeof value.runId !== 'string' || !/^local-[1-9]\d*$/.test(value.runId)
      || (run && value.runId !== (typeof run === 'string' ? run : run.id))
      || !finite(value.activeSeconds, 0, 31536000) || !finite(value.planningSeconds, 0, 31536000)
      || (value.backlogSeconds !== undefined && !finite(value.backlogSeconds, 0, 31536000))
      || typeof value.clockStarted !== 'boolean' || ![1, 2, 4].includes(value.speed as number)
      || !finite(value.savedAt, 0, 8.64e15) || !list(value.placedTowerTypes, t => towers.includes(t as string), 12)
      || !validBattle(value.battle) || value.battle.speed !== value.speed) return false;
    if (run && typeof run !== 'string' && run.config.access === 'ranked' && run.rulesVersion === 'local-ranked-v1'
      && value.speed !== 1) return false;
    return true;
  } catch { return false; }
}

export function createRunCheckpoint(input: Omit<RunCheckpoint, 'version' | 'engineVersion' | 'savedAt'>
  & { savedAt?: number }): RunCheckpoint {
  const checkpoint = { ...input, version: 1 as const, engineVersion: CHECKPOINT_ENGINE_VERSION,
    savedAt: input.savedAt ?? Date.now() };
  if (!validateRunCheckpoint(checkpoint)) throw new CheckpointRecoveryError();
  const copy = structuredClone(checkpoint);
  copy.battle.paused = true;
  return copy;
}

export function restoreRunCheckpoint(value: unknown, run?: RunSession | string): RunCheckpoint {
  if (!validateRunCheckpoint(value, run)) throw new CheckpointRecoveryError();
  const copy = structuredClone(value);
  copy.battle.paused = true;
  return copy;
}

export function createInitialRunCheckpoint(run: RunSession, now = Date.now()): RunCheckpoint {
  const battle = createGame(undefined, undefined, undefined, { combatSeed: run.seed ?? 0 });
  battle.speed = run.speed ?? 1;
  return createRunCheckpoint({ runId: run.id, battle, activeSeconds: 0, planningSeconds: 0,
    clockStarted: false, speed: (run.speed ?? 1), placedTowerTypes: [], savedAt: now });
}
