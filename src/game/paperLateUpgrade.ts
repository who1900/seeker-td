import type { PaperMatrix, PaperModel, PaperPart } from './paperGeometry';

export interface PaperLateDraw {
  matrix: PaperMatrix;
  source: [number, number, number, number];
  destination: [number, number, number, number];
}

const topology = 'shadow.png:::false|base.png::256,280:false|block_2x2.png:base:256,270:true|rocket_ammo.png:block_2x2:256,195:true|enhancement_1.png:block_2x2:256,175:false|enhancement_2.png:base:256,280:false';
const validatedTopology = new WeakMap<PaperModel, string>();

// Offline PNG calibration: wide mirrored shoulders fit the cell, including the full alpha fringe.
export function paperLateUpgradeDrawCommands(tower: { towerId: string; level: number; worldX: number; worldY: number },
  part: PaperPart, model: PaperModel,
  sprite: { image: { width: number; height: number }; bounds: readonly number[]; alphaBounds?: readonly number[] },
  matrix: PaperMatrix, cell: number): PaperLateDraw[] | null {
  if (tower.towerId !== 'rocketLauncher' || !Number.isInteger(tower.level) || tower.level < 10 || tower.level > 14
    || part.file !== 'enhancement_2.png' || part.parent !== 'base' || part.pivot?.[0] !== 256 || part.pivot?.[1] !== 280
    || model.canvas[0] !== 512 || model.canvas[1] !== 512 || sprite.image.width !== 256 || sprite.image.height !== 256
    || !sprite.alphaBounds || sprite.alphaBounds.length !== 4 || sprite.bounds.length !== 4
    || !sprite.alphaBounds.every((v, i) => v === [87, 127, 169, 153][i])
    || !sprite.bounds.every((v, i) => v === [90, 129, 166, 150][i])
    || matrix.length !== 6 || ![...matrix, cell, tower.worldX, tower.worldY].every(Number.isFinite) || cell <= 0
    || !model.parts || model.parts.length > 32) return null;
  let fingerprint = validatedTopology.get(model);
  if (fingerprint === undefined) {
    fingerprint = model.parts.map(layer => [layer.file, layer.parent, layer.pivot, layer.rotates ?? false].join(':')).join('|');
    validatedTopology.set(model, fingerprint);
  }
  if (fingerprint !== topology) return null;
  const scale = cell * .8 / 168;
  const expected = [scale * 1.28, 0, 0, scale * 1.72,
    tower.worldX - scale * 1.28 * 256, tower.worldY + scale * (-256 - .72 * 306)];
  if (!matrix.every((v, i) => Math.abs(v - expected[i]) < 1e-9)) return null;
  const [a, b, c, d, e, f] = matrix;
  return [
    { matrix: [2 * c, 2 * d, -1.5 * a, -1.5 * b, e + a * 635 - c * 120, f + b * 635 - d * 120],
      source: [87, 127, 16, 26], destination: [174, 254, 32, 52] },
    { matrix: [-2 * c, -2 * d, 1.5 * a, 1.5 * b, e - a * 123 + c * 904, f - b * 123 + d * 904],
      source: [153, 127, 16, 26], destination: [306, 254, 32, 52] },
  ];
}
