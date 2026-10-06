import { createGame, placeTower, promoteTower, sellTower, setTargeting, setTargetLock, tick, cellToWorld, worldToCell } from './engine';
import { findPath } from './pathfinding';
import { CELL_PX } from './data';
import type { BattleState, Enemy, PlacedTower, TowerId } from './types';

// Independent targeting, laser, glue and teleport regression fixtures.
let checks = 0;
let cases = 0;
const failures: string[] = [];
function check(value: unknown, message: string) {
  checks++;
  if (!value) throw new Error(message);
}
function near(actual: number, expected: number, message: string, tolerance = 1e-6) {
  check(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} != ${expected}`);
}
function test(name: string, body: () => void) {
  cases++;
  try { body(); } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function fixture(id: TowerId, width = 12) {
  const state = createGame(width, 21);
  state.gold = 1e9;
  check(placeTower(state, id, { x: 4, y: 5 }), 'tower fixture placement');
  return { state, tower: state.towers[0] };
}
function mob(state: BattleState, x: number, y: number, hp = 1e9): Enemy {
  const en: Enemy = { uid: `status-${state.uidCounter++}`, id: 'soldier', hp, maxHp: hp, speed: 0,
    pos: { x, y }, path: [{ x, y }, { x, y: y + 1000 }], pathIdx: 1, pathProgress: 0 };
  state.enemies.push(en);
  return en;
}
function moveTo(en: Enemy, x: number, y: number) {
  en.pos = { x, y };
  en.path = [{ x, y }, { x, y: y + 1000 }];
  en.pathIdx = 1;
  en.pathProgress = 0;
}
function advance(state: BattleState, seconds: number) {
  for (let i = 0; i < Math.round(seconds * 64); i++) tick(state, 1 / 64);
}
function quiet(state: BattleState) { state.towers.forEach(tower => { tower.cooldown = 1e6; }); }
function acquire(state: BattleState) { tick(state, .1); }
function probe(state: BattleState, tower: PlacedTower) {
  const prior = new Set(state.shots.map(shot => shot.uid));
  tower.cooldown = 0;
  tick(state, 0);
  const shot = state.shots.find(item => !prior.has(item.uid));
  quiet(state);
  return shot?.targetUid;
}
function flyer(state: BattleState): Enemy {
  const entry = cellToWorld(state.entry), exit = cellToWorld(state.exit);
  const en = mob(state, entry.x, entry.y + (exit.y - entry.y) * .25);
  en.id = 'flyer';
  en.speed = 1.3 * CELL_PX;
  en.flyProgress = .25;
  en.path = undefined;
  return en;
}
function displacement(state: BattleState, en: Enemy, seconds: number) {
  const before = { ...en.pos };
  advance(state, seconds);
  return Math.hypot(en.pos.x - before.x, en.pos.y - before.y);
}

test('default Closest/lock=true; locked target survives strategy change until range/death', () => {
  const { state, tower } = fixture('canon');
  check(tower.targetingMode === 'closest' && tower.targetLock === true, 'default targeting/lock');
  const nearTarget = mob(state, tower.worldX + CELL_PX, tower.worldY);
  const strong = mob(state, tower.worldX + 2 * CELL_PX, tower.worldY, 2e9);
  check(probe(state, tower) === undefined && tower.targetUid === undefined, 'Aimer selected before first .1s refresh');
  tower.cooldown = 0;
  acquire(state);
  check(tower.targetUid === nearTarget.uid, 'default did not pick closest');
  setTargeting(state, tower.uid, 'strongest');
  advance(state, .125);
  check(probe(state, tower) === nearTarget.uid, 'strategy change broke target lock');
  moveTo(nearTarget, tower.worldX + 10 * CELL_PX, tower.worldY);
  advance(state, .125);
  check(probe(state, tower) === strong.uid, 'locked out-of-range target not released');
  const replacement = mob(state, tower.worldX + CELL_PX, tower.worldY);
  strong.hp = 0;
  advance(state, .125);
  check(probe(state, tower) === replacement.uid, 'locked dead target not released');
});
test('lock=false refreshes at .1s, not every fire or strategy assignment; pause/JSON retain cache', () => {
  const { state, tower } = fixture('canon');
  const old = mob(state, tower.worldX + CELL_PX, tower.worldY);
  const strong = mob(state, tower.worldX + 2 * CELL_PX, tower.worldY, 2e9);
  acquire(state);
  check(probe(state, tower) === old.uid, 'initial closest');
  setTargetLock(state, tower.uid, false);
  setTargeting(state, tower.uid, 'strongest');
  advance(state, .09375);
  check(probe(state, tower) === old.uid, 'unlocked cache refreshed before .1s');
  state.paused = true;
  const snapshot = JSON.stringify(state);
  tick(state, 50);
  check(JSON.stringify(state) === snapshot, 'pause advanced aimer timer/cache');
  const restored = JSON.parse(snapshot) as BattleState;
  restored.paused = false;
  advance(restored, .015625);
  check(probe(restored, restored.towers[0]) === strong.uid, 'JSON cache did not refresh after .1s');
  near(state.time, .19375, 'restored timer shared original state');
});
test('promotion retains strategy and lock, resets new-tier aiming without stale target', () => {
  const { state, tower } = fixture('canon');
  setTargetLock(state, tower.uid, false);
  setTargeting(state, tower.uid, 'weakest');
  const en = mob(state, tower.worldX + CELL_PX, tower.worldY);
  acquire(state);
  check(probe(state, tower) === en.uid, 'promotion target fixture');
  check(promoteTower(state, tower.uid), 'promotion failed');
  check(tower.targetLock === false && tower.targetingMode === 'weakest' && tower.cooldown === 0,
    'promotion lost strategy/lock/readiness');
  acquire(state);
  check(tower.targetUid === en.uid, 'promoted aimer failed to acquire valid target');
});
test('chain chooses nearest unseen targets, primary plus four extra, eligibility/grace independent of array order', () => {
  const { state, tower } = fixture('bouncingLaser');
  setTargeting(state, tower.uid, 'strongest');
  const x = tower.worldX + CELL_PX;
  const primary = mob(state, x, tower.worldY, 2e9);
  const nodes = Array.from({ length: 5 }, (_, n) => mob(state, x + (n + 1) * .25 * CELL_PX, tower.worldY));
  const protectedMob = mob(state, x + .1 * CELL_PX, tower.worldY);
  protectedMob.spawnedAt = 0;
  const dead = mob(state, x + .05 * CELL_PX, tower.worldY, 0);
  state.enemies = [primary, nodes[4], nodes[3], protectedMob, dead, nodes[2], nodes[1], nodes[0]];
  acquire(state);
  near(primary.hp, 2e9 - 4300, 'chain primary damage');
  nodes.slice(0, 4).forEach(en => near(en.hp, 1e9 - 4300, 'nearest chain node damage'));
  check(nodes[4].hp === 1e9 && protectedMob.hp === 1e9, 'chain exceeded five or bypassed grace');
  check(!state.enemies.includes(dead), 'dead chain candidate retained');
});
test('chain bounce range2 stops when nearest unseen candidate is too far', () => {
  const { state, tower } = fixture('bouncingLaser');
  const primary = mob(state, tower.worldX + CELL_PX, tower.worldY);
  const outside = mob(state, primary.pos.x + 2.01 * CELL_PX, primary.pos.y);
  acquire(state);
  check(primary.hp < primary.maxHp && outside.hp === outside.maxHp, 'chain crossed source bounce distance');
});
test('straight laser finite segment muzzle.8 to100, fullwidth.7 includes endpoints and excludes behind/beyond', () => {
  const { state, tower } = fixture('straightLaser', 160);
  setTargeting(state, tower.uid, 'strongest');
  const primary = mob(state, tower.worldX + 2 * CELL_PX, tower.worldY, 2e9);
  const start = mob(state, tower.worldX + .8 * CELL_PX, tower.worldY);
  const end = mob(state, tower.worldX + 100 * CELL_PX, tower.worldY);
  const inside = mob(state, tower.worldX + 4 * CELL_PX, tower.worldY + .349 * CELL_PX);
  const outside = mob(state, tower.worldX + 4 * CELL_PX, tower.worldY + .351 * CELL_PX);
  const behind = mob(state, tower.worldX + .79 * CELL_PX, tower.worldY);
  const beyond = mob(state, tower.worldX + 100.01 * CELL_PX, tower.worldY);
  const protectedMob = mob(state, tower.worldX + 3 * CELL_PX, tower.worldY);
  protectedMob.spawnedAt = 0;
  acquire(state);
  check(primary.hp < primary.maxHp && start.hp < start.maxHp && end.hp < end.maxHp
    && inside.hp < inside.maxHp, 'finite laser missed inclusive endpoint/inside halfwidth');
  check([outside, behind, beyond, protectedMob].every(en => en.hp === en.maxHp),
    'finite laser extended segment/width or bypassed grace');
});
for (const [id, duration] of [['simpleLaser', .5], ['bouncingLaser', .5], ['straightLaser', 1]] as const) {
  test(`${id}: real flyer speed .05 during ${duration}s then restore, even after tower sold`, () => {
    const { state, tower } = fixture(id);
    const en = flyer(state);
    acquire(state);
    check(en.hp < en.maxHp, 'stun fixture laser did not hit flyer');
    quiet(state);
    const first = displacement(state, en, .125);
    near(first, en.speed * .05 * .125, 'flyer stun movement');
    sellTower(state, tower.uid);
    const sold = displacement(state, en, .125);
    near(sold, en.speed * .05 * .125, 'sold tower prematurely canceled active stun');
    advance(state, duration);
    near(displacement(state, en, .125), en.speed * .125, 'flyer stun did not restore base movement');
  });
}
test('overlapping flyer stuns multiply before minimum.05, expire independently, pause/JSON preserve', () => {
  const { state, tower } = fixture('bouncingLaser');
  check(placeTower(state, 'straightLaser', { x: 5, y: 5 }), 'second laser fixture');
  const en = flyer(state);
  acquire(state);
  quiet(state);
  near(displacement(state, en, .125), en.speed * .05 * .125, 'overlap applied minimum per individual effect');
  state.paused = true;
  const snapshot = JSON.stringify(state);
  tick(state, 100);
  check(JSON.stringify(state) === snapshot, 'pause expired stun');
  const restored = JSON.parse(snapshot) as BattleState;
  restored.paused = false;
  restored.effects = [];
  restored.projectiles = [];
  const restoredEnemy = restored.enemies.find(item => item.uid === en.uid)!;
  advance(restored, .5);
  near(displacement(restored, restoredEnemy, .125), en.speed * .05 * .125, 'remaining straight stun lost after bounce expiry');
  advance(restored, .5);
  near(displacement(restored, restoredEnemy, .125), en.speed * .125, 'independent stun expiration did not restore');
  check(tower.towerId === 'bouncingLaser', 'JSON copy changed source tower');
});
test('GlueGun authoritative travel4, intensity enhancement, persistent area enter/exit/expiry, cosmetic clear safe', () => {
  const { state, tower } = fixture('glueGun');
  tower.level = 2;
  const en = mob(state, tower.worldX + 2 * CELL_PX, tower.worldY);
  acquire(state);
  check(en.slowUntil === undefined, 'glue slowed at launch');
  const shot = state.glueShots[0];
  check(!!shot && shot.speed === 4 * CELL_PX, 'authoritative glue travel speed');
  quiet(state);
  state.projectiles = [];
  state.effects = [];
  advance(state, .625);
  const anchor = { ...en.pos };
  en.speed = CELL_PX;
  near(displacement(state, en, .125), CELL_PX / 1.8 * .125, 'enhanced glue intensity1.2+.3*2');
  moveTo(en, anchor.x + 2 * CELL_PX, anchor.y);
  advance(state, .125);
  near(displacement(state, en, .125), CELL_PX * .125, 'leaving area did not cancel slow');
  moveTo(en, anchor.x, anchor.y);
  advance(state, .125);
  near(displacement(state, en, .125), CELL_PX / 1.8 * .125, 're-entering persistent area did not slow');
  advance(state, 3);
  near(displacement(state, en, .125), CELL_PX * .125, 'expired glue area did not restore speed');
});
test('GlueGun forecast is fixed arrival position, not homing onto moved target', () => {
  const { state, tower } = fixture('glueGun');
  const en = mob(state, tower.worldX + 2 * CELL_PX, tower.worldY);
  en.speed = CELL_PX;
  acquire(state);
  quiet(state);
  const shot = state.glueShots[0];
  check(!!shot, 'missing glue prediction shot');
  const flightTime = Math.hypot(en.pos.x - tower.worldX, en.pos.y - tower.worldY) / (4 * CELL_PX);
  near(shot!.to.y, en.pos.y + flightTime * en.speed, 'distance/4 prediction');
  const target = { ...shot!.to };
  moveTo(en, en.pos.x + 5 * CELL_PX, en.pos.y);
  advance(state, .125);
  near(shot!.to.x, target.x, 'glue shot homed on moved target x');
  near(shot!.to.y, target.y, 'glue shot homed on moved target y');
});
test('GlueTower .8s outward phase releases multiple path sites, enhanced patches survive JSON and expire', () => {
  const state = createGame();
  state.gold = 1e9;
  check(placeTower(state, 'glueTower', { x: 5, y: 5 }), 'GlueTower route fixture');
  const tower = state.towers[0];
  tower.level = 2;
  mob(state, tower.worldX + CELL_PX, tower.worldY);
  acquire(state);
  check(state.glueShots.length === 0 && tower.glueReleaseAt !== undefined, 'GlueTower skipped outward phase');
  quiet(state);
  advance(state, .796875);
  check(state.glueShots.length === 0, 'GlueTower released before .8s');
  advance(state, .015625);
  check(state.glueShots.length >= 2, 'GlueTower did not emit multi-site route volley');
  const sites = state.glueShots.map(shot => shot.to);
  for (const shot of state.glueShots) {
    near(shot.intensity, 1.6, 'GlueTower intensity1.2+.2*2');
    near(shot.duration, 1.5, 'GlueTower patch duration');
    near(shot.speed, 4 * CELL_PX, 'GlueTower flight speed');
    near(shot.to.x, cellToWorld(state.entry).x, 'GlueTower site off canonical straight route');
    near(Math.hypot(shot.from.x - tower.worldX, shot.from.y - tower.worldY), .8 * CELL_PX,
      'GlueTower muzzle offset');
  }
  const ordered = [...sites].sort((a, b) => a.y - b.y);
  for (let i = 1; i < ordered.length; i++) near(ordered[i].y - ordered[i - 1].y, CELL_PX, 'route samples spaced one cell');
  check(sites.every((a, i) => sites.every((b, j) => i === j || Math.hypot(a.x - b.x, a.y - b.y) >= .5 * CELL_PX)),
    'GlueTower duplicate near sites');
  const restored = JSON.parse(JSON.stringify(state)) as BattleState;
  restored.projectiles = [];
  restored.effects = [];
  advance(restored, .625);
  check(restored.gluePatches.length >= 2, 'serialized multi-site flight lost arrival patches');
  check(restored.gluePatches.every(p => p.radius === CELL_PX && p.intensity === 1.6
    && Math.abs(p.expiresAt - p.startedAt - 1.5) < 1e-8), 'GlueTower authority patch geometry/duration');
  const en = restored.enemies[0];
  moveTo(en, ordered[0].x, ordered[0].y);
  advance(restored, .125);
  const count = restored.gluePatches.filter(p => p.enemyUids.includes(en.uid)).length;
  check(count > 0, 'GlueTower patches never observed ground target');
  en.speed = CELL_PX;
  near(displacement(restored, en, .0625), CELL_PX / Math.pow(1.6, count) * .0625, 'GlueTower actual enhanced movement');
  advance(restored, 2);
  check(restored.gluePatches.length === 0, 'GlueTower patches persisted after duration');
  near(displacement(restored, en, .125), CELL_PX * .125, 'GlueTower cleanup did not restore movement');
});
test('two glue areas multiply; exiting only one restores the remaining factor; pause/JSON safe', () => {
  const { state, tower } = fixture('glueGun');
  const en = mob(state, tower.worldX + 2 * CELL_PX, tower.worldY);
  acquire(state);
  quiet(state);
  const first = { ...en.pos };
  check(placeTower(state, 'glueGun', { x: 4, y: 6 }), 'second glue tower');
  moveTo(en, first.x, first.y + .75 * CELL_PX);
  acquire(state);
  quiet(state);
  const second = { ...en.pos };
  advance(state, .625);
  check(state.gluePatches.length === 2, 'overlap fixture did not form exactly two patches');
  moveTo(en, first.x, (first.y + second.y) / 2);
  advance(state, .125);
  en.speed = CELL_PX;
  near(displacement(state, en, .125), CELL_PX / (1.2 * 1.2) * .125, 'overlap did not multiply');
  en.speed = 0;
  moveTo(en, second.x, second.y + .75 * CELL_PX);
  advance(state, .125);
  check(state.gluePatches.filter(p => p.enemyUids.includes(en.uid)).length === 1, 'exit did not remove only first membership');
  state.paused = true;
  const snapshot = JSON.stringify(state);
  tick(state, 100);
  check(JSON.stringify(state) === snapshot, 'pause expired glue memberships');
  const restored = JSON.parse(snapshot) as BattleState;
  restored.paused = false;
  restored.enemies[0].speed = CELL_PX;
  near(displacement(restored, restored.enemies[0], .125), CELL_PX / 1.2 * .125, 'single exit lost remaining intensity');
});
test('Glue resistant flyer is not slowed, support aura composes with ground glue then restores', () => {
  const { state, tower } = fixture('glueGun');
  const ground = mob(state, tower.worldX + 2 * CELL_PX, tower.worldY);
  const resistant = mob(state, ground.pos.x, ground.pos.y);
  resistant.id = 'flyer';
  const support = mob(state, ground.pos.x, ground.pos.y);
  support.id = 'support';
  acquire(state);
  quiet(state);
  advance(state, .625);
  ground.speed = resistant.speed = CELL_PX;
  near(displacement(state, ground, .125), CELL_PX * 1.2 / 1.2 * .125, 'support aura/glue composition');
  // This stationary-position flyer fixture tests resistance; real flight is tested above.
  near(displacement(state, resistant, .125), CELL_PX * 1.2 * .125, 'flyer Glue resistance ignored');
  advance(state, 3);
  moveTo(ground, support.pos.x, support.pos.y);
  near(displacement(state, ground, .125), CELL_PX * 1.2 * .125, 'glue expiration lost aura or base speed');
});
test('two teleporters cannot pull same enemy simultaneously; one-second phase and permanent exclusion', () => {
  const { state, tower } = fixture('teleporter');
  check(placeTower(state, 'teleporter', { x: 5, y: 5 }), 'second teleporter fixture');
  const en = mob(state, tower.worldX + CELL_PX, tower.worldY);
  en.path = [{ x: en.pos.x, y: en.pos.y - 5 * CELL_PX }, { ...en.pos },
    { x: en.pos.x, y: en.pos.y + 1000 }];
  en.pathIdx = 1;
  en.pathProgress = 1;
  en.speed = 0;
  const initial = { ...en.pos };
  acquire(state);
  en.speed = CELL_PX;
  check(en.pos.x === initial.x && en.pos.y === initial.y, 'teleport instantly rewound');
  quiet(state);
  advance(state, .5);
  near(en.pos.x, (initial.x + tower.worldX) / 2, 'teleport linear pull midpoint');
  near(en.pos.y, (initial.y + tower.worldY) / 2, 'teleport failed to freeze ordinary movement');
  const frozen = JSON.stringify(state);
  state.paused = true;
  tick(state, 100);
  state.paused = false;
  check(JSON.stringify(state) === frozen, 'pause advanced teleport phase');
  const restored = JSON.parse(frozen) as BattleState;
  advance(restored, .5);
  const moved = restored.enemies.find(item => item.uid === en.uid)!;
  near(moved.pos.x, initial.x, 'teleport rewind captured route x');
  near(moved.pos.y, initial.y - 5 * CELL_PX, 'teleport rewind clamps captured route start');
  check(moved.pathProgress === 0 && moved.wasTeleported === true && restored.teleports.length === 0,
    'teleport phase did not finish with permanent marker');
  moveTo(moved, initial.x, initial.y);
  restored.towers.forEach(item => { item.cooldown = 0; });
  const previousFire = restored.towers.map(item => item.lastFireTime);
  advance(restored, .125);
  check(restored.towers.every((item, n) => item.lastFireTime === previousFire[n]),
    'previously teleported enemy was targeted again');
});

for (const occupiedBefore of [false, true]) {
  test(`teleport maze adaptation: ${occupiedBefore ? 'occupied old history before launch' : 'build on captured destination during phase'}`, () => {
    const { state, tower } = fixture('teleporter');
    const destinationCell = { x: 5, y: 1 };
    const destination = cellToWorld(destinationCell);
    if (occupiedBefore) check(placeTower(state, 'canon', destinationCell), 'old history obstacle placement');
    const en = mob(state, tower.worldX + CELL_PX, tower.worldY);
    en.path = [destination, { ...en.pos }, { x: en.pos.x, y: en.pos.y + 1000 }];
    en.pathIdx = 1;
    en.pathProgress = 1;
    acquire(state);
    quiet(state);
    check(state.teleports.length === 1, 'maze fixture did not begin teleport');
    if (!occupiedBefore) {
      const captured = worldToCell(state.teleports[0].destination);
      const accepted = placeTower(state, 'canon', captured);
      if (accepted) check(!state.grid[worldToCell(state.teleports[0].destination).y]
        [worldToCell(state.teleports[0].destination).x], 'accepted build left reserved destination blocked');
    }
    advance(state, 1);
    const cell = worldToCell(en.pos);
    check(en.wasTeleported === true && state.teleports.length === 0, 'maze phase did not complete');
    check(!state.grid[cell.y][cell.x], 'teleport ended embedded in tower');
    check(!!findPath(state.grid, cell, state.exit), 'teleport ended with no exit route');
    check(en.path!.every(point => {
      const next = worldToCell(point);
      return !state.grid[next.y]?.[next.x];
    }), 'rebuilt personal route retains blocked history');
  });
}
test('teleport lost target cleans phase and JSON state without crashing or reviving target', () => {
  const { state, tower } = fixture('teleporter');
  const en = mob(state, tower.worldX + CELL_PX, tower.worldY);
  acquire(state);
  check(state.teleports.length === 1, 'lost target phase fixture');
  en.hp = 0;
  const restored = JSON.parse(JSON.stringify(state)) as BattleState;
  advance(restored, .125);
  check(restored.teleports.length === 0 && !restored.enemies.some(item => item.uid === en.uid),
    'dead target retained teleport or revived');
});

if (failures.length) throw new Error(`Targeting/status: ${failures.length}/${cases} failed\n${failures.join('\n')}`);
console.log(`Targeting/status passed: ${cases} cases, ${checks} checks; targeting/laser/glue/teleport fixtures.`);
