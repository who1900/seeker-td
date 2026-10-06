import { createGame, getWave, startWave, tick, placeTower, sellTower, cellToWorld } from './engine';
import { CELL_PX, ENEMIES, WAVES, TOWERS, damageMul } from './data';
import type { BattleState, Enemy, EnemyId } from './types';

function check(ok: unknown, message: string): void {
  if (!ok) throw new Error(message);
}
function near(a: number, b: number, message: string) {
  check(Math.abs(a - b) < 1e-8, message);
}
function spawn(state: BattleState, id: EnemyId, waveIndex = 0): Enemy {
  state.spawnQueue.push({ id, delay: 0, waveIndex });
  state.spawning = true;
  tick(state, 0);
  const enemy = state.enemies.find(e => e.id === id && e.waveIndex === waveIndex)!;
  check(enemy, `missing ${id}`);
  return enemy;
}

const random = Math.random;
Math.random = () => 0.5;
try {
  check(Object.keys(ENEMIES).length === 11, 'expected 10 regular enemies and boss');
  const original: [EnemyId, number, number, number][] = [
    ['soldier', 300, 1, 10], ['blob', 600, 0.5, 20], ['sprinter', 200, 3, 15],
    ['flyer', 400, 1.3, 30], ['healer', 400, 1.2, 30], ['boss', 4000, 0.5, 300],
  ];
  for (const [id, hp, speed, reward] of original) {
    check(ENEMIES[id].hp === hp && ENEMIES[id].speed === speed
      && ENEMIES[id].reward === reward, `original ${id} tuning changed`);
  }
  for (let i = 0; i < 15; i++) {
    const groups = getWave(i, 0).enemies.filter(group => group.id !== 'boss');
    check(JSON.stringify(groups) === JSON.stringify(WAVES[i].enemies), 'original waves changed');
  }
  const introduced: EnemyId[] = ['brute', 'shieldbearer', 'splitter', 'swarm', 'support'];
  introduced.forEach((id, index) => {
    check(!getWave(14 + index, 0).enemies.some(group => group.id === id), 'premature introduction');
    check(getWave(15 + index, 0).enemies.some(group => group.id === id), 'missing introduction');
  });
  const high = getWave(999, 1e12);
  check(high.enemies.reduce((sum, group) => sum + group.count, 0) <= 250, 'unbounded high-wave budget');
  const cycleRoster = Array.from({ length: 15 }, (_, index) => getWave(15 + index, 1e12).enemies).flat();
  for (const id of Object.keys(ENEMIES)) check(cycleRoster.some(group => group.id === id), `missing generated ${id} across source cycle`);
  check(high.enemies.every(group => Number.isFinite(group.count) && group.count > 0), 'invalid counts');

  const bruteState = createGame();
  const brute = spawn(bruteState, 'brute');
  const soldier = spawn(bruteState, 'soldier');
  near(brute.maxHp / soldier.maxHp, 4, 'brute health not data-driven');
  check(ENEMIES.swarm.speed > ENEMIES.soldier.speed && ENEMIES.swarm.visualScale! < 1, 'swarm not fast/small');
  const shieldSpec = ENEMIES.shieldbearer;
  check(damageMul('Bullet', shieldSpec.weakAgainst, shieldSpec.strongAgainst) < 1
    && damageMul('Laser', shieldSpec.weakAgainst, shieldSpec.strongAgainst) < 1, 'shield resistance missing');
  const shieldState = createGame(undefined, undefined, 0);
  shieldState.gold = 100000;
  check(placeTower(shieldState, 'canon', { x: 5, y: 1 }), 'shield test placement');
  shieldState.towers[0].cooldown = 100;
  const shield = spawn(shieldState, 'shieldbearer');
  const hp = shield.hp;
  shieldState.towers[0].cooldown = 0;
  shield.speed = 0;
  tick(shieldState, .125);
  check(shield.hp === hp, 'shield damaged at launch');
  shieldState.towers[0].cooldown = 100;
  shield.speed = 0;
  for (let i = 0; i < 64; i++) tick(shieldState, 1 / 64);
  near(hp - shield.hp, TOWERS.canon.damage * damageMul('Bullet', shieldSpec.weakAgainst, shieldSpec.strongAgainst), 'shield damage incorrect');

  const aura = createGame();
  const runner = spawn(aura, 'soldier');
  spawn(aura, 'support');
  spawn(aura, 'support');
  const beforeAura = runner.pos.y;
  tick(aura, 0.1);
  near(runner.pos.y - beforeAura, CELL_PX * 0.12, 'aura missing or stacked');
  near(runner.speed, CELL_PX, 'aura permanently changed speed');
  runner.slowFactor = 2;
  runner.slowUntil = 10;
  const beforeSlow = runner.pos.y;
  tick(aura, 0.1);
  near(runner.pos.y - beforeSlow, CELL_PX * 0.06, 'aura/slow composition incorrect');
  aura.enemies.filter(e => e.id === 'support').forEach(e => { e.hp = 0; });
  const beforeDeadAura = runner.pos.y;
  tick(aura, 0.1);
  near(runner.pos.y - beforeDeadAura, CELL_PX * 0.05, 'dead support still boosts');

  const healing = createGame();
  const ally = spawn(healing, 'soldier');
  const healer = spawn(healing, 'healer');
  ally.hp = 10;
  healer.hp = 0;
  healer.healCooldown = 0;
  const livesBefore = healing.lives;
  healer.pathIdx = healer.path!.length;
  tick(healing, 0.1);
  check(ally.hp === 10 && healing.lives === livesBefore, 'dead healer healed or leaked');
  const liveHealer = spawn(healing, 'healer');
  liveHealer.healCooldown = 0;
  ally.hp = 0;
  tick(healing, 0);
  check(!healing.enemies.includes(ally) && ally.hp === 0, 'healer resurrected dead ally');

  const split = createGame(undefined, undefined, 0);
  split.gold = 100000;
  check(placeTower(split, 'dualCanon', { x: 5, y: 1 }), 'split test placement');
  split.towers[0].cooldown = 100;
  const parent = spawn(split, 'splitter', 17);
  split.waveIndex = 17;
  split.waveActive = true;
  split.pendingWaveIndices = [17];
  const deathPos = { ...parent.pos };
  const goldBefore = split.gold;
  parent.hp = 1;
  parent.speed = 0;
  tick(split, .125);
  split.towers[0].cooldown = 0;
  tick(split, 0);
  check(parent.hp === 1, 'splitter damaged at launch');
  split.towers[0].cooldown = 100;
  for (let i = 0; i < 64 && split.enemies.includes(parent); i++) tick(split, 1 / 64);
  check(parent.hp === 0, 'HP underflow');
  check(split.enemies.length === 2 && split.enemies.every(e => e.id === 'swarm'), 'split children incorrect');
  check(split.gold === goldBefore + 24, 'split parent payout incorrect');
  check(split.completedWaves === 0, 'wave cleared before splitter children');
  split.enemies.forEach(child => {
    check(child.pos.x === deathPos.x && child.pos.y === deathPos.y, 'child teleported');
    check(child.waveIndex === 17 && child.rewardOverride === 0, 'child provenance/payout incorrect');
  });
  sellTower(split, split.towers[0].uid);
  check(placeTower(split, 'canon', { x: 5, y: 4 }), 'child reroute placement');
  split.towers[0].cooldown = 100;
  const child = split.enemies[0];
  tick(split, 0.001);
  check(Math.hypot(child.pos.x - deathPos.x, child.pos.y - deathPos.y)
    <= child.speed * 0.001 + 1e-8, 'split child reroute jumped');
  const beforeChildrenDie = split.gold;
  split.enemies.forEach(e => { e.hp = 0; });
  tick(split, 0);
  tick(split, 0);
  check(split.enemies.length === 0 && split.gold === beforeChildrenDie, 'unbounded split rewards/recursion');
  check(split.completedWaves === 1, 'splitter children prevented final wave clear');
  const leak = createGame();
  const leakingSplitter = spawn(leak, 'splitter');
  const leakGold = leak.gold;
  leakingSplitter.pathIdx = leakingSplitter.path!.length - 1;
  leakingSplitter.pathProgress = 0.99;
  leakingSplitter.pos = cellToWorld(leak.exit);
  tick(leak, 1);
  check(leak.enemies.length === 0 && leak.gold === leakGold, 'leaking splitter split or paid');
  const survivingLeak = createGame();
  survivingLeak.waveActive = true;
  survivingLeak.waveIndex = 0;
  survivingLeak.pendingWaveIndices = [0];
  const survivor = spawn(survivingLeak, 'soldier');
  survivor.pathIdx = survivor.path!.length;
  tick(survivingLeak, 0);
  check(survivingLeak.lives > 0 && survivingLeak.completedWaves === 1,
    'surviving a leaked wave did not count as completion');

  const cleared = createGame();
  startWave(cleared);
  check(cleared.completedWaves === 0, 'wave start counted');
  cleared.spawnQueue = [];
  tick(cleared, 0);
  tick(cleared, 0);
  check(cleared.completedWaves === 1 && cleared.clearedWaveIndices.join() === '0', 'clear not counted once');
  const overlap = createGame();
  startWave(overlap);
  for (let i = 0; i < 320; i++) tick(overlap, 1 / 64);
  const originalQueueSize = overlap.spawnQueue.length;
  const originalLiveUids = overlap.enemies.map(enemy => enemy.uid);
  startWave(overlap);
  check(overlap.spawnQueue.filter(entry => entry.waveIndex === 0).length === originalQueueSize, 'early start dropped previous queue');
  check(originalLiveUids.every(uid => overlap.enemies.some(enemy => enemy.uid === uid)), 'early start dropped live enemies');
  tick(overlap, 3);
  check(overlap.enemies.some(e => e.waveIndex === 0) && overlap.enemies.some(e => e.waveIndex === 1), 'spawn provenance lost');
  overlap.spawnQueue = overlap.spawnQueue.filter(entry => entry.waveIndex === 0);
  overlap.enemies = overlap.enemies.filter(e => e.waveIndex === 0);
  tick(overlap, 0);
  check(overlap.completedWaves === 1 && overlap.clearedWaveIndices.join() === '1', 'uncleared previous wave counted');
  overlap.spawnQueue = [];
  overlap.enemies = [];
  tick(overlap, 0);
  check(overlap.completedWaves === 2 && overlap.clearedWaveIndices.join() === '1,0', 'previous wave clear lost');
  const defeat = createGame();
  defeat.waveIndex = 998;
  defeat.creditsEarned = 1e12;
  defeat.lives = 1;
  startWave(defeat);
  check(defeat.spawnQueue.length <= 250, 'unbounded high-wave queue');
  tick(defeat, 1e6);
  check(defeat.gameOver && defeat.completedWaves === 0 && defeat.clearedWaveIndices.length === 0, 'loss counted as clear or impossible');
  const visuals = createGame();
  const hugeWave = spawn(visuals, 'brute', 1000000);
  check(hugeWave.paletteVariant === 3 && hugeWave.visualScale! <= 1.35, 'unsafe visual values');
  near(hugeWave.speed, ENEMIES.brute.speed * CELL_PX, 'visual scale changed speed');
  console.log('roster regression checks passed');
} finally {
  Math.random = random;
}
