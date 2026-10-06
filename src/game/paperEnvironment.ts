import type { Vec2 } from './types';
import { transformPaperPoint } from './paperGeometry';
import type { PaperMatrix } from './paperGeometry';

export const PAPER_ENVIRONMENT_ALIASES = {
  entry_gate: {
    'frame.png': 'environment/entry_gate_frame.png',
    'flap_left.png': 'environment/entry_gate_flap_left.png',
    'flap_right.png': 'environment/entry_gate_flap_right.png',
    'shadow.png': 'environment/entry_gate_shadow.png',
  },
  exit_goal: {
    'body.png': 'environment/exit_goal_body.png',
    'fold_detail_1.png': 'environment/exit_goal_fold_1.png',
    'fold_detail_2.png': 'environment/exit_goal_fold_2.png',
    'shadow.png': 'environment/exit_goal_shadow.png',
  },
} as const;

export type PaperEnvironmentId = keyof typeof PAPER_ENVIRONMENT_ALIASES;
export type PaperEnvironmentModel = { canvas: number[]; parts: string[] };
export const PAPER_ENVIRONMENT_PATHS: readonly string[] = [
  'environment/paper_field.png',
  ...Object.values(PAPER_ENVIRONMENT_ALIASES).flatMap(parts => Object.values(parts)),
];

export function paperEnvironmentFiles(id: PaperEnvironmentId, parts: readonly string[]): string[] | null {
  const aliases: Readonly<Record<string, string>> = PAPER_ENVIRONMENT_ALIASES[id];
  if (!aliases || parts.length !== Object.keys(aliases).length || new Set(parts).size !== parts.length
    || parts.some(part => !Object.prototype.hasOwnProperty.call(aliases, part))) return null;
  return ['shadow.png', ...parts.filter(part => part !== 'shadow.png')].map(part => aliases[part]);
}

export function paperEnvironmentBounds(canvas: readonly number[], layers: readonly { width: number; height: number; bounds: readonly number[] }[]): number[] | null {
  if (canvas.length < 2 || !canvas.slice(0, 2).every(n => Number.isFinite(n) && n > 0) || !layers.length) return null;
  const bounds: number[][] = [];
  for (const layer of layers) {
    const [left, top, right, bottom] = layer.bounds;
    if (layer.bounds.length < 4 || ![layer.width, layer.height, left, top, right, bottom].every(Number.isFinite)
      || layer.width <= 0 || layer.height <= 0 || left < 0 || top < 0 || right > layer.width || bottom > layer.height || right <= left || bottom <= top) return null;
    bounds.push([left * canvas[0] / layer.width, top * canvas[1] / layer.height,
      right * canvas[0] / layer.width, bottom * canvas[1] / layer.height]);
  }
  return [Math.min(...bounds.map(b => b[0])), Math.min(...bounds.map(b => b[1])),
    Math.max(...bounds.map(b => b[2])), Math.max(...bounds.map(b => b[3]))];
}

export type PaperEnvironmentPose = {
  matrix: PaperMatrix;
  bounds: number[];
  clip: { x: number; y: number; width: number; height: number };
  label: { x: number; y: number; fontSize: number };
};

export function paperEnvironmentPose(bounds: readonly number[], gridCell: Vec2, cell: number): PaperEnvironmentPose | null {
  const [left, top, right, bottom] = bounds;
  if (bounds.length < 4 || ![left, top, right, bottom, gridCell.x, gridCell.y, cell].every(Number.isFinite)
    || cell <= 0 || right <= left || bottom <= top || !Number.isInteger(gridCell.x) || !Number.isInteger(gridCell.y) || gridCell.x < 0 || gridCell.y < 0) return null;
  const x = gridCell.x * cell, y = gridCell.y * cell;
  const scale = Math.min(cell * .88 / (right - left), cell * .6 / (bottom - top));
  const tx = x + cell / 2 - (left + right) * scale / 2;
  const ty = y + cell * .64 - (top + bottom) * scale / 2;
  return { matrix: [scale, 0, 0, scale, tx, ty],
    bounds: [left * scale + tx, top * scale + ty, right * scale + tx, bottom * scale + ty],
    clip: { x, y, width: cell, height: cell },
    label: { x: x + cell / 2, y: y + cell * .27, fontSize: cell * .27 } };
}

export function paperEnvironmentSocket(pose: PaperEnvironmentPose, position: readonly number[]): Vec2 | null {
  if (position.length < 2 || !position.slice(0, 2).every(Number.isFinite)) return null;
  return transformPaperPoint(pose.matrix, position);
}

export function paperEnvironmentRegressionChecks(): number {
  let count = 0;
  const check = (ok: boolean, name: string) => { if (!ok) throw new Error(`Paper environment regression: ${name}`); count++; };
  check(PAPER_ENVIRONMENT_PATHS.length === 9 && new Set(PAPER_ENVIRONMENT_PATHS).size === 9, 'nine real required files, no previews');
  check(PAPER_ENVIRONMENT_ALIASES.exit_goal['fold_detail_1.png'].endsWith('exit_goal_fold_1.png'), 'explicit fold alias');
  for (const id of ['entry_gate', 'exit_goal'] as const) {
    const files = paperEnvironmentFiles(id, Object.keys(PAPER_ENVIRONMENT_ALIASES[id]));
    check(files?.length === 4 && files[0].endsWith('_shadow.png'), 'shadow first and all shared layers');
    check(paperEnvironmentFiles(id, ['shadow.png']) === null, 'incomplete manifest fails closed');
    check(paperEnvironmentFiles(id, ['fake.png', 'shadow.png', 'body.png', 'body.png']) === null, 'unknown or duplicate alias fails closed');
  }
  const layers = [{ width: 256, height: 256, bounds: [58, 44, 199, 214] }, { width: 256, height: 256, bounds: [88, 90, 129, 199] }];
  const before = JSON.stringify(layers);
  const bounds = paperEnvironmentBounds([512, 512], layers)!;
  check(JSON.stringify(bounds) === JSON.stringify([116, 88, 398, 428]), 'runtime to shared master bounds');
  for (const cell of [1, 28, 30, 34, 64]) for (const gridCell of [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 20 }, { x: 11, y: 20 }]) {
    const pose = paperEnvironmentPose(bounds, gridCell, cell)!;
    check(pose.bounds[0] >= pose.clip.x && pose.bounds[1] >= pose.clip.y && pose.bounds[2] <= pose.clip.x + cell && pose.bounds[3] <= pose.clip.y + cell, 'footprint stays in exact cell');
    check(pose.bounds[1] > pose.label.y && pose.label.x === pose.clip.x + cell / 2, 'label stripe does not overlap art');
    check(JSON.stringify(pose) === JSON.stringify(paperEnvironmentPose(bounds, gridCell, cell)), 'static pose repeatable, no clock or pause input');
    const center = paperEnvironmentSocket(pose, [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2])!;
    check(Math.abs(center.x - (gridCell.x + .5) * cell) < 1e-9 && Math.abs(center.y - (gridCell.y + .64) * cell) < 1e-9, 'socket inherits same shared transform');
  }
  check(JSON.stringify(layers) === before, 'bounds input not mutated');
  check(paperEnvironmentBounds([512, 512], []) === null, 'empty layers rejected');
  check(paperEnvironmentBounds([512, 512], [{ width: 256, height: 256, bounds: [0, 0, 300, 200] }]) === null, 'invalid alpha bounds rejected');
  check(paperEnvironmentPose(bounds, { x: 0, y: 0 }, NaN) === null, 'invalid cell rejected');
  check(paperEnvironmentPose(bounds, { x: -.1, y: 0 }, 28) === null, 'invalid grid cell rejected');
  check(paperEnvironmentSocket(paperEnvironmentPose(bounds, { x: 0, y: 0 }, 28)!, [NaN, 0]) === null, 'invalid socket rejected');
  return count;
}
