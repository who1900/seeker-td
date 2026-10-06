import type { Vec2 } from './types';

export interface PaperBeamViewport { x: number; y: number; width: number; height: number }
export interface PaperBeamStrip { canvas: number[]; tile_range_x: number[]; height?: number; link_interval?: number }

export function paperBeamTiles(strip: PaperBeamStrip, image: { width: number; height: number }, bounds: readonly number[],
  from: Vec2, to: Vec2, thickness: number, viewport?: PaperBeamViewport, visibleRange?: readonly number[]) {
  if (!strip || !Array.isArray(strip.canvas) || !Array.isArray(strip.tile_range_x)) return null;
  const [masterWidth, masterHeight] = strip.canvas, [tileStart, tileEnd] = strip.tile_range_x;
  const [left, top, right, bottom] = bounds;
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (![masterWidth, masterHeight, tileStart, tileEnd, image.width, image.height, left, top, right, bottom,
    from.x, from.y, to.x, to.y, thickness, length].every(Number.isFinite)
    || Math.min(masterWidth, masterHeight, image.width, image.height, thickness, length) <= 0
    || tileStart < 0 || tileEnd <= tileStart || tileEnd > masterWidth || left < 0 || right > image.width
    || top < 0 || bottom > image.height || right <= left || bottom <= top) return null;
  const ratioX = image.width / masterWidth, ratioY = image.height / masterHeight;
  const nominalHeight = strip.height === undefined ? (bottom - top) / ratioY : strip.height;
  if (!Number.isFinite(nominalHeight) || nominalHeight <= 0 || nominalHeight > masterHeight
    || strip.link_interval !== undefined && (!Number.isFinite(strip.link_interval) || strip.link_interval <= 0 || strip.link_interval > tileEnd - tileStart
      || !Number.isInteger((tileEnd - tileStart) / strip.link_interval))) return null;
  const scale = thickness / nominalHeight;
  const dx = (to.x - from.x) / length, dy = (to.y - from.y) / length;
  let enter = 0, exit = length;
  if (viewport) {
    if (![viewport.x, viewport.y, viewport.width, viewport.height].every(Number.isFinite) || viewport.width <= 0 || viewport.height <= 0) return null;
    const margin = (bottom - top) / ratioY * scale / 2;
    const edges = [viewport.x - margin, viewport.x + viewport.width + margin, viewport.y - margin, viewport.y + viewport.height + margin];
    if (!edges.every(Number.isFinite)) return null;
    for (const [origin, direction, low, high] of [[from.x, dx, edges[0], edges[1]], [from.y, dy, edges[2], edges[3]]]) {
      if (direction === 0) { if (origin < low || origin > high) return null; }
      else {
        const a = (low - origin) / direction, b = (high - origin) / direction;
        enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
      }
    }
    if (exit <= enter) return null;
  }
  if (visibleRange) {
    if (visibleRange.length !== 2 || !visibleRange.every(Number.isFinite) || visibleRange[0] < 0 || visibleRange[1] > 1 || visibleRange[1] <= visibleRange[0]) return null;
    const visibleLength = exit - enter, originalEnter = enter;
    enter = originalEnter + visibleLength * visibleRange[0]; exit = originalEnter + visibleLength * visibleRange[1];
  }
  const capLeft = tileStart * scale, capRight = (masterWidth - tileEnd) * scale;
  const short = length < capLeft + capRight;
  const leftLength = short ? length * capLeft / (capLeft + capRight) : capLeft;
  const rightLength = short ? length - leftLength : capRight;
  const tiles: { sx: number; sy: number; sw: number; sh: number; x: number; y: number; width: number; height: number }[] = [];
  const add = (start: number, end: number, sourceStart: number) => {
    const a = Math.max(enter, start), b = Math.min(exit, end);
    if (b <= a) return;
    tiles.push({ sx: (sourceStart + (a - start) / scale) * ratioX, sy: top, sw: (b - a) / scale * ratioX,
      sh: bottom - top, x: a - enter, y: -(bottom - top) / ratioY * scale / 2,
      width: b - a, height: (bottom - top) / ratioY * scale });
  };
  add(0, leftLength, 0);
  const middleEnd = length - rightLength;
  const period = (tileEnd - tileStart) * scale;
  const first = Math.max(0, Math.floor((enter - leftLength) / period));
  const last = Math.ceil((Math.min(exit, middleEnd) - leftLength) / period);
  if (!Number.isFinite(period) || period <= 0 || !Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last - first > 4096) return null;
  for (let index = first; index < last; index++) {
    const start = leftLength + index * period;
    add(start, Math.min(middleEnd, start + period), tileStart);
  }
  add(middleEnd, length, masterWidth - rightLength / scale);
  if (!tiles.length || tiles.some(tile => !Object.values(tile).every(Number.isFinite))) return null;
  return { from: { x: from.x + dx * enter, y: from.y + dy * enter }, angle: Math.atan2(dy, dx), tiles };
}
