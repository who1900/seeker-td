// ── Game engine types ─────────────────────────────────────────────────────

export type DamageType = 'Bullet' | 'Laser' | 'Explosive' | 'Glue' | 'None';

export type TowerId =
  | 'canon' | 'dualCanon' | 'machineGun'
  | 'simpleLaser' | 'bouncingLaser' | 'straightLaser'
  | 'mortar' | 'mineLayer' | 'rocketLauncher'
  | 'glueTower' | 'glueGun' | 'teleporter';

export type EnemyId = 'soldier' | 'blob' | 'sprinter' | 'flyer' | 'healer'
  | 'brute' | 'shieldbearer' | 'splitter' | 'swarm' | 'support' | 'boss';

export type TargetingMode = 'first' | 'last' | 'strongest' | 'weakest' | 'closest';

export interface Vec2 { x: number; y: number; }

export interface TowerSpec {
  id: TowerId;
  name: string;
  cost: number;
  damage: number;
  range: number;       // grid units
  reload: number;      // seconds
  damageType: DamageType;
  maxLevel: number;
  enhanceCost: number;
  enhanceBase: number;
  upgradeLevel: number;
  dmgPerLevel: number;
  rangePerLevel: number;
  reloadPerLevel: number; // subtracted per level
  upgradeCostToNext: number | null; // null = top tier
  // special
  shotsPerFire?: number;   // dualCanon
  bounces?: number;        // bouncingLaser
  bounceRange?: number;
  pierces?: boolean;       // straightLaser
  splashRadius?: number;   // mortar, mineLayer, rocketLauncher
  splashPerLevel?: number;
  placesMines?: boolean;   // mineLayer
  tracking?: boolean;      // rocketLauncher
  slowFactor?: number;     // glueTower, glueGun
  slowFactorPerLevel?: number;
  slowDuration?: number;
  aoeRadius?: number;      // glue AoE
  teleportBack?: number;   // teleporter, units
  teleportPerLevel?: number;
}

export interface EnemySpec {
  id: EnemyId;
  name: string;
  hp: number;
  speed: number;  // grid units/sec
  reward: number;
  weakAgainst: DamageType[];
  strongAgainst: DamageType[];
  flying?: boolean;
  heals?: boolean;        // healer
  healRadius?: number;
  healPct?: number;
  healInterval?: number;  // seconds
  splitInto?: EnemyId;
  splitCount?: number;
  speedAuraRadius?: number;
  speedAuraMultiplier?: number;
  visualScale?: number;
}

export interface WaveSpec {
  waveReward: number;
  extend: number;     // extra enemies per loop after w15
  maxExtend: number;
  enemies: WaveEntry[];
}

export interface WaveEntry {
  id: EnemyId;
  count: number;
  delay?: number; // incremental source delay; the first wave entry ignores it
  offset?: number;
  pathIndex?: number;
}

export interface PlacedTower {
  uid: string;
  towerId: TowerId;
  cell: Vec2;           // grid cell
  level: number;        // 0-based; 0 = fresh
  value: number;        // current sell value (tracks aging + upgrades)
  targetingMode: TargetingMode;
  targetLock?: boolean;
  targetUid?: string;
  targetRefreshRemaining?: number;
  glueReleaseAt?: number;
  glueTargets?: Vec2[];
  gluePathKey?: string;
  glueScanRemaining?: number;
  cooldown: number;     // seconds remaining until next shot
  aimAngle?: number;    // radians, world +X axis toward the actual fired-at target
  lastFireTime?: number; // state.time of the most recent firing event
  nextBarrel?: number;
  mineReleaseAt?: number;
  rocketLoadRemaining?: number;
  loadedRocket?: { damage: number; splashRadius: number; damageType: DamageType };
  // transient derived — recalculated in engine
  worldX: number;       // pixel center
  worldY: number;
}

export interface Enemy {
  uid: string;
  id: EnemyId;
  hp: number;
  maxHp: number;
  speed: number;        // effective speed (grid units/sec)
  pos: Vec2;            // world position (pixels)
  waveIndex?: number;
  spawnedAt?: number;   // engine time; absent legacy enemies are immediately eligible
  rewardOverride?: number;
  reward?: number;
  healthModifier?: number;
  paletteVariant?: number;
  visualScale?: number;
  // path-follower state (non-flyers)
  path?: Vec2[];        // per-enemy world-space waypoints, including traveled history
  pathIdx?: number;     // current waypoint index
  pathProgress?: number; // 0..1 fraction between pathIdx-1 and pathIdx
  // flyer state
  flyProgress?: number; // 0..1 from entry to exit
  // status
  slowUntil?: number;   // game time in seconds
  slowFactor?: number;
  healCooldown?: number; // healer: seconds to next heal pulse
  hitFlash?: number;    // seconds remaining for hit-flash
  speedEffects?: SpeedStatus[];
  glueSpeedMultiplier?: number;
  stunUntil?: number;
  teleportingUntil?: number;
  wasTeleported?: boolean;
}

export interface SpeedStatus {
  uid: string;
  kind: 'laserStun';
  sourceTowerUid: string;
  multiplier: number;
  startedAt: number;
  expiresAt: number;
}

export interface GlueFlight {
  uid: string;
  towerId: TowerId;
  sourceTowerUid: string;
  from: Vec2;
  to: Vec2;
  pos: Vec2;
  speed: number;
  intensity: number;
  duration: number;
  launchedAt: number;
}

export interface GluePatch {
  uid: string;
  towerId: TowerId;
  sourceTowerUid: string;
  pos: Vec2;
  radius: number;
  intensity: number;
  startedAt: number;
  expiresAt: number;
  nextObserveAt: number;
  enemyUids: string[];
}

export interface CombatTeleport {
  uid: string;
  sourceTowerUid: string;
  targetUid: string;
  startedAt: number;
  expiresAt: number;
  distance: number;
  from: Vec2;
  to: Vec2;
  destination: Vec2;
  anchorPath?: Vec2[];
  anchorPathIdx?: number;
  anchorPathProgress?: number;
  anchorFlyProgress?: number;
  mazePathKey?: string;
  mazeGridKey?: string;
  destinationPathIdx?: number;
  destinationPathProgress?: number;
  destinationFlyProgress?: number;
}

export interface Projectile {
  uid: string;
  kind: 'bullet' | 'laser' | 'rocket' | 'glue' | 'teleport' | 'mine';
  from: Vec2;
  to: Vec2;
  progress: number; // 0..1
  speed: number;    // world units/sec
  damage: number;
  damageType: DamageType;
  targetUid?: string; // for tracking rocket
  sourceTowerUid?: string;
  pos?: Vec2;
  sourceSocket?: number;
  authoritativeUid?: string;
  splashRadius?: number;
  life: number;     // seconds, decrements each tick
  towerId?: TowerId; // visual variant
}

export interface CombatShot {
  uid: string;
  kind: 'cannon' | 'machineGun' | 'mortar' | 'rocket';
  towerId: TowerId;
  sourceTowerUid: string;
  sourceSocket?: number;
  from: Vec2;
  pos: Vec2;
  to: Vec2;
  direction: Vec2;
  targetUid?: string;
  damage: number;
  damageType: DamageType;
  splashRadius: number;
  speed: number;
  launchedAt: number;
}

export interface CombatMine {
  uid: string;
  towerId: TowerId;
  sourceTowerUid: string;
  from: Vec2;
  pos: Vec2;
  to: Vec2;
  damage: number;
  damageType: DamageType;
  splashRadius: number;
  launchedAt: number;
  landed: boolean;
  nextTriggerAt: number;
}

export interface Effect {
  uid: string;
  kind: 'boom' | 'chain' | 'ring' | 'heal' | 'glue' | 'teleport'
      | 'laser_flash' | 'bullet_spark' | 'glue_splat' | 'boom_big' | 'chain_bounce' | 'chain_straight';
  x: number;
  y: number;
  r?: number;
  life: number;     // seconds, decrements each tick
  maxLife: number;
  pts?: Vec2[];     // chain
  targetUids?: string[];
  sourceTowerUid?: string;
  towerId?: TowerId; // visual variant
}

export interface SpawnEntry {
  id: EnemyId;
  delay: number; // seconds from wave start
  bossHpMul?: number; // optional HP multiplier for boss
  waveIndex?: number;
  offset?: number;
  pathIndex?: number;
  scheduledDelay?: number;
  healthModifier?: number;
  reward?: number;
}

export interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  life: number;   // seconds remaining
  maxLife: number;
  r: number;      // radius
  color: string;
}

export interface CombatRandomState {
  algorithm: 'mulberry32';
  version: 1;
  state: number;
  cursor: number;
}

export interface BattleState {
  combatRandom?: CombatRandomState;
  gold: number;
  lives: number;
  waveIndex: number;        // 0-based; -1 = pre-game
  completedWaves: number;
  clearedWaveIndices: number[];
  pendingWaveIndices: number[];
  leakedWaveIndices: number[];
  nextWaveReadyAt: number;
  waveRewards: Record<number, number>;
  rewardedWaveIndices: number[];
  spawnTargetGraceSeconds: number;
  waveActive: boolean;      // spawning or enemies still alive
  spawning: boolean;        // still spawning from queue
  spawnQueue: SpawnEntry[];
  spawnElapsed: number;     // seconds since wave start
  towers: PlacedTower[];
  defaultTargetingMode: TargetingMode;
  defaultTargetLock: boolean;
  enemies: Enemy[];
  projectiles: Projectile[];
  shots: CombatShot[];
  mines: CombatMine[];
  glueShots: GlueFlight[];
  gluePatches: GluePatch[];
  teleports: CombatTeleport[];
  effects: Effect[];
  grid: boolean[][];        // true = blocked (tower placed)
  gridW: number;
  gridH: number;
  entry: Vec2;
  exit: Vec2;
  currentPath: Vec2[] | null; // recomputed A* path (cell coords), null impossible
  waveBaseHealth: number;
  creditsEarned: number;
  paused: boolean;
  speed: number;            // 1/2/4
  gameOver: boolean;
  victory: boolean;
  time: number;             // total elapsed seconds
  uidCounter: number;
  prevWaveStillSpawning: boolean; // for early-start bonus detection
  particles: Particle[];          // canvas juice particles
  lifeFlashUntil: number;         // game time when life-loss flash ends
  isBossWave: boolean;            // current wave is a boss wave
  soundQueue: string[];           // tags for audio events this tick
}
