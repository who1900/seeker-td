import type { BattleState, Enemy, Vec2 } from './types';
import { CELL_PX } from './data';
import { paperEnemyWalkPhaseDelta } from './paperGeometry';

export const PAPER_WALK_ENTRY_CAP = 2048;
export const PAPER_WALK_SEGMENT_CAP = 64;
type Cursor = { enemy: Enemy; x: number; y: number; path: Vec2[] | undefined; index: number; progress: number;
  fly: number | undefined; speed: number; stuns: { startedAt: number; expiresAt: number }[]; statusOverflow: boolean };
type Snapshot = { game: BattleState; time: number; entries: Map<string, Cursor>; teleports: Set<string>;
  entry: Vec2; exit: Vec2; paused: boolean };

export function createPaperWalkClock() {
  const entries = new Map<string, { enemy: Enemy; phase: number }>();
  let owner: BattleState | undefined, lastTime = -Infinity, pending: Snapshot | undefined;
  const diagnostics = { overflow: 0, unresolved: 0, segmentVisits: 0, teleportSkipped: 0, stunSkipped: 0 };
  const finitePoint = (p: Vec2) => Number.isFinite(p.x) && Number.isFinite(p.y);
  const seed = (enemy: Enemy) => [...enemy.uid].reduce((sum, char) => sum + char.charCodeAt(0), 0) % (Math.PI * 2);
  const retain = (game: BattleState) => {
    if (owner !== game || !Number.isFinite(game.time) || game.time < lastTime) entries.clear();
    owner = game; lastTime = game.time;
    const alive = new Set(game.enemies.filter(e => e.hp > 0).map(e => e.uid));
    for (const uid of entries.keys()) if (!alive.has(uid)) entries.delete(uid);
    for (const enemy of game.enemies) {
      if (enemy.hp <= 0 || typeof enemy.uid !== 'string' || !enemy.uid.length || enemy.uid.length > 1024) continue;
      const existing = entries.get(enemy.uid);
      if (existing?.enemy === enemy) continue;
      if (existing || entries.size < PAPER_WALK_ENTRY_CAP) entries.set(enemy.uid, { enemy, phase: seed(enemy) });
    }
    diagnostics.overflow = Math.max(0, alive.size - entries.size);
  };
  const cursorPoint = (path: Vec2[], index: number, progress: number): Vec2 | undefined => {
    if (!Number.isInteger(index) || index < 1 || index >= path.length || !Number.isFinite(progress) || progress < 0 || progress > 1) return;
    const a = path[index - 1], b = path[index];
    if (!finitePoint(a) || !finitePoint(b)) return;
    return { x: a.x + (b.x - a.x) * progress, y: a.y + (b.y - a.y) * progress };
  };
  const matches = (a: Vec2 | undefined, b: Vec2) => !!a && finitePoint(b) && Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
  const distance = (before: Cursor, enemy: Enemy, shot: Snapshot): number | undefined => {
    if (before.fly !== undefined || enemy.flyProgress !== undefined) {
      const start = before.fly, end = enemy.flyProgress;
      if (start === undefined || end === undefined || ![start, end].every(Number.isFinite) || start < 0 || end > 1 || end < start) return;
      const pos = (t: number) => ({ x: shot.entry.x + (shot.exit.x - shot.entry.x) * t, y: shot.entry.y + (shot.exit.y - shot.entry.y) * t });
      if (!matches(pos(start), { x: before.x, y: before.y }) || !matches(pos(end), enemy.pos)) return;
      return (end - start) * Math.hypot(shot.exit.x - shot.entry.x, shot.exit.y - shot.entry.y);
    }
    const path = before.path, endIndex = enemy.pathIdx ?? 1, endProgress = enemy.pathProgress ?? 0;
    if (!path || path !== enemy.path || endIndex < before.index
      || !matches(cursorPoint(path, before.index, before.progress), { x: before.x, y: before.y })
      || !matches(cursorPoint(path, endIndex, endProgress), enemy.pos)) return;
    if (endIndex - before.index + 1 > PAPER_WALK_SEGMENT_CAP) return;
    let travelled = 0;
    for (let i = before.index; i <= endIndex; i++) {
      diagnostics.segmentVisits++;
      const a = path[i - 1], b = path[i];
      if (!finitePoint(a) || !finitePoint(b)) return;
      const fraction = (i === endIndex ? endProgress : 1) - (i === before.index ? before.progress : 0);
      if (fraction < 0) return;
      travelled += Math.hypot(b.x - a.x, b.y - a.y) * fraction;
    }
    return Number.isFinite(travelled) ? travelled : undefined;
  };
  return {
    diagnostics,
    sync: retain,
    get size() { return entries.size; },
    phase(enemy: Enemy) {
      if (enemy.hp <= 0 || typeof enemy.uid !== 'string' || !enemy.uid.length || enemy.uid.length > 1024) return undefined;
      const record = entries.get(enemy.uid);
      return record?.enemy === enemy ? record.phase : seed(enemy);
    },
    snapshot(game: BattleState): Snapshot {
      retain(game);
      diagnostics.unresolved = diagnostics.segmentVisits = diagnostics.teleportSkipped = diagnostics.stunSkipped = 0;
      const records = new Map<string, Cursor>();
      for (const [uid, record] of entries) {
        const e = record.enemy, effects = e.speedEffects ?? [];
        records.set(uid, { enemy: e, x: e.pos.x, y: e.pos.y, path: e.path, index: e.pathIdx ?? 1, progress: e.pathProgress ?? 0,
          fly: e.flyProgress, speed: e.speed, statusOverflow: effects.length > PAPER_WALK_SEGMENT_CAP,
          stuns: [...effects.slice(0, PAPER_WALK_SEGMENT_CAP).filter(s => s.kind === 'laserStun' && Number.isFinite(s.multiplier) && s.multiplier < 1)
            .map(s => ({ startedAt: s.startedAt, expiresAt: s.expiresAt })),
            ...(Number.isFinite(e.stunUntil) ? [{ startedAt: game.time, expiresAt: e.stunUntil! }] : [])] });
      }
      pending = { game, time: game.time, entries: records, teleports: new Set(game.teleports.map(t => t.targetUid)),
        entry: { x: (game.entry.x + .5) * CELL_PX, y: (game.entry.y + .5) * CELL_PX },
        exit: { x: (game.exit.x + .5) * CELL_PX, y: (game.exit.y + .5) * CELL_PX }, paused: game.paused || game.gameOver || game.victory };
      return pending;
    },
    capture(game: BattleState, shot: Snapshot) {
      const valid = pending === shot && shot.game === game && Number.isFinite(game.time) && game.time >= shot.time;
      pending = undefined;
      if (!valid) { retain(game); diagnostics.unresolved = entries.size; return; }
      retain(game);
      if (shot.paused || game.time === shot.time) return;
      for (const [uid, before] of shot.entries) {
        const current = entries.get(uid), e = current?.enemy;
        if (!e || e !== before.enemy) continue;
        if (shot.teleports.has(uid)) { diagnostics.teleportSkipped++; continue; }
        if (before.stuns.some(s => Number.isFinite(s.startedAt) && s.startedAt <= game.time && Number.isFinite(s.expiresAt) && s.expiresAt > game.time)) {
          diagnostics.stunSkipped++; continue;
        }
        const travelled = before.statusOverflow ? undefined : distance(before, e, shot);
        const delta = travelled === undefined ? undefined : paperEnemyWalkPhaseDelta(e.id, before.speed, travelled);
        if (delta === undefined) { diagnostics.unresolved++; continue; }
        current!.phase = (current!.phase + delta % (Math.PI * 2)) % (Math.PI * 2);
      }
    },
  };
}
