export type HealthArcInput = { uid: string; x: number; y: number; radius: number; stroke: number; boss?: boolean; targeted?: boolean;
  bodyPoint?: { x: number; y: number } };
type Offset = { dx: number; dy: number; order: number; conflictSince: number | null };
export type HealthArcLayoutState = ReadonlyMap<string, Offset>;
type Rect = { x: number; y: number; width: number; height: number };
type Leader = { from: { x: number; y: number }; to: { x: number; y: number } };
export const HEALTH_ARC_LAYOUT_CAP = 2048;
export const HEALTH_ARC_MAX_OFFSET = 2.4;
export const HEALTH_ARC_COMPARISON_BUDGET = 65536;
export const HEALTH_ARC_BIN_BUDGET = 131072;

export function healthArcStrokeBounds(anchor: HealthArcInput, dx = 0, dy = 0): Rect {
  const half = anchor.stroke / 2;
  const side = Math.sqrt(3) * anchor.radius / 2;
  return { x: anchor.x + dx - side - half, y: anchor.y + dy - anchor.radius - half,
    width: side * 2 + anchor.stroke, height: anchor.radius / 2 + anchor.stroke };
}

export function layoutHealthArcs(inputs: readonly HealthArcInput[], world: Rect, displayScale: number,
  time: number, cell: number, previous: HealthArcLayoutState = new Map()) {
  const placements = new Map<string, { dx: number; dy: number; unresolved: boolean;
    leaderUnresolved?: boolean; leader?: Leader }>();
  const state = new Map<string, Offset>();
  const diagnostics = { queries: 0, comparisons: 0, binVisits: 0, budgetExhausted: false,
    unresolved: 0, leaderUnresolved: 0 };
  const finite = (...values: number[]) => values.every(Number.isFinite);
  const validWorld = finite(world.x, world.y, world.width, world.height, world.x + world.width,
    world.y + world.height, displayScale, 2 / displayScale, time, cell)
    && world.width > 0 && world.height > 0 && displayScale > 0 && cell > 0;
  const valid = (a: HealthArcInput) => typeof a.uid === 'string' && a.uid.length > 0
    && finite(a.x, a.y, a.radius, a.stroke) && a.radius > 0 && a.stroke >= .75
    && (!a.bodyPoint || finite(a.bodyPoint.x, a.bodyPoint.y))
    && Object.values(healthArcStrokeBounds(a)).every(Number.isFinite);
  const seen = new Set<string>();
  const eligible: HealthArcInput[] = [];
  for (const a of inputs) {
    if (seen.has(a.uid)) continue;
    seen.add(a.uid);
    placements.set(a.uid, { dx: 0, dy: 0, unresolved: true });
    if (validWorld && valid(a)) eligible.push(a);
  }
  if (!validWorld) {
    diagnostics.unresolved = placements.size;
    return { placements, state, diagnostics };
  }
  const old = (uid: string) => {
    const value = previous.get(uid);
    return value && finite(value.dx, value.dy, value.order) && value.order >= 0
      && Math.hypot(value.dx, value.dy) <= cell * HEALTH_ARC_MAX_OFFSET
      && (value.conflictSince === null || Number.isFinite(value.conflictSince)) ? value : undefined;
  };
  eligible.sort((a, b) => {
    const pa = old(a.uid), pb = old(b.uid);
    if (pa && pb) return pa.order - pb.order || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);
    if (pa || pb) return pa ? -1 : 1;
    return Number(!!b.boss) - Number(!!a.boss) || Number(!!b.targeted) - Number(!!a.targeted)
      || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);
  });
  const gap = 2 / displayScale;
  const inside = (r: Rect) => r.x >= world.x && r.y >= world.y
    && r.x + r.width <= world.x + world.width && r.y + r.height <= world.y + world.height;
  const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width + gap && a.x + a.width + gap > b.x
    && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
  const occupied: { uid: string; rect: Rect; leader?: Leader }[] = [];
  const leaderFor = (a: HealthArcInput, offset: { dx: number; dy: number }): Leader | undefined =>
    offset.dx || offset.dy ? { from: { ...(a.bodyPoint ?? { x: a.x, y: a.y }) },
      to: { x: a.x + offset.dx, y: a.y - a.radius + offset.dy } } : undefined;
  const envelope = (r: Rect, line?: Leader): Rect => {
    if (!line) return r;
    const x = Math.min(r.x, line.from.x, line.to.x), y = Math.min(r.y, line.from.y, line.to.y);
    return { x, y, width: Math.max(r.x + r.width, line.from.x, line.to.x) - x,
      height: Math.max(r.y + r.height, line.from.y, line.to.y) - y };
  };
  const intersects = (line: Leader, r: Rect) => {
    let lo = 0, hi = 1;
    for (const axis of ['x', 'y'] as const) {
      const delta = line.to[axis] - line.from[axis];
      const min = r[axis] - gap / 2, max = r[axis] + (axis === 'x' ? r.width : r.height) + gap / 2;
      if (delta === 0) { if (line.from[axis] < min || line.from[axis] > max) return false; }
      else {
        const t1 = (min - line.from[axis]) / delta, t2 = (max - line.from[axis]) / delta;
        lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2));
        if (lo > hi) return false;
      }
    }
    return true;
  };
  const crossing = (a: Leader, b: Leader) => {
    const distance = (p: Leader['from'], line: Leader) => {
      const dx = line.to.x - line.from.x, dy = line.to.y - line.from.y;
      const t = Math.max(0, Math.min(1, ((p.x - line.from.x) * dx + (p.y - line.from.y) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(p.x - line.from.x - t * dx, p.y - line.from.y - t * dy);
    };
    const orient = (p: Leader['from'], q: Leader['from'], r: Leader['from']) =>
      (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    return (orient(a.from, a.to, b.from) * orient(a.from, a.to, b.to) < 0
      && orient(b.from, b.to, a.from) * orient(b.from, b.to, a.to) < 0)
      || Math.min(distance(a.from, b), distance(a.to, b), distance(b.from, a), distance(b.to, a)) < gap / 2;
  };
  const bins = new Map<number, number[]>();
  const binSize = Math.max(cell, world.width / 64, world.height / 64);
  const columns = Math.max(1, Math.min(64, Math.ceil(world.width / binSize)));
  const rows = Math.max(1, Math.min(64, Math.ceil(world.height / binSize)));
  const binRange = (r: Rect, padding: number) => {
    const left = Math.max(world.x, r.x - padding), top = Math.max(world.y, r.y - padding);
    const right = Math.min(world.x + world.width, r.x + r.width + padding);
    const bottom = Math.min(world.y + world.height, r.y + r.height + padding);
    if (right < left || bottom < top) return null;
    return { left: Math.min(columns - 1, Math.max(0, Math.floor((left - world.x) / binSize))),
      right: Math.min(columns - 1, Math.max(0, Math.floor((right - world.x) / binSize))),
      top: Math.min(rows - 1, Math.max(0, Math.floor((top - world.y) / binSize))),
      bottom: Math.min(rows - 1, Math.max(0, Math.floor((bottom - world.y) / binSize))) };
  };
  const visitBin = () => {
    if (diagnostics.binVisits >= HEALTH_ARC_BIN_BUDGET) { diagnostics.budgetExhausted = true; return false; }
    diagnostics.binVisits++;
    return true;
  };
  const collision = (r: Rect, exclude = -1, leader?: Leader, checkLeaders = false) => {
    diagnostics.queries++;
    if (diagnostics.budgetExhausted) return true;
    const range = binRange(envelope(r, leader), gap);
    if (!range) return false;
    const checked = new Set<number>();
    for (let y = range.top; y <= range.bottom; y++) for (let x = range.left; x <= range.right; x++) {
      if (!visitBin()) return true;
      for (const index of bins.get(y * columns + x) ?? []) {
        if (index === exclude || checked.has(index)) continue;
        checked.add(index);
        if (diagnostics.comparisons >= HEALTH_ARC_COMPARISON_BUDGET) {
          diagnostics.budgetExhausted = true; return true;
        }
        diagnostics.comparisons++;
        if (overlaps(r, occupied[index].rect)) return true;
        if (checkLeaders) {
          const other = occupied[index];
          if (leader && intersects(leader, other.rect) || other.leader && intersects(other.leader, r)
            || leader && other.leader && crossing(leader, other.leader)) return true;
        }
      }
    }
    return false;
  };
  const register = (index: number) => {
    if (diagnostics.budgetExhausted) return;
    const range = binRange(envelope(occupied[index].rect, occupied[index].leader), 0);
    if (!range) return;
    for (let y = range.top; y <= range.bottom; y++) for (let x = range.left; x <= range.right; x++) {
      if (!visitBin()) return;
      const key = y * columns + x;
      const entries = bins.get(key) ?? [];
      entries.push(index); bins.set(key, entries);
    }
  };
  const candidates = [[0, 0], [-.14, 0], [.14, 0], [-.28, 0], [.28, 0], [0, -.14], [0, -.28],
    [-.28, -.28], [.28, -.28], [0, .14], [0, .28], [-.28, .28], [.28, .28],
    [-.75, 0], [.75, 0], [0, -.75], [-.75, -.5], [.75, -.5], [-1.25, 0], [1.25, 0],
    [0, -1.25], [-1.25, -.75], [1.25, -.75], [-1.75, 0], [1.75, 0], [0, -1.75],
    [-1.75, -1], [1.75, -1], [-2.25, 0], [2.25, 0], [0, -2.25], [-2, -1], [2, -1],
    [-.75, .5], [.75, .5], [-1.25, .75], [1.25, .75], [-1.75, 1], [1.75, 1]]
    .map(([x, y], index) => ({ dx: x * cell, dy: y * cell, index }))
    .sort((a, b) => a.dx * a.dx + a.dy * a.dy - b.dx * b.dx - b.dy * b.dy || a.index - b.index)
    .map(({ dx, dy }) => ({ dx, dy }));
  for (const a of eligible.slice(0, HEALTH_ARC_LAYOUT_CAP)) {
    const prior = old(a.uid);
    let offset = prior ? { dx: prior.dx, dy: prior.dy } : { dx: 0, dy: 0 };
    let rect = healthArcStrokeBounds(a, offset.dx, offset.dy);
    const conflict = collision(rect, -1, leaderFor(a, offset), true);
    let conflictSince = conflict ? prior?.conflictSince ?? time : null;
    if (conflictSince !== null && conflictSince > time) conflictSince = time;
    if (!diagnostics.budgetExhausted && (!prior || !inside(rect) || (conflict && time - conflictSince! >= .15 - 1e-9))) {
      const fit = candidates.find(candidate => {
        const bounds = healthArcStrokeBounds(a, candidate.dx, candidate.dy);
        return inside(bounds) && !collision(bounds, -1, leaderFor(a, candidate), true);
      }) ?? candidates.find(candidate => {
        const bounds = healthArcStrokeBounds(a, candidate.dx, candidate.dy);
        return inside(bounds) && !collision(bounds);
      });
      if (fit) { offset = fit; rect = healthArcStrokeBounds(a, fit.dx, fit.dy); conflictSince = null; }
      else if (!inside(rect)) {
        const bounded = candidates.find(candidate => inside(healthArcStrokeBounds(a, candidate.dx, candidate.dy)));
        offset = bounded ?? { dx: 0, dy: 0 };
        rect = healthArcStrokeBounds(a, offset.dx, offset.dy);
      }
    }
    const leader = leaderFor(a, offset);
    placements.set(a.uid, { ...offset, unresolved: !inside(rect), ...(leader ? { leader } : {}) });
    state.set(a.uid, { ...offset, order: state.size, conflictSince });
    occupied.push({ uid: a.uid, rect, leader });
    register(occupied.length - 1);
  }
  for (let i = 0; i < occupied.length; i++) {
    if (collision(occupied[i].rect, i)) placements.get(occupied[i].uid)!.unresolved = true;
    placements.get(occupied[i].uid)!.leaderUnresolved = collision(occupied[i].rect, i, occupied[i].leader, true);
  }
  if (diagnostics.budgetExhausted) for (const placement of placements.values()) {
    placement.unresolved = true;
    if (placement.leader) placement.leaderUnresolved = true;
  }
  for (const placement of placements.values()) {
    if (placement.unresolved) diagnostics.unresolved++;
    if (placement.leaderUnresolved) diagnostics.leaderUnresolved++;
  }
  return { placements, state, diagnostics };
}
