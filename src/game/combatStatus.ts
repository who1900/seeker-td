import type { BattleState, Enemy, PlacedTower, Vec2 } from './types';
import { CELL_PX, ENEMIES, damageMul } from './data';

const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const uid = (s: BattleState) => String(s.uidCounter++);
const eligible = (s: BattleState, e: Enemy) => e.hp > 0 && (e.spawnedAt === undefined
  || s.time - e.spawnedAt >= s.spawnTargetGraceSeconds);

export function effectiveEnemySpeed(s: BattleState, e: Enemy): number {
  let product = e.slowUntil !== undefined && s.time < e.slowUntil ? 1 / (e.slowFactor ?? 1.2) : 1;
  for (const status of e.speedEffects ?? []) if (s.time < status.expiresAt) product *= status.multiplier;
  for (const patch of s.gluePatches) {
    if (s.time < patch.expiresAt && patch.enemyUids.includes(e.uid)) product /= patch.intensity;
  }
  let aura = 1;
  for (const other of s.enemies) {
    const spec = ENEMIES[other.id];
    if (other !== e && other.hp > 0 && spec.speedAuraRadius !== undefined
      && distance(e.pos, other.pos) <= spec.speedAuraRadius * CELL_PX) aura = Math.max(aura, spec.speedAuraMultiplier ?? 1);
  }
  return e.speed * aura * Math.max(0.05, product);
}

export function refreshInterval(remaining: number | undefined, dt: number): { remaining: number; due: boolean } {
  let next = (remaining ?? 0.1) - dt;
  const due = next <= 1e-10;
  if (due) next += (Math.floor(Math.max(0, -next) / 0.1) + 1) * 0.1;
  return { remaining: next, due };
}

function laserHit(s: BattleState, tower: PlacedTower, target: Enemy, damage: number, duration: number) {
  if (!eligible(s, target)) return;
  const spec = ENEMIES[target.id];
  target.hp = Math.max(0, target.hp - damage * damageMul('Laser', spec.weakAgainst, spec.strongAgainst));
  target.hitFlash = 0.06;
  if (target.hp > 0 && spec.flying && !spec.strongAgainst.includes('Laser')) {
    (target.speedEffects ??= []).push({ uid: uid(s), kind: 'laserStun', sourceTowerUid: tower.uid,
      multiplier: 1 / 20, startedAt: s.time, expiresAt: s.time + duration });
  }
}

export function fireLaser(s: BattleState, tower: PlacedTower, target: Enemy,
  stats: { damage: number; bounces: number; bounceRange: number }): void {
  const angle = Math.atan2(target.pos.y - tower.worldY, target.pos.x - tower.worldX);
  const dir = { x: Math.cos(angle), y: Math.sin(angle) };
  const straight = tower.towerId === 'straightLaser';
  const from = { x: tower.worldX + dir.x * (straight ? 0.8 : 0.7) * CELL_PX,
    y: tower.worldY + dir.y * (straight ? 0.8 : 0.7) * CELL_PX };
  const points = [from];
  const targetUids: string[] = [];
  if (straight) {
    const to = { x: tower.worldX + dir.x * 100 * CELL_PX, y: tower.worldY + dir.y * 100 * CELL_PX };
    const length = distance(from, to);
    for (const e of s.enemies) {
      const dx = e.pos.x - from.x, dy = e.pos.y - from.y;
      const projection = dx * dir.x + dy * dir.y;
      if (projection >= -1e-9 && projection <= length + 1e-9
        && Math.abs(dx * dir.y - dy * dir.x) <= 0.35 * CELL_PX + 1e-9) laserHit(s, tower, e, stats.damage, 1);
    }
    points.push(to);
  } else {
    const visited = new Set<string>();
    let current: Enemy | undefined = target;
    const count = tower.towerId === 'bouncingLaser' ? stats.bounces : 0;
    for (let bounce = 0; current && bounce <= count; bounce++) {
      visited.add(current.uid);
      targetUids.push(current.uid);
      points.push({ ...current.pos });
      let next: Enemy | undefined;
      // Choose the successor before damaging the current node.
      if (bounce < count) for (const e of s.enemies) {
        if (eligible(s, e) && !visited.has(e.uid) && distance(current.pos, e.pos) <= stats.bounceRange
          && (!next || distance(current.pos, e.pos) < distance(current.pos, next.pos))) next = e;
      }
      laserHit(s, tower, current, stats.damage, 0.5);
      current = next;
    }
  }
  s.effects.push({ uid: uid(s), kind: straight ? 'chain_straight' : tower.towerId === 'bouncingLaser' ? 'chain_bounce' : 'chain',
    x: from.x, y: from.y, pts: points, targetUids: straight ? undefined : targetUids,
    life: 0.5, maxLife: 0.5, sourceTowerUid: tower.uid, towerId: tower.towerId });
  if (!straight) for (const pt of points.slice(1)) s.effects.push({ uid: uid(s), kind: 'laser_flash',
    x: pt.x, y: pt.y, life: 0.12, maxLife: 0.12, sourceTowerUid: tower.uid, towerId: tower.towerId });
  if (s.soundQueue.length < 32) s.soundQueue.push(straight ? 'shot_straightPierce' : tower.towerId === 'bouncingLaser' ? 'shot_bounceChain' : 'shot_simpleLaser');
}

export function determineGlueTargets(s: BattleState, tower: PlacedTower, radius: number): Vec2[] {
  const center = { x: tower.worldX, y: tower.worldY };
  const path = s.currentPath?.map(p => ({ x: (p.x + 0.5) * CELL_PX, y: (p.y + 0.5) * CELL_PX })) ?? [];
  const points: Vec2[] = [];
  let offset = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dx = b.x - a.x, dy = b.y - a.y, aa = dx * dx + dy * dy;
    if (!aa) continue;
    const ox = a.x - center.x, oy = a.y - center.y, bb = 2 * (ox * dx + oy * dy);
    const discriminant = bb * bb - 4 * aa * (ox * ox + oy * oy - radius * radius);
    if (discriminant <= 0) continue;
    const lo = Math.max(0, (-bb - Math.sqrt(discriminant)) / (2 * aa));
    const hi = Math.min(1, (-bb + Math.sqrt(discriminant)) / (2 * aa));
    if (hi <= lo) continue;
    const length = (hi - lo) * Math.sqrt(aa);
    while (offset < length - 1e-9) {
      const t = lo + offset / Math.sqrt(aa);
      const point = { x: a.x + dx * t, y: a.y + dy * t };
      if (points.every(p => distance(p, point) >= 0.5 * CELL_PX)) points.push(point);
      offset += CELL_PX;
    }
    offset -= length;
  }
  return points;
}

export function launchGlue(s: BattleState, tower: PlacedTower, to: Vec2, intensity: number, duration: number): void {
  const angle = Math.atan2(to.y - tower.worldY, to.x - tower.worldX);
  const offset = tower.towerId === 'glueTower' ? 0.8 : 0.7;
  const from = { x: tower.worldX + Math.cos(angle) * offset * CELL_PX, y: tower.worldY + Math.sin(angle) * offset * CELL_PX };
  s.glueShots.push({ uid: uid(s), sourceTowerUid: tower.uid, towerId: tower.towerId, from, to: { ...to }, pos: { ...from },
    speed: 4 * CELL_PX, intensity, duration, launchedAt: s.time });
  tower.aimAngle = angle;
}

export function advanceStatus(s: BattleState, dt: number): void {
  for (const e of s.enemies) if (e.speedEffects) e.speedEffects = e.speedEffects.filter(effect => effect.expiresAt > s.time);
  s.gluePatches = s.gluePatches.filter(patch => patch.expiresAt > s.time);
  s.glueShots = s.glueShots.filter(shot => {
    if (shot.launchedAt >= s.time) return true;
    const d = distance(shot.pos, shot.to), step = shot.speed * dt;
    if (d <= step + 1e-10) {
      s.gluePatches.push({ uid: uid(s), sourceTowerUid: shot.sourceTowerUid, towerId: shot.towerId, pos: { ...shot.to },
        radius: CELL_PX, intensity: shot.intensity, startedAt: s.time, expiresAt: s.time + shot.duration,
        nextObserveAt: s.time + 0.1, enemyUids: [] });
      return false;
    }
    shot.pos.x += (shot.to.x - shot.pos.x) * step / d;
    shot.pos.y += (shot.to.y - shot.pos.y) * step / d;
    return true;
  });
  for (const patch of s.gluePatches) {
    if (s.time + 1e-10 < patch.nextObserveAt) continue;
    patch.nextObserveAt += (Math.floor(Math.max(0, s.time - patch.nextObserveAt) / 0.1) + 1) * 0.1;
    patch.enemyUids = s.enemies.filter(e => eligible(s, e) && !ENEMIES[e.id].strongAgainst.includes('Glue')
      && distance(e.pos, patch.pos) <= patch.radius).map(e => e.uid);
  }
}

export function projectStatus(s: BattleState): void {
  const teleportIds = new Set(s.teleports.map(t => t.uid));
  s.effects = s.effects.filter(e => e.kind !== 'teleport' || !e.targetUids || teleportIds.has(e.uid));
  for (const teleport of s.teleports) {
    const target = s.enemies.find(e => e.uid === teleport.targetUid && e.hp > 0);
    if (!target) continue;
    const projection = { uid: teleport.uid, kind: 'teleport' as const, towerId: 'teleporter' as const,
      sourceTowerUid: teleport.sourceTowerUid, targetUids: [target.uid], pts: [{ ...teleport.to }, { ...target.pos }],
      x: target.pos.x, y: target.pos.y, r: CELL_PX * 0.7,
      life: teleport.expiresAt - s.time, maxLife: teleport.expiresAt - teleport.startedAt };
    const existing = s.effects.find(e => e.uid === teleport.uid);
    if (existing) Object.assign(existing, projection); else s.effects.push(projection);
  }
  for (const effect of s.effects) if (effect.targetUids && effect.pts) {
    effect.targetUids.forEach((targetUid, index) => {
      const target = s.enemies.find(e => e.uid === targetUid);
      if (target) effect.pts![index + 1] = { ...target.pos };
    });
  }
  for (const enemy of s.enemies) {
    enemy.stunUntil = enemy.speedEffects?.filter(effect => effect.expiresAt > s.time)
      .reduce((max, effect) => Math.max(max, effect.expiresAt), 0) || undefined;
    enemy.glueSpeedMultiplier = s.gluePatches.filter(patch => patch.expiresAt > s.time && patch.enemyUids.includes(enemy.uid))
      .reduce((product, patch) => product / patch.intensity, 1);
  }
  const previous = new Map(s.projectiles.filter(p => p.authoritativeUid !== undefined).map(p => [p.uid, p]));
  s.projectiles = s.projectiles.filter(p => p.towerId !== 'glueTower' && p.towerId !== 'glueGun' || p.authoritativeUid === undefined);
  for (const shot of s.glueShots) {
    const projection = { uid: shot.uid, authoritativeUid: shot.uid, kind: 'glue' as const, towerId: shot.towerId,
      sourceTowerUid: shot.sourceTowerUid, from: { ...shot.from }, to: { ...shot.to }, pos: { ...shot.pos },
      progress: Math.min(1, distance(shot.from, shot.pos) / (distance(shot.from, shot.to) || 1)), speed: shot.speed,
      damage: 0, damageType: 'Glue' as const, life: 1 };
    s.projectiles.push(Object.assign(previous.get(shot.uid) ?? {}, projection));
  }
  // Projection recreation never owns patch membership or status expiration.
  const patchIds = new Set(s.gluePatches.map(p => p.uid));
  s.effects = s.effects.filter(e => !(e.kind === 'glue' && e.sourceTowerUid && !patchIds.has(e.uid)));
  for (const patch of s.gluePatches) {
    const existing = s.effects.find(e => e.uid === patch.uid);
    const projection = { uid: patch.uid, kind: 'glue' as const, towerId: patch.towerId, sourceTowerUid: patch.sourceTowerUid,
      x: patch.pos.x, y: patch.pos.y, r: patch.radius, life: patch.expiresAt - s.time, maxLife: patch.expiresAt - patch.startedAt };
    if (existing) Object.assign(existing, projection); else s.effects.push(projection);
  }
}
