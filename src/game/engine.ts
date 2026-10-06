import type {
  BattleState, PlacedTower, Enemy,
  TowerId, EnemyId, TargetingMode, Vec2, SpawnEntry,
} from './types';
import { TOWERS, ENEMIES, UPGRADE_GRAPH, START_GOLD, START_LIVES, AGING_FACTOR, WAVE_BASE_HEALTH, CELL_PX, DEFAULT_SPAWN_TARGET_GRACE_SECONDS } from './data';
import { createGameplayRandom } from './gameplayRandom';

const PARTICLE_MAX = 200;

function spawnParticles(
  state: BattleState,
  x: number, y: number,
  color: string,
  count: number,
  speed: number,
  r: number,
  life: number
): void {
  for (let i = 0; i < count && state.particles.length < PARTICLE_MAX; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const v = speed * (0.6 + Math.random() * 0.8);
    state.particles.push({
      x, y,
      vx: Math.cos(angle) * v,
      vy: Math.sin(angle) * v,
      life, maxLife: life,
      r: r * (0.7 + Math.random() * 0.6),
      color,
    });
  }
}
import { findPath } from './pathfinding';
import { advanceCombat, cleanOwnedCombat, launchCombat, projectCombat, sampleMineRoute, forecastPosition } from './combatShots';
import { effectiveEnemySpeed, refreshInterval, fireLaser, determineGlueTargets, launchGlue, advanceStatus, projectStatus } from './combatStatus';
import { generateWave, waveSpawnQueue, nextWaveReady, nextWaveWait, earlyWaveBonus, payWaveReward } from './waveManager';

const GRID_W = 12;
const GRID_H = 21;

// ── Helpers ───────────────────────────────────────────────────────────────
function uid(state: BattleState): string {
  return String(state.uidCounter++);
}

function cellToWorld(cell: Vec2): Vec2 {
  return { x: (cell.x + 0.5) * CELL_PX, y: (cell.y + 0.5) * CELL_PX };
}

function worldToCell(pos: Vec2): Vec2 {
  return { x: Math.floor(pos.x / CELL_PX), y: Math.floor(pos.y / CELL_PX) };
}

function dist2(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function validateSpawnGrace(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError('spawnTargetGraceSeconds must be finite and nonnegative');
  }
}

function canTowerTarget(state: BattleState, enemy: Enemy): boolean {
  return enemy.hp > 0 && (enemy.spawnedAt === undefined
    || state.time - enemy.spawnedAt >= state.spawnTargetGraceSeconds);
}

// Tower's current effective stats at its level
function towerStats(tower: PlacedTower) {
  const spec = TOWERS[tower.towerId];
  const lvl = tower.level;
  let damage = spec.damage;
  for (let level = 0; level < lvl; level++) {
    damage = Math.fround(damage + Math.fround(spec.dmgPerLevel
      * Math.fround(Math.pow(Math.fround(spec.enhanceBase), level))));
  }
  return {
    damage,
    range: (spec.range + spec.rangePerLevel * lvl) * CELL_PX,
    reload: Math.max(0.05, spec.reload - spec.reloadPerLevel * lvl),
    splashRadius: spec.splashRadius != null
      ? (spec.splashRadius + (spec.splashPerLevel ?? 0) * lvl) * CELL_PX
      : 0,
    teleportBack: spec.teleportBack != null
      ? (spec.teleportBack + (spec.teleportPerLevel ?? 0) * lvl) * CELL_PX
      : 0,
    slowFactor: (spec.slowFactor ?? 1) + (spec.slowFactorPerLevel ?? 0) * lvl,
    slowDuration: spec.slowDuration ?? 0,
    bounces: spec.bounces ?? 0,
    bounceRange: (spec.bounceRange ?? 0) * CELL_PX,
  };
}

function enemyPresentation(id: EnemyId, waveIndex: number) {
  const wave = Math.max(0, waveIndex);
  return {
    paletteVariant: Math.min(3, Math.floor(wave / 15)),
    visualScale: Math.max(0.6, Math.min(1.35,
      (ENEMIES[id].visualScale ?? 1) * (1 + Math.min(0.12, wave * 0.004)))),
  };
}

// ── Path walking ──────────────────────────────────────────────────────────
// Returns world-space position of an enemy following its personal world path.
// pathIdx = waypoint index we're heading toward.
// pathProgress = 0..1 fraction of segment pathIdx-1 → pathIdx.
function enemyWorldPos(
  enemy: Enemy,
  path: Vec2[]
): Vec2 {
  if (enemy.flyProgress !== undefined) {
    // Flyer: straight line entry→exit in world space
    // We store world positions for entry/exit in the state; they're accessible via closure
    return enemy.pos; // updated each tick
  }
  if (!path.length) return enemy.pos;
  const idx = enemy.pathIdx ?? 1;
  const prog = enemy.pathProgress ?? 0;
  if (idx >= path.length) return { ...path[path.length - 1] };
  const from = path[Math.max(0, idx - 1)];
  const to = path[idx];
  return { x: from.x + (to.x - from.x) * prog, y: from.y + (to.y - from.y) * prog };
}

// Rank ground enemies by remaining route distance, independent of route history.
// Used for targeting first/last.
function enemyPathDist(enemy: Enemy, path: Vec2[]): number {
  if (enemy.flyProgress !== undefined) return (enemy.flyProgress ?? 0) * 99999;
  path = enemy.path ?? path.map(cellToWorld);
  const idx = enemy.pathIdx ?? 1;
  const prog = enemy.pathProgress ?? 0;
  let remaining = 0;
  for (let i = Math.max(1, idx); i < path.length; i++) {
    remaining += dist2(path[i - 1], path[i]) * (i === idx ? 1 - prog : 1);
  }
  return -remaining;
}

// Total path length in pixels
function totalPathLen(path: Vec2[]): number {
  let d = 0;
  for (let i = 1; i < path.length; i++) d += dist2(cellToWorld(path[i - 1]), cellToWorld(path[i]));
  return d;
}

// ── createGame ────────────────────────────────────────────────────────────
export function createGame(gridW = GRID_W, gridH = GRID_H,
  spawnTargetGraceSeconds = DEFAULT_SPAWN_TARGET_GRACE_SECONDS, options?: { combatSeed?: number }): BattleState {
  validateSpawnGrace(spawnTargetGraceSeconds);
  if (options !== undefined && (!options || Object.getPrototypeOf(options) !== Object.prototype
    || Reflect.ownKeys(options).some(key => key !== 'combatSeed'))) throw new Error('COMBAT_RANDOM_INVALID');
  const seedDescriptor = options === undefined ? undefined : Object.getOwnPropertyDescriptor(options, 'combatSeed');
  if (seedDescriptor && !Object.prototype.hasOwnProperty.call(seedDescriptor, 'value')) throw new Error('COMBAT_RANDOM_INVALID');
  const combatRandom = seedDescriptor ? createGameplayRandom(seedDescriptor.value) : undefined;
  const grid: boolean[][] = Array.from({ length: gridH }, () => new Array(gridW).fill(false));
  const entry: Vec2 = { x: Math.floor(gridW / 2), y: 0 };
  const exit: Vec2 = { x: Math.floor(gridW / 2), y: gridH - 1 };

  // Entry and exit are never buildable — mark as blocked so placement rejects them
  // (we unblock them for pathfinding though — pathfinding uses separate logic)
  const path = findPath(grid, entry, exit);

  return {
    ...(combatRandom ? { combatRandom } : {}),
    gold: START_GOLD,
    lives: START_LIVES,
    waveIndex: -1,
    completedWaves: 0,
    clearedWaveIndices: [],
    pendingWaveIndices: [],
    leakedWaveIndices: [],
    nextWaveReadyAt: 0,
    waveRewards: {},
    rewardedWaveIndices: [],
    spawnTargetGraceSeconds,
    waveActive: false,
    spawning: false,
    spawnQueue: [],
    spawnElapsed: 0,
    towers: [],
    defaultTargetingMode: 'closest',
    defaultTargetLock: true,
    enemies: [],
    projectiles: [],
    shots: [],
    mines: [],
    glueShots: [],
    gluePatches: [],
    teleports: [],
    effects: [],
    grid,
    gridW,
    gridH,
    entry,
    exit,
    currentPath: path,
    waveBaseHealth: WAVE_BASE_HEALTH,
    creditsEarned: 0,
    paused: false,
    speed: 1,
    gameOver: false,
    victory: false,
    time: 0,
    uidCounter: 1,
    prevWaveStillSpawning: false,
    particles: [],
    lifeFlashUntil: -1,
    isBossWave: false,
    soundQueue: [],
  };
}

// ── Grid helpers ──────────────────────────────────────────────────────────
function isBuildable(state: BattleState, cell: Vec2): boolean {
  const { gridW, gridH, entry, exit } = state;
  if (cell.x < 0 || cell.y < 0 || cell.x >= gridW || cell.y >= gridH) return false;
  if (cell.x === entry.x && cell.y === entry.y) return false;
  if (cell.x === exit.x && cell.y === exit.y) return false;
  return !state.grid[cell.y][cell.x];
}

function pathExistsWithTower(state: BattleState, cell: Vec2): Vec2[] | null {
  for (const enemy of state.enemies) {
    if (enemy.flyProgress !== undefined || enemy.hp <= 0) continue;
    const teleport = state.teleports.find(effect => effect.targetUid === enemy.uid);
    if (teleport) {
      const destination = worldToCell(teleport.destination);
      const anchor = worldToCell(teleport.from);
      const pulling = worldToCell(enemy.pos);
      if ([destination, anchor, pulling].some(point => cell.x === point.x && cell.y === point.y)) return null;
      continue;
    }
    const current = worldToCell(enemy.pos);
    const route = enemy.path ?? state.currentPath?.map(cellToWorld);
    const next = worldToCell(route?.[enemy.pathIdx ?? 1] ?? enemy.pos);
    // Reserve the transit rectangle, including diagonal corner-clearance cells.
    if (cell.x >= Math.min(current.x, next.x) && cell.x <= Math.max(current.x, next.x)
      && cell.y >= Math.min(current.y, next.y) && cell.y <= Math.max(current.y, next.y)) return null;
  }
  // Temporarily block the cell, check global path + all active ground enemies
  state.grid[cell.y][cell.x] = true;
  const path = findPath(state.grid, state.entry, state.exit);
  let allEnemiesHavePath = true;
  if (path) {
    for (const enemy of state.enemies) {
      if (enemy.flyProgress !== undefined || enemy.hp <= 0) continue; // flyers don't need grid path
      const teleport = state.teleports.find(effect => effect.targetUid === enemy.uid);
      const curCell = worldToCell(teleport?.destination ?? enemy.pos);
      const cx = Math.max(0, Math.min(state.gridW - 1, curCell.x));
      const cy = Math.max(0, Math.min(state.gridH - 1, curCell.y));
      const enemyPath = findPath(state.grid, { x: cx, y: cy }, state.exit);
      if (!enemyPath) { allEnemiesHavePath = false; break; }
    }
  }
  state.grid[cell.y][cell.x] = false;
  if (!path || !allEnemiesHavePath) return null;
  return path;
}

// ── placeTower ────────────────────────────────────────────────────────────
export function placeTower(
  state: BattleState,
  towerId: TowerId,
  cell: Vec2
): boolean {
  const spec = TOWERS[towerId];
  if (state.gold < spec.cost) return false;
  if (!isBuildable(state, cell)) return false;

  const newPath = pathExistsWithTower(state, cell);
  if (!newPath) return false; // would block all paths

  // Commit
  state.grid[cell.y][cell.x] = true;
  state.currentPath = newPath;
  const world = cellToWorld(cell);

  state.towers.push({
    uid: uid(state),
    towerId,
    cell,
    level: 0,
    value: spec.cost,
    targetingMode: state.defaultTargetingMode,
    targetLock: state.defaultTargetLock,
    targetRefreshRemaining: 0.1,
    cooldown: 0,
    worldX: world.x,
    worldY: world.y,
  });
  state.gold -= spec.cost;

  // Recompute enemy paths (non-flyers)
  recomputeEnemyPaths(state);
  if (state.soundQueue.length < 32) state.soundQueue.push('build');
  return true;
}

// ── sellTower ─────────────────────────────────────────────────────────────
export function sellTower(state: BattleState, instanceId: string): void {
  const idx = state.towers.findIndex(t => t.uid === instanceId);
  if (idx < 0) return;
  const tower = state.towers[idx];
  cleanOwnedCombat(state, tower);
  tower.glueReleaseAt = undefined;
  tower.glueTargets = undefined;
  state.gold += tower.value; // 100% refund of current value
  state.grid[tower.cell.y][tower.cell.x] = false;
  state.towers.splice(idx, 1);
  state.currentPath = findPath(state.grid, state.entry, state.exit);
  recomputeEnemyPaths(state);
  if (state.soundQueue.length < 32) state.soundQueue.push('sell');
}

// ── upgradeTower ──────────────────────────────────────────────────────────
export function getEnhanceCost(tower: PlacedTower): number {
  const spec = TOWERS[tower.towerId];
  if (tower.level >= spec.maxLevel - 1) return -1;
  return Math.round(Math.fround(spec.enhanceCost
    * Math.fround(Math.pow(Math.fround(spec.enhanceBase), tower.level))));
}

export function enhanceTower(state: BattleState, instanceId: string): boolean {
  const tower = state.towers.find(t => t.uid === instanceId);
  if (!tower) return false;
  const cost = getEnhanceCost(tower);
  if (cost < 0 || state.gold < cost) return false;
  state.gold -= cost;
  tower.level++;
  tower.value += cost;
  if (state.soundQueue.length < 32) state.soundQueue.push('enhance');
  return true;
}

export function promoteTower(state: BattleState, instanceId: string): boolean {
  const tower = state.towers.find(t => t.uid === instanceId);
  if (!tower) return false;
  const spec = TOWERS[tower.towerId];
  const nextId = UPGRADE_GRAPH[tower.towerId];
  if (!nextId || spec.upgradeCostToNext == null) return false;
  const upgradeCost = spec.upgradeCostToNext;
  if (state.gold < upgradeCost) return false;

  state.gold -= upgradeCost;
  cleanOwnedCombat(state, tower);
  tower.glueReleaseAt = undefined;
  tower.glueTargets = undefined;
  tower.glueScanRemaining = undefined;
  tower.value += upgradeCost;
  tower.towerId = nextId;
  tower.level = 0;
  tower.cooldown = 0;
  tower.lastFireTime = undefined;
  if (state.soundQueue.length < 32) state.soundQueue.push('enhance');
  return true;
}

export function upgradeTower(state: BattleState, instanceId: string): boolean {
  const tower = state.towers.find(t => t.uid === instanceId);
  if (!tower) return false;
  return tower.level < TOWERS[tower.towerId].maxLevel - 1
    ? enhanceTower(state, instanceId) : promoteTower(state, instanceId);
}

// ── setTargeting ──────────────────────────────────────────────────────────
export function setTargeting(
  state: BattleState,
  instanceId: string,
  mode: TargetingMode
): void {
  const tower = state.towers.find(t => t.uid === instanceId);
  if (tower && tower.towerId !== 'glueTower' && tower.towerId !== 'mineLayer') {
    tower.targetingMode = mode;
    state.defaultTargetingMode = mode;
  }
}

export function setTargetLock(state: BattleState, instanceId: string, lock: boolean): void {
  const tower = state.towers.find(t => t.uid === instanceId);
  if (tower && tower.towerId !== 'glueTower' && tower.towerId !== 'mineLayer') {
    tower.targetLock = lock;
    state.defaultTargetLock = lock;
  }
}

export const getEnemySpeed = effectiveEnemySpeed;

// ── Wave API ──────────────────────────────────────────────────────────────
export const getWave = generateWave;
export const canStartNextWave = nextWaveReady;
export const getEarlyWaveBonus = earlyWaveBonus;
export const getNextWaveWait = nextWaveWait;

export function startWave(state: BattleState): void {
  if (!canStartNextWave(state)) return;
  const nextIdx = state.waveIndex + 1;
  const bonus = getEarlyWaveBonus(state);
  const active = state.pendingWaveIndices.filter(index => !state.clearedWaveIndices.includes(index));
  if (active.length) payWaveReward(state, Math.max(...active));
  const wave = getWave(nextIdx, state.creditsEarned);
  const queue = waveSpawnQueue(wave, nextIdx);
  const previousQueue = state.spawnQueue.map(entry => ({
    ...entry, waveIndex: entry.waveIndex ?? state.waveIndex,
    delay: Math.max(0, entry.delay - state.spawnElapsed),
  }));
  state.prevWaveStillSpawning = state.spawning;
  state.waveIndex = nextIdx;
  state.pendingWaveIndices.push(nextIdx);
  state.waveRewards[nextIdx] = wave.waveReward;
  state.nextWaveReadyAt = state.time + 5;
  state.waveBaseHealth = wave.baseHealth;
  state.waveActive = true;
  state.spawnQueue = [...previousQueue, ...queue].sort((a, b) => a.delay - b.delay);
  state.spawning = state.spawnQueue.length > 0;
  state.spawnElapsed = 0;
  state.gold += bonus;
  state.isBossWave = wave.isBossWave;
  if (state.soundQueue.length >= 32) state.soundQueue.pop();
  state.soundQueue.push('wave_start');
}

// ── isWaveClear / isGameOver ──────────────────────────────────────────────
export function isWaveClear(state: BattleState): boolean {
  return !state.spawning && state.enemies.length === 0;
}

export function isGameOver(state: BattleState): boolean {
  return state.gameOver || state.victory;
}

// ── Recompute enemy paths after grid change ───────────────────────────────
function recomputeEnemyPaths(state: BattleState): void {
  for (const tower of state.towers) if (tower.towerId === 'glueTower') {
    // Source uses static paths; the maze port refreshes cached samples on grid changes.
    tower.glueTargets = determineGlueTargets(state, tower, towerStats(tower).range);
    tower.gluePathKey = JSON.stringify(state.currentPath);
  }
  for (const enemy of state.enemies) {
    if (enemy.flyProgress !== undefined || enemy.teleportingUntil !== undefined) continue;
    const route = findPath(state.grid, worldToCell(enemy.pos), state.exit);
    if (!route) continue;
    const previous = enemy.path ?? state.currentPath?.map(cellToWorld) ?? [];
    const history = previous.slice(0, enemy.pathIdx ?? 1);
    enemy.path = [...history, { ...enemy.pos }, ...route.map(cellToWorld)];
    enemy.pathIdx = history.length + 1;
    enemy.pathProgress = 0;
  }
}

function beginTeleport(state: BattleState, tower: PlacedTower, target: Enemy, distance: number): boolean {
  const from = { ...target.pos };
  const anchorPath = (target.path ?? state.currentPath?.map(cellToWorld))?.map(point => ({ ...point }));
  const clone: Enemy = { ...target, pos: { ...from }, path: anchorPath };
  if (target.flyProgress !== undefined) {
    const entry = cellToWorld(state.entry), exit = cellToWorld(state.exit);
    clone.flyProgress = Math.max(0, target.flyProgress - distance / (dist2(entry, exit) || 1));
    clone.pos = { x: entry.x + (exit.x - entry.x) * clone.flyProgress, y: entry.y + (exit.y - entry.y) * clone.flyProgress };
  } else if (anchorPath) teleportBack(clone, distance, anchorPath);
  if (target.flyProgress === undefined) {
    const safe = (position: Vec2) => {
      const cell = worldToCell(position);
      return cell.x >= 0 && cell.y >= 0 && cell.x < state.gridW && cell.y < state.gridH
        && !state.grid[cell.y][cell.x] && findPath(state.grid, cell, state.exit) !== null;
    };
    if (!safe(clone.pos)) {
      const idealIndex = clone.pathIdx ?? 1;
      const candidates: { pos: Vec2; index: number; progress: number }[] = [];
      for (let i = Math.min(idealIndex - 1, (anchorPath?.length ?? 0) - 1); i >= 0; i--) {
        candidates.push({ pos: anchorPath![i], index: Math.max(1, i), progress: i === 0 ? 0 : 1 });
      }
      for (let i = idealIndex; i < (target.pathIdx ?? 1) && i < (anchorPath?.length ?? 0); i++) {
        candidates.push({ pos: anchorPath![i], index: Math.max(1, i), progress: 1 });
      }
      candidates.push({ pos: from, index: target.pathIdx ?? 1, progress: target.pathProgress ?? 0 });
      const chosen = candidates.find(candidate => safe(candidate.pos));
      if (!chosen) return false;
      clone.pos = { ...chosen.pos };
      clone.pathIdx = chosen.index;
      clone.pathProgress = chosen.progress;
    }
  }
  target.teleportingUntil = state.time + 1;
  state.teleports.push({ uid: uid(state), sourceTowerUid: tower.uid, targetUid: target.uid,
    startedAt: state.time, expiresAt: state.time + 1, distance, from,
    to: { x: tower.worldX, y: tower.worldY }, destination: { ...clone.pos }, anchorPath,
    anchorPathIdx: target.pathIdx, anchorPathProgress: target.pathProgress, anchorFlyProgress: target.flyProgress,
    mazePathKey: JSON.stringify(state.currentPath), mazeGridKey: JSON.stringify(state.grid),
    destinationPathIdx: clone.pathIdx, destinationPathProgress: clone.pathProgress, destinationFlyProgress: clone.flyProgress });
  return true;
}

function advanceTeleports(state: BattleState): Set<string> {
  const finished = new Set<string>();
  state.teleports = state.teleports.filter(teleport => {
    const target = state.enemies.find(enemy => enemy.uid === teleport.targetUid && enemy.hp > 0);
    if (!target) return false;
    const progress = Math.min(1, (state.time - teleport.startedAt) / (teleport.expiresAt - teleport.startedAt));
    if (progress < 1 - 1e-10) {
      target.pos = { x: teleport.from.x + (teleport.to.x - teleport.from.x) * progress,
        y: teleport.from.y + (teleport.to.y - teleport.from.y) * progress };
      return true;
    }
    target.pos = { ...teleport.destination };
    target.path = teleport.anchorPath?.map(point => ({ ...point }));
    target.pathIdx = teleport.destinationPathIdx;
    target.pathProgress = teleport.destinationPathProgress;
    if (teleport.anchorFlyProgress !== undefined) {
      const entry = cellToWorld(state.entry), exit = cellToWorld(state.exit);
      target.flyProgress = teleport.destinationFlyProgress ?? Math.max(0, teleport.anchorFlyProgress - teleport.distance / (dist2(entry, exit) || 1));
      target.pos = { x: entry.x + (exit.x - entry.x) * target.flyProgress, y: entry.y + (exit.y - entry.y) * target.flyProgress };
    } else if (target.path) {
      // Maze-safe adaptation: rewind the captured route progress, not the off-route pull position.
      const blockedHistory = target.path.slice(Math.max(0, (target.pathIdx ?? 1) - 1)).some(point => {
        const cell = worldToCell(point);
        return state.grid[cell.y]?.[cell.x] === true;
      });
      const changed = blockedHistory || teleport.mazeGridKey !== JSON.stringify(state.grid);
      const route = changed ? findPath(state.grid, worldToCell(target.pos), state.exit) : null;
      if (route) {
        target.path = [{ ...target.pos }, ...route.map(cellToWorld)];
        target.pathIdx = 1;
        target.pathProgress = 0;
      }
    }
    target.teleportingUntil = undefined;
    target.wasTeleported = true;
    finished.add(target.uid);
    return false;
  });
  return finished;
}

// ── Spawn helper ──────────────────────────────────────────────────────────
function spawnEnemy(state: BattleState, entry: SpawnEntry): void {
  const { id } = entry;
  const spec = ENEMIES[id];
  const baseHp = spec.hp * (entry.healthModifier ?? 0.5);
  const hp = id === 'boss' && entry.bossHpMul !== undefined
    ? spec.hp * entry.bossHpMul
    : baseHp;
  const entryWorld = cellToWorld(state.entry);
  const isFlyer = spec.flying === true;

  const enemy: Enemy = {
    uid: uid(state),
    id,
    hp,
    maxHp: hp,
    speed: spec.speed * CELL_PX, // cells/sec → px/sec
    pos: { ...entryWorld },
    waveIndex: entry.waveIndex ?? state.waveIndex,
    spawnedAt: state.time,
    healthModifier: entry.healthModifier ?? 0.5,
    reward: entry.reward ?? spec.reward,
    ...enemyPresentation(id, entry.waveIndex ?? state.waveIndex),
  };

  if (isFlyer) {
    enemy.flyProgress = 0;
  } else {
    enemy.path = state.currentPath?.map(cellToWorld);
    enemy.pathIdx = 1;
    enemy.pathProgress = 0;
  }

  if (spec.heals) {
    enemy.healCooldown = spec.healInterval ?? 5;
  }

  state.enemies.push(enemy);
}

// ── tick ──────────────────────────────────────────────────────────────────
export function tick(state: BattleState, dtSec: number): void {
  validateSpawnGrace(state.spawnTargetGraceSeconds);
  if (state.paused || state.gameOver || state.victory) return;

  state.time += dtSec;
  advanceStatus(state, dtSec);
  const finishedTeleports = advanceTeleports(state);

  // ── Spawning ────────────────────────────────────────────────────────────
  if (state.spawning) {
    state.spawnElapsed += dtSec;
    let i = 0;
    while (i < state.spawnQueue.length && state.spawnQueue[i].delay <= state.spawnElapsed) {
      spawnEnemy(state, state.spawnQueue[i]);
      i++;
    }
    state.spawnQueue.splice(0, i);
    if (state.spawnQueue.length === 0) state.spawning = false;
  }

  // ── Move enemies ─────────────────────────────────────────────────────────
  const entryWorld = cellToWorld(state.entry);
  const exitWorld = cellToWorld(state.exit);
  const path = state.currentPath;
  const leakedEnemies: Enemy[] = [];

  for (const enemy of state.enemies) {
    if (enemy.hp <= 0 || enemy.teleportingUntil !== undefined || finishedTeleports.has(enemy.uid)) continue;
    const spec = ENEMIES[enemy.id];
    const speed = getEnemySpeed(state, enemy);

    if (enemy.flyProgress !== undefined) {
      // Flyer: straight line
      const totalDist = dist2(entryWorld, exitWorld);
      enemy.flyProgress += (speed * dtSec) / totalDist;
      if (enemy.flyProgress >= 1) {
        leakedEnemies.push(enemy);
        continue;
      }
      enemy.pos = {
        x: entryWorld.x + (exitWorld.x - entryWorld.x) * enemy.flyProgress,
        y: entryWorld.y + (exitWorld.y - entryWorld.y) * enemy.flyProgress,
      };
    } else {
      // Ground: follow path
      const path = enemy.path ?? state.currentPath?.map(cellToWorld);
      if (!path || !path.length) continue;
      enemy.path = path;
      let remaining = speed * dtSec;
      let idx = enemy.pathIdx ?? 1;
      let prog = enemy.pathProgress ?? 0;

      while (remaining > 0 && idx < path.length) {
        const from = path[idx - 1];
        const to = path[idx];
        const segLen = dist2(from, to);
        const traveled = prog * segLen;
        const left = segLen - traveled;
        if (remaining >= left) {
          remaining -= left;
          idx++;
          prog = 0;
        } else {
          prog = (traveled + remaining) / segLen;
          remaining = 0;
        }
      }

      if (idx >= path.length) {
        leakedEnemies.push(enemy);
        continue;
      }
      enemy.pathIdx = idx;
      enemy.pathProgress = prog;
      enemy.pos = enemyWorldPos(enemy, path);
    }

    // Healer: pulse heal nearby allies
    if (spec.heals && spec.healRadius != null && spec.healPct != null) {
      enemy.healCooldown = (enemy.healCooldown ?? 0) - dtSec;
      if (enemy.healCooldown! <= 0) {
        enemy.healCooldown = spec.healInterval ?? 5;
        const healRange = spec.healRadius * CELL_PX;
        for (const other of state.enemies) {
          if (other === enemy || other.hp <= 0) continue;
          if (dist2(enemy.pos, other.pos) <= healRange) {
            other.hp = Math.min(other.maxHp, other.hp + other.maxHp * spec.healPct);
          }
        }
        state.effects.push({
          uid: uid(state), kind: 'heal',
          x: enemy.pos.x, y: enemy.pos.y, r: healRange,
          life: 0.4, maxLife: 0.4,
        });
      }
    }
  }

  // Process leaks
  if (leakedEnemies.length) {
    for (const enemy of leakedEnemies) {
      const index = enemy.waveIndex ?? state.waveIndex;
      if (!state.leakedWaveIndices.includes(index)) state.leakedWaveIndices.push(index);
    }
    state.lives = Math.max(0, state.lives - leakedEnemies.length);
    const leakSet = new Set(leakedEnemies.map(e => e.uid));
    state.enemies = state.enemies.filter(e => !leakSet.has(e.uid));
    state.lifeFlashUntil = state.time + 0.35; // life-loss flash
    if (state.soundQueue.length >= 32) state.soundQueue.pop();
    state.soundQueue.push('life_lost');
    if (state.lives <= 0) {
      state.gameOver = true;
      if (state.soundQueue.length >= 32) state.soundQueue.shift();
      state.soundQueue.push('defeat');
      return;
    }
  }

  // ── Towers fire ──────────────────────────────────────────────────────────
  for (const tower of state.towers) {
    tower.cooldown -= dtSec;
    const stats = towerStats(tower);
    if (tower.towerId === 'rocketLauncher' && !tower.loadedRocket) {
      tower.rocketLoadRemaining = Math.max(0, (tower.rocketLoadRemaining ?? 1) - dtSec);
      if (tower.rocketLoadRemaining <= 1e-10) {
        tower.loadedRocket = { damage: stats.damage, splashRadius: stats.splashRadius, damageType: 'Explosive' };
      }
    }
    if (tower.towerId === 'mineLayer') {
      const towerPos = { x: tower.worldX, y: tower.worldY };
      if (tower.mineReleaseAt !== undefined && state.time + 1e-10 >= tower.mineReleaseAt) {
        const to = sampleMineRoute(state, towerPos, stats.range);
        if (to && state.mines.filter(m => m.sourceTowerUid === tower.uid).length < 3 + tower.level) {
          state.mines.push({ uid: uid(state), towerId: tower.towerId, sourceTowerUid: tower.uid, from: { ...towerPos }, pos: { ...towerPos }, to, damage: stats.damage, damageType: 'Explosive', splashRadius: stats.splashRadius, launchedAt: state.time, landed: false, nextTriggerAt: state.time + 1.6 });
          tower.aimAngle = Math.atan2(to.y - towerPos.y, to.x - towerPos.x);
          tower.lastFireTime = state.time;
          if (state.soundQueue.length < 32) state.soundQueue.push('shot_mine');
        }
        tower.mineReleaseAt = undefined;
      }
      if (tower.cooldown <= 0 && tower.mineReleaseAt === undefined
        && state.mines.filter(m => m.sourceTowerUid === tower.uid).length < 3 + tower.level
        && sampleMineRoute(state, towerPos, stats.range)) {
        // Release at animation frame 9/30.
        tower.mineReleaseAt = state.time + 0.3;
        tower.cooldown = stats.reload;
      }
      continue;
    }
    const spec = TOWERS[tower.towerId];
    const towerPos: Vec2 = { x: tower.worldX, y: tower.worldY };
    const inRange = state.enemies.filter(enemy => canTowerTarget(state, enemy)
      && dist2(enemy.pos, towerPos) <= stats.range
      && (tower.towerId !== 'teleporter' || enemy.teleportingUntil === undefined && !enemy.wasTeleported));

    if (tower.towerId === 'glueTower') {
      const pathKey = JSON.stringify(state.currentPath);
      if (tower.gluePathKey !== pathKey) {
        tower.glueTargets = determineGlueTargets(state, tower, stats.range);
        tower.gluePathKey = pathKey;
      }
      if (tower.glueReleaseAt !== undefined && state.time + 1e-10 >= tower.glueReleaseAt) {
        for (const point of tower.glueTargets ?? []) launchGlue(state, tower, point, stats.slowFactor, stats.slowDuration);
        tower.glueReleaseAt = undefined;
        tower.lastFireTime = state.time;
        if (state.soundQueue.length < 32) state.soundQueue.push('shot_glueTower');
      }
      if (tower.cooldown <= 0 && tower.glueReleaseAt === undefined) {
        const timer = refreshInterval(tower.glueScanRemaining, dtSec);
        tower.glueScanRemaining = timer.remaining;
        if (timer.due && inRange.length) {
          tower.glueTargets ??= determineGlueTargets(state, tower, stats.range);
          tower.glueReleaseAt = state.time + 0.8;
          tower.cooldown = stats.reload;
        }
      }
      continue;
    }

    let target = state.enemies.find(enemy => enemy.uid === tower.targetUid && canTowerTarget(state, enemy));
    if (!target || tower.towerId === 'teleporter' && (target.teleportingUntil !== undefined || target.wasTeleported)) {
      tower.targetUid = undefined;
      target = undefined;
    }
    const refresh = refreshInterval(tower.targetRefreshRemaining, dtSec);
    tower.targetRefreshRemaining = refresh.remaining;
    if (refresh.due) {
      if (target && dist2(target.pos, towerPos) > stats.range) target = undefined;
      if (!target || !(tower.targetLock ?? true)) target = pickTarget(inRange, tower.targetingMode, towerPos, path ?? []) ?? undefined;
      tower.targetUid = target?.uid;
    }
    if (target) tower.aimAngle = Math.atan2(target.pos.y - towerPos.y, target.pos.x - towerPos.x);
    if (tower.cooldown > 0 || !target) continue;

    if (tower.towerId === 'teleporter') {
      if (target.teleportingUntil !== undefined || target.wasTeleported || dist2(target.pos, towerPos) > stats.range) {
        tower.targetUid = undefined;
        continue;
      }
      if (!beginTeleport(state, tower, target, stats.teleportBack)) {
        tower.targetUid = undefined;
        continue;
      }
      tower.lastFireTime = state.time;
      tower.cooldown = stats.reload;
      if (state.soundQueue.length < 32) state.soundQueue.push('sfx_teleport');
      continue;
    }
    if (tower.towerId === 'rocketLauncher' && !tower.loadedRocket) continue;
    tower.lastFireTime = state.time;
    tower.cooldown = stats.reload;
    if (tower.towerId === 'glueGun') {
      const point = forecastPosition(state, target, dist2(towerPos, target.pos) / (4 * CELL_PX));
      launchGlue(state, tower, point, stats.slowFactor, stats.slowDuration);
      if (state.soundQueue.length < 32) state.soundQueue.push('shot_glueGun');
    } else if (spec.damageType === 'Bullet' || spec.damageType === 'Explosive') {
      launchCombat(state, tower, target, tower.loadedRocket ?? stats, tower.loadedRocket?.damageType ?? spec.damageType);
      if (tower.towerId === 'rocketLauncher') {
        tower.loadedRocket = undefined;
        tower.rocketLoadRemaining = 1;
      }
    } else if (spec.damageType === 'Laser') fireLaser(state, tower, target, stats);
  }

  // ── Move projectiles ──────────────────────────────────────────────────────
  advanceCombat(state, dtSec);
  state.projectiles = state.projectiles.filter(p => {
    if (p.authoritativeUid !== undefined) return true;
    p.life -= dtSec;
    const d = dist2(p.from, p.to || p.from);
    p.progress = Math.min(1, p.progress + dtSec * p.speed / (d || 1));
    // Rocket trail particles
    if (p.kind === 'rocket' && state.particles.length < PARTICLE_MAX) {
      const px = p.from.x + (p.to.x - p.from.x) * p.progress;
      const py = p.from.y + (p.to.y - p.from.y) * p.progress;
      const ang = Math.atan2(p.to.y - p.from.y, p.to.x - p.from.x);
      state.particles.push({
        x: px - Math.cos(ang) * 6,
        y: py - Math.sin(ang) * 6,
        vx: -Math.cos(ang) * 12 + (Math.random() - 0.5) * 20,
        vy: -Math.sin(ang) * 12 + (Math.random() - 0.5) * 20,
        life: 0.14, maxLife: 0.14,
        r: 1.5 + Math.random() * 1,
        color: Math.random() > 0.5 ? '#a58a4a' : '#8a4a4a',
      });
    }
    return p.life > 0;
  });
  projectCombat(state);

  // ── Decay effects ─────────────────────────────────────────────────────────
  state.effects = state.effects.filter(e => {
    e.life -= dtSec;
    return e.life > 0;
  });

  // ── Decay hit-flash on enemies ────────────────────────────────────────────
  for (const en of state.enemies) {
    if (en.hitFlash !== undefined && en.hitFlash > 0) {
      en.hitFlash = Math.max(0, en.hitFlash - dtSec);
    }
  }

  // ── Remove dead enemies + death burst ────────────────────────────────────
  const children: Enemy[] = [];
  state.enemies = state.enemies.filter(en => {
    if (en.hp > 0) return true;
    const spec = ENEMIES[en.id];
    const reward = en.rewardOverride ?? en.reward ?? spec.reward;
    state.gold += reward;
    state.creditsEarned += reward;
    if (spec.splitInto && en.rewardOverride === undefined) {
      const childSpec = ENEMIES[spec.splitInto];
      const count = Math.max(0, Math.min(4, Math.floor(spec.splitCount ?? 0)));
      for (let i = 0; i < count; i++) {
        const hp = childSpec.hp * (en.healthModifier ?? en.maxHp / spec.hp);
        children.push({
          uid: uid(state), id: childSpec.id, hp, maxHp: hp, speed: childSpec.speed * CELL_PX,
          pos: { ...en.pos }, path: en.path?.map(p => ({ ...p })) ?? state.currentPath?.map(cellToWorld),
          pathIdx: en.pathIdx, pathProgress: en.pathProgress, waveIndex: en.waveIndex,
          spawnedAt: en.spawnedAt,
          rewardOverride: 0,
          healthModifier: en.healthModifier ?? en.maxHp / spec.hp,
          ...enemyPresentation(childSpec.id, en.waveIndex ?? state.waveIndex),
        });
      }
    }
    if (state.soundQueue.length < 32) state.soundQueue.push('enemy_death');
    // Death burst particles
    const es = { soldier: '#595959', blob: '#6b7a5a', sprinter: '#2b2b2b', flyer: '#4a5a8a', healer: '#8a6b4a', boss: '#1a1a1a' };
    const color = es[en.id as keyof typeof es] ?? '#595959';
    const isBoss = en.id === 'boss';
    spawnParticles(state, en.pos.x, en.pos.y, color, isBoss ? 18 : 6, isBoss ? 80 : 50, isBoss ? 4.5 : 2.5, 0.45);
    return false;
  });
  state.enemies.push(...children);
  for (const tower of state.towers) {
    if (tower.targetUid && !state.enemies.some(enemy => enemy.uid === tower.targetUid && enemy.hp > 0)) tower.targetUid = undefined;
  }
  projectStatus(state);

  // ── Update particles ──────────────────────────────────────────────────────
  state.particles = state.particles.filter(p => {
    p.life -= dtSec;
    if (p.life <= 0) return false;
    p.x += p.vx * dtSec;
    p.y += p.vy * dtSec;
    p.vy += 60 * dtSec; // light gravity
    return true;
  });

  // ── Wave clear ────────────────────────────────────────────────────────────
  if (state.lives > 0 && !state.gameOver) {
    const pending = state.pendingWaveIndices.length ? state.pendingWaveIndices
      : state.waveActive && state.waveIndex >= 0 ? [state.waveIndex] : [];
    for (const index of pending) {
      if (state.spawnQueue.some(entry => (entry.waveIndex ?? state.waveIndex) === index)
        || state.enemies.some(enemy => (enemy.waveIndex ?? state.waveIndex) === index)) continue;
      if (!state.clearedWaveIndices.includes(index)) {
        payWaveReward(state, index);
        for (const tower of state.towers) tower.value = Math.round(tower.value * AGING_FACTOR);
        state.clearedWaveIndices.push(index);
        state.completedWaves++;
      }
    }
    state.pendingWaveIndices = pending.filter(index => !state.clearedWaveIndices.includes(index));
  }
  if (state.waveActive && !state.spawning && state.enemies.length === 0) {
    state.waveActive = false;
    // Endless mode: no victory condition, only defeat (lives <= 0)
  }
}

// ── Targeting ─────────────────────────────────────────────────────────────
function pickTarget(
  candidates: Enemy[],
  mode: TargetingMode,
  towerPos: Vec2,
  path: Vec2[]
): Enemy | null {
  if (!candidates.length) return null;
  switch (mode) {
    case 'first':
      return candidates.reduce((a, b) =>
        enemyPathDist(a, path) > enemyPathDist(b, path) ? a : b);
    case 'last':
      return candidates.reduce((a, b) =>
        enemyPathDist(a, path) < enemyPathDist(b, path) ? a : b);
    case 'strongest':
      return candidates.reduce((a, b) => a.hp > b.hp ? a : b);
    case 'weakest':
      return candidates.reduce((a, b) => a.hp < b.hp ? a : b);
    case 'closest':
      return candidates.reduce((a, b) =>
        dist2(a.pos, towerPos) < dist2(b.pos, towerPos) ? a : b);
  }
}

// ── Teleport back along path ──────────────────────────────────────────────
function teleportBack(enemy: Enemy, distPx: number, path: Vec2[]): void {
  // Walk backwards from current position by distPx
  let idx = enemy.pathIdx ?? 1;
  let prog = enemy.pathProgress ?? 0;
  let remaining = distPx;

  while (remaining > 0 && idx >= 1) {
    const from = path[idx - 1];
    const to = path[idx];
    const segLen = dist2(from, to);
    const traveled = prog * segLen;
    if (segLen > 0 && remaining <= traveled) {
      prog = (traveled - remaining) / segLen;
      remaining = 0;
    } else {
      remaining -= traveled;
      idx--;
      prog = 1;
    }
  }
  enemy.pathIdx = Math.max(1, idx);
  enemy.pathProgress = idx < 1 ? 0 : Math.max(0, Math.min(1, prog));
  enemy.pos = enemyWorldPos(enemy, path);
}

export { cellToWorld, worldToCell, towerStats, totalPathLen, GRID_W, GRID_H };
