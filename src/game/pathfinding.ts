import type { Vec2 } from './types';

// ── Binary min-heap ───────────────────────────────────────────────────────
interface HeapNode { f: number; idx: number; }

class MinHeap {
  private data: HeapNode[] = [];

  push(node: HeapNode) {
    this.data.push(node);
    this._bubbleUp(this.data.length - 1);
  }

  pop(): HeapNode | undefined {
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this._sinkDown(0);
    }
    return top;
  }

  get size() { return this.data.length; }

  private _bubbleUp(i: number) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[parent].f <= this.data[i].f) break;
      [this.data[parent], this.data[i]] = [this.data[i], this.data[parent]];
      i = parent;
    }
  }

  private _sinkDown(i: number) {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this.data[l].f < this.data[smallest].f) smallest = l;
      if (r < n && this.data[r].f < this.data[smallest].f) smallest = r;
      if (smallest === i) break;
      [this.data[smallest], this.data[i]] = [this.data[i], this.data[smallest]];
      i = smallest;
    }
  }
}

// ── 8-direction A* ────────────────────────────────────────────────────────
// grid[y][x] = true means blocked
// Returns array of Vec2 cell coords from start to goal (inclusive), or null if unreachable.
export function findPath(
  grid: boolean[][],
  start: Vec2,
  goal: Vec2
): Vec2[] | null {
  const H = grid.length;
  const W = grid[0]?.length ?? 0;

  const key = (x: number, y: number) => y * W + x;
  const heuristic = (x: number, y: number) =>
    Math.max(Math.abs(x - goal.x), Math.abs(y - goal.y)); // Chebyshev

  const DIRS: [number, number, number][] = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
  ];

  const gScore = new Float32Array(W * H).fill(Infinity);
  const prev = new Int32Array(W * H).fill(-1);
  const startKey = key(start.x, start.y);
  gScore[startKey] = 0;

  const heap = new MinHeap();
  heap.push({ f: heuristic(start.x, start.y), idx: startKey });

  const goalKey = key(goal.x, goal.y);

  while (heap.size > 0) {
    const { idx } = heap.pop()!;
    if (idx === goalKey) break;

    const cx = idx % W;
    const cy = (idx / W) | 0;
    const cg = gScore[idx];

    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (grid[ny][nx]) continue;
      // diagonal: both cardinal neighbours must be open to avoid corner-cutting
      if (dx !== 0 && dy !== 0) {
        if (grid[cy][nx] || grid[ny][cx]) continue;
      }
      const nk = key(nx, ny);
      const ng = cg + cost;
      if (ng < gScore[nk]) {
        gScore[nk] = ng;
        prev[nk] = idx;
        heap.push({ f: ng + heuristic(nx, ny), idx: nk });
      }
    }
  }

  if (gScore[goalKey] === Infinity) return null;

  // Reconstruct path
  const path: Vec2[] = [];
  let cur = goalKey;
  while (cur !== -1) {
    path.push({ x: cur % W, y: (cur / W) | 0 });
    cur = prev[cur];
  }
  path.reverse();
  return path;
}
