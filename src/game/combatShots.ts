import type { BattleState, CombatMine, CombatShot, Enemy, PlacedTower, Vec2 } from './types';
import { CELL_PX, ENEMIES, damageMul } from './data';
import { effectiveEnemySpeed } from './combatStatus';
import { gameplayRandom } from './gameplayRandom';

const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const nextUid = (s: BattleState) => String(s.uidCounter++);
export const combatEligible = (s: BattleState, e: Enemy) => e.hp > 0
  && (e.spawnedAt === undefined || s.time - e.spawnedAt >= s.spawnTargetGraceSeconds);


// Forecast distance includes crossed waypoints.
export function forecastPosition(s: BattleState, e: Enemy, seconds: number): Vec2 {
  let pos = { ...e.pos };
  let remaining = effectiveEnemySpeed(s, e) * seconds;
  const path = e.flyProgress !== undefined
    ? [{ x: (s.exit.x + 0.5) * CELL_PX, y: (s.exit.y + 0.5) * CELL_PX }]
    : (e.path ?? s.currentPath?.map(p => ({ x: (p.x + 0.5) * CELL_PX, y: (p.y + 0.5) * CELL_PX })) ?? []).slice(e.pathIdx ?? 1);
  for (const to of path) {
    const d = distance(pos, to);
    if (d > remaining) return { x: pos.x + (to.x - pos.x) * remaining / d, y: pos.y + (to.y - pos.y) * remaining / d };
    remaining -= d;
    pos = { ...to };
  }
  return pos;
}

export function sampleMineRoute(s: BattleState, center: Vec2, radius: number): Vec2 | undefined {
  const path = s.currentPath?.map(p => ({ x: (p.x + 0.5) * CELL_PX, y: (p.y + 0.5) * CELL_PX })) ?? [];
  const sections: { from: Vec2; to: Vec2; length: number }[] = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const aa = dx * dx + dy * dy;
    if (!aa) continue;
    const ox = a.x - center.x, oy = a.y - center.y;
    const bb = 2 * (ox * dx + oy * dy);
    const discriminant = bb * bb - 4 * aa * (ox * ox + oy * oy - radius * radius);
    if (discriminant <= 0) continue;
    const lo = Math.max(0, (-bb - Math.sqrt(discriminant)) / (2 * aa));
    const hi = Math.min(1, (-bb + Math.sqrt(discriminant)) / (2 * aa));
    if (hi <= lo) continue;
    sections.push({ from: { x: a.x + dx * lo, y: a.y + dy * lo }, to: { x: a.x + dx * hi, y: a.y + dy * hi }, length: (hi - lo) * Math.sqrt(aa) });
  }
  let offset = gameplayRandom(s) * sections.reduce((sum, section) => sum + section.length, 0);
  for (const section of sections) {
    if (offset <= section.length) return { x: section.from.x + (section.to.x - section.from.x) * offset / section.length, y: section.from.y + (section.to.y - section.from.y) * offset / section.length };
    offset -= section.length;
  }
}

function hit(s: BattleState, e: Enemy, payload: CombatShot | CombatMine): void {
  if (!combatEligible(s, e)) return;
  e.hp = Math.max(0, e.hp - payload.damage * damageMul(payload.damageType, ENEMIES[e.id].weakAgainst, ENEMIES[e.id].strongAgainst));
  e.hitFlash = 0.06;
}

function impact(s: BattleState, payload: CombatShot | CombatMine, target?: Enemy): void {
  if (payload.damageType === 'Explosive') {
    for (const e of s.enemies) if (distance(e.pos, payload.pos) <= payload.splashRadius) hit(s, e, payload);
  } else if (target) hit(s, target, payload);
  const explosive = payload.damageType === 'Explosive';
  s.effects.push({ uid: nextUid(s), kind: explosive ? payload.towerId === 'rocketLauncher' ? 'boom_big' : 'boom' : 'bullet_spark', x: payload.pos.x, y: payload.pos.y, r: explosive ? payload.splashRadius : undefined, life: explosive ? 0.5 : 0.1, maxLife: explosive ? 0.5 : 0.1, towerId: payload.towerId, sourceTowerUid: payload.sourceTowerUid });
  if (explosive && s.soundQueue.length < 32) s.soundQueue.push('hit_explosion');
}

export function cleanOwnedCombat(s: BattleState, tower: PlacedTower): void {
  const owned = new Set(s.mines.filter(m => m.sourceTowerUid === tower.uid).map(m => m.uid));
  s.mines = s.mines.filter(m => !owned.has(m.uid));
  s.projectiles = s.projectiles.filter(p => !p.authoritativeUid || !owned.has(p.authoritativeUid));
  tower.mineReleaseAt = undefined;
  tower.loadedRocket = undefined;
  tower.rocketLoadRemaining = undefined;
  tower.nextBarrel = undefined;
}

export function advanceCombat(s: BattleState, dt: number): void {
  s.shots = s.shots.filter(shot => {
    if (shot.launchedAt >= s.time) return true;
    if (shot.kind === 'mortar') {
      const progress = Math.min(1, (s.time - shot.launchedAt) / 1.5);
      shot.pos = { x: shot.from.x + (shot.to.x - shot.from.x) * progress, y: shot.from.y + (shot.to.y - shot.from.y) * progress };
      if (progress >= 1 - 1e-10) { impact(s, shot); return false; }
      return true;
    }
    if (shot.kind === 'machineGun') {
      shot.pos.x += shot.direction.x * shot.speed * dt;
      shot.pos.y += shot.direction.y * shot.speed * dt;
      const target = s.enemies.find(e => combatEligible(s, e) && distance(e.pos, shot.pos) <= 0.5 * CELL_PX);
      if (target) { impact(s, shot, target); return false; }
      return shot.pos.x >= 0 && shot.pos.y >= 0 && shot.pos.x <= s.gridW * CELL_PX && shot.pos.y <= s.gridH * CELL_PX;
    }
    let target = s.enemies.find(e => e.uid === shot.targetUid && e.hp > 0);
    // Remove shots whose tracked target is no longer active.
    if (!target && shot.kind === 'rocket') {
      for (const e of s.enemies) if (combatEligible(s, e) && (!target || distance(e.pos, shot.pos) < distance(target.pos, shot.pos))) target = e;
      shot.targetUid = target?.uid;
    }
    if (!target) return false;
    shot.to = { ...target.pos };
    const d = distance(shot.pos, target.pos), step = shot.speed * dt;
    if (d > 0) shot.direction = { x: (target.pos.x - shot.pos.x) / d, y: (target.pos.y - shot.pos.y) / d };
    if (d <= step) { shot.pos = { ...target.pos }; impact(s, shot, target); return false; }
    shot.pos.x += (target.pos.x - shot.pos.x) * step / d;
    shot.pos.y += (target.pos.y - shot.pos.y) * step / d;
    return true;
  });
  s.mines = s.mines.filter(mine => {
    if (!mine.landed) {
      const progress = Math.min(1, (s.time - mine.launchedAt) / 1.5);
      mine.pos = { x: mine.from.x + (mine.to.x - mine.from.x) * progress, y: mine.from.y + (mine.to.y - mine.from.y) * progress };
      if (progress >= 1 - 1e-10) { mine.landed = true; mine.nextTriggerAt = s.time + 0.1; }
      return true;
    }
    if (s.time + 1e-10 < mine.nextTriggerAt) return true;
    mine.nextTriggerAt += (Math.floor(Math.max(0, s.time - mine.nextTriggerAt) / 0.1) + 1) * 0.1;
    if (s.enemies.some(e => combatEligible(s, e) && !ENEMIES[e.id].flying && distance(e.pos, mine.pos) <= 0.7 * CELL_PX)) { impact(s, mine); return false; }
    return true;
  });
}

export function projectCombat(s: BattleState): void {
  const previous = new Map(s.projectiles.filter(p => p.authoritativeUid !== undefined).map(p => [p.uid, p]));
  s.projectiles = s.projectiles.filter(p => p.authoritativeUid === undefined || p.kind === 'glue');
  for (const item of [...s.shots, ...s.mines]) {
    const mine = 'landed' in item;
    const projection = { uid: item.uid, authoritativeUid: item.uid, kind: mine ? 'mine' as const : item.kind === 'rocket' ? 'rocket' as const : 'bullet' as const, from: { ...item.from }, to: { ...item.to }, pos: { ...item.pos }, progress: mine && item.landed ? 1 : Math.min(1, distance(item.from, item.pos) / (distance(item.from, item.to) || 1)), speed: mine ? distance(item.from, item.to) / 1.5 : item.speed, damage: 0, damageType: item.damageType, life: 1, towerId: item.towerId, sourceTowerUid: item.sourceTowerUid, sourceSocket: mine ? undefined : item.sourceSocket };
    s.projectiles.push(Object.assign(previous.get(item.uid) ?? {}, projection));
  }
}

export function launchCombat(s: BattleState, tower: PlacedTower, target: Enemy, stats: { damage: number; splashRadius: number }, damageType: CombatShot['damageType']): void {
  const kind = tower.towerId === 'machineGun' ? 'machineGun' : tower.towerId === 'mortar' ? 'mortar' : tower.towerId === 'rocketLauncher' ? 'rocket' : 'cannon';
  const center = { x: tower.worldX, y: tower.worldY };
  let to = kind === 'mortar' ? forecastPosition(s, target, 1.5) : { ...target.pos };
  if (kind === 'mortar') {
    const radius = gameplayRandom(s) * CELL_PX, angle = gameplayRandom(s) * Math.PI * 2;
    to = { x: to.x + radius * Math.cos(angle), y: to.y + radius * Math.sin(angle) };
  }
  let angle = Math.atan2(to.y - center.y, to.x - center.x);
  if (kind === 'machineGun') {
    const ahead = forecastPosition(s, target, 1 / 1000);
    const vx = (ahead.x - target.pos.x) * 1000, vy = (ahead.y - target.pos.y) * 1000;
    const muzzle = { x: center.x + Math.cos(angle) * 0.7 * CELL_PX, y: center.y + Math.sin(angle) * 0.7 * CELL_PX };
    const base = Math.atan2(target.pos.y - muzzle.y, target.pos.x - muzzle.x);
    angle = base + Math.asin(Math.max(-1, Math.min(1, (vy * Math.cos(base) - vx * Math.sin(base)) / (8 * CELL_PX))));
  }
  const direction = { x: Math.cos(angle), y: Math.sin(angle) };
  const socket = tower.towerId === 'dualCanon' ? tower.nextBarrel ?? 0 : undefined;
  if (socket !== undefined) tower.nextBarrel = 1 - socket;
  const offset = kind === 'rocket' ? 0 : kind === 'mortar' ? 0.6 : 0.7;
  const side = socket === undefined ? 0 : socket === 0 ? 0.3 : -0.3;
  const from = { x: center.x + (direction.x * offset - direction.y * side) * CELL_PX, y: center.y + (direction.y * offset + direction.x * side) * CELL_PX };
  s.shots.push({ uid: nextUid(s), kind, towerId: tower.towerId, sourceTowerUid: tower.uid, sourceSocket: socket, from, pos: { ...from }, to, direction, targetUid: target.uid, damage: stats.damage, damageType, splashRadius: stats.splashRadius, speed: kind === 'mortar' ? distance(from, to) / 1.5 : (kind === 'rocket' ? 2.5 : kind === 'machineGun' ? 8 : 4) * CELL_PX, launchedAt: s.time });
  tower.aimAngle = angle;
  if (s.soundQueue.length < 32) s.soundQueue.push(kind === 'rocket' ? 'shot_rocket' : kind === 'mortar' ? 'shot_mortar' : kind === 'machineGun' ? 'shot_machineGun' : socket !== undefined ? 'shot_dualCanon' : 'shot_canon');
}
