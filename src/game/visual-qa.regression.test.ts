import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { CELL_PX, ENEMIES, TOWERS, TOWER_ORDER } from './data';
import { paperTowerPose } from './paperGeometry';
import type { PaperModel } from './paperGeometry';
import { buildVisualQaFixture, QA_ENEMY_IDS, QA_TOWER_IDS } from './visualQaFixtures';
import type { QaDensity } from './visualQaFixtures';
import { tick, worldToCell } from './engine';
import { findPath } from './pathfinding';
import type { BattleState, TowerId, Vec2 } from './types';

const manifest = JSON.parse(readFileSync('public/paper-assets/manifest.json', 'utf8')) as {
  towers: Record<string, PaperModel>; mobs: Record<string, PaperModel>;
};
let checks = 0;
function check(value: unknown, message: string): asserts value {
  checks++;
  assert.ok(value, message);
}
const balanceSnapshot = JSON.stringify({ TOWERS, ENEMIES });
check(TOWER_ORDER.length === 12 && Object.keys(ENEMIES).length === 11, 'QA production roster changed');
const modelPaths = new Set<string>();
for (const id of TOWER_ORDER) {
  const model = manifest.towers[id];
  check(!!model?.parts?.length, `${id}: missing paper model`);
  for (const part of model.parts) {
    const path = `public/paper-assets/runtime/towers/${id}/${part.file}`;
    check(existsSync(path), `${id}: missing mapped part ${part.file}`);
    modelPaths.add(path);
  }
  const max = TOWERS[id].maxLevel - 1;
  for (const requested of [0, 1, 2, 4, 5, max]) {
    const level = Math.min(max, requested);
    const pose = paperTowerPose(model, [0, 0, 256, 256], { worldX: 100, worldY: 100, level }, 0, Infinity, CELL_PX);
    check(!!pose, `${id}: level ${level} has no pose`);
    const files = pose.parts.map(item => item.part.file);
    check(files.includes('enhancement_1.png') === (level >= 2), `${id}: first enhancement mapping level ${level}`);
    check(files.includes('enhancement_2.png') === (level >= 5), `${id}: second enhancement mapping level ${level}`);
    check(pose.parts.every(item => item.matrix.every(Number.isFinite)), `${id}: invalid pose matrix`);
  }
}
check(modelPaths.size === TOWER_ORDER.reduce((sum, id) => sum + manifest.towers[id].parts!.length, 0),
  'tower models alias another tower directory');
for (const id of Object.keys(ENEMIES)) check(!!manifest.mobs[id], `${id}: missing mapped mob model`);
check(JSON.stringify({ TOWERS, ENEMIES }) === balanceSnapshot, 'visual mapping audit changed balance');

const fixtureSource = readFileSync('src/game/visualQaFixtures.ts', 'utf8');
check(!/from\s+['"][^'"]*(?:state\/|store|payment|wallet)/i.test(fixtureSource)
  && !/\b(?:localStorage|sessionStorage|saveState|executePayment)\b/.test(fixtureSource),
  'QA builder has persistent store/payment dependencies');
assert.deepEqual([...QA_TOWER_IDS].sort(), [...TOWER_ORDER].sort()); checks++;
assert.deepEqual([...QA_ENEMY_IDS].sort(), Object.keys(ENEMIES).sort()); checks++;

function point(state: BattleState, pos: Vec2, name: string) {
  check(Number.isFinite(pos.x) && Number.isFinite(pos.y), `${name}: NaN position`);
  check(pos.x >= 0 && pos.x < state.gridW * CELL_PX && pos.y >= 0 && pos.y < state.gridH * CELL_PX,
    `${name}: position outside field ${pos.x},${pos.y}`);
}
function audit(state: BattleState, id: TowerId) {
  check([state.time, state.gold, state.lives, state.creditsEarned].every(Number.isFinite), `${id}: nonfinite state`);
  check(state.spawnTargetGraceSeconds === 1, `${id}: QA disables production spawn grace`);
  check(state.towers.length === 1 && state.towers[0].towerId === id, `${id}: selected tower absent after builder`);
  point(state, { x: state.towers[0].worldX, y: state.towers[0].worldY }, `${id} tower`);
  for (const enemy of state.enemies) {
    point(state, enemy.pos, `${id}/${enemy.id}`);
    check([enemy.hp, enemy.maxHp, enemy.speed, enemy.spawnedAt!].every(Number.isFinite), `${id}: invalid enemy stats/grace`);
    check(enemy.hp > 0 && enemy.hp <= enemy.maxHp && enemy.speed > 0, `${id}: dead/nonmoving fixture mob`);
    if (enemy.teleportingUntil === undefined && enemy.flyProgress === undefined) {
      const cell = worldToCell(enemy.pos);
      check(!state.grid[cell.y][cell.x] && !!findPath(state.grid, cell, state.exit), `${id}: mob embedded or stranded`);
      check(!!enemy.path?.length && enemy.path.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)), `${id}: invalid personal path`);
    }
  }
  for (const shot of [...state.shots, ...state.mines, ...state.glueShots]) {
    point(state, shot.pos, `${id} authority`);
    point(state, shot.from, `${id} origin`);
    point(state, shot.to, `${id} destination`);
  }
  for (const effect of state.effects) {
    point(state, effect, `${id} effect`);
    check([effect.life, effect.maxLife].every(Number.isFinite), `${id}: invalid effect duration`);
    // StraightLaser's finite 100-cell endpoint intentionally extends beyond the viewport.
    check(!effect.pts || effect.pts.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)), `${id}: invalid beam geometry`);
  }
}

let snapshots = 0;
for (const id of QA_TOWER_IDS) {
  const max = TOWERS[id].maxLevel - 1;
  for (const requested of [-99, 0, 2, 5, max, 999, 2.9, NaN, Infinity]) {
    const state = buildVisualQaFixture(id, requested);
    const expected = Number.isFinite(requested) ? Math.max(0, Math.min(max, Math.floor(requested))) : 0;
    check(state.towers[0].level === expected, `${id}: level clamp ${requested}`);
    check(state.towers[0].cooldown === 0, `${id}: built enhanced/promoted tower not ready`);
    check(state.towers[0].lastFireTime === undefined, `${id}: builder injected fake fire`);
    check(state.shots.length + state.mines.length + state.glueShots.length + state.gluePatches.length
      + state.teleports.length + state.projectiles.length + state.effects.length === 0, `${id}: builder injected combat evidence`);
    audit(state, id);
    snapshots++;
  }
  for (const enemyId of QA_ENEMY_IDS) {
    const state = buildVisualQaFixture(id, 0, enemyId);
    check(state.enemies.filter(e => e.id === enemyId).length >= 6, `${id}/${enemyId}: selected mob roster absent`);
    check(state.enemies.every(e => e.maxHp >= ENEMIES[e.id].hp * 100), `${id}/${enemyId}: QA HP not explicit high-HP`);
    check(state.spawnQueue.length === 48 && state.spawnQueue.every(e => (e.healthModifier ?? 0) >= 100),
      `${id}/${enemyId}: arrivals missing QA-only health modifier`);
    audit(state, id);
    snapshots++;
  }
}

const evidence = new Map<TowerId, Set<string>>();
for (const id of QA_TOWER_IDS) {
  const state = buildVisualQaFixture(id, 0, 'soldier');
  const selectedUid = state.towers[0].uid;
  const seen = new Set(state.enemies.map(e => e.uid));
  const emitted = new Set<string>();
  evidence.set(id, emitted);
  const firstSnapshot = JSON.stringify(state.enemies.map(e => ({ hp: e.hp, pos: e.pos, spawnedAt: e.spawnedAt })));
  tick(state, 0);
  check(state.towers[0].lastFireTime === undefined, `${id}: emitted before initial scan/preparation`);
  check(state.shots.length === 0 && state.glueShots.length === 0, `${id}: zero-tick fake shot`);
  check(JSON.stringify(state.enemies.map(e => ({ hp: e.hp, pos: e.pos, spawnedAt: e.spawnedAt }))) === firstSnapshot,
    `${id}: initial zero-tick snapshot damaged/moved fixture mobs`);
  for (let step = 0; step < 400; step++) {
    tick(state, .05);
    audit(state, id);
    check(!state.gameOver, `${id}: fixture ended before 20s smoke`);
    for (const enemy of state.enemies) if (!seen.has(enemy.uid)) {
      seen.add(enemy.uid);
      check(enemy.spawnedAt === state.time && enemy.hp === enemy.maxHp && !enemy.hitFlash,
        `${id}: ordinary QA arrival bypassed normal birth/grace`);
    }
    for (const shot of state.shots) if (shot.sourceTowerUid === selectedUid) emitted.add(`shot:${shot.kind}`);
    for (const mine of state.mines) if (mine.sourceTowerUid === selectedUid) emitted.add(mine.landed ? 'mine:landed' : 'mine:flight');
    for (const shot of state.glueShots) if (shot.sourceTowerUid === selectedUid) emitted.add('glue:flight');
    for (const patch of state.gluePatches) if (patch.sourceTowerUid === selectedUid) emitted.add('glue:patch');
    for (const effect of state.effects) if (effect.sourceTowerUid === selectedUid && effect.kind.startsWith('chain')) emitted.add('laser:beam');
    for (const teleport of state.teleports) if (teleport.sourceTowerUid === selectedUid) emitted.add('teleport:phase');
  }
  const required = id === 'mineLayer' ? ['mine:flight', 'mine:landed']
    : id === 'glueTower' || id === 'glueGun' ? ['glue:flight', 'glue:patch']
    : id === 'teleporter' ? ['teleport:phase']
    : TOWERS[id].damageType === 'Laser' ? ['laser:beam']
    : [`shot:${id === 'machineGun' ? 'machineGun' : id === 'mortar' ? 'mortar' : id === 'rocketLauncher' ? 'rocket' : 'cannon'}`];
  check(required.every(kind => emitted.has(kind)), `${id}: missing real evidence ${required.filter(kind => !emitted.has(kind)).join(',')}`);
  check(state.towers[0].lastFireTime !== undefined, `${id}: no authoritative fire event`);
}
assert.throws(() => buildVisualQaFixture('canon', 0, 'soldier', 'invalid' as QaDensity), RangeError); checks++;
for (const id of QA_TOWER_IDS) {
  for (const enemyId of QA_ENEMY_IDS) {
    const state = buildVisualQaFixture(id, 0, enemyId, 'spaced');
    check(state.enemies.length === 1 && state.enemies[0].id === enemyId,
      `${id}/${enemyId}: spaced contains peers or wrong selected mob`);
    check(state.enemies[0].hp === state.enemies[0].maxHp && state.enemies[0].maxHp >= ENEMIES[enemyId].hp * 100,
      `${id}/${enemyId}: spaced lost QA high-HP fixture`);
    check(state.spawnQueue.length === 48 && state.spawnQueue.every((entry, index) => entry.id === enemyId
      && entry.delay === state.spawnElapsed + 2.5 * (index + 1)), `${id}/${enemyId}: spaced arrival interval/type`);
    audit(state, id);
    snapshots++;
  }
  const state = buildVisualQaFixture(id, 0, 'soldier', 'spaced');
  const selectedUid = state.towers[0].uid;
  const seen = new Set(state.enemies.map(e => e.uid));
  const actual = new Set<string>();
  for (let step = 0; step < 160; step++) {
    tick(state, .05);
    audit(state, id);
    check(!state.gameOver, `${id}: spaced fixture ended before 8s`);
    for (const enemy of state.enemies) if (!seen.has(enemy.uid)) {
      seen.add(enemy.uid);
      check(enemy.spawnedAt === state.time && enemy.hp === enemy.maxHp && !enemy.hitFlash,
        `${id}: spaced arrival skipped birth/grace`);
    }
    for (const shot of state.shots) if (shot.sourceTowerUid === selectedUid) actual.add(`shot:${shot.kind}`);
    for (const mine of state.mines) if (mine.sourceTowerUid === selectedUid) actual.add(mine.landed ? 'mine:landed' : 'mine:flight');
    for (const shot of state.glueShots) if (shot.sourceTowerUid === selectedUid) actual.add('glue:flight');
    for (const patch of state.gluePatches) if (patch.sourceTowerUid === selectedUid) actual.add('glue:patch');
    for (const effect of state.effects) if (effect.sourceTowerUid === selectedUid && effect.kind.startsWith('chain')) actual.add('laser:beam');
    for (const phase of state.teleports) if (phase.sourceTowerUid === selectedUid) actual.add('teleport:phase');
  }
  const required = evidence.get(id)!;
  check([...required].every(kind => actual.has(kind)), `${id}: spaced lacks actual evidence ${[...required].filter(kind => !actual.has(kind)).join(',')}`);
  check(state.towers[0].lastFireTime !== undefined, `${id}: spaced selected tower never fired`);
  check(seen.size >= 3, `${id}: spaced arrivals smoke vacuous`);
}
check(JSON.stringify({ TOWERS, ENEMIES }) === balanceSnapshot, 'builder/combat mutated persistent balance tables');
console.log(`Visual QA passed: ${snapshots} roster/level snapshots, 12 towers x 20s cluster + 8s spaced real combat, ${checks} checks; no browser visual claim.`);
console.log(Object.fromEntries([...evidence].map(([id, kinds]) => [id, [...kinds]])));
