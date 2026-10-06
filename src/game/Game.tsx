import { useState, useEffect, useRef, useCallback } from 'react';
import type { GameState } from '../state/store';
import { STD_PER_WAVE, SKINS, TOWER_FAMILY } from '../state/store';
import { initAudio, playSfx, setMuted, isMuted, startAmbient, stopAmbient, stopGameAudio } from '../audio';
import { settleRun, continuePrice, continuedCount } from '../state/runs';
import type { RunSession } from '../state/runs';
import { createRunCheckpoint, restoreRunCheckpoint } from '../state/checkpoints';
import type { RunCheckpoint } from '../state/checkpoints';
import { createReplayTiming } from './replayTiming';
import { LifeHeart, TokenBadge } from '../components/Shapes';
import type { BattleState, PlacedTower, Enemy, Effect, Vec2, Particle, Projectile, CombatShot, GluePatch } from './types';
import type { TargetingMode, TowerId } from './types';
import {
  createGame, tick, placeTower, sellTower, getEnhanceCost, enhanceTower, promoteTower, setTargeting, setTargetLock,
  startWave, canStartNextWave, getEarlyWaveBonus, getNextWaveWait, cellToWorld, towerStats, GRID_W, GRID_H,
} from './engine';
import { TOWERS, BASE_TOWER_ORDER, UPGRADE_GRAPH, TOWER_SHAPES, ENEMY_SHAPES, CELL_PX as ENGINE_CELL_PX } from './data';
import type { EnemySpec } from './types';
import { ENEMIES } from './data';
import { enemyHealthPresentation, enemyHealthAnchor, enemyHealthArc } from './enemyReadability';
import { layoutHealthArcs } from './healthArcLayout';
import type { HealthArcLayoutState } from './healthArcLayout';
import { createPaperWalkClock } from './paperWalkClock';
import { paperLaserRecipe, paperLaserFlashOwner, capturePaperLaserOriginals } from './paperLaserFx';
import { drawPaperTower, drawPaperEnemy, getPaperEnemyVisibleBounds, createPaperEnemyFrame, PaperImage, usePaperAssets, loadPaperAssets, canRetryPaperAssets, getPaperTowerSocket,
  drawPaperSprite, drawPaperBeam as drawPaperBeamSegment, canDrawPaperLaserFx, drawPaperGround, drawPaperEnvironmentStructure } from './paperAssets';
const PAPER_PROJECTILES: Partial<Record<TowerId, string>> = {
  canon: 'projectile_cannon', dualCanon: 'projectile_dual', machineGun: 'projectile_machine',
  mortar: 'projectile_mortar', rocketLauncher: 'projectile_rocket', mineLayer: 'mine', glueGun: 'projectile_glue', glueTower: 'projectile_glue',
};
const PAPER_BEAMS: Partial<Record<Effect['kind'], string>> = {
  chain: 'beam_simple_strip', chain_bounce: 'beam_chain_strip', chain_straight: 'beam_pierce_strip',
};
export function freezePaperOrigin(cache: Map<string, Vec2>, uid: string, fallback: Vec2, socket: Vec2 | null): Vec2 {
  const existing = cache.get(uid);
  if (existing) return existing;
  const origin = socket && Number.isFinite(socket.x) && Number.isFinite(socket.y) ? socket : fallback;
  const frozen = { ...origin };
  cache.set(uid, frozen);
  return frozen;
}

export function paperBeamPoints(points: Vec2[] | undefined, socket: Vec2 | null): Vec2[] | undefined {
  return points && points.length >= 2 && socket && Number.isFinite(socket.x) && Number.isFinite(socket.y)
    ? [{ ...socket }, ...points.slice(1)] : points;
}

export function followPaperBeamPoints(effect: Pick<Effect, 'kind' | 'pts' | 'targetUids'>, enemies: ReadonlyMap<string, Enemy>, origin: Vec2 | null): Vec2[] | undefined {
  const points = paperBeamPoints(effect.pts, origin);
  if (!points || effect.kind === 'chain_straight' || !effect.targetUids) return points;
  return points.map((point, index) => {
    if (index === 0) return point;
    const uid = effect.targetUids?.[index - 1];
    const target = uid ? enemies.get(uid) : undefined;
    return target && target.hp > 0 && Number.isFinite(target.pos.x) && Number.isFinite(target.pos.y) ? { ...target.pos } : point;
  });
}

export function beamFollowRegressionChecks(): number {
  let count = 0;
  const check = (ok: boolean, name: string) => { if (!ok) throw new Error(`Beam follow regression: ${name}`); count++; };
  const target: Enemy = { uid: 'live', id: 'flyer', hp: 10, maxHp: 10, speed: 10, pos: { x: 30, y: 40 } };
  const enemies = new Map<string, Enemy>([['live', target], ['dead', { ...target, uid: 'dead', hp: 0 }]]);
  const effect = { kind: 'chain_bounce' as const, pts: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }, { x: 7, y: 8 }], targetUids: ['live', 'dead', 'gone'] };
  const initial = JSON.stringify(effect);
  const cache = new Map<string, Vec2>();
  const origin = freezePaperOrigin(cache, 'beam', effect.pts[0], { x: 9, y: 10 });
  const points = followPaperBeamPoints(effect, enemies, origin)!;
  check(points[0].x === 9 && points[0].y === 10, 'first point uses frozen socket');
  check(points[1].x === 30 && points[1].y === 40, 'live authoritative endpoint follows');
  check(points[2] === effect.pts[2] && points[3] === effect.pts[3], 'dead and removed targets retain snapshots');
  target.pos = { x: 50, y: 60 };
  const moved = followPaperBeamPoints(effect, enemies, freezePaperOrigin(cache, 'beam', effect.pts[0], { x: 99, y: 100 }))!;
  check(moved[0].x === 9 && moved[1].x === 50, 'socket frozen while live endpoint follows');
  check(followPaperBeamPoints(effect, enemies, freezePaperOrigin(cache, 'beam', effect.pts[0], null))![0].x === 9, 'sold source preserves origin');
  check(followPaperBeamPoints({ ...effect, kind: 'chain_straight' }, enemies, origin)![1] === effect.pts[1], 'straight direction remains frozen');
  check(followPaperBeamPoints({ ...effect, kind: 'chain', targetUids: ['live'] }, enemies, origin)![1].x === 50, 'simple beam follows');
  check(followPaperBeamPoints({ kind: 'chain', pts: effect.pts }, enemies, null) === effect.pts, 'legacy beam fallback');
  check(JSON.stringify(effect) === initial, 'effect authority not mutated');
  check(target.pos.x === 50 && target.hp === 10, 'enemy authority not mutated');
  prunePaperOrigins(cache, new Set());
  check(cache.size === 0, 'expired beam cache pruned');
  return count;
}

export function enemyVisualStatuses(enemy: Pick<Enemy, 'hp' | 'slowUntil' | 'slowFactor' | 'speedEffects' | 'teleportingUntil' | 'wasTeleported'> & { uid?: string }, time: number, patches: readonly GluePatch[] = []) {
  const alive = enemy.hp > 0 && Number.isFinite(time);
  return {
    slowed: alive && ((Number.isFinite(enemy.slowUntil) && enemy.slowUntil! > time && Number.isFinite(enemy.slowFactor) && enemy.slowFactor! > 1)
      || patches.some(patch => patch.startedAt <= time && patch.expiresAt > time && patch.intensity > 1 && enemy.uid !== undefined && patch.enemyUids.includes(enemy.uid))),
    stunned: alive && (enemy.speedEffects ?? []).some(status => status.kind === 'laserStun' && Number.isFinite(status.startedAt) && status.startedAt <= time && Number.isFinite(status.expiresAt) && status.expiresAt > time && Number.isFinite(status.multiplier) && status.multiplier < 1),
    teleporting: alive && Number.isFinite(enemy.teleportingUntil) && enemy.teleportingUntil! > time,
    teleported: alive && enemy.wasTeleported === true,
  };
}

export function towerVisualAim(tower: Pick<PlacedTower, 'worldX' | 'worldY' | 'targetUid' | 'aimAngle'>, enemies: ReadonlyMap<string, Enemy>, fallback: number): number {
  const target = tower.targetUid ? enemies.get(tower.targetUid) : undefined;
  if (target && target.hp > 0) return Math.atan2(target.pos.y - tower.worldY, target.pos.x - tower.worldX) + Math.PI / 2;
  return Number.isFinite(tower.aimAngle) ? tower.aimAngle! + Math.PI / 2 : fallback;
}

export function statusVisualRegressionChecks(): number {
  let count = 0;
  const check = (ok: boolean, name: string) => { if (!ok) throw new Error(`Status visual regression: ${name}`); count++; };
  const enemy = { hp: 10, slowUntil: 2, slowFactor: 1.2, speedEffects: [{ uid: 'stun', kind: 'laserStun' as const, sourceTowerUid: 'laser', multiplier: .05, startedAt: 0, expiresAt: 1 }] };
  const before = JSON.stringify(enemy);
  check(enemyVisualStatuses(enemy, 0).slowed && enemyVisualStatuses(enemy, 0).stunned, 'authoritative statuses active');
  check(!enemyVisualStatuses(enemy, 1).stunned && enemyVisualStatuses(enemy, 1).slowed, 'stun expires independently');
  check(!enemyVisualStatuses(enemy, 2).slowed, 'slow expires at boundary');
  check(!enemyVisualStatuses({ ...enemy, hp: 0 }, 0).stunned, 'dead target no stun');
  check(!enemyVisualStatuses({ ...enemy, slowFactor: 1 }, 0).slowed, 'no slowdown no slow visual');
  check(!enemyVisualStatuses({ ...enemy, slowFactor: .5 }, 0).slowed, 'legacy intensity below one is not slow');
  check(!enemyVisualStatuses({ hp: 10 }, 0).slowed && !enemyVisualStatuses({ hp: 10 }, 0).stunned, 'legacy statuses absent');
  check(!enemyVisualStatuses({ ...enemy, speedEffects: [{ ...enemy.speedEffects[0], expiresAt: NaN }] }, 0).stunned, 'invalid stun rejected');
  check(!enemyVisualStatuses(enemy, NaN).slowed, 'invalid time rejected');
  check(JSON.stringify(enemy) === before, 'status projection never mutates engine');
  check(!enemyVisualStatuses(enemy, -1).stunned, 'future status not shown');
  check(enemyVisualStatuses({ hp: 10, teleportingUntil: 1 }, 0).teleporting, 'authoritative teleport phase');
  check(!enemyVisualStatuses({ hp: 10, teleportingUntil: 1 }, 1).teleporting, 'teleport phase expires');
  check(enemyVisualStatuses({ hp: 10, wasTeleported: true }, 100).teleported, 'permanent teleport marker');
  const tower = { worldX: 0, worldY: 0, targetUid: 'locked', aimAngle: 0 };
  const targets = new Map<string, Enemy>([['locked', { uid: 'locked', id: 'flyer', hp: 10, maxHp: 10, speed: 0, pos: { x: 0, y: 10 } }]]);
  check(towerVisualAim(tower, targets, 0) === Math.PI, 'visual follows authoritative locked target');
  check(towerVisualAim({ ...tower, targetUid: 'gone' }, targets, 0) === Math.PI / 2, 'removed target retains actual aim');
  check(towerVisualAim({ ...tower, targetUid: undefined, aimAngle: undefined }, targets, .25) === .25, 'legacy visual fallback');
  const patch: GluePatch = { uid: 'patch', towerId: 'glueTower', sourceTowerUid: 'sold', pos: { x: 10, y: 20 }, radius: 20, intensity: 1.2, startedAt: 0, expiresAt: 4, nextObserveAt: .1, enemyUids: ['inside'] };
  check(enemyVisualStatuses({ hp: 10, uid: 'inside' }, 1, [patch]).slowed, 'authoritative glue membership');
  check(!enemyVisualStatuses({ hp: 10, uid: 'outside' }, 1, [patch]).slowed, 'renderer cannot infer glue from distance');
  check(!enemyVisualStatuses({ hp: 10, uid: 'inside' }, 4, [patch]).slowed, 'patch expires at engine deadline');
  check(enemyVisualStatuses({ hp: 10, uid: 'inside' }, 1, [patch]).slowed, 'sold source does not erase live patch');
  return count;
}

export function prunePaperOrigins(cache: Map<string, Vec2>, live: ReadonlySet<string>): void {
  for (const uid of cache.keys()) if (!live.has(uid)) cache.delete(uid);
}

export function paperSocketName(towerId: TowerId, shotIndex = 0): string {
  if (towerId === 'dualCanon') return shotIndex % 2 === 0 ? 'muzzle_left' : 'muzzle_right';
  if (towerId === 'rocketLauncher') return `launch_${shotIndex % 4 + 1}`;
  return towerId === 'bouncingLaser' ? 'lens_center' : towerId === 'mineLayer' ? 'discharge'
    : towerId === 'glueTower' ? 'spray_center' : towerId === 'teleporter' ? 'portal_center' : 'muzzle';
}

export function paperRenderedAngle(current: number, desired: number, dt: number, firedAim?: number): number {
  if (firedAim !== undefined && Number.isFinite(firedAim)) return firedAim + Math.PI / 2;
  const difference = Math.atan2(Math.sin(desired - current), Math.cos(desired - current));
  return current + difference * (1 - Math.exp(-18 * Math.max(0, dt)));
}

export function projectileRenderPose(projectile: Projectile, visualOrigin: Vec2, shot?: CombatShot): { x: number; y: number; angle: number; alpha: number } {
  const pos = projectile.pos ?? {
    x: visualOrigin.x + (projectile.to.x - visualOrigin.x) * projectile.progress,
    y: visualOrigin.y + (projectile.to.y - visualOrigin.y) * projectile.progress,
  };
  const dx = projectile.to.x - pos.x, dy = projectile.to.y - pos.y;
  const fixedDirection = shot?.kind === 'machineGun' || Math.hypot(dx, dy) < 1e-9;
  const direction = fixedDirection && shot ? shot.direction : { x: dx, y: dy };
  return { x: pos.x, y: pos.y,
    angle: projectile.kind === 'mine' ? 0 : Math.atan2(direction.y, direction.x),
    alpha: projectile.authoritativeUid !== undefined ? 1 : Math.min(1, projectile.life * 8) };
}

export function authorityRendererRegressionChecks(): number {
  let count = 0;
  const check = (ok: boolean, name: string) => { if (!ok) throw new Error(`Authority renderer regression: ${name}`); count++; };
  const p: Projectile = { uid: 'shot', authoritativeUid: 'shot', kind: 'rocket', towerId: 'rocketLauncher',
    from: { x: 0, y: 0 }, pos: { x: 35, y: 70 }, to: { x: 100, y: 20 }, progress: .5,
    speed: 100, damage: 0, damageType: 'Explosive', life: 0 };
  const before = JSON.stringify(p);
  const pose = projectileRenderPose(p, { x: 50, y: 60 });
  check(pose.x === 35 && pose.y === 70, 'homing authoritative position not reconstructed');
  check(pose.angle === Math.atan2(-50, 65), 'heading follows actual current target');
  check(pose.alpha === 1, 'cosmetic TTL cannot hide authority');
  check(JSON.stringify(p) === before, 'renderer never mutates authority');
  const mine = projectileRenderPose({ ...p, kind: 'mine', pos: { x: 100, y: 20 }, progress: 1 }, { x: 999, y: 999 });
  check(mine.x === 100 && mine.y === 20 && mine.angle === 0 && mine.alpha === 1, 'landed mine fixed position/orientation, no TTL');
  const cosmetic = projectileRenderPose({ ...p, authoritativeUid: undefined, pos: undefined, life: .05 }, { x: 20, y: 40 });
  check(cosmetic.x === 60 && cosmetic.y === 30 && cosmetic.alpha === .4, 'cosmetic frozen muzzle fallback remains');
  check(paperSocketName('dualCanon', 0) === 'muzzle_left' && paperSocketName('dualCanon', 1) === 'muzzle_right', 'explicit dual sourceSocket');
  const shot: CombatShot = { uid: 'machine', kind: 'machineGun', towerId: 'machineGun', sourceTowerUid: 'tower',
    from: { x: 0, y: 0 }, pos: { x: 100, y: 0 }, to: { x: 10, y: 0 }, direction: { x: 1, y: 0 },
    damage: 1, damageType: 'Bullet', splashRadius: 0, speed: 100, launchedAt: 0 };
  check(projectileRenderPose({ ...p, kind: 'bullet', pos: shot.pos, to: shot.to }, shot.from, shot).angle === 0, 'machine gun does not turn back toward stale target');
  return count;
}

export function idleVisualRegressionChecks(): number {
  let count = 0;
  const check = (ok: boolean, name: string) => { if (!ok) throw new Error(`Idle visual regression: ${name}`); count++; };
  const state = createGame();
  state.effects.push({ uid: 'beam', kind: 'chain', x: 3, y: 4, pts: [{ x: 3, y: 4 }, { x: 10, y: 20 }], life: .3, maxLife: .3 },
    { uid: 'impact', kind: 'boom', x: 10, y: 20, life: .5, maxLife: .5 });
  state.projectiles.push({ uid: 'projectile', kind: 'bullet', from: { x: 0, y: 0 }, to: { x: 100, y: 0 },
    progress: .2, speed: 100, life: .4, damage: 0, damageType: 'Bullet' });
  state.particles.push({ x: 1, y: 2, vx: 10, vy: 20, life: .6, maxLife: .6, r: 1, color: '#595959' });
  const initial = JSON.stringify(state);
  const timing = createReplayTiming({ getState: () => state, tick, startWave, canStartNextWave, getNextWaveWait },
    { mode: 'endless', waveLimit: 10, durationSeconds: 300 });
  timing.frame(0);
  check(JSON.stringify(state) === initial, 'initial frame is pure');
  timing.command({ type: 'pause' });
  check(timing.frame(10).ticks === 0, 'paused freeze');
  timing.command({ type: 'resume' }); timing.frame(0);
  const gold = state.gold, completed = state.completedWaves;
  state.mines.push({ uid: 'persistent-mine', towerId: 'mineLayer', sourceTowerUid: 'sold-source',
    from: { x: 0, y: 0 }, pos: { x: 100, y: 0 }, to: { x: 100, y: 0 }, damage: 1,
    damageType: 'Explosive', splashRadius: 20, launchedAt: 0, landed: true, nextTriggerAt: .1 });
  timing.frame(.05);
  check(state.effects[0].life < .3 && state.effects[1].life < .5, 'idle beam and impact decay');
  check(Math.abs(state.effects[0].life - .25) < 1e-9, 'decay equals processed BUILD time');
  check(state.projectiles.find(p => p.uid === 'projectile')!.life < .4, 'cosmetic projectile expires via engine');
  check(state.particles[0].x > 1 && state.particles[0].y > 2 && state.particles[0].life < .6, 'engine owns idle particles');
  check(state.effects[0].x === 3 && state.effects[1].x === 10 && state.effects[0].pts![1].y === 20, 'beam/impact coordinates preserved');
  timing.command({ type: 'pause' });
  const pausedMidFade = JSON.stringify(state);
  timing.frame(10);
  check(JSON.stringify(state) === pausedMidFade, 'pause mid-fade freezes');
  timing.command({ type: 'resume' }); timing.frame(0);
  for (let frame = 0; frame < 20; frame++) timing.frame(.05);
  check(state.effects.length === 0 && !state.projectiles.some(p => p.authoritativeUid === undefined) && state.particles.length === 0, 'build transients fully expire');
  check(state.mines.length === 1 && state.projectiles.some(p => p.authoritativeUid === 'persistent-mine' && p.kind === 'mine' && p.pos?.x === 100), 'BUILD keeps authoritative mine projection alive');
  check(state.time > 0 && !state.waveActive && state.waveIndex === -1, 'BUILD clock advances without starting wave');
  check(state.gold === gold && state.completedWaves === completed, 'BUILD gives no run reward');
  return count;
}

function drawPaperFxSprite(ctx: CanvasRenderingContext2D, id: string, x: number, y: number, size: number, angle = 0, alpha = 1): boolean {
  return drawPaperSprite(ctx, `fx_parts/${id}.png`, x, y, size, size, angle, alpha);
}

function drawPaperProjectile(ctx: CanvasRenderingContext2D, towerId: TowerId | undefined, x: number, y: number, angle: number, progress: number): boolean {
  const id = towerId && PAPER_PROJECTILES[towerId];
  if (!id) return false;
  const size = ENGINE_CELL_PX * (id === 'projectile_machine' ? .22 : id === 'projectile_rocket' ? .65 : id === 'projectile_mortar' || id === 'mine' ? .45 : .32);
  const arc = id === 'projectile_mortar' || id === 'mine' && progress < 1 ? Math.sin(progress * Math.PI) * ENGINE_CELL_PX * .15 : 0;
  const drawn = drawPaperSprite(ctx, `projectiles/${id}.png`, x, y - arc, size, size,
    id === 'mine' ? 0 : angle + Math.PI / 2);
  if (drawn && id === 'projectile_rocket') drawPaperFxSprite(ctx, 'rocket_exhaust', x - Math.cos(angle) * size * .45,
    y - Math.sin(angle) * size * .45, size * .6, angle + Math.PI / 2, .65);
  return drawn;
}

function drawPaperBeam(ctx: CanvasRenderingContext2D, e: Effect, viewport?: { x: number; y: number; width: number; height: number }, reducedMotion = false, contacts?: Set<number>): boolean {
  const id = PAPER_BEAMS[e.kind];
  const recipe = paperLaserRecipe(e, reducedMotion);
  if (!id) return false;
  if (!recipe) return true;
  const height = ENGINE_CELL_PX * (e.kind === 'chain_straight' ? .2 : e.kind === 'chain_bounce' ? .13 : .1) * recipe.thickness;
  let drawn = false;
  for (const segment of recipe.segments) {
    const success = drawPaperBeamSegment(ctx, `projectiles/${id}.png`, segment.from, segment.to, height,
      recipe.alpha, e.kind === 'chain_straight' ? viewport : undefined);
    drawn = success || drawn;
    if (success && recipe.sweep) drawPaperBeamSegment(ctx, `projectiles/${id}.png`, segment.from, segment.to, height,
      recipe.alpha * .65, viewport, recipe.sweep);
    const contactAge = recipe.age - (!reducedMotion && e.kind === 'chain_bounce' ? .12 * segment.node / (e.pts!.length - 1) : 0);
    if (success && segment.arrived && e.kind !== 'chain_straight' && contactAge >= -1e-7 && contactAge < .12) {
      const contact = drawPaperFxSprite(ctx, e.kind === 'chain_bounce' ? 'chain_contact' : 'hit_laser_mark',
        segment.to.x, segment.to.y, recipe.contactSize, 0, recipe.alpha);
      if (contact) contacts?.add(segment.node);
    }
  }
  return drawn || recipe.segments.length === 0;
}

function drawPaperLaserEffects(ctx: CanvasRenderingContext2D, effects: readonly Effect[], enemies: ReadonlyMap<string, Enemy>,
  originFor: (effect: Effect) => Vec2 | null, viewport: { x: number; y: number; width: number; height: number }, reducedMotion: boolean,
  originals = new Map<string, Vec2[]>()) {
  const handled = new Set<string>(), suppressed = new Set<string>(), contacts = new Map<string, Set<number>>(), pending = new Map<string, Set<number>>();
  if (effects.length > 2048) { originals.clear(); return { handled, suppressed, contacts, pending }; }
  const beams = effects.filter(e => !!PAPER_BEAMS[e.kind]);
  if (beams.length > 256) { originals.clear(); return { handled, suppressed, contacts, pending }; }
  capturePaperLaserOriginals(effects, originals);
  for (const beam of beams) {
    const nodes = new Set<number>();
    const displayed = { ...beam, pts: followPaperBeamPoints(beam, enemies, originFor(beam)) };
    const success = drawEffect(ctx, displayed, viewport, reducedMotion, nodes) === true;
    const recipe = paperLaserRecipe(displayed, reducedMotion);
    if (success && recipe && canDrawPaperLaserFx(beam.kind)) {
      const arrived = new Set(recipe.segments.filter(segment => segment.arrived).map(segment => segment.node));
      pending.set(beam.uid, new Set(displayed.pts!.map((_, node) => node).filter(node => node > 0 && !arrived.has(node))));
    }
    contacts.set(beam.uid, nodes); handled.add(beam.uid);
  }
  const associationBeams = beams.map(beam => ({ ...beam, pts: originals.get(beam.uid) ?? beam.pts }));
  for (const flash of effects) {
    const owner = paperLaserFlashOwner(flash, associationBeams);
    if (owner && (contacts.get(owner.uid)?.has(owner.node) || pending.get(owner.uid)?.has(owner.node))) suppressed.add(flash.uid);
  }
  return { handled, suppressed, contacts, pending };
}

export function isGroundEffect(effect: Pick<Effect, 'kind' | 'uid'> & { authoritativeUid?: string }, patchIds?: ReadonlySet<string>): boolean {
  return effect.kind === 'glue' && (effect.authoritativeUid !== undefined || patchIds?.has(effect.uid) === true);
}

export function effectLayerRegressionChecks(): number {
  let count = 0;
  const check = (ok: boolean, name: string) => { if (!ok) throw new Error(`Effect layer regression: ${name}`); count++; };
  const patch: Effect & { authoritativeUid: string } = { uid: 'patch', authoritativeUid: 'patch', kind: 'glue', x: 10, y: 20, r: 30, life: 2, maxLife: 4 };
  const before = JSON.stringify(patch);
  check(isGroundEffect(patch), 'persistent authoritative glue on ground');
  check(!isGroundEffect({ ...patch, authoritativeUid: undefined }), 'legacy cosmetic glue remains overlay');
  const patchIds = new Set(['patch']);
  check(isGroundEffect({ ...patch, authoritativeUid: undefined }, patchIds), 'actual engine patch uid is authoritative');
  check(!isGroundEffect({ ...patch, uid: 'cosmetic', authoritativeUid: undefined }, patchIds), 'unrelated cosmetic glue stays overlay');
  for (const kind of ['chain', 'chain_bounce', 'chain_straight', 'boom', 'boom_big', 'laser_flash', 'bullet_spark', 'glue_splat', 'teleport', 'heal', 'ring'] as const) {
    check(!isGroundEffect({ ...patch, kind }), `${kind} stays overlay`);
  }
  check(JSON.stringify(patch) === before, 'layer predicate preserves authority');
  return count;
}

function drawPaperDamageEffect(ctx: CanvasRenderingContext2D, e: Effect, viewport?: { x: number; y: number; width: number; height: number }, reducedMotion = false, contacts?: Set<number>): boolean {
  if (PAPER_BEAMS[e.kind]) return drawPaperBeam(ctx, e, viewport, reducedMotion, contacts);
  const t = Math.max(0, Math.min(1, 1 - e.life / e.maxLife));
  const alpha = 1 - t;
  if (e.kind === 'glue' && (e.towerId === 'glueTower' || e.towerId === 'glueGun')) {
    const radius = e.r ?? 0;
    const patchAlpha = .5 + alpha * .5;
    let drawn = drawPaperFxSprite(ctx, e.towerId === 'glueTower' ? 'slow_ribbon' : 'glue_splat_01', e.x, e.y, radius * 2, 0, patchAlpha);
    if (e.towerId === 'glueTower') for (let i = 0; i < 6; i++) {
      const angle = i * Math.PI / 3;
      drawn = drawPaperFxSprite(ctx, 'glue_spray_drop', e.x + Math.cos(angle) * radius * .7,
        e.y + Math.sin(angle) * radius * .7, ENGINE_CELL_PX * .2, angle + Math.PI / 2, patchAlpha) || drawn;
    }
    return drawn;
  }
  if (e.kind === 'boom' || e.kind === 'boom_big') {
    const radius = (e.r ?? 20) * (.2 + t * .8);
    let drawn = false;
    for (let i = 0; i < 4; i++) {
      const angle = i * Math.PI / 2;
      drawn = drawPaperFxSprite(ctx, `explosion_petal_0${i + 1}`, e.x + Math.cos(angle) * radius * .35,
        e.y + Math.sin(angle) * radius * .35, radius * 1.8, angle + t * .3, alpha) || drawn;
    }
    drawPaperFxSprite(ctx, 'smoke_puff_01', e.x, e.y, radius * 1.5, 0, alpha * .35);
    return drawn;
  }
  const id = e.kind === 'bullet_spark' ? 'hit_bullet_mark' : e.kind === 'laser_flash'
    ? e.towerId === 'bouncingLaser' ? 'chain_contact' : 'hit_laser_mark'
    : e.kind === 'glue_splat' ? `glue_splat_0${Math.min(3, Math.floor(t * 3) + 1)}`
    : e.kind === 'glue' || e.kind === 'ring' ? 'slow_ribbon'
    : e.kind === 'heal' ? 'heal_symbol' : e.kind === 'teleport' ? 'portal_ring' : undefined;
  if (!id) return false;
  const size = e.kind === 'bullet_spark' || e.kind === 'laser_flash' ? 15 * (1 - t * .35)
    : e.kind === 'heal' ? 22 + t * 8 : (e.r ?? 10) * 2 * (.5 + t * .7);
  const drawn = drawPaperFxSprite(ctx, id, e.x, e.y - (e.kind === 'heal' ? t * 8 : 0), size,
    e.kind === 'teleport' ? t * Math.PI : 0, alpha);
  if (drawn && e.kind === 'teleport') drawPaperFxSprite(ctx, 'portal_inner', e.x, e.y, size * .7, -t * Math.PI, alpha);
  if (drawn && e.kind === 'heal') drawPaperFxSprite(ctx, 'heal_spark', e.x, e.y, size * 1.3, t, alpha * .6);
  return drawn;
}

export function paperCombatRegressionChecks(): number {
  let count = 0;
  const check = (ok: boolean, name: string) => { if (!ok) throw new Error(`Paper combat regression: ${name}`); count++; };
  const cache = new Map<string, Vec2>();
  const origin = freezePaperOrigin(cache, 'p1', { x: 1, y: 2 }, { x: 8, y: 9 });
  check(origin.x === 8 && origin.y === 9, 'socket origin');
  check(freezePaperOrigin(cache, 'p1', { x: 1, y: 2 }, { x: 90, y: 91 }) === origin, 'rotation/recoil cannot drift');
  check(freezePaperOrigin(cache, 'p1', { x: 1, y: 2 }, null) === origin, 'sold source retains frozen origin');
  check(freezePaperOrigin(cache, 'p2', { x: 3, y: 4 }, null).x === 3, 'missing art/source fallback');
  check(freezePaperOrigin(cache, 'p3', { x: 3, y: 4 }, { x: NaN, y: 9 }).x === 3, 'invalid socket fallback');
  const points = [{ x: 1, y: 2 }, { x: 5, y: 6 }, { x: 7, y: 8 }];
  const chain = paperBeamPoints(points, { x: 9, y: 10 })!;
  check(chain[0].x === 9 && chain[1] === points[1] && chain[2] === points[2], 'chain intermediate targets intact');
  check(points[0].x === 1, 'engine geometry not mutated');
  check(paperBeamPoints(points, null) === points, 'sold beam source fallback');
  check(new Set(Object.values(PAPER_PROJECTILES)).size === 7, 'seven distinct projectile sprites');
  check(new Set(Object.values(PAPER_BEAMS)).size === 3, 'three distinct beam strips');
  check(paperSocketName('dualCanon', 0) === 'muzzle_left' && paperSocketName('dualCanon', 1) === 'muzzle_right', 'dual sockets');
  check(paperSocketName('rocketLauncher', 3) === 'launch_4' && paperSocketName('rocketLauncher', 4) === 'launch_1', 'rocket sockets');
  check(paperSocketName('bouncingLaser') === 'lens_center' && paperSocketName('mineLayer') === 'discharge', 'special sockets');
  check(paperRenderedAngle(Math.PI, 0, .016, 0) === Math.PI / 2, 'new shot snaps to actual fired aim');
  const tracking = paperRenderedAngle(0, 1, .016);
  check(tracking > 0 && tracking < 1, 'smooth tracking between shots');
  check(paperRenderedAngle(0, 1, 0) === 0, 'paused pose stable');
  prunePaperOrigins(cache, new Set(['p1']));
  check(cache.size === 1 && cache.has('p1'), 'cache pruned');
  return count;
}

// ── Fixed canvas sizing for Seeker phone (412px logical width) ───────────
// Full-bleed board: cell = floor(412 / GRID_W). With GRID_W=12 → 34px, board = 408px wide.
// GRID_H=21 → canvas height = 21 × 34 = 714px, fits between HUD and picker. No resize listener (zoom locked).
const DISPLAY_CELL_PX = Math.floor(412 / GRID_W); // = 34

export function runHasVictory(mode: RunSession['config']['mode'], completed: number, limit: number, elapsed: number, duration: number, started: boolean, alive: boolean): boolean {
  if (!alive) return false;
  return mode === 'waves' ? completed >= limit : mode === 'timed' && started && elapsed >= duration;
}

export function nextWaveBlockReason(mode: RunSession['config']['mode'], called: number, limit: number, elapsed: number, duration: number, paused: boolean, terminal: boolean, hidden: boolean, ready: boolean, wait: number): string {
  if (terminal) return 'Run has ended';
  if (paused) return 'Resume game to call the next wave';
  if (hidden) return 'Return to the game to call the next wave';
  if (!Number.isInteger(called) || called < 0 || !Number.isFinite(elapsed) || elapsed < 0) return 'Wave state unavailable';
  if (mode === 'waves' && (!Number.isInteger(limit) || limit <= 0 || called >= limit)) return 'All configured waves have been called';
  if (mode === 'timed' && (!Number.isFinite(duration) || duration <= 0 || elapsed >= duration)) return 'Timed run deadline reached';
  if (!ready) return Number.isFinite(wait) && wait > 0 ? `Next wave ready in ${wait} seconds` : 'Next wave is not ready';
  return '';
}

export function shouldAutoStart(mode: RunSession['config']['mode'], started: boolean, blocked: boolean, waveActive: boolean, planning: number, ready = true): boolean {
  return mode === 'timed' && started && !blocked && !waveActive && planning >= 3 && ready;
}

export function autoWaveWait(planning: number, readinessWait: number): number {
  return Math.ceil(Math.max(0, 3 - planning, readinessWait));
}

export function nextWaveRegressionChecks(): number {
  let count = 0;
  const reason = (mode: RunSession['config']['mode'], called = 0, elapsed = 0, paused = false, terminal = false, hidden = false, ready = true, wait = 0) => nextWaveBlockReason(mode, called, 10, elapsed, 300, paused, terminal, hidden, ready, wait);
  const check = (name: string, actual: boolean, expected: boolean) => {
    if (actual !== expected) throw new Error(`Next wave regression: ${name}`);
    count++;
  };
  check('first wave', reason('waves') === '', true);
  check('early overlapping wave allowed', reason('waves', 9) === '', true);
  check('called limit rather than cleared limit', reason('waves', 10) !== '', true);
  check('beyond limit', reason('waves', 11) !== '', true);
  check('endless uncapped', reason('endless', 10000) === '', true);
  check('timed before deadline', reason('timed', 100, 299.99) === '', true);
  check('timed at deadline', reason('timed', 100, 300) !== '', true);
  check('timed beyond deadline', reason('timed', 100, 301) !== '', true);
  check('paused explanation', reason('waves', 1, 0, true).includes('Resume'), true);
  check('terminal blocked', reason('waves', 1, 0, false, true) !== '', true);
  check('hidden blocked', reason('waves', 1, 0, false, false, true) !== '', true);
  check('exact wait', reason('waves', 1, 0, false, false, false, false, 4.125).includes('4.125 seconds'), true);
  check('unknown readiness fail closed', reason('waves', 1, 0, false, false, false, false, NaN) !== '', true);
  check('corrupt count', reason('waves', NaN) !== '', true);
  check('auto waits for engine', shouldAutoStart('timed', true, false, false, 10, false), false);
  check('auto ready', shouldAutoStart('timed', true, false, false, 10, true), true);
  check('auto deadline blocked', shouldAutoStart('timed', true, reason('timed', 1, 300) !== '', false, 10, true), false);
  check('quick clear uses engine wait', autoWaveWait(3, 2) === 2, true);
  check('planning wait still applies', autoWaveWait(1, .25) === 2, true);
  check('fractional wait rounds up', autoWaveWait(10, .001) === 1, true);
  check('ready countdown zero', autoWaveWait(3, 0) === 0, true);
  const state = createGame();
  check('engine first call ready', canStartNextWave(state), true);
  startWave(state);
  const firstWave = state.waveIndex;
  check('engine cooldown starts at five seconds', getNextWaveWait(state) === 5, true);
  startWave(state);
  check('repeated call cannot advance', state.waveIndex === firstWave, true);
  state.time = state.nextWaveReadyAt - .001;
  check('engine before readiness', canStartNextWave(state), false);
  state.time = state.nextWaveReadyAt;
  check('engine active wave ready', state.waveActive && canStartNextWave(state), true);
  const bonus = getEarlyWaveBonus(state);
  check('actual gold bonus is nonnegative integer', Number.isInteger(bonus) && bonus >= 0, true);
  startWave(state);
  check('engine early call advances', state.waveIndex === firstWave + 1, true);
  check('early call rearms readiness', canStartNextWave(state), false);
  return count;
}

export function runModeRegressionChecks(): number {
  let count = 0;
  const check = (name: string, actual: number | boolean, expected: number | boolean) => {
    if (actual !== expected) throw new Error(`Run mode regression: ${name}`);
    count++;
  };
  check('before timed boundary', runHasVictory('timed', 0, 10, .99, 1, true, true), false);
  check('timed survives boundary', runHasVictory('timed', 0, 10, 1, 1, true, true), true);
  check('death beats timer', runHasVictory('timed', 0, 10, 1, 1, true, false), false);
  check('clock not started', runHasVictory('timed', 0, 10, 1, 1, false, true), false);
  check('waves unfinished', runHasVictory('waves', 9, 10, 0, 1, true, true), false);
  check('waves cleared', runHasVictory('waves', 10, 10, 0, 1, true, true), true);
  check('death beats waves', runHasVictory('waves', 10, 10, 0, 1, true, false), false);
  check('endless never wins', runHasVictory('endless', 999, 10, 999, 1, true, true), false);
  check('planning before boundary', shouldAutoStart('timed', true, false, false, 2.99), false);
  check('planning boundary', shouldAutoStart('timed', true, false, false, 3), true);
  check('planning paused', shouldAutoStart('timed', true, true, false, 3), false);
  check('no overlapping waves', shouldAutoStart('timed', true, false, true, 3), false);
  check('manual waves', shouldAutoStart('waves', true, false, false, 3), false);
  return count;
}

export function canPlayGameAmbient(enabled: boolean, paused: boolean, hidden: boolean, terminal: boolean): boolean {
  return enabled && !paused && !hidden && !terminal;
}

export function planGameAudio(queue: readonly string[], terminal: 'victory' | 'defeat' | null, resultSeen: boolean, blocked: boolean): { tags: string[]; resultSeen: boolean } {
  const result = terminal && !resultSeen ? [terminal] : [];
  const priority = (tag: string) => tag === 'life_lost' ? 3 : tag === 'wave_start' ? 2 : ['build', 'enhance', 'sell'].includes(tag) ? 1 : 0;
  const queued = [...new Set(queue.slice(0, 32))].filter(tag => tag !== 'victory' && tag !== 'defeat')
    .sort((a, b) => priority(b) - priority(a));
  return { tags: blocked ? [] : [...result, ...queued.slice(0, 8 - result.length)], resultSeen: terminal !== null };
}

export function runAudioRegressionChecks(): number {
  let count = 0;
  const check = (name: string, actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Game audio regression: ${name}`);
    count++;
  };
  check('build phase events', planGameAudio(['build', 'enhance', 'sell', 'wave_start'], null, false, false).tags, ['wave_start', 'build', 'enhance', 'sell']);
  check('final life and single defeat', planGameAudio(['defeat', 'life_lost', 'defeat'], 'defeat', false, false).tags, ['defeat', 'life_lost']);
  check('defeat only once', planGameAudio([], 'defeat', true, false).tags, []);
  check('victory cue', planGameAudio([], 'victory', false, false).tags, ['victory']);
  check('victory only once', planGameAudio([], 'victory', true, false).tags, []);
  check('exit settlement not result', planGameAudio([], null, false, false).tags, []);
  check('muted queue discarded', planGameAudio(['build'], null, false, true).tags, []);
  check('hidden result not replayed', planGameAudio([], 'defeat', false, true), { tags: [], resultSeen: true });
  check('continued run rearms cue', planGameAudio([], null, true, false).resultSeen, false);
  check('duplicate tags coalesced', planGameAudio(['build', 'build'], null, false, false).tags, ['build']);
  check('bounded tags', planGameAudio(Array.from({ length: 32 }, (_, i) => `shot_${i}`), null, false, false).tags.length, 8);
  check('result reserved in bound', planGameAudio(Array.from({ length: 32 }, (_, i) => `shot_${i}`), 'victory', false, false).tags.length, 8);
  check('life priority under load', planGameAudio([...Array.from({ length: 30 }, (_, i) => `shot_${i}`), 'life_lost', 'wave_start'], null, false, false).tags.slice(0, 2), ['life_lost', 'wave_start']);
  check('ambient allowed', canPlayGameAmbient(true, false, false, false), true);
  check('muted ambient stopped', canPlayGameAmbient(false, false, false, false), false);
  check('paused ambient stopped', canPlayGameAmbient(true, true, false, false), false);
  check('background ambient stopped', canPlayGameAmbient(true, false, true, false), false);
  check('result ambient stopped', canPlayGameAmbient(true, false, false, true), false);
  return count;
}

// ── HUD ───────────────────────────────────────────────────────────────────
export function compactHudCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  if (value === 0) return '0';
  const sign = value < 0 ? '-' : '';
  const magnitude = Math.abs(value);
  if (magnitude < 1) return `${sign}<1`;
  if (magnitude < 1000) return `${sign}${Math.floor(magnitude)}`;
  const units = ['', 'K', 'M', 'B', 'T', 'Q'];
  let index = Math.min(units.length - 1, Math.floor(Math.log10(magnitude) / 3));
  let scaled = Math.round(magnitude / 1000 ** index * 10) / 10;
  if (scaled >= 1000 && index < units.length - 1) { scaled /= 1000; index++; }
  if (scaled >= 10000) return `${sign}≥10KQ`;
  return `${sign}${scaled.toFixed(scaled >= 100 ? 0 : 1).replace(/\.0$/, '')}${units[index]}`;
}

export function hudRawCount(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 }) : 'no data';
}

export function cleanCompletedSince(cleared: readonly number[], leaked: readonly number[], settledCount: number): boolean {
  if (!Number.isSafeInteger(settledCount) || settledCount < 0 || settledCount >= cleared.length) return false;
  const knownLeaks = new Set(leaked);
  const previous = new Set(cleared.slice(0, settledCount));
  return cleared.slice(settledCount).some(index => Number.isSafeInteger(index) && index >= 0
    && !previous.has(index) && !knownLeaks.has(index));
}

export function hudProvenanceRegressionChecks(): number {
  let count = 0;
  const check = (ok: boolean, name: string) => { if (!ok) throw new Error(`HUD/provenance regression: ${name}`); count++; };
  for (const [value, expected] of [[0, '0'], [-0, '0'], [999, '999'], [1000, '1K'], [1250, '1.3K'],
    [999999, '1M'], [1.52e12, '1.5T'], [Number.MAX_SAFE_INTEGER, '9Q'], [Number.MAX_VALUE, '≥10KQ'],
    [null, '--'], [undefined, '--'], [NaN, '--'], [Infinity, '--']] as const) check(compactHudCount(value) === expected, `count ${value}`);
  check(!cleanCompletedSince([0], [0], 0), 'old wave leak after early start remains dirty');
  check(cleanCompletedSince([0, 1], [0], 1), 'new clean wave earns no-leak despite old leak');
  check(!cleanCompletedSince([0], [], 1), 'replay cannot earn credit');
  check(!cleanCompletedSince([0, 0], [], 1), 'duplicate index cannot earn credit');
  check(!cleanCompletedSince([0, 1], [1], 1), 'previously settled clean does not qualify new leaky wave');
  check(!cleanCompletedSince([], [], 0), 'uncleared wave earns nothing');
  check(cleanCompletedSince([2, 0, 1], [2, 1], 1), 'overlap clear order is not wave index order');
  check(!cleanCompletedSince([2, 0, 1], [1], 2), 'old non-monotonic clean excluded by count');
  check(!cleanCompletedSince([0], [], NaN) && !cleanCompletedSince([0], [], -1), 'invalid watermark fails closed');
  check(hudRawCount(Number.MAX_VALUE).includes('e') === false && hudRawCount(NaN) === 'no data', 'expanded aria raw count');
  return count;
}

interface HUDProps {
  gold: number; lives: number; wave: number;
  waveActive: boolean; onExit: () => void; onStart: () => void;
  nextBlocked: string; nextWait: number; earlyBonus: number;
  gameOver: boolean; victory: boolean; speed: number;
  onSpeedCycle: () => void;
  speedLocked?: boolean;
  paused: boolean; onPause: () => void;
  isBossWave: boolean;
  soundEnabled: boolean; onToggleSound: () => void;
}

function GameHUD({ gold, lives, wave, waveActive, onExit, onStart, nextBlocked, nextWait, earlyBonus, gameOver, victory, speed, onSpeedCycle, speedLocked = false, paused, onPause, isBossWave, soundEnabled, onToggleSound }: HUDProps) {
  const stateLabel = victory ? 'VICTORY' : gameOver ? 'DEFEAT' : paused ? 'PAUSED' : waveActive ? 'IN WAVE' : 'BUILD';
  const nextTitle = `${nextBlocked || `Call ${wave === 0 ? 'first' : 'next'} wave`}; early-call bonus ${hudRawCount(earlyBonus)} gold; readiness wait ${hudRawCount(nextWait)} seconds`;
  return (
    <div style={{ height: 80, flexShrink: 0, width: '100%', padding: '0 8px', background: '#f6f5f0', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', height: 32, gap: 10, alignItems: 'center', justifyContent: 'space-between', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span className="eyebrow">W</span>
          <span className="mono" aria-label={`Wave ${hudRawCount(wave)}${isBossWave ? ', boss wave' : ''}`} title={hudRawCount(wave)} style={{ fontSize: 12, fontWeight: 700, color: isBossWave ? '#8a4a4a' : undefined }}>{compactHudCount(wave)}</span>
          {isBossWave && <span aria-hidden="true" style={{ fontSize: 8, fontFamily: 'var(--mono)', fontWeight: 700, color: '#8a4a4a' }}>B</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span className="eyebrow">$</span>
          <span className="mono" aria-label={`Gold ${hudRawCount(gold)}`} title={hudRawCount(gold)} style={{ fontSize: 12, fontWeight: 700 }}>{compactHudCount(gold)}</span>
        </div>
        <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
          <LifeHeart size={14} filled={true} />
          <span className="mono" aria-label={`Lives ${hudRawCount(lives)}`} title={hudRawCount(lives)} style={{ fontSize: 12 }}>×{compactHudCount(lives)}</span>
        </div>
        <span className="eyebrow" style={{ fontSize: 11, color: paused ? '#8a4a4a' : '#595959' }}>{stateLabel}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '48px 48px 48px 48px minmax(96px, 1fr)', gap: 4, height: 48 }}>
        <button type="button" className="btn small ghost" aria-label="Exit to home" onClick={onExit} style={{ height: 48, minHeight: 48, minWidth: 48, boxShadow: 'none', padding: 2, fontSize: 11, letterSpacing: 0, whiteSpace: 'nowrap' }}>Exit</button>
        {/* Sound toggle */}
        <button
          onClick={onToggleSound}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            height: 48, minHeight: 48, minWidth: 48, fontFamily: 'var(--mono)', fontSize: 16, padding: 2,
            color: soundEnabled ? '#1a1a1a' : '#595959',
            opacity: soundEnabled ? 1 : 0.45,
          }}
          title={soundEnabled ? 'Mute sound' : 'Unmute sound'}
          aria-label={soundEnabled ? 'Mute sound' : 'Unmute sound'}
          aria-pressed={soundEnabled}
        >
          {soundEnabled ? '♪' : '×'}
        </button>
          <button type="button" className="btn small" disabled={gameOver || victory} aria-label={paused ? 'Resume game' : 'Pause game'} onClick={onPause} style={{ height: 48, minHeight: 48, minWidth: 48, padding: 2, fontSize: 11, letterSpacing: 0, whiteSpace: 'nowrap' }}>
            {paused ? 'Resume' : 'Pause'}
          </button>
        <button type="button" className="btn small" disabled={speedLocked || paused || gameOver || victory} aria-label={speedLocked ? 'Ranked speed locked at 1 times' : `Change game speed, currently ${speed} times`} title={speedLocked ? 'Ranked · fixed 1× speed' : `Change game speed, currently ${speed} times`} onClick={onSpeedCycle} style={{ height: 48, minHeight: 48, minWidth: 48, padding: 2, fontSize: 12, letterSpacing: 0, whiteSpace: 'nowrap' }}>×{speed}</button>
        <button type="button" className="btn small primary" disabled={!!nextBlocked} aria-label={nextTitle} title={nextTitle} onClick={onStart} style={{ height: 48, minHeight: 48, minWidth: 48, padding: '2px 4px', fontSize: 11, letterSpacing: 0, whiteSpace: 'nowrap', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 1 }}>
          <span>{wave === 0 ? 'Start Wave' : 'Next Wave'}</span>
          <span className="mono" style={{ fontSize: 11 }}>{nextBlocked ? paused ? 'Paused' : gameOver || victory ? 'Ended' : nextBlocked.startsWith('Next wave ready in ') ? `Wait ${Math.ceil(nextWait)}s` : 'Unavailable' : `+${compactHudCount(earlyBonus)} gold`}</span>
        </button>
      </div>
    </div>
  );
}

// ── Inspector ─────────────────────────────────────────────────────────────
interface InspectorProps {
  tower: PlacedTower; gold: number;
  lockBlocked?: string;
  onEnhance: () => void; onPromote: () => void; onSell: () => void; onCycleTarget: () => void; onToggleLock: () => void; onClose: () => void;
}

const TARGET_MODES: TargetingMode[] = ['first', 'last', 'strongest', 'weakest', 'closest'];
const CONTROL_DOCK_HEIGHT = 108;

export function towerActionAvailability(tower: PlacedTower, gold: number) {
  const spec = TOWERS[tower.towerId];
  const nextTier = UPGRADE_GRAPH[tower.towerId];
  const enhanceCost = getEnhanceCost(tower);
  const promoteCost = spec.upgradeCostToNext;
  const atMaxLevel = tower.level >= spec.maxLevel - 1;
  return { nextTier, enhanceCost, promoteCost, atMaxLevel,
    canEnhance: !atMaxLevel && Number.isFinite(enhanceCost) && enhanceCost >= 0 && gold >= enhanceCost,
    canPromote: !!nextTier && promoteCost != null && gold >= promoteCost };
}

export function towerHasAimer(towerId: TowerId): boolean {
  return towerId !== 'glueTower' && towerId !== 'mineLayer';
}

export function inspectorStatItems(tower: PlacedTower): { label: string; value: string; title: string }[] {
  const stats = towerStats(tower);
  const decimal = (value: number) => Number.isFinite(value) ? value.toFixed(2).replace(/\.?0+$/, '') : '--';
  const range = { label: 'RNG', value: (stats.range / ENGINE_CELL_PX).toFixed(1), title: `Range ${hudRawCount(stats.range / ENGINE_CELL_PX)} cells` };
  if (tower.towerId === 'glueTower' || tower.towerId === 'glueGun') return [
    { label: 'INT', value: `×${decimal(stats.slowFactor)}`, title: `Glue intensity multiplier ${hudRawCount(stats.slowFactor)}` },
    { label: 'DUR', value: `${decimal(stats.slowDuration)}s`, title: `Glue duration ${hudRawCount(stats.slowDuration)} seconds` }, range,
  ];
  if (tower.towerId === 'teleporter') return [
    { label: 'BACK', value: decimal(stats.teleportBack / ENGINE_CELL_PX), title: `Teleport rewind distance ${hudRawCount(stats.teleportBack / ENGINE_CELL_PX)} cells` },
    { label: 'RELOAD', value: `${decimal(stats.reload)}s`, title: `Reload interval ${hudRawCount(stats.reload)} seconds` }, range,
  ];
  const dps = stats.damage / stats.reload;
  return [
    { label: 'DMG', value: compactHudCount(stats.damage), title: `Damage ${hudRawCount(stats.damage)}` },
    { label: 'DPS', value: compactHudCount(dps), title: `Damage per second ${hudRawCount(dps)}` }, range,
  ];
}

export function inspectorStatsRegressionChecks(): number {
  let count = 0;
  const check = (ok: boolean, name: string) => { if (!ok) throw new Error(`Inspector stats regression: ${name}`); count++; };
  const fixture = (towerId: TowerId, level: number): PlacedTower => ({ uid: 'stats', towerId, level, value: 0, targetingMode: 'closest', cooldown: 0, cell: { x: 0, y: 0 }, worldX: 0, worldY: 0 });
  for (const towerId of ['glueTower', 'glueGun', 'teleporter'] as const) {
    for (let level = 0; level < TOWERS[towerId].maxLevel; level++) {
      const tower = fixture(towerId, level);
      const before = JSON.stringify(tower);
      const items = inspectorStatItems(tower);
      const stats = towerStats(tower);
      check(items.length === 3 && items[2].label === 'RNG', 'three compact stats with range');
      check(!items.some(item => item.label === 'DMG' || item.label === 'DPS'), 'support tower meaningful stats');
      check(items.every(item => item.title.length > 0 && !item.value.includes('--')), 'finite values and exact titles');
      if (towerId === 'teleporter') {
        check(Number(items[0].value) === stats.teleportBack / ENGINE_CELL_PX && Number(items[1].value.slice(0, -1)) === stats.reload, 'rewind cells and reload from engine');
        check(items[0].value === String(15 + 5 * level), 'enhance changes rewind visibly');
      } else {
        check(Math.abs(Number(items[0].value.slice(1)) - stats.slowFactor) < 1e-9, 'intensity from engine');
        check(items[1].value === (towerId === 'glueTower' ? '1.5s' : '2.5s'), 'source duration');
        if (level > 0) check(items[0].value !== inspectorStatItems(fixture(towerId, level - 1))[0].value, 'enhance changes intensity visibly');
      }
      check(JSON.stringify(tower) === before, 'stat projection pure');
    }
  }
  check(inspectorStatItems(fixture('canon', 0))[0].label === 'DMG', 'damage tower stats preserved');
  for (const towerId of Object.keys(TOWERS) as TowerId[]) {
    check(towerHasAimer(towerId) === (towerId !== 'glueTower' && towerId !== 'mineLayer'), 'only two area weapons lack aimer');
  }
  return count;
}

function TowerInspector({ tower, gold, lockBlocked = '', onEnhance, onPromote, onSell, onCycleTarget, onToggleLock, onClose }: InspectorProps) {
  const spec = TOWERS[tower.towerId];
  const statItems = inspectorStatItems(tower);
  const { nextTier, enhanceCost, promoteCost, atMaxLevel, canEnhance, canPromote } = towerActionAvailability(tower, gold);
  const enhanceTitle = atMaxLevel ? 'Enhance: maximum level reached' : `Enhance to level ${tower.level + 2} for ${hudRawCount(enhanceCost)} gold`;
  const promoteTitle = nextTier && promoteCost != null ? `Upgrade to ${TOWERS[nextTier].name} for ${hudRawCount(promoteCost)} gold` : 'Upgrade: maximum tier reached';
  const locked = tower.targetLock !== false;
  const hasAimer = towerHasAimer(tower.towerId);
  const areaTitle = 'Area weapon — no target lock/strategy';
  const lockTitle = hasAimer ? `Target lock ${locked ? 'on' : 'off'}; ${tower.targetUid ? `current target ${tower.targetUid}` : 'no current target'}; ${lockBlocked || `${locked ? 'disable' : 'enable'} target lock`}` : areaTitle;

  return (
    <div style={{
      height: '100%', width: '100%', boxSizing: 'border-box',
      background: '#f6f5f0', padding: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', height: 48, gap: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span className="serif" style={{ fontSize: 14, lineHeight: 1.1, whiteSpace: 'nowrap', color: '#1a1a1a' }}>{spec.name}</span>
            <span className="mono" style={{ fontSize: 11, whiteSpace: 'nowrap', color: '#595959' }}>LV {tower.level + 1}/{spec.maxLevel}</span>
          </div>
          <div className="mono" style={{ display: 'flex', gap: 6, fontSize: 11, lineHeight: '16px', whiteSpace: 'nowrap', color: '#595959' }}>
            {statItems.map(item => <span key={item.label} title={item.title} aria-label={item.title}>{item.label} {item.value}</span>)}
          </div>
        </div>
        <button type="button" className="btn small" disabled={!hasAimer || !!lockBlocked} title={lockTitle} aria-label={lockTitle} aria-pressed={hasAimer ? locked : undefined} onClick={onToggleLock}
          style={{ width: 48, height: 48, minHeight: 48, minWidth: 48, flexShrink: 0, padding: 2, fontSize: 11, letterSpacing: 0, display: 'flex', flexDirection: 'column', gap: 1, whiteSpace: 'nowrap' }}>
          <span>Lock</span>
          <span className="mono" style={{ fontSize: 11 }}>{hasAimer ? locked ? 'ON' : 'OFF' : 'N/A'}</span>
        </button>
        <button type="button" aria-label="Close tower inspector" onClick={onClose} style={{ width: 48, height: 48, flexShrink: 0, background: 'none', border: 'none', fontFamily: 'var(--mono)', fontSize: 16, cursor: 'pointer', color: '#1a1a1a', padding: 0 }}>✕</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6, height: 48 }}>
        <button
          className="btn small"
          disabled={!hasAimer} title={hasAimer ? `Change targeting strategy: ${tower.targetingMode}` : areaTitle} aria-label={hasAimer ? `Change targeting strategy, currently ${tower.targetingMode}` : areaTitle}
          style={{ minHeight: 48, minWidth: 48, padding: '2px 4px', fontSize: 11, letterSpacing: 0, display: 'flex', flexDirection: 'column', gap: 1 }}
          onClick={onCycleTarget}
        >
          <span>Target</span>
          <span className="mono" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{hasAimer ? tower.targetingMode.toUpperCase() : 'N/A'}</span>
        </button>
        <button
          className={`btn small${canEnhance ? ' primary' : ''}`}
          disabled={!canEnhance} title={enhanceTitle} aria-label={enhanceTitle}
          style={{
            minHeight: 48, minWidth: 48, padding: '2px 4px',
            fontSize: 11, lineHeight: '13px', letterSpacing: 0,
            fontWeight: 700,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
            opacity: canEnhance ? 1 : 0.5,
          }}
          onClick={onEnhance}
        >
          <span>Enhance</span>
          <span className="mono" style={{ fontSize: 11, fontWeight: 400 }}>{atMaxLevel ? 'MAX LV' : `$${compactHudCount(enhanceCost)}`}</span>
        </button>
        <button className={`btn small${canPromote ? ' primary' : ''}`} disabled={!canPromote}
          title={promoteTitle} aria-label={promoteTitle} onClick={onPromote}
          style={{ minHeight: 48, minWidth: 48, padding: '2px 4px', fontSize: 11, letterSpacing: 0,
            display: 'flex', flexDirection: 'column', gap: 1, opacity: canPromote ? 1 : .5 }}>
          <span>Upgrade</span>
          <span className="mono" style={{ fontSize: 11 }}>{nextTier && promoteCost != null ? `$${compactHudCount(promoteCost)}` : 'MAX TIER'}</span>
        </button>
        <button
          className="btn small"
          title={`Sell ${spec.name} for ${hudRawCount(tower.value)} gold`} aria-label={`Sell ${spec.name} for ${hudRawCount(tower.value)} gold`}
          style={{ minHeight: 48, minWidth: 48, padding: '2px 4px', fontSize: 11, letterSpacing: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}
          onClick={onSell}
        >
          <span>Sell</span>
          <span className="mono" style={{ fontSize: 11 }}>${compactHudCount(tower.value)}</span>
        </button>
      </div>
    </div>
  );
}

// ── Canvas draw helpers ───────────────────────────────────────────────────
function polygon(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, n: number, phase = 0) {
  for (let i = 0; i < n; i++) {
    const a = phase + (Math.PI * 2 / n) * i;
    if (i === 0) ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    else ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
}
function star(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, r: number, n: number) {
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (Math.PI / n) * i;
    const rad = i % 2 === 0 ? R : r;
    if (i === 0) ctx.moveTo(cx + rad * Math.cos(a), cy + rad * Math.sin(a));
    else ctx.lineTo(cx + rad * Math.cos(a), cy + rad * Math.sin(a));
  }
}

// ── Detailed tower silhouette drawings ───────────────────────────────────
// Each function draws the tower icon centered at (cx, cy) with base radius r.
// bodyColor = main fill, accentColor = barrel/lens details, strokeColor = outline.

function drawCanon(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, bodyColor: string, accentColor: string, strokeColor: string) {
  // Round base
  ctx.fillStyle = bodyColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();
  // Single thick barrel pointing up
  const bw = r * 0.38, bh = r * 0.75;
  ctx.fillStyle = accentColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(cx - bw / 2, cy - r - bh + r * 0.3, bw, bh);
  ctx.fill(); ctx.stroke();
  // Barrel tip cap
  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.rect(cx - bw / 2 - 1.5, cy - r - bh + r * 0.3 - 2, bw + 3, 3);
  ctx.fill(); ctx.stroke();
}

function drawDualCanon(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, bodyColor: string, accentColor: string, strokeColor: string) {
  // Wider flat base
  ctx.fillStyle = bodyColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();
  // Central turret box
  const tw = r * 0.8, th = r * 0.5;
  ctx.fillStyle = bodyColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(cx - tw / 2, cy - th / 2, tw, th);
  ctx.fill(); ctx.stroke();
  // Two parallel barrels
  const bw = r * 0.22, bh = r * 0.7, gap = r * 0.22;
  for (const dx of [-gap, gap]) {
    ctx.fillStyle = accentColor;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.rect(cx + dx - bw / 2, cy - r * 0.2 - bh, bw, bh);
    ctx.fill(); ctx.stroke();
    // Tip
    ctx.fillStyle = strokeColor;
    ctx.beginPath();
    ctx.rect(cx + dx - bw / 2 - 1, cy - r * 0.2 - bh - 2, bw + 2, 3);
    ctx.fill();
  }
}

function drawMachineGun(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, bodyColor: string, accentColor: string, strokeColor: string) {
  // Wider squat base
  ctx.fillStyle = bodyColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.ellipse(cx, cy + r * 0.1, r * 1.1, r * 0.75, 0, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();
  // Drum/casing on right side
  ctx.fillStyle = accentColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.arc(cx + r * 0.55, cy - r * 0.05, r * 0.38, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();
  // Long thin barrel
  const bw = r * 0.2, bh = r * 1.0;
  ctx.fillStyle = accentColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(cx - r * 0.62, cy - r * 0.15, bw, -bh);
  ctx.fill(); ctx.stroke();
  // Cooling slots (3 lines on barrel)
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 0.6;
  for (let i = 0; i < 3; i++) {
    const sy = cy - r * 0.15 - bh * 0.3 - i * (bh * 0.18);
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.62, sy);
    ctx.lineTo(cx - r * 0.62 + bw, sy);
    ctx.stroke();
  }
}

function drawSimpleLaser(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, bodyColor: string, accentColor: string, strokeColor: string) {
  // Diamond prism body
  ctx.fillStyle = bodyColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r * 0.78, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r * 0.78, cy);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  // Inner lens point
  ctx.fillStyle = accentColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.25, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();
}

function drawBouncingLaser(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, bodyColor: string, accentColor: string, strokeColor: string) {
  // Multi-faceted crystal: octagon-ish (rotated square + diamond overlay)
  ctx.fillStyle = bodyColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  polygon(ctx, cx, cy, r, 8, Math.PI / 8);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  // Inner crystal
  ctx.fillStyle = accentColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 0.45);
  ctx.lineTo(cx + r * 0.35, cy);
  ctx.lineTo(cx, cy + r * 0.45);
  ctx.lineTo(cx - r * 0.35, cy);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  // 3 spark dots around
  const sparkR = r * 0.12;
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + (Math.PI * 2 / 3) * i;
    const sx = cx + (r + 3) * Math.cos(a);
    const sy = cy + (r + 3) * Math.sin(a);
    ctx.fillStyle = accentColor;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.arc(sx, sy, sparkR, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
  }
}

function drawStraightLaser(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, bodyColor: string, accentColor: string, strokeColor: string) {
  // Tall elongated prism
  const hw = r * 0.6, hh = r * 1.15;
  ctx.fillStyle = bodyColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(cx, cy - hh);
  ctx.lineTo(cx + hw, cy - hh * 0.3);
  ctx.lineTo(cx + hw, cy + hh * 0.6);
  ctx.lineTo(cx, cy + hh);
  ctx.lineTo(cx - hw, cy + hh * 0.6);
  ctx.lineTo(cx - hw, cy - hh * 0.3);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  // Narrow beam line upward
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy - hh);
  ctx.lineTo(cx, cy - hh - r * 0.6);
  ctx.stroke();
  // Emitter dot at top
  ctx.fillStyle = accentColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.arc(cx, cy - hh * 0.7, r * 0.18, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();
}

function drawMortar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, bodyColor: string, accentColor: string, strokeColor: string) {
  // Squat trapezoid base (wider bottom)
  const bw = r * 1.1, tw = r * 0.7, h = r * 0.85;
  const baseY = cy + r * 0.3;
  ctx.fillStyle = bodyColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(cx - bw / 2, baseY);
  ctx.lineTo(cx + bw / 2, baseY);
  ctx.lineTo(cx + tw / 2, baseY - h);
  ctx.lineTo(cx - tw / 2, baseY - h);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  // Barrel at slight angle (tilted right)
  const brl_w = r * 0.3, brl_h = r * 0.8;
  ctx.save();
  ctx.translate(cx + r * 0.2, baseY - h + r * 0.1);
  ctx.rotate(Math.PI / 10);
  ctx.fillStyle = accentColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(-brl_w / 2, -brl_h, brl_w, brl_h);
  ctx.fill(); ctx.stroke();
  // Barrel rim
  ctx.fillStyle = strokeColor;
  ctx.beginPath();
  ctx.rect(-brl_w / 2 - 1.5, -brl_h - 2, brl_w + 3, 3);
  ctx.fill();
  ctx.restore();
}

function drawMineLayer(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, bodyColor: string, accentColor: string, strokeColor: string) {
  // Low flat box body
  const bw = r * 1.3, bh = r * 0.75;
  ctx.fillStyle = bodyColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.rect(cx - bw / 2, cy - bh / 2, bw, bh);
  ctx.fill(); ctx.stroke();
  // Central dispenser nozzle (short tube on top)
  const nw = r * 0.35, nh = r * 0.4;
  ctx.fillStyle = accentColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(cx - nw / 2, cy - bh / 2 - nh, nw, nh);
  ctx.fill(); ctx.stroke();
  // 3 mini mines (circles) scattered below
  const minePositions = [[-r * 0.5, r * 0.7], [0, r * 0.85], [r * 0.5, r * 0.7]] as const;
  for (const [mx, my] of minePositions) {
    ctx.fillStyle = accentColor;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.arc(cx + mx, cy + my, r * 0.15, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    // Mine spike (top)
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(cx + mx, cy + my - r * 0.15);
    ctx.lineTo(cx + mx, cy + my - r * 0.26);
    ctx.stroke();
  }
}

function drawRocketLauncher(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, bodyColor: string, accentColor: string, strokeColor: string) {
  // 2×2 grid of launch tubes (square with 4 circles as tube mouths)
  const blockSz = r * 1.05;
  ctx.fillStyle = bodyColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.rect(cx - blockSz / 2, cy - blockSz / 2, blockSz, blockSz);
  ctx.fill(); ctx.stroke();
  // 4 tube openings
  const tubeR = r * 0.22;
  const offsets = [[-0.28, -0.28], [0.28, -0.28], [-0.28, 0.28], [0.28, 0.28]] as const;
  for (const [ox, oy] of offsets) {
    ctx.fillStyle = strokeColor;
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.arc(cx + ox * r * 1.9, cy + oy * r * 1.9, tubeR, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    // Inner tube highlight
    ctx.fillStyle = accentColor;
    ctx.beginPath();
    ctx.arc(cx + ox * r * 1.9, cy + oy * r * 1.9, tubeR * 0.45, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawGlueTower(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, bodyColor: string, accentColor: string, strokeColor: string) {
  // Rounded tank body
  const tw = r * 1.0, th = r * 0.9;
  ctx.fillStyle = bodyColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(cx - tw / 2, cy - th / 2 + r * 0.1, tw, th, r * 0.3);
  ctx.fill(); ctx.stroke();
  // Nozzle pipe on top
  const pw = r * 0.28, ph = r * 0.45;
  ctx.fillStyle = accentColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(cx - pw / 2, cy - th / 2 + r * 0.1 - ph, pw, ph);
  ctx.fill(); ctx.stroke();
  // Glue drop on top of nozzle
  const dy = cy - th / 2 + r * 0.1 - ph - r * 0.28;
  ctx.fillStyle = accentColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.arc(cx, dy, r * 0.2, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();
  // Drop tip
  ctx.fillStyle = accentColor;
  ctx.strokeStyle = accentColor;
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.1, dy);
  ctx.lineTo(cx + r * 0.1, dy);
  ctx.lineTo(cx, dy - r * 0.22);
  ctx.closePath();
  ctx.fill();
}

function drawGlueGun(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, bodyColor: string, accentColor: string, strokeColor: string) {
  // Wider tank
  const tw = r * 1.15, th = r * 0.85;
  ctx.fillStyle = bodyColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(cx - tw / 2, cy - th / 2, tw, th, r * 0.25);
  ctx.fill(); ctx.stroke();
  // Two nozzles side by side
  const nw = r * 0.22, nh = r * 0.5, gap = r * 0.25;
  for (const dx of [-gap, gap]) {
    ctx.fillStyle = accentColor;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.rect(cx + dx - nw / 2, cy - th / 2 - nh, nw, nh);
    ctx.fill(); ctx.stroke();
    // Drop
    ctx.fillStyle = accentColor;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.arc(cx + dx, cy - th / 2 - nh - r * 0.2, r * 0.16, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
  }
  // Connector bar between nozzles
  ctx.fillStyle = bodyColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.rect(cx - gap - nw / 2, cy - th / 2 - r * 0.15, gap * 2 + nw, r * 0.15);
  ctx.fill(); ctx.stroke();
}

function drawTeleporter(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, bodyColor: string, accentColor: string, strokeColor: string) {
  // Outer ring
  ctx.strokeStyle = bodyColor;
  ctx.lineWidth = r * 0.22;
  ctx.fillStyle = 'transparent';
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.82, 0, Math.PI * 2);
  ctx.stroke();
  // Outer ring outline
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.72, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.92, 0, Math.PI * 2);
  ctx.stroke();
  // Inner star (5 points)
  ctx.fillStyle = accentColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  star(ctx, cx, cy, r * 0.55, r * 0.24, 5);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  // Central dot
  ctx.fillStyle = strokeColor;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.14, 0, Math.PI * 2);
  ctx.fill();
}

// Dispatch draw by towerId
function drawTowerSilhouette(
  ctx: CanvasRenderingContext2D,
  towerId: TowerId,
  cx: number, cy: number, r: number,
  bodyColor: string, accentColor: string, strokeColor: string
) {
  switch (towerId) {
    case 'canon':          drawCanon(ctx, cx, cy, r, bodyColor, accentColor, strokeColor); break;
    case 'dualCanon':      drawDualCanon(ctx, cx, cy, r, bodyColor, accentColor, strokeColor); break;
    case 'machineGun':     drawMachineGun(ctx, cx, cy, r, bodyColor, accentColor, strokeColor); break;
    case 'simpleLaser':    drawSimpleLaser(ctx, cx, cy, r, bodyColor, accentColor, strokeColor); break;
    case 'bouncingLaser':  drawBouncingLaser(ctx, cx, cy, r, bodyColor, accentColor, strokeColor); break;
    case 'straightLaser':  drawStraightLaser(ctx, cx, cy, r, bodyColor, accentColor, strokeColor); break;
    case 'mortar':         drawMortar(ctx, cx, cy, r, bodyColor, accentColor, strokeColor); break;
    case 'mineLayer':      drawMineLayer(ctx, cx, cy, r, bodyColor, accentColor, strokeColor); break;
    case 'rocketLauncher': drawRocketLauncher(ctx, cx, cy, r, bodyColor, accentColor, strokeColor); break;
    case 'glueTower':      drawGlueTower(ctx, cx, cy, r, bodyColor, accentColor, strokeColor); break;
    case 'glueGun':        drawGlueGun(ctx, cx, cy, r, bodyColor, accentColor, strokeColor); break;
    case 'teleporter':     drawTeleporter(ctx, cx, cy, r, bodyColor, accentColor, strokeColor); break;
    default:               ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
}

// Accent colors per tower family (for details — barrels, lenses, etc.)
const TOWER_ACCENT: Partial<Record<TowerId, string>> = {
  canon: '#f6f5f0', dualCanon: '#f6f5f0', machineGun: '#f6f5f0',
  simpleLaser: '#4a5a8a', bouncingLaser: '#6a7aaa', straightLaser: '#8aaacc',
  mortar: '#f6f5f0', mineLayer: '#f6f5f0', rocketLauncher: '#f6f5f0',
  glueTower: '#a8c878', glueGun: '#a8c878', teleporter: '#a58a4a',
};

function drawTowerCanvas(
  ctx: CanvasRenderingContext2D,
  tower: PlacedTower,
  selected: boolean,
  alpha = 1,
  colorOverride?: string,
  paper?: { angle: number; shotAge: number; reducedMotion?: boolean }
) {
  const { worldX: x, worldY: y } = tower;
  const base = TOWER_SHAPES[tower.towerId] ?? { shape: 'circle', color: '#595959' };
  // Fixed base size — cell is 34px, want icon to sit comfortably in cell
  const r = 11;

  const bodyColor = colorOverride ?? base.color;
  const accentColor = TOWER_ACCENT[tower.towerId] ?? '#f6f5f0';
  const strokeColor = '#2b2b2b';

  ctx.save();
  ctx.globalAlpha = alpha;

  const paperDrawn = paper && drawPaperTower(ctx, tower, paper.angle, paper.shotAge, ENGINE_CELL_PX, colorOverride, paper.reducedMotion);
  if (!paperDrawn) {
  // Shadow ellipse
  ctx.fillStyle = 'rgba(43,43,43,0.18)';
  ctx.strokeStyle = 'rgba(43,43,43,0.10)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.ellipse(x, y + r * 0.65, r * 0.85, r * 0.22, 0, 0, Math.PI * 2);
  ctx.fill();

  // Draw silhouette
    drawTowerSilhouette(ctx, tower.towerId, x, y, r, bodyColor, accentColor, strokeColor);
  }

  // Level indicator: small pips at bottom (up to 5), then number for >5
  const pipY = y + r + 4.5;
  if (tower.level <= 5) {
    const pipCount = tower.level;
    if (pipCount > 0) {
      const pipSpacing = 3.5;
      const pipStart = x - (pipCount - 1) * pipSpacing * 0.5;
      for (let i = 0; i < pipCount; i++) {
        ctx.fillStyle = '#a58a4a';
        ctx.strokeStyle = '#2b2b2b';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.arc(pipStart + i * pipSpacing, pipY, 1.5, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }
    }
  } else {
    ctx.fillStyle = '#a58a4a';
    ctx.font = `bold 7px JetBrains Mono, monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(`${tower.level}`, x, pipY + 2);
  }

  // Selected ring: dashed amber circle
  if (selected) {
    ctx.strokeStyle = '#a58a4a';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    ctx.arc(x, y, r + 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

function drawEnemyCanvas(ctx: CanvasRenderingContext2D, enemy: Enemy, time: number, heading: number, moving: boolean, patches: readonly GluePatch[] = [], frame?: ReturnType<typeof createPaperEnemyFrame>, reducedMotion = false, walkPhase?: number) {
  const { pos, id } = enemy;
  const espec: EnemySpec = ENEMIES[id];
  const es = ENEMY_SHAPES[id] ?? { shape: 'circle', color: '#595959' };
  const isFlyer = espec.flying === true;
  const isBoss = id === 'boss';
  const sz = isBoss ? ENGINE_CELL_PX * 0.62 : id === 'blob' ? ENGINE_CELL_PX * 0.38 : ENGINE_CELL_PX * 0.28;
  const py = isFlyer ? pos.y - 5 : pos.y;

  // Hit-flash overlay
  const flashing = (enemy.hitFlash ?? 0) > 0;
  const statuses = enemyVisualStatuses(enemy, time, patches);

  ctx.save();

  const paperDrawn = drawPaperEnemy(ctx, enemy, time, heading, moving && !statuses.stunned, ENGINE_CELL_PX, frame, reducedMotion, walkPhase);
  if (!paperDrawn) {
  if (isFlyer) {
    // shadow on ground
    ctx.fillStyle = 'rgba(43,43,43,0.15)';
    ctx.beginPath();
    ctx.ellipse(pos.x, pos.y + 3, sz, sz * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = flashing ? '#ffffff' : es.color;
  ctx.strokeStyle = flashing ? '#ffffff' : (isBoss ? '#8a4a4a' : '#2b2b2b');
  ctx.lineWidth = isBoss ? 2.0 : 1.1;

  ctx.beginPath();
  switch (es.shape) {
    case 'circle': ctx.arc(pos.x, py, sz, 0, Math.PI * 2); break;
    case 'hex': polygon(ctx, pos.x, py, sz, 6, Math.PI / 6); break;
    case 'triangle':
      ctx.moveTo(pos.x, py - sz);
      ctx.lineTo(pos.x + sz, py + sz * 0.7);
      ctx.lineTo(pos.x - sz, py + sz * 0.7);
      break;
    case 'diamond':
      ctx.moveTo(pos.x, py - sz);
      ctx.lineTo(pos.x + sz, py);
      ctx.lineTo(pos.x, py + sz);
      ctx.lineTo(pos.x - sz, py);
      break;
    default: ctx.arc(pos.x, py, sz, 0, Math.PI * 2);
  }
  ctx.closePath(); ctx.fill(); ctx.stroke();

  // Boss inner detail ring
  if (isBoss) {
    ctx.strokeStyle = 'rgba(138,74,74,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(pos.x, py, sz * 0.55, 0, Math.PI * 2);
    ctx.stroke();
  }

  }
  // Slow ring
  if (statuses.slowed && !drawPaperFxSprite(ctx, 'slow_status', pos.x, py + sz, sz * 1.3, 0, .8)) {
    ctx.strokeStyle = 'rgba(107,122,90,0.8)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(pos.x, py, sz + 3, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (statuses.stunned) {
    if (!drawPaperFxSprite(ctx, 'chain_contact', pos.x, py - sz - 10, sz * 1.1, 0, .9)) {
      ctx.strokeStyle = '#a58a4a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const x = pos.x + (i - 1) * 5;
        ctx.moveTo(x, py - sz - 13); ctx.lineTo(x, py - sz - 7);
      }
      ctx.stroke();
    }
  }

  if (statuses.teleporting || statuses.teleported) {
    const size = statuses.teleporting ? sz * 2.4 : sz * .7;
    const x = statuses.teleporting ? pos.x : pos.x + sz;
    if (!drawPaperFxSprite(ctx, 'portal_ring', x, py, size, 0, statuses.teleporting ? .85 : .6)) {
      ctx.strokeStyle = '#a58a4a';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, py, size / 2, 0, Math.PI * 2); ctx.stroke();
    }
  }

  ctx.restore();
}

function drawGrid(ctx: CanvasRenderingContext2D, _blocked: boolean[][], gridW: number, gridH: number, entry: Vec2, exit: Vec2) {
  const C = ENGINE_CELL_PX;
  ctx.strokeStyle = 'rgba(89,89,89,0.08)';
  ctx.lineWidth = 0.8;
  for (let x = 0; x <= gridW; x++) {
    ctx.beginPath(); ctx.moveTo(x * C, 0); ctx.lineTo(x * C, gridH * C); ctx.stroke();
  }
  for (let y = 0; y <= gridH; y++) {
    ctx.beginPath(); ctx.moveTo(0, y * C); ctx.lineTo(gridW * C, y * C); ctx.stroke();
  }
  // Entry / exit markers
  ctx.font = `600 8px JetBrains Mono, monospace`;
  ctx.fillStyle = '#2b2b2b';
  ctx.textAlign = 'center';
  ctx.fillText('IN', (entry.x + .5) * C, (entry.y + .27) * C);
  ctx.fillText('OUT', (exit.x + .5) * C, (exit.y + .27) * C);
  ctx.textAlign = 'start';
}

function drawPath(ctx: CanvasRenderingContext2D, path: Vec2[] | null) {
  if (!path || path.length < 2) return;
  ctx.strokeStyle = 'rgba(43,43,43,0.25)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  const p0 = cellToWorld(path[0]);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < path.length; i++) {
    const p = cellToWorld(path[i]);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawEffect(ctx: CanvasRenderingContext2D, e: Effect, viewport?: { x: number; y: number; width: number; height: number }, reducedMotion = false, contacts?: Set<number>) {
  if (drawPaperDamageEffect(ctx, e, viewport, reducedMotion, contacts)) return true;
  const t = 1 - e.life / e.maxLife; // 0→1 as effect fades out
  const alpha = e.life / e.maxLife;
  ctx.save();
  switch (e.kind) {
    case 'boom': {
      // Mortar: expanding ring charcoal
      const r = (e.r ?? 20) * t;
      ctx.strokeStyle = `rgba(43,43,43,${alpha * 0.85})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(e.x, e.y, Math.max(1, r), 0, Math.PI * 2);
      ctx.stroke();
      // Inner fill flash
      if (t < 0.35) {
        ctx.fillStyle = `rgba(165,138,74,${(0.35 - t) / 0.35 * 0.22})`;
        ctx.beginPath();
        ctx.arc(e.x, e.y, Math.max(1, r), 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'boom_big': {
      // Rocket: larger bright ring + inner ring
      const r = (e.r ?? 30) * t;
      ctx.strokeStyle = `rgba(138,74,74,${alpha * 0.9})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(e.x, e.y, Math.max(1, r), 0, Math.PI * 2);
      ctx.stroke();
      // Second inner ring
      ctx.strokeStyle = `rgba(165,138,74,${alpha * 0.6})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(e.x, e.y, Math.max(1, r * 0.55), 0, Math.PI * 2);
      ctx.stroke();
      // Flash fill
      if (t < 0.25) {
        ctx.fillStyle = `rgba(165,138,74,${(0.25 - t) / 0.25 * 0.3})`;
        ctx.beginPath();
        ctx.arc(e.x, e.y, Math.max(1, r), 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'chain': {
      // simpleLaser thin beam
      if (e.pts && e.pts.length >= 2) {
        ctx.strokeStyle = `rgba(74,90,138,${alpha * 0.9})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(e.pts[0].x, e.pts[0].y);
        for (let i = 1; i < e.pts.length; i++) ctx.lineTo(e.pts[i].x, e.pts[i].y);
        ctx.stroke();
      }
      break;
    }
    case 'chain_bounce': {
      // bouncingLaser: ломаная синяя линия
      if (e.pts && e.pts.length >= 2) {
        ctx.strokeStyle = `rgba(106,122,170,${alpha})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(e.pts[0].x, e.pts[0].y);
        for (let i = 1; i < e.pts.length; i++) ctx.lineTo(e.pts[i].x, e.pts[i].y);
        ctx.stroke();
        // Glow line
        ctx.strokeStyle = `rgba(180,200,255,${alpha * 0.4})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(e.pts[0].x, e.pts[0].y);
        for (let i = 1; i < e.pts.length; i++) ctx.lineTo(e.pts[i].x, e.pts[i].y);
        ctx.stroke();
      }
      break;
    }
    case 'chain_straight': {
      // straightLaser: толстый пронзающий луч синий/охра
      if (e.pts && e.pts.length >= 2) {
        // Bright core
        ctx.strokeStyle = `rgba(138,170,204,${alpha})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(e.pts[0].x, e.pts[0].y);
        ctx.lineTo(e.pts[1].x, e.pts[1].y);
        ctx.stroke();
        // Glow outer
        ctx.strokeStyle = `rgba(74,90,138,${alpha * 0.45})`;
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(e.pts[0].x, e.pts[0].y);
        ctx.lineTo(e.pts[1].x, e.pts[1].y);
        ctx.stroke();
      }
      break;
    }
    case 'laser_flash': {
      // Вспышка-точка акцентного синего
      const fr = 5 * (1 - t * 0.5);
      ctx.fillStyle = `rgba(106,122,170,${alpha})`;
      ctx.beginPath();
      ctx.arc(e.x, e.y, fr, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(180,200,255,${alpha * 0.6})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(e.x, e.y, fr * 1.8, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'bullet_spark': {
      // 3 маленьких искорки charcoal (рисуем звёздочку)
      ctx.strokeStyle = `rgba(43,43,43,${alpha})`;
      ctx.lineWidth = 1;
      for (let i = 0; i < 4; i++) {
        const angle = (Math.PI / 2) * i + Math.PI / 4;
        const len = 4 * (1 - t * 0.7);
        ctx.beginPath();
        ctx.moveTo(e.x, e.y);
        ctx.lineTo(e.x + Math.cos(angle) * len, e.y + Math.sin(angle) * len);
        ctx.stroke();
      }
      break;
    }
    case 'ring':
    case 'glue': {
      // Glue AoE ring — зеленоватый
      ctx.strokeStyle = `rgba(74,106,90,${alpha * 0.7})`;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r ?? 20, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      break;
    }
    case 'glue_splat': {
      // Растекающийся зелёный овал
      const sr = (e.r ?? 6) * (0.4 + t * 0.8);
      ctx.fillStyle = `rgba(74,106,90,${alpha * 0.45})`;
      ctx.beginPath();
      ctx.ellipse(e.x, e.y, sr * 1.4, sr * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(74,106,90,${alpha * 0.7})`;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.ellipse(e.x, e.y, sr * 1.4, sr * 0.7, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'heal': {
      ctx.strokeStyle = `rgba(107,122,90,${alpha})`;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r ?? 20, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      break;
    }
    case 'teleport': {
      // Вихрь-кольцо золотое + внутренняя окружность
      const tr = (e.r ?? 14) * (0.3 + t * 0.8);
      ctx.strokeStyle = `rgba(165,138,74,${alpha * 0.9})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(e.x, e.y, Math.max(2, tr), 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = `rgba(165,138,74,${alpha * 0.4})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(e.x, e.y, Math.max(2, tr * 0.55), 0, Math.PI * 2);
      ctx.stroke();
      // Fill flash at start
      if (t < 0.3) {
        ctx.fillStyle = `rgba(165,138,74,${(0.3 - t) / 0.3 * 0.25})`;
        ctx.beginPath();
        ctx.arc(e.x, e.y, Math.max(2, tr), 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
  }
  ctx.restore();
}

// ── Main game component ───────────────────────────────────────────────────
export type GameFrameSnapshot = Readonly<{
  time: number; paused: boolean; towers: number; enemies: number; projectiles: number; effects: number;
  shots: number; mines: number; glueShots: number; gluePatches: number; canvasWidth: number; canvasHeight: number;
  paperStatus: string;
}>;

interface GameExProps {
  run: RunSession;
  onRestart: () => void;
  onContinue: () => boolean;
  onExit: () => void;
  state: GameState;
  setState: (updater: (s: GameState) => GameState) => boolean | void;
  initialCheckpoint?: RunCheckpoint;
  onCheckpoint?: (checkpoint: RunCheckpoint) => boolean;
  onPersistenceError?: () => void;
  onTopUp?: () => void;
  onSettled?: () => void;
  suspended?: boolean;
  persistenceBlocked?: boolean;
  onRetryPersistence?: () => GameState | false;
  hudVariant?: number; // kept for API compat, ignored
  initialGameFactory?: () => BattleState;
  onFrameSnapshot?: (snapshot: GameFrameSnapshot) => void;
}

function PaperAssetStatus({ status }: { status: string }) {
  if (status === 'ready') return null;
  const loading = status === 'loading';
  const retryAvailable = canRetryPaperAssets();
  return <div role="status" aria-busy={loading} style={{ position: 'relative', minHeight: loading ? undefined : 48, boxSizing: 'border-box', fontSize: 12, padding: loading ? '4px 8px' : '4px 96px 4px 8px', background: '#e8e8e3', flexShrink: 0 }}>
    <span>{loading ? 'Loading paper assets…' : !retryAvailable ? `${status} · Retry limit reached. Reload to try again.` : status}</span>
    {!loading && <button type="button" disabled={!retryAvailable} style={{ position: 'absolute', top: 0, right: 8, zIndex: 2, minHeight: 48, minWidth: 48 }} onClick={() => {
      if (!canRetryPaperAssets()) return;
      void loadPaperAssets({ retry: true });
    }}>Retry art</button>}
  </div>;
}

export function GameEx({ run, onRestart, onContinue, onExit, state: _appState, setState: _setAppState, initialGameFactory, onFrameSnapshot,
  initialCheckpoint, onCheckpoint, onPersistenceError, onTopUp, onSettled, suspended = false,
  persistenceBlocked = false, onRetryPersistence }: GameExProps) {
  const paperStatus = usePaperAssets();
  const [motionRevision, setMotionRevision] = useState(0);
  const reducedMotionRef = useRef(true);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { reducedMotionRef.current = preference.matches; setMotionRevision(value => value + 1); };
    update();
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);
  const paperStatusRef = useRef(paperStatus);
  paperStatusRef.current = paperStatus;
  const fieldRef = useRef<HTMLDivElement>(null);
  const towerMotion = useRef(new Map<string, { cooldown: number; shotAt: number; angle: number; time: number }>());
  const projectileOrigins = useRef(new Map<string, Vec2>());
  const laserOriginalPoints = useRef(new Map<string, Vec2[]>());
  const emissionSockets = useRef(new Map<string, string>());
  const emissionSequence = useRef(new Map<string, number>());
  const enemyMotion = useRef(new Map<string, { x: number; y: number; heading: number; movedAt: number }>());
  const [paperWalkClock] = useState(createPaperWalkClock);
  const paperWalkClockRef = useRef(paperWalkClock);
  const healthArcLayoutRef = useRef<HealthArcLayoutState>(new Map());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isFixture = import.meta.env.DEV && initialGameFactory !== undefined;
  const [restored] = useState(() => initialCheckpoint ? restoreRunCheckpoint(initialCheckpoint, run) : undefined);
  const [initialGame] = useState(() => restored?.battle ?? (isFixture ? initialGameFactory!()
    : createGame(undefined, undefined, undefined, { combatSeed: run.seed ?? 0 })));
  const snapshotCallbackRef = useRef(onFrameSnapshot);
  snapshotCallbackRef.current = onFrameSnapshot;
  const gsRef = useRef<BattleState>(initialGame);
  const [renderTick, setRenderTick] = useState(0); // triggers React re-render for HUD
  const [selectedTowerId, setSelectedTowerId] = useState<string | null>(null);
  const [selTowerId, setSelTowerId] = useState<TowerId>('canon');
  const [hoverCell, setHoverCell] = useState<Vec2 | null>(null);
  const [speed, setSpeed] = useState<1 | 2 | 4>(run.config.access === 'ranked' ? 1 : restored?.speed ?? run.speed ?? 1);
  const speedRef = useRef<1 | 2 | 4>(speed);
  const lastTimeRef = useRef<number | null>(null);
  const rafRef = useRef<number>(0);
  const [cellPx, setCellPx] = useState<number>(DISPLAY_CELL_PX);
  const cellPxRef = useRef<number>(DISPLAY_CELL_PX);
  // D: track if we already paid out STD for this game-over
  const rewardedRef = useRef(false);
  const activeSecondsRef = useRef(restored?.activeSeconds ?? 0);
  const clockStartedRef = useRef(restored?.clockStarted ?? (isFixture && initialGame.waveIndex >= 0));
  const planningSecondsRef = useRef(restored?.planningSeconds ?? 0);
  // Track unique tower base types placed this run (for use_4 challenge)
  const placedTowerTypesRef = useRef<Set<string>>(new Set(restored?.placedTowerTypes ?? []));
  // Track whether any enemy leaked (reached exit) this run (for no_leak challenge)
  const hadLeakRef = useRef(false);

  // Audio: track whether ambient has been started (needs first gesture first)
  const ambientStartedRef = useRef(false);
  const resultSoundSeenRef = useRef(false);
  const [persistenceError, setPersistenceError] = useState(false);
  const persistenceErrorRef = useRef(false);
  const persistenceWasBlockedRef = useRef(false);
  const exitRequestedRef = useRef<{ wasPaused: boolean } | null>(null);
  const [toast, setToast] = useState('');
  const checkpointAtRef = useRef(-1);
  const callbacksRef = useRef({ onCheckpoint, onPersistenceError, onSettled, onRetryPersistence, state: _appState, setState: _setAppState });
  callbacksRef.current = { onCheckpoint, onPersistenceError, onSettled, onRetryPersistence, state: _appState, setState: _setAppState };
  const [timing] = useState(() => createReplayTiming({
    getState: () => gsRef.current,
    tick: (state, dt) => {
      const before = paperWalkClockRef.current.snapshot(state);
      tick(state, dt);
      capturePaperLaserOriginals(state.effects, laserOriginalPoints.current);
      paperWalkClockRef.current.capture(state, before);
    }, startWave, canStartNextWave, getNextWaveWait,
  }, { mode: run.config.mode, waveLimit: run.config.waveLimit, durationSeconds: run.config.durationMinutes * 60,
    ...(run.config.access === 'ranked' ? { speedLimit: 1 as const } : {}) }, {
    version: 1, speed: speedRef.current, activeSeconds: activeSecondsRef.current,
    planningSeconds: planningSecondsRef.current, clockStarted: clockStartedRef.current,
    hidden: false, resetNextFrame: true, backlogSeconds: restored?.backlogSeconds ?? 0,
  }));

  // Resolve equipped skin color per family (applied to towers on the field)
  const skinColorsRef = useRef<Record<string, string>>({});
  {
    const map: Record<string, string> = {};
    if (_appState?.skinsEnabled !== false && _appState?.equippedSkins) {
      for (const fam of ['canon', 'laser', 'mortar', 'glue'] as const) {
        const sk = SKINS.find(s => s.id === _appState.equippedSkins[fam]);
        if (sk) map[fam] = sk.color;
      }
    }
    skinColorsRef.current = map;
  }

  // ── Game loop ─────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const gs = gsRef.current;
    const cp = cellPxRef.current;
    const cw = GRID_W * cp;
    const ch = GRID_H * cp;

    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#f6f5f0';
    ctx.fillRect(0, 0, cw, ch);

    // Scale from engine coords (ENGINE_CELL_PX) to display coords (cp)
    const scale = cp / ENGINE_CELL_PX;
    ctx.save();
    ctx.scale(scale, scale);

    drawPaperGround(ctx, gs.gridW, gs.gridH, ENGINE_CELL_PX);
    drawPaperEnvironmentStructure(ctx, 'entry_gate', gs.entry, ENGINE_CELL_PX);
    drawPaperEnvironmentStructure(ctx, 'exit_goal', gs.exit, ENGINE_CELL_PX);
    drawGrid(ctx, gs.grid, gs.gridW, gs.gridH, gs.entry, gs.exit);
    drawPath(ctx, gs.currentPath);

    // Hover preview
    if (hoverCell && !selectedTowerId) {
      const spec = TOWERS[selTowerId];
      const w = cellToWorld(hoverCell);
      const isBlocked = gs.grid[hoverCell.y]?.[hoverCell.x];
      const isEntry = hoverCell.x === gs.entry.x && hoverCell.y === gs.entry.y;
      const isExit = hoverCell.x === gs.exit.x && hoverCell.y === gs.exit.y;
      ctx.fillStyle = isBlocked || isEntry || isExit
        ? 'rgba(138,74,74,0.12)'
        : 'rgba(89,89,89,0.08)';
      ctx.fillRect(hoverCell.x * ENGINE_CELL_PX, hoverCell.y * ENGINE_CELL_PX, ENGINE_CELL_PX, ENGINE_CELL_PX);
      // Range preview
      const rangeR = (spec.range * ENGINE_CELL_PX);
      ctx.strokeStyle = 'rgba(43,43,43,0.3)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(w.x, w.y, rangeR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Selected tower range
    if (selectedTowerId) {
      const tw = gs.towers.find(t => t.uid === selectedTowerId);
      if (tw) {
        const stats = towerStats(tw);
        ctx.fillStyle = 'rgba(165,138,74,0.08)';
        ctx.strokeStyle = '#a58a4a';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(tw.worldX, tw.worldY, stats.range, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }
    }

    const groundEffectIds = new Set(gs.gluePatches.map(patch => patch.uid));
    for (const effect of gs.effects) if (isGroundEffect(effect, groundEffectIds)) drawEffect(ctx, effect);

    // Towers
    const towersByUid = new Map(gs.towers.map(tower => [tower.uid, tower]));
    const enemiesByUid = new Map(gs.enemies.map(enemy => [enemy.uid, enemy]));
    const renderedTowers = new Map<string, { angle: number; shotAge: number }>();
    for (const uid of towerMotion.current.keys()) if (!gs.towers.some(t => t.uid === uid)) towerMotion.current.delete(uid);
    for (const uid of emissionSequence.current.keys()) if (!towersByUid.has(uid)) emissionSequence.current.delete(uid);
    for (const tower of gs.towers) {
      const fam = TOWER_FAMILY[tower.towerId];
      const motion = towerMotion.current.get(tower.uid) ?? { cooldown: tower.cooldown, shotAt: -100, angle: 0, time: gs.time - .016 };
      const presentation = tower as PlacedTower & { aimAngle?: number; lastFireTime?: number };
      const fired = presentation.lastFireTime !== undefined && presentation.lastFireTime !== motion.shotAt;
      if (fired) motion.shotAt = presentation.lastFireTime!;
      else if (presentation.lastFireTime === undefined && tower.cooldown > motion.cooldown + .0001) motion.shotAt = gs.time;
      let nearest: Enemy | undefined;
      let distance = Infinity;
      const aimTarget = tower.targetUid ? enemiesByUid.get(tower.targetUid) : undefined;
      if (!(aimTarget && aimTarget.hp > 0) && !Number.isFinite(tower.aimAngle)) {
        for (const enemy of gs.enemies) {
          const d = Math.hypot(enemy.pos.x - tower.worldX, enemy.pos.y - tower.worldY);
          if (enemy.hp > 0 && d < distance) { distance = d; nearest = enemy; }
        }
      }
      const fallback = nearest ? Math.atan2(nearest.pos.y - tower.worldY, nearest.pos.x - tower.worldX) + Math.PI / 2 : motion.angle;
      const desired = towerVisualAim(tower, enemiesByUid, fallback);
      motion.angle = paperRenderedAngle(motion.angle, desired, gs.time - motion.time, fired ? presentation.aimAngle : undefined);
      motion.time = gs.time;
      motion.cooldown = tower.cooldown;
      towerMotion.current.set(tower.uid, motion);
      const shotAge = gs.time - (presentation.lastFireTime ?? motion.shotAt);
      renderedTowers.set(tower.uid, { angle: motion.angle, shotAge });
      drawTowerCanvas(ctx, tower, tower.uid === selectedTowerId, 1, skinColorsRef.current[fam], {
        angle: motion.angle,
        shotAge,
        reducedMotion: reducedMotionRef.current,
      });
    }

    // Enemies
    paperWalkClockRef.current.sync(gs);
    const paperEnemyFrame = createPaperEnemyFrame();
    const healthAnchors = new Map<string, ReturnType<typeof enemyHealthAnchor>>();
    const targetedEnemyUids = new Set(gs.towers.map(tower => tower.targetUid).filter(Boolean));
    for (const uid of enemyMotion.current.keys()) if (!gs.enemies.some(e => e.uid === uid)) enemyMotion.current.delete(uid);
    for (const enemy of gs.enemies) {
      const motion = enemyMotion.current.get(enemy.uid) ?? { x: enemy.pos.x, y: enemy.pos.y, heading: 0, movedAt: -100 };
      if (Math.hypot(enemy.pos.x - motion.x, enemy.pos.y - motion.y) > .001) {
        motion.heading = Math.atan2(enemy.pos.y - motion.y, enemy.pos.x - motion.x); motion.movedAt = gs.time;
      }
      motion.x = enemy.pos.x; motion.y = enemy.pos.y; enemyMotion.current.set(enemy.uid, motion);
      const walkPhase = paperWalkClockRef.current.phase(enemy);
      drawEnemyCanvas(ctx, enemy, gs.time, motion.heading, gs.time - motion.movedAt < .1, gs.gluePatches, paperEnemyFrame, reducedMotionRef.current, walkPhase);
      const statuses = enemyVisualStatuses(enemy, gs.time, gs.gluePatches);
      if (enemyHealthPresentation(enemy.hp, enemy.maxHp, enemy.id === 'boss', targetedEnemyUids.has(enemy.uid)
        || (enemy.hitFlash ?? 0) > 0 || statuses.slowed || statuses.stunned || statuses.teleporting).visible) {
        healthAnchors.set(enemy.uid, enemyHealthAnchor(getPaperEnemyVisibleBounds(enemy, gs.time, motion.heading,
          gs.time - motion.movedAt < .1 && !statuses.stunned, ENGINE_CELL_PX, paperEnemyFrame, reducedMotionRef.current, walkPhase), {
          x: enemy.pos.x, y: enemy.pos.y - (ENEMIES[enemy.id].flying ? 5 : 0),
          radius: ENGINE_CELL_PX * (enemy.id === 'boss' ? .8 : .45),
        }));
      }
    }

    // Health is a separate pass: later actors cannot cover an earlier indicator.
    const healthLayout = layoutHealthArcs(gs.enemies.filter(enemy => healthAnchors.has(enemy.uid)).map(enemy => ({
      uid: enemy.uid, ...healthAnchors.get(enemy.uid)!, stroke: enemy.id === 'boss' ? 1.5 : 1,
      bodyPoint: { x: healthAnchors.get(enemy.uid)!.x, y: healthAnchors.get(enemy.uid)!.y },
      boss: enemy.id === 'boss', targeted: targetedEnemyUids.has(enemy.uid),
    })), { x: 0, y: 0, width: gs.gridW * ENGINE_CELL_PX, height: gs.gridH * ENGINE_CELL_PX },
    cp / ENGINE_CELL_PX, gs.time, ENGINE_CELL_PX, healthArcLayoutRef.current);
    healthArcLayoutRef.current = healthLayout.state;
    ctx.save();
    ctx.strokeStyle = '#73766d';
    ctx.fillStyle = '#73766d';
    ctx.lineWidth = 1 / scale;
    for (const placement of healthLayout.placements.values()) {
      if (!placement.leader) continue;
      ctx.beginPath();
      ctx.moveTo(placement.leader.from.x, placement.leader.from.y);
      ctx.lineTo(placement.leader.to.x, placement.leader.to.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(placement.leader.from.x, placement.leader.from.y, 1.25 / scale, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    for (const enemy of gs.enemies) {
      const statuses = enemyVisualStatuses(enemy, gs.time, gs.gluePatches);
      const health = enemyHealthPresentation(enemy.hp, enemy.maxHp, enemy.id === 'boss',
        targetedEnemyUids.has(enemy.uid) || (enemy.hitFlash ?? 0) > 0 || statuses.slowed || statuses.stunned || statuses.teleporting);
      if (!health.visible) continue;
      const arc = enemyHealthArc(health.ratio);
      if (!arc) continue;
      ctx.save();
      ctx.lineCap = 'butt';
      const anchor = healthAnchors.get(enemy.uid)!;
      const placement = healthLayout.placements.get(enemy.uid);
      const dx = placement?.dx ?? 0, dy = placement?.dy ?? 0;
      ctx.strokeStyle = 'rgba(89,89,89,0.25)';
      ctx.lineWidth = .75;
      ctx.beginPath();
      ctx.arc(anchor.x + dx, anchor.y + dy, anchor.radius, arc.start, arc.end);
      ctx.stroke();
      ctx.strokeStyle = '#8a4a4a';
      ctx.lineWidth = enemy.id === 'boss' ? 1.5 : 1;
      if (health.ratio > 0) {
        ctx.beginPath();
        ctx.arc(anchor.x + dx, anchor.y + dy, anchor.radius, arc.start, arc.fillEnd);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Projectiles
    const liveEmissions = new Set([...gs.projectiles.map(p => p.uid), ...gs.effects.map(e => e.uid)]);
    prunePaperOrigins(projectileOrigins.current, liveEmissions);
    for (const uid of emissionSockets.current.keys()) if (!liveEmissions.has(uid)) emissionSockets.current.delete(uid);
    const socketFor = (uid: string, sourceUid: string | undefined, towerId: TowerId | undefined, sourceSocket?: number): Vec2 | null => {
      const tower = sourceUid ? towersByUid.get(sourceUid) : undefined;
      const rendered = sourceUid ? renderedTowers.get(sourceUid) : undefined;
      if (!tower || !rendered) return null;
      let socketName = emissionSockets.current.get(uid);
      if (!socketName) {
        const sequence = sourceSocket ?? emissionSequence.current.get(tower.uid) ?? 0;
        socketName = paperSocketName(towerId ?? tower.towerId, sequence);
        emissionSockets.current.set(uid, socketName);
        if (sourceSocket === undefined) emissionSequence.current.set(tower.uid, sequence + 1);
      }
      return getPaperTowerSocket(tower, rendered.angle, rendered.shotAge, ENGINE_CELL_PX, socketName);
    };
    const shotsByUid = new Map(gs.shots.map(shot => [shot.uid, shot]));
    for (const p of gs.projectiles) {
      const from = projectileOrigins.current.get(p.uid) ?? freezePaperOrigin(projectileOrigins.current, p.uid, p.from,
        socketFor(p.uid, p.sourceTowerUid, p.towerId, p.sourceSocket));
      const { x, y, angle: ang, alpha } = projectileRenderPose(p, from,
        p.authoritativeUid !== undefined ? shotsByUid.get(p.authoritativeUid) : undefined);
      ctx.save();
      ctx.globalAlpha = alpha;

      if (drawPaperProjectile(ctx, p.towerId, x, y, ang, p.progress)) {
        ctx.restore();
        continue;
      }

      if (p.kind === 'bullet') {
        const tid = p.towerId;
        if (tid === 'machineGun') {
          // Маленькая быстрая пуля — тонкая черта-трассер
          ctx.strokeStyle = '#2b2b2b';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x - Math.cos(ang) * 4, y - Math.sin(ang) * 4);
          ctx.lineTo(x + Math.cos(ang) * 2, y + Math.sin(ang) * 2);
          ctx.stroke();
          // Точка
          ctx.fillStyle = '#595959';
          ctx.beginPath();
          ctx.arc(x, y, 1.2, 0, Math.PI * 2);
          ctx.fill();
        } else if (tid === 'mortar') {
          // Тёмный кружок-бомба (баллистическая дуга через progress)
          const arc = Math.sin(p.progress * Math.PI) * 5; // вертикальный подъём
          ctx.fillStyle = '#1a1a1a';
          ctx.strokeStyle = '#595959';
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.arc(x, y - arc, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          // Тень на земле
          ctx.fillStyle = `rgba(43,43,43,${0.18 * (1 - arc / 5)})`;
          ctx.beginPath();
          ctx.ellipse(x, y, 3, 1.2, 0, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // canon/dualCanon: короткая черта + точка
          ctx.strokeStyle = '#2b2b2b';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x - Math.cos(ang) * 5, y - Math.sin(ang) * 5);
          ctx.lineTo(x + Math.cos(ang) * 2, y + Math.sin(ang) * 2);
          ctx.stroke();
          ctx.fillStyle = '#1a1a1a';
          ctx.beginPath();
          ctx.arc(x, y, 2, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (p.kind === 'rocket') {
        // Ракета: вытянутый силуэт с поворотом
        ctx.translate(x, y);
        ctx.rotate(ang);
        // Корпус
        ctx.fillStyle = '#2b2b2b';
        ctx.strokeStyle = '#595959';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.ellipse(0, 0, 7, 3, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // Нос
        ctx.fillStyle = '#8a4a4a';
        ctx.beginPath();
        ctx.moveTo(7, 0);
        ctx.lineTo(5, -2);
        ctx.lineTo(5, 2);
        ctx.closePath();
        ctx.fill();
        // Хвост-финн
        ctx.fillStyle = '#595959';
        ctx.beginPath();
        ctx.moveTo(-7, 0);
        ctx.lineTo(-10, -3);
        ctx.lineTo(-10, 3);
        ctx.closePath();
        ctx.fill();
        // Трейл частицы (рисуем небольшую вспышку)
        ctx.fillStyle = `rgba(165,138,74,0.5)`;
        ctx.beginPath();
        ctx.ellipse(-9, 0, 4, 1.5, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'mine') {
        ctx.fillStyle = '#595959'; ctx.strokeStyle = '#2b2b2b'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(x, y, 5, 3, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#a58a4a'; ctx.fillRect(x - 1, y - 2, 2, 2);
      } else if (p.kind === 'glue') {
        // Капля клей — мягкий зелёный кружок
        ctx.fillStyle = 'rgba(74,106,90,0.85)';
        ctx.strokeStyle = '#4a6a5a';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // Капля-хвостик
        ctx.fillStyle = 'rgba(74,106,90,0.5)';
        ctx.beginPath();
        ctx.arc(x - Math.cos(ang) * 4, y - Math.sin(ang) * 4, 2, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }

    // Effects
    const laserPresentation = drawPaperLaserEffects(ctx, gs.effects, enemiesByUid, e => e.pts?.[0]
      ? freezePaperOrigin(projectileOrigins.current, e.uid, e.pts[0], socketFor(e.uid, e.sourceTowerUid, e.towerId)) : null,
      { x: 0, y: 0, width: gs.gridW * ENGINE_CELL_PX, height: gs.gridH * ENGINE_CELL_PX }, reducedMotionRef.current, laserOriginalPoints.current);
    for (const e of gs.effects) {
      if (laserPresentation.handled.has(e.uid) || laserPresentation.suppressed.has(e.uid)) continue;
      if (isGroundEffect(e, groundEffectIds)) continue;
      if (PAPER_BEAMS[e.kind]) {
        const origin = e.pts?.[0] ? freezePaperOrigin(projectileOrigins.current, e.uid, e.pts[0], socketFor(e.uid, e.sourceTowerUid, e.towerId)) : null;
        drawEffect(ctx, { ...e, pts: followPaperBeamPoints(e, enemiesByUid, origin) },
          { x: 0, y: 0, width: gs.gridW * ENGINE_CELL_PX, height: gs.gridH * ENGINE_CELL_PX });
      } else {
        drawEffect(ctx, e.towerId ? e : { ...e, towerId: e.sourceTowerUid ? towersByUid.get(e.sourceTowerUid)?.towerId : undefined });
      }
    }

    for (const tower of gs.towers) {
      const rendered = renderedTowers.get(tower.uid);
      if (!rendered || rendered.shotAge < 0 || rendered.shotAge >= .08) continue;
      const explicitShot = gs.shots.find(shot => shot.sourceTowerUid === tower.uid && Math.abs(shot.launchedAt - (tower.lastFireTime ?? -100)) < 1e-6);
      const sequence = explicitShot?.sourceSocket ?? (tower.towerId === 'dualCanon' && tower.nextBarrel !== undefined
        ? 1 - tower.nextBarrel : Math.max(0, (emissionSequence.current.get(tower.uid) ?? 1) - 1));
      const muzzle = getPaperTowerSocket(tower, rendered.angle, rendered.shotAge, ENGINE_CELL_PX,
        paperSocketName(tower.towerId, sequence));
      if (!muzzle) continue;
      const id = TOWER_FAMILY[tower.towerId] === 'canon' ? 'muzzle_small'
        : TOWER_FAMILY[tower.towerId] === 'mortar' ? 'muzzle_heavy' : undefined;
      if (id) drawPaperFxSprite(ctx, id, muzzle.x, muzzle.y, ENGINE_CELL_PX * .35,
        rendered.angle, 1 - rendered.shotAge / .08);
    }

    // Particles
    for (const p of gs.particles as Particle[]) {
      const alpha = p.life / p.maxLife;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Life-flash: red border overlay
    if (gs.waveActive && gs.lifeFlashUntil > gs.time) {
      const flashAlpha = Math.min(1, (gs.lifeFlashUntil - gs.time) / 0.35) * 0.35;
      ctx.strokeStyle = `rgba(138,74,74,${flashAlpha})`;
      ctx.lineWidth = 8;
      ctx.strokeRect(4, 4, gs.gridW * ENGINE_CELL_PX - 8, gs.gridH * ENGINE_CELL_PX - 8);
    }

    ctx.restore(); // undo engine-space scale
    if (import.meta.env.DEV && snapshotCallbackRef.current) snapshotCallbackRef.current(Object.freeze({
      time: gs.time, paused: gs.paused, towers: gs.towers.length, enemies: gs.enemies.length,
      projectiles: gs.projectiles.length, effects: gs.effects.length, shots: gs.shots.length, mines: gs.mines.length,
      glueShots: gs.glueShots.length, gluePatches: gs.gluePatches.length,
      canvasWidth: GRID_W * cp, canvasHeight: GRID_H * cp,
      paperStatus: paperStatusRef.current,
    }));
  }, [hoverCell, selectedTowerId, selTowerId]);

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    const observer = new ResizeObserver(([entry]) => {
      setCellPx(Math.max(1, Math.min(entry.contentRect.width / GRID_W, entry.contentRect.height / GRID_H)));
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = GRID_W * cellPx;
    const ch = GRID_H * cellPx;
    c.width = cw * dpr;
    c.height = ch * dpr;
    c.style.width = cw + 'px';
    c.style.height = ch + 'px';
    cellPxRef.current = cellPx;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, [cellPx]);

  // Apply current soundEnabled on mount; clear game audio across screen lifetimes.
  useEffect(() => {
    stopGameAudio();
    setMuted(!_appState.soundEnabled);
    return () => {
      stopGameAudio();
      ambientStartedRef.current = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function settleCurrentRun() {
    if (isFixture || rewardedRef.current) return true;
    const gs = gsRef.current;
    if (!saveCheckpoint()) return false;
    const summary = { completedWaves: gs.completedWaves, victory: gs.victory,
      uniqueTowerTypes: placedTowerTypesRef.current.size, speed: speedRef.current };
    const cleared = [...gs.clearedWaveIndices];
    const leaked = [...gs.leakedWaveIndices];
    const now = Date.now();
    let accepted: boolean | undefined;
    try {
      const persisted = callbacksRef.current.setState(s => {
        const next = settleRun(s, run, { ...summary,
          noLeakWave: cleanCompletedSince(cleared, leaked, s.runLedger[run.id]?.completedWaves ?? 0) }, now);
        const entry = next.runLedger[run.id];
        accepted = !!entry?.settled && !entry.continuationAuthorized && entry.completedWaves >= summary.completedWaves;
        return next;
      });
      if (persisted === false || accepted === false) { failPersistence(); return false; }
      rewardedRef.current = true;
      setRenderTick(value => value + 1);
      callbacksRef.current.onSettled?.();
      return true;
    } catch { failPersistence(); return false; }
  }

  function syncTiming() {
    const snapshot = timing.snapshot();
    activeSecondsRef.current = snapshot.activeSeconds;
    planningSecondsRef.current = snapshot.planningSeconds;
    clockStartedRef.current = snapshot.clockStarted;
    speedRef.current = snapshot.speed;
    gsRef.current.speed = snapshot.speed;
  }

  function failPersistence() {
    gsRef.current.paused = true;
    lastTimeRef.current = null;
    haltGameAudio();
    persistenceErrorRef.current = true;
    setPersistenceError(true);
    setRenderTick(value => value + 1);
    callbacksRef.current.onPersistenceError?.();
  }

  function saveCheckpoint() {
    if (isFixture || !callbacksRef.current.onCheckpoint) return true;
    try {
      reconcileContinuation(callbacksRef.current.state);
      if (rewardedRef.current && (gsRef.current.gameOver || gsRef.current.victory)) return true;
      syncTiming();
      const saved = callbacksRef.current.onCheckpoint(createRunCheckpoint({ runId: run.id, battle: gsRef.current,
        activeSeconds: activeSecondsRef.current, planningSeconds: planningSecondsRef.current,
        clockStarted: clockStartedRef.current, speed: speedRef.current,
        backlogSeconds: timing.snapshot().backlogSeconds ?? 0,
        placedTowerTypes: [...placedTowerTypesRef.current] }));
      if (!saved) { failPersistence(); return false; }
      checkpointAtRef.current = clockStartedRef.current ? activeSecondsRef.current : gsRef.current.time;
      return true;
    } catch { failPersistence(); return false; }
  }

  function retrySaving() {
    const retry = callbacksRef.current.onRetryPersistence;
    if (retry) {
      let authoritative: GameState | false;
      try { authoritative = retry(); }
      catch { failPersistence(); return; }
      if (authoritative === false) return;
      reconcileContinuation(authoritative);
      const entry = authoritative.runLedger[run.id];
      if (entry?.abandoned) return;
      if ((gsRef.current.gameOver || gsRef.current.victory) && entry?.settled && !entry.continuationAuthorized
        && entry.completedWaves >= gsRef.current.completedWaves) rewardedRef.current = true;
    }
    if (!saveCheckpoint()) return;
    if ((gsRef.current.gameOver || gsRef.current.victory) && !settleCurrentRun()) return;
    persistenceErrorRef.current = false;
    setPersistenceError(false);
    setRenderTick(value => value + 1);
  }

  function reconcileContinuation(authoritative: GameState) {
    const entry = authoritative?.runLedger?.[run.id], checkpoint = authoritative?.battleCheckpoint;
    if (!gsRef.current.gameOver || !entry?.continuationAuthorized || authoritative.activeRun?.id !== run.id
      || !checkpoint || checkpoint.battle.gameOver) return;
    const restored = restoreRunCheckpoint(checkpoint, run);
    gsRef.current = restored.battle;
    placedTowerTypesRef.current = new Set(restored.placedTowerTypes);
    rewardedRef.current = false;
    resultSoundSeenRef.current = false;
    lastTimeRef.current = null;
    setRenderTick(value => value + 1);
  }

  useEffect(() => {
    if ((gsRef.current.gameOver || gsRef.current.victory) && !rewardedRef.current) {
      if (!persistenceErrorRef.current) settleCurrentRun();
    }
  });

  useEffect(() => {
    const onVisibility = () => {
      lastTimeRef.current = null;
      if (timing.snapshot().hidden !== document.hidden) timing.command({ type: 'visibility', hidden: document.hidden });
      if (document.hidden) { haltGameAudio(); saveCheckpoint(); }
      setRenderTick(t => t + 1);
    };
    const onPageHide = () => { gsRef.current.paused = true; lastTimeRef.current = null; haltGameAudio(); saveCheckpoint(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    if (document.hidden) onVisibility();
    return () => { document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('pagehide', onPageHide); };
  }, [timing]);

  useEffect(() => {
    if (!suspended) {
      if (exitRequestedRef.current && !exitRequestedRef.current.wasPaused && !persistenceErrorRef.current
        && !gsRef.current.gameOver && !gsRef.current.victory && !document.hidden) {
        timing.command({ type: 'resume' });
        lastTimeRef.current = null;
        tryStartAmbient();
        setRenderTick(value => value + 1);
      }
      exitRequestedRef.current = null;
      return;
    }
    gsRef.current.paused = true;
    lastTimeRef.current = null;
    haltGameAudio();
    saveCheckpoint();
    setRenderTick(value => value + 1);
  }, [suspended]);

  useEffect(() => {
    const wasBlocked = persistenceWasBlockedRef.current;
    persistenceWasBlockedRef.current = persistenceBlocked;
    if (persistenceBlocked && !persistenceErrorRef.current) failPersistence();
    else if (!persistenceBlocked && wasBlocked && persistenceErrorRef.current) retrySaving();
  }, [persistenceBlocked]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 2400);
    return () => clearTimeout(timer);
  }, [toast]);

  const drawRef = useRef(draw);
  drawRef.current = draw;
  const loopRunning = !gsRef.current.paused && !gsRef.current.gameOver && !gsRef.current.victory
    && !suspended && !persistenceBlocked && !persistenceError && !document.hidden;

  useEffect(() => { draw(); }, [draw, paperStatus, cellPx, motionRevision, _appState.skinsEnabled, _appState.equippedSkins]);

  useEffect(() => {
    if (!loopRunning) { drawRef.current(); return; }
    const loop = (now: number) => {
      if (lastTimeRef.current === null) lastTimeRef.current = now;
      const wallDt = Math.max(0, (now - lastTimeRef.current) / 1000);
      const gs = gsRef.current;
      lastTimeRef.current = now;
      const processed = timing.frame(wallDt);
      syncTiming();
      if (processed.ticks > 0) {
        hadLeakRef.current = hadLeakRef.current || gs.leakedWaveIndices.length > 0;
        const checkpointClock = clockStartedRef.current ? activeSecondsRef.current : gs.time;
        if (checkpointClock - checkpointAtRef.current >= 1 && !gs.gameOver && !gs.victory) saveCheckpoint();
        setRenderTick(t => t + 1);
      }

      const terminal = gs.victory ? 'victory' : gs.gameOver ? 'defeat' : null;
      if (terminal && ambientStartedRef.current) haltAmbient();
      const audio = planGameAudio(gs.soundQueue, terminal, resultSoundSeenRef.current, isMuted() || document.hidden || gs.paused);
      gs.soundQueue.length = 0;
      resultSoundSeenRef.current = audio.resultSeen;
      for (const tag of audio.tags) playSfx(tag);

      drawRef.current();
      if (!gs.paused && !gs.gameOver && !gs.victory && !document.hidden && !persistenceErrorRef.current) {
        rafRef.current = requestAnimationFrame(loop);
      }
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [timing, loopRunning]);

  // ── Interaction ───────────────────────────────────────────────────────
  function canvasCell(e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>): Vec2 {
    const rect = canvasRef.current!.getBoundingClientRect();
    let cx: number, cy: number;
    if ('touches' in e) {
      cx = e.touches[0].clientX; cy = e.touches[0].clientY;
    } else {
      cx = (e as React.MouseEvent).clientX; cy = (e as React.MouseEvent).clientY;
    }
    // Map CSS pixel → engine cell: divide by cellPx (CSS pixels per cell)
    const cp = cellPxRef.current;
    const x = Math.floor((cx - rect.left) / cp);
    const y = Math.floor((cy - rect.top) / cp);
    return { x: Math.max(0, Math.min(gsRef.current.gridW - 1, x)), y: Math.max(0, Math.min(gsRef.current.gridH - 1, y)) };
  }

  function haltAmbient() {
    stopAmbient();
    ambientStartedRef.current = false;
  }

  function haltGameAudio() {
    stopGameAudio();
    ambientStartedRef.current = false;
  }

  function handleExit() {
    haltGameAudio();
    if (gsRef.current.gameOver || gsRef.current.victory) {
      if (settleCurrentRun()) onExit();
      return;
    }
    exitRequestedRef.current = { wasPaused: gsRef.current.paused };
    gsRef.current.paused = true;
    lastTimeRef.current = null;
    if (saveCheckpoint()) onExit();
    setRenderTick(value => value + 1);
  }

  function tryStartAmbient() {
    const gs = gsRef.current;
    if (!canPlayGameAmbient(_appState.soundEnabled ?? true, gs.paused, document.hidden, gs.gameOver || gs.victory) || isMuted()) return;
    initAudio();
    if (!ambientStartedRef.current) {
      ambientStartedRef.current = true;
      startAmbient();
    }
  }

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    tryStartAmbient();
    const gs = gsRef.current;
    if (gs.gameOver || gs.victory || gs.paused || suspended || persistenceErrorRef.current) return;
    const cell = canvasCell(e);
    const world = cellToWorld(cell);

    // Hit test existing tower (within cell center radius)
    const hit = gs.towers.find(t =>
      Math.abs(t.cell.x - cell.x) < 1 && Math.abs(t.cell.y - cell.y) < 1
    );
    if (hit) {
      setSelectedTowerId(prev => prev === hit.uid ? null : hit.uid);
      return;
    }
    if (selectedTowerId) {
      setSelectedTowerId(null);
      return;
    }

    // Place tower
    const ok = placeTower(gs, selTowerId, cell);
    if (ok) {
      // Track unique base tower types placed this run (for use_4 challenge)
      placedTowerTypesRef.current.add(selTowerId);
      saveCheckpoint();
    } else setToast(gs.gold < TOWERS[selTowerId].cost ? 'Funds needed' : gs.grid[cell.y]?.[cell.x] ? 'Cell occupied' : 'Keep route open');
    setRenderTick(t => t + 1);
    void world; // suppress unused warning
  }

  function handleMove(e: React.MouseEvent<HTMLCanvasElement>) {
    setHoverCell(canvasCell(e));
  }

  function handleSpeedCycle() {
    if (run.config.access === 'ranked' || gsRef.current.paused || gsRef.current.gameOver || gsRef.current.victory || document.hidden || suspended) return;
    timing.command({ type: 'speedCycle' });
    syncTiming();
    const next = speedRef.current;
    setSpeed(next);
    saveCheckpoint();
  }

  function handlePause() {
    const gs = gsRef.current;
    if (persistenceErrorRef.current || persistenceBlocked || suspended || document.hidden || gs.gameOver || gs.victory) return;
    timing.command({ type: gs.paused ? 'resume' : 'pause' });
    if (gs.paused) haltGameAudio();
    else tryStartAmbient();
    lastTimeRef.current = null;
    saveCheckpoint();
    setRenderTick(t => t + 1);
  }

  function handleStartWave() {
    const gs = gsRef.current;
    if (nextWaveBlockReason(run.config.mode, gs.waveIndex + 1, run.config.waveLimit, activeSecondsRef.current, run.config.durationMinutes * 60, gs.paused, gs.gameOver || gs.victory, document.hidden, canStartNextWave(gs), getNextWaveWait(gs))) return;
    tryStartAmbient();
    const previousWave = gs.waveIndex;
    timing.command({ type: 'startWave' });
    if (gs.waveIndex === previousWave) return;
    syncTiming();
    lastTimeRef.current = null;
    saveCheckpoint();
    setRenderTick(t => t + 1);
  }

  function handleEnhance() {
    if (!selectedTowerId || gsRef.current.paused || gsRef.current.gameOver || gsRef.current.victory || suspended || document.hidden) return;
    tryStartAmbient();
    if (enhanceTower(gsRef.current, selectedTowerId)) { saveCheckpoint(); setRenderTick(t => t + 1); }
  }

  function handlePromote() {
    if (!selectedTowerId || gsRef.current.paused || gsRef.current.gameOver || gsRef.current.victory || suspended || document.hidden) return;
    tryStartAmbient();
    if (promoteTower(gsRef.current, selectedTowerId)) { saveCheckpoint(); setRenderTick(t => t + 1); }
  }

  function handleSell() {
    if (!selectedTowerId || gsRef.current.paused || gsRef.current.gameOver || gsRef.current.victory || suspended || document.hidden) return;
    tryStartAmbient();
    sellTower(gsRef.current, selectedTowerId);
    saveCheckpoint();
    setSelectedTowerId(null);
    setRenderTick(t => t + 1);
  }

  function handleToggleSound() {
    const newEnabled = !_appState.soundEnabled;
    if (_setAppState((s: GameState) => ({ ...s, soundEnabled: newEnabled })) === false) { failPersistence(); return; }
    haltAmbient();
    setMuted(!newEnabled);
    if (newEnabled) {
      initAudio();
      const gs = gsRef.current;
      if (canPlayGameAmbient(true, gs.paused, document.hidden, gs.gameOver || gs.victory)) {
        startAmbient(); ambientStartedRef.current = true;
      }
    }
  }

  function handleCycleTarget() {
    if (!selectedTowerId || gsRef.current.paused || gsRef.current.gameOver || gsRef.current.victory || suspended || document.hidden) return;
    const tw = gsRef.current.towers.find(t => t.uid === selectedTowerId);
    if (!tw || !towerHasAimer(tw.towerId)) return;
    const i = TARGET_MODES.indexOf(tw.targetingMode);
    setTargeting(gsRef.current, selectedTowerId, TARGET_MODES[(i + 1) % TARGET_MODES.length]);
    saveCheckpoint();
    setRenderTick(t => t + 1);
  }

  function handleToggleLock() {
    const state = gsRef.current;
    if (!selectedTowerId || state.paused || state.gameOver || state.victory || document.hidden) return;
    const tower = state.towers.find(t => t.uid === selectedTowerId);
    if (!tower || !towerHasAimer(tower.towerId)) return;
    setTargetLock(state, tower.uid, tower.targetLock === false);
    saveCheckpoint();
    setRenderTick(t => t + 1);
  }

  const gs = gsRef.current;
  const selTowerInspect = selectedTowerId ? gs.towers.find(t => t.uid === selectedTowerId) : null;
  const waveNum = Math.max(0, gs.waveIndex + 1);
  const nextWait = getNextWaveWait(gs);
  const continueCost = continuePrice(_appState, run);
  const continuesUsed = continuedCount(_appState, run);
  const continueAllowed = run.config.access === 'practice' || (run.config.access === 'standard' && continuesUsed < 1);
  const nextBlocked = nextWaveBlockReason(run.config.mode, waveNum, run.config.waveLimit, activeSecondsRef.current, run.config.durationMinutes * 60, gs.paused, gs.gameOver || gs.victory, document.hidden, canStartNextWave(gs), nextWait);
  // suppress renderTick lint warning — it's purely to trigger re-renders
  void renderTick;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <GameHUD
        gold={gs.gold} lives={gs.lives}
        wave={waveNum}
        waveActive={gs.waveActive}
        nextBlocked={nextBlocked} nextWait={nextWait} earlyBonus={getEarlyWaveBonus(gs)}
        onExit={handleExit} onStart={handleStartWave}
        gameOver={gs.gameOver} victory={gs.victory}
        speed={speed} onSpeedCycle={handleSpeedCycle} speedLocked={run.config.access === 'ranked'}
        paused={gs.paused} onPause={handlePause}
        isBossWave={gs.isBossWave}
        soundEnabled={_appState.soundEnabled ?? true}
        onToggleSound={handleToggleSound}
      />

      <div role="status" style={{ flexShrink: 0, padding: '4px 8px', fontSize: 12, background: '#e8e8e3' }}>
        {isFixture ? `DEV ONLY · paper ${paperStatus === 'ready' ? 'ready' : paperStatus === 'loading' ? 'loading' : 'fallback'}` : run.config.access === 'practice' ? 'Practice · no rewards or scores' : run.config.access === 'ranked' ? 'Ranked · LOCAL ONLY · prizes unverified' : 'Standard · local results'}
        {' · '}{run.config.mode === 'timed'
          ? `${Math.ceil(Math.max(0, run.config.durationMinutes * 60 - activeSecondsRef.current))}s left${gs.paused ? ' · Paused' : !clockStartedRef.current ? ' · start wave to begin' : !gs.waveActive && !gs.victory && !gs.gameOver ? ` · next wave in ${autoWaveWait(planningSecondsRef.current, nextWait)}s` : ''}`
          : run.config.mode === 'waves' ? `${gs.completedWaves}/${run.config.waveLimit} cleared` : `${gs.completedWaves} cleared · Endless`}
      </div>
      <PaperAssetStatus status={paperStatus} />
      <div ref={fieldRef} style={{ position: 'relative', flex: 1, minHeight: 0, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <canvas
          ref={canvasRef}
          onClick={handleClick}
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverCell(null)}
          style={{ background: '#f6f5f0', cursor: 'crosshair', display: 'block', touchAction: 'none' }}
        />


        {gs.paused && !gs.gameOver && !gs.victory && (
          <div style={{
            position: 'absolute', inset: 0, background: 'rgba(246,245,240,0.72)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column',
            gap: 12,
          }}>
            <div className="mono" style={{ fontSize: 28, fontWeight: 700, letterSpacing: '0.12em', color: '#1a1a1a' }}>PAUSED</div>
            <button className="btn small primary" disabled={persistenceError || persistenceBlocked || suspended} onClick={handlePause} style={{ padding: '8px 24px', minHeight: 48, minWidth: 48 }}>Resume</button>
          </div>
        )}

        {(gs.gameOver || gs.victory) && (
          <div style={{
            position: 'absolute', inset: 0, background: 'rgba(246,245,240,0.94)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column',
            border: '1.5px solid #2b2b2b',
          }}>
            <div className="serif" style={{ fontSize: 42, fontWeight: 500 }}>{gs.victory ? 'Victory' : 'Defeat'}</div>
            <div className="hand" style={{ fontSize: 24, color: '#595959', marginTop: 4 }}>
              {gs.completedWaves} waves cleared
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center' }}>
              <TokenBadge size={18} />
              <span className="mono" style={{ fontWeight: 700 }}>
                {run.config.access === 'practice' ? 'Practice · no rewards' : `${gs.completedWaves * STD_PER_WAVE} STD total · ${rewardedRef.current ? 'saved' : 'saving'}`}
              </span>
            </div>
            {/* E: Continue / Restart / Home */}
            <div style={{ display: 'flex', gap: 8, marginTop: 18, flexWrap: 'wrap', justifyContent: 'center', padding: '0 12px' }}>
              {!gs.victory && continueAllowed && <button
                className="btn small"
                style={{ minHeight: 48, minWidth: 48 }}
                disabled={persistenceError || suspended || !rewardedRef.current || (run.config.access === 'standard' && _appState.tokens < continueCost)}
                onClick={() => {
                  if (!gsRef.current.gameOver || persistenceErrorRef.current || !rewardedRef.current || suspended
                    || (run.config.access === 'standard' && _appState.tokens < continueCost)) return;
                  if (!onContinue()) return;
                  gsRef.current.lives = 10;
                  gsRef.current.gameOver = false;
                  gsRef.current.paused = false;
                  resultSoundSeenRef.current = false;
                  tryStartAmbient();
                  rewardedRef.current = false;
                  lastTimeRef.current = null;
                  saveCheckpoint();
                  setRenderTick(t => t + 1);
                }}
              >
                {run.config.access === 'practice' ? 'Continue free' : `Continue (${continueCost} STD)`}
              </button>}
              {!gs.victory && continueAllowed && run.config.access === 'standard' && _appState.tokens < continueCost && onTopUp && <button
                className="btn small" disabled={persistenceError || !rewardedRef.current || suspended}
                style={{ minHeight: 48, minWidth: 48 }} onClick={() => { haltGameAudio(); onTopUp(); }}>Top up STD</button>}
              <button
                className="btn small"
                style={{ minHeight: 48, minWidth: 48 }}
                onClick={() => {
                  if (settleCurrentRun()) onRestart();
                }}
              >
                Restart
              </button>
              <button className="btn small" style={{ minHeight: 48, minWidth: 48 }} onClick={handleExit}>Home</button>
            </div>
            {!gs.victory && <div className="mono" style={{ fontSize: 12, marginTop: 8 }}>
              {run.config.access === 'ranked' ? 'Ranked · no Continue' : run.config.access === 'practice' ? 'Practice · unlimited Continues'
                : `Continues ${continuesUsed}/1 · restores 10 lives`}
            </div>}
          </div>
        )}
        {toast && <div role="status" style={{ position: 'absolute', top: 8, padding: '8px 12px', background: '#e8e8e3', color: '#1a1a1a', fontSize: 12, pointerEvents: 'none' }}>{toast}</div>}
        {persistenceError && <div role="alertdialog" aria-modal="true" aria-label="Saving failed" style={{ position: 'absolute', inset: 0, background: 'rgba(246,245,240,0.96)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 16 }}>Saving failed. Battle paused.</div>
          <button className="btn small primary" style={{ minHeight: 48, minWidth: 48 }} onClick={retrySaving}>Try saving again</button>
        </div>}
      </div>

      <div style={{ height: CONTROL_DOCK_HEIGHT, minHeight: CONTROL_DOCK_HEIGHT, flexShrink: 0, width: '100%', boxSizing: 'border-box', background: '#f6f5f0' }}>
      {selTowerInspect && !gs.gameOver && !gs.victory && !gs.paused
        ? <TowerInspector tower={selTowerInspect} gold={gs.gold} lockBlocked={gs.paused ? 'Resume game to change target lock' : gs.gameOver || gs.victory ? 'Run has ended' : document.hidden ? 'Return to the game to change target lock' : ''} onEnhance={handleEnhance} onPromote={handlePromote} onSell={handleSell} onCycleTarget={handleCycleTarget} onToggleLock={handleToggleLock} onClose={() => setSelectedTowerId(null)} />
        : <div style={{ padding: 6 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
          {BASE_TOWER_ORDER.map(towerId => {
            const spec = TOWERS[towerId];
            const canAfford = gs.gold >= spec.cost;
            const isSelected = selTowerId === towerId;
            return (
              <button
                key={towerId}
                onClick={() => { setSelTowerId(towerId); setSelectedTowerId(null); }}
                style={{
                  padding: '4px', border: '1.3px solid #2b2b2b',
                  background: isSelected ? '#2b2b2b' : '#f6f5f0',
                  color: isSelected ? '#f6f5f0' : '#2b2b2b',
                  borderRadius: 0, height: 78, minHeight: 48, minWidth: 48, cursor: 'pointer', fontFamily: 'var(--sans)',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
                  opacity: canAfford ? 1 : 0.45,
                }}
              >
                <TowerIcon towerId={towerId} inverted={isSelected} skinColor={skinColorsRef.current[TOWER_FAMILY[towerId]]} />
                <span style={{ fontSize: 12, fontWeight: 600 }}>
                  {spec.name}
                </span>
                <span className="mono" style={{ fontSize: 11 }}>${spec.cost >= 1000 ? (spec.cost / 1000).toFixed(0) + 'k' : spec.cost}</span>
              </button>
            );
          })}
        </div>
        <div style={{ marginTop: 4, lineHeight: '14px', textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--charcoal)', letterSpacing: '0.02em' }}>
          Tap a tower to build · tap it on the field to upgrade
        </div>
      </div>}
      </div>
    </div>
  );
}

// ── Mini tower icon (SVG silhouettes matching canvas drawTowerSilhouette) ──
function TowerIcon({ towerId, inverted, skinColor }: { towerId: TowerId; inverted: boolean; skinColor?: string }) {
  const paperStatus = usePaperAssets();
  if (paperStatus === 'ready') return <PaperImage path={`towers/${towerId}/preview.png`} label={TOWERS[towerId].name} width={36} skinColor={skinColor} />;
  const ts = TOWER_SHAPES[towerId] ?? { shape: 'circle', color: '#595959' };
  const sz = 24;
  const cx = sz / 2, cy = sz / 2;
  // Map colors: inverted = selected (dark bg), cream body + dark accent; else normal
  const bodyFill = inverted ? '#f6f5f0' : ts.color;
  const accentFill = inverted ? '#c8c8c0' : (TOWER_ACCENT[towerId] ?? '#f6f5f0');
  const strokeC = inverted ? 'rgba(246,245,240,0.5)' : '#2b2b2b';
  const sw = 1.1;
  const r = 8.5;


  const bw = r * 0.38, bh = r * 0.7;   // barrel dims

  return (
    <svg width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`} style={{ display: 'block' }}>
      {towerId === 'canon' && <>
        <circle cx={cx} cy={cy} r={r} fill={bodyFill} stroke={strokeC} strokeWidth={sw} />
        <rect x={cx - bw / 2} y={cy - r - bh + r * 0.3} width={bw} height={bh} fill={accentFill} stroke={strokeC} strokeWidth={0.8} />
        <rect x={cx - bw / 2 - 1.5} y={cy - r - bh + r * 0.3 - 2} width={bw + 3} height={2.5} fill={accentFill} stroke={strokeC} strokeWidth={0.6} />
      </>}

      {towerId === 'simpleLaser' && <>
        <polygon points={`${cx},${cy - r} ${cx + r * 0.78},${cy} ${cx},${cy + r} ${cx - r * 0.78},${cy}`} fill={bodyFill} stroke={strokeC} strokeWidth={sw} />
        <circle cx={cx} cy={cy} r={r * 0.25} fill={accentFill} stroke={strokeC} strokeWidth={0.7} />
      </>}

      {towerId === 'mortar' && (() => {
        const bw2 = r * 1.1, tw2 = r * 0.7, h2 = r * 0.82;
        const baseY = cy + r * 0.25;
        const brl_w = r * 0.28, brl_h = r * 0.72;
        // rotate barrel tip coords manually (angle ~18deg)
        const angle = Math.PI / 10;
        const bx = cx + r * 0.18, by2 = baseY - h2 + r * 0.05;
        return <>
          <polygon
            points={`${cx - bw2 / 2},${baseY} ${cx + bw2 / 2},${baseY} ${cx + tw2 / 2},${baseY - h2} ${cx - tw2 / 2},${baseY - h2}`}
            fill={bodyFill} stroke={strokeC} strokeWidth={sw}
          />
          <g transform={`rotate(${angle * 180 / Math.PI} ${bx} ${by2})`}>
            <rect x={bx - brl_w / 2} y={by2 - brl_h} width={brl_w} height={brl_h} fill={accentFill} stroke={strokeC} strokeWidth={0.8} />
            <rect x={bx - brl_w / 2 - 1.2} y={by2 - brl_h - 2} width={brl_w + 2.4} height={2.5} fill={strokeC} stroke="none" />
          </g>
        </>;
      })()}

      {towerId === 'glueTower' && (() => {
        const tw2 = r * 1.0, th2 = r * 0.9;
        const pw = r * 0.28, ph = r * 0.42;
        const tankTop = cy - th2 / 2 + r * 0.1;
        const nozzleTop = tankTop - ph;
        const dropCy = nozzleTop - r * 0.24;
        return <>
          <rect x={cx - tw2 / 2} y={tankTop} width={tw2} height={th2} rx={r * 0.3} fill={bodyFill} stroke={strokeC} strokeWidth={sw} />
          <rect x={cx - pw / 2} y={nozzleTop} width={pw} height={ph} fill={accentFill} stroke={strokeC} strokeWidth={0.8} />
          <circle cx={cx} cy={dropCy} r={r * 0.2} fill={accentFill} stroke={strokeC} strokeWidth={0.7} />
          <polygon points={`${cx - r * 0.1},${dropCy} ${cx + r * 0.1},${dropCy} ${cx},${dropCy - r * 0.2}`} fill={accentFill} stroke="none" />
        </>;
      })()}

      {/* Fallback for any unexpected towerId */}
      {!['canon', 'simpleLaser', 'mortar', 'glueTower'].includes(towerId) && (
        <circle cx={cx} cy={cy} r={r} fill={bodyFill} stroke={strokeC} strokeWidth={sw} />
      )}

    </svg>
  );
}
