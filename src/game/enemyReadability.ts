export function enemyHealthPresentation(hp: number, maxHp: number, boss: boolean, relevant = false) {
  const valid = Number.isFinite(hp) && Number.isFinite(maxHp) && hp > 0 && maxHp > 0;
  const ratio = valid ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
  return { visible: valid && (boss || ratio < 1 || relevant), ratio };
}

export function enemyHealthArc(ratio: number) {
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) return null;
  const start = -5 * Math.PI / 6;
  const end = -Math.PI / 6;
  return { start, end, fillEnd: ratio === 1 ? end : start + (end - start) * ratio };
}

export function enemyHealthAnchor(bounds: { x: number; y: number; width: number; height: number } | null,
  fallback: { x: number; y: number; radius: number }) {
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0) return { ...fallback };
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2,
    radius: Math.hypot(bounds.width, bounds.height) / 2 + 2 };
}

export function enemyReadabilityRegressionChecks(): number {
  let count = 0;
  const check = (ok: boolean) => { if (!ok) throw new Error('Enemy readability regression'); count++; };
  check(!enemyHealthPresentation(10, 10, false).visible);
  check(enemyHealthPresentation(10, 10, true).visible);
  check(enemyHealthPresentation(10, 10, false, true).visible);
  check(enemyHealthPresentation(5, 10, false).ratio === .5);
  for (const hp of [0, -1, NaN, Infinity]) check(!enemyHealthPresentation(hp, 10, true).visible);
  for (const max of [0, -1, NaN, Infinity]) check(!enemyHealthPresentation(10, max, true).visible);
  check(enemyHealthPresentation(20, 10, false, true).ratio === 1);
  const input = [5, 10] as const;
  check(JSON.stringify(enemyHealthPresentation(...input, false)) === JSON.stringify(enemyHealthPresentation(...input, false)));
  const bounds = { x: -10, y: -20, width: 20, height: 40 };
  const fallback = { x: 1, y: 2, radius: 3 };
  const before = JSON.stringify(bounds);
  const anchor = enemyHealthAnchor(bounds, fallback);
  check(anchor.x === 0 && anchor.y === 0);
  check(anchor.radius > Math.hypot(10, 20));
  check(JSON.stringify(bounds) === before);
  check(JSON.stringify(enemyHealthAnchor(null, fallback)) === JSON.stringify(fallback));
  check(enemyHealthAnchor({ ...bounds, width: NaN }, fallback).radius === 3);
  return count;
}
