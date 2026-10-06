import type { Enemy, Vec2 } from './types';
import { CELL_PX } from './data';

export interface PaperPart {
  file: string;
  parent?: string | null;
  pivot?: number[];
  rotates?: boolean;
  order: number;
  optional?: boolean;
}

export interface PaperModel {
  canvas: number[];
  parts?: PaperPart[];
  pivots?: Record<string, number[]>;
  sockets?: Record<string, { part: string; position: number[] }>;
  masks?: string[];
}

export type PaperMatrix = [number, number, number, number, number, number];
export interface PaperTowerPose {
  scale: number;
  parts: { part: PaperPart; matrix: PaperMatrix }[];
}

export function transformPaperPoint(matrix: PaperMatrix, point: readonly number[]): Vec2 {
  return { x: matrix[0] * point[0] + matrix[2] * point[1] + matrix[4], y: matrix[1] * point[0] + matrix[3] * point[1] + matrix[5] };
}

// Full shared-canvas layers inherit one aiming rotation, never rotate twice.
export function paperTowerPose(model: PaperModel, baseBounds: readonly number[], tower: { worldX: number; worldY: number; level: number; towerId?: string }, angle: number, shotAge: number, cell: number, runtimeCanvasWidth = 256): PaperTowerPose | null {
  const [width, height] = model.canvas;
  const extent = baseBounds[2] - baseBounds[0];
  if (!model.parts?.length || ![width, height, extent, tower.worldX, tower.worldY, tower.level, angle, cell, runtimeCanvasWidth].every(Number.isFinite)
    || width <= 0 || height <= 0 || extent <= 0 || cell <= 0 || runtimeCanvasWidth <= 0) return null;
  // Bounds are runtime pixels; manifest pivots and sockets are master pixels.
  const scale = cell * .8 / (extent * width / runtimeCanvasWidth);
  const recoil = Number.isFinite(shotAge) && shotAge >= 0 && shotAge < .16 ? Math.sin(shotAge / .16 * Math.PI) * 12 : 0;
  const transforms = new Map<string, { moving: boolean; pivot: number[]; recoil: boolean }>();
  const parts: PaperTowerPose['parts'] = [];
  const secondEnhancementLevel = ['glueTower', 'glueGun', 'teleporter'].includes(tower.towerId ?? '') ? 4 : 5;
  const visible = model.parts.filter(p => !p.optional || tower.level >= (p.file === 'enhancement_1.png' ? 2 : p.file === 'enhancement_2.png' ? secondEnhancementLevel : 5));
  for (const part of [...visible].sort((a, b) => a.order - b.order)) {
    const parent = part.parent ? transforms.get(part.parent) : undefined;
    const moving = !!(parent?.moving || part.rotates);
    const pivot = parent?.moving ? parent.pivot : part.pivot ?? [width / 2, height / 2];
    if (!pivot.slice(0, 2).every(Number.isFinite) || pivot.length < 2) return null;
    const kicks = !!(parent?.recoil || /barrel|bolt|nozzle|rocket_ammo/.test(part.file));
    transforms.set(part.file.replace('.png', ''), { moving, pivot, recoil: kicks });
    const rotation = moving ? angle : 0;
    const cos = Math.cos(rotation), sin = Math.sin(rotation), offset = kicks ? recoil : 0;
    const tx = pivot[0] - cos * pivot[0] + sin * pivot[1] - sin * offset;
    const ty = pivot[1] - sin * pivot[0] - cos * pivot[1] + cos * offset;
    parts.push({ part, matrix: [scale * cos, scale * sin, -scale * sin, scale * cos,
      tower.worldX + scale * (tx - width / 2), tower.worldY + scale * (ty - height / 2)] });
  }
  return { scale, parts };
}

export function paperEnhancementDrawMatrix(towerId: string | undefined, part: PaperPart, model: PaperModel,
  sprite: { image: { width: number; height: number }; bounds: readonly number[] }, matrix: PaperMatrix): PaperMatrix {
  if (!['glueTower', 'glueGun', 'teleporter'].includes(towerId ?? '')
    || !['enhancement_1.png', 'enhancement_2.png'].includes(part.file)) return matrix;
  const [left, top, right, bottom] = sprite.bounds;
  const [width, height] = model.canvas;
  const pivot = part.pivot;
  if (!pivot || ![left, top, right, bottom, width, height, sprite.image.width, sprite.image.height, ...pivot.slice(0, 2), ...matrix].every(Number.isFinite)
    || pivot.length < 2 || right <= left || bottom <= top || Math.min(width, height, sprite.image.width, sprite.image.height) <= 0) return matrix;
  const second = part.file === 'enhancement_2.png';
  const profiles = towerId === 'glueTower' ? [[2.2, 2.6], [1.7, 3]]
    : towerId === 'glueGun' ? [[2.6, 1.8], [1.8, 2.4]] : [[2.8, 2.8], [3.2, 2.3]];
  const [scaleX, scaleY] = profiles[second ? 1 : 0];
  const x = Math.max(left * width / sprite.image.width, Math.min(right * width / sprite.image.width, pivot[0]));
  const y = second ? bottom * height / sprite.image.height
    : Math.max(top * height / sprite.image.height, Math.min(bottom * height / sprite.image.height, pivot[1]));
  const [a, b, c, d, e, f] = matrix;
  return [a * scaleX, b * scaleX, c * scaleY, d * scaleY,
    e - (scaleX - 1) * a * x - (scaleY - 1) * c * y,
    f - (scaleX - 1) * b * x - (scaleY - 1) * d * y];
}

const structuralUpgradeProfiles: Record<string, number[][]> = {
    canon: [[1.35, 2.1], [1.25, 1.65]], dualCanon: [[.95, .65], [1.1, 1.45]], machineGun: [[.8, .9], [2.5, 2]],
    simpleLaser: [[.9, .65], [1.7, 2.2]], bouncingLaser: [[2, 1.45], [2.2, 1.6]], straightLaser: [[.8, .7], [1.8, 2.3]],
    mortar: [[1.15, 3], [1.05, 1.7]], mineLayer: [[.7, 1.8], [1.05, 3.3]], rocketLauncher: [[.9, .7], [1.35, 1.9]],
};
const structuralUpgradeCalibration: Record<string, { extent: number; bounds: number[][]; topology: string; factors: number[] }> = {
  canon: {"extent":98,"bounds":[[110,97,146,113],[85,122,171,163]],"topology":"shadow.png:::false|base.png::256,280:false|turret.png:base:256,280:true|barrel.png:turret:256,280:true|muzzle_cap.png:barrel:256,120:true|enhancement_1.png:barrel:256,210:false|enhancement_2.png:base:256,280:false","factors":[0.249,0.999]},
  dualCanon: {"extent":118,"bounds":[[100,72,156,91],[72,116,184,168]],"topology":"shadow.png:::false|base.png::256,285:false|turret.png:base:256,285:true|barrel_left.png:turret:256,285:true|barrel_right.png:turret:256,285:true|tie_bar.png:turret:256,200:true|enhancement_1.png:tie_bar:256,160:false|enhancement_2.png:base:256,285:false","factors":[0.999,0.999]},
  machineGun: {"extent":98,"bounds":[[116,57,140,93],[105,119,124,133]],"topology":"shadow.png:::false|base.png::256,280:false|turret.png:base:256,280:true|barrel.png:turret:256,280:true|feed_drum.png:turret:215,275:true|bolt.png:turret:256,270:true|enhancement_1.png:barrel:256,160:false|enhancement_2.png:base:256,280:false","factors":[0.999,0.999]},
  simpleLaser: {"extent":121,"bounds":[[109,78,147,97],[102,147,154,163]],"topology":"shadow.png:::false|base.png::256,285:false|emitter.png:base:256,285:true|lens.png:emitter:256,210:true|reflector_flap.png:emitter:285,210:true|enhancement_1.png:lens:256,175:false|enhancement_2.png:base:256,285:false","factors":[0.999,0.999]},
  bouncingLaser: {"extent":126,"bounds":[[120,112,136,133],[115,167,141,181]],"topology":"shadow.png:::false|base.png::256,285:false|central_lens.png:base:256,250:true|reflector_flap_1.png:central_lens:205,230:true|reflector_flap_2.png:central_lens:307,230:true|reflector_flap_3.png:central_lens:256,180:true|enhancement_1.png:central_lens:256,250:false|enhancement_2.png:base:256,285:false","factors":[0.999,0.999]},
  straightLaser: {"extent":88,"bounds":[[120,62,136,74],[87,152,103,173]],"topology":"shadow.png:::false|base.png::256,285:false|emitter.png:base:256,285:true|prism.png:emitter:256,230:true|vane_left.png:prism:226,230:true|vane_right.png:prism:286,230:true|enhancement_1.png:prism:256,130:false|enhancement_2.png:base:256,285:false","factors":[0.999,0.999]},
  mortar: {"extent":117,"bounds":[[107,101,149,109],[77,161,179,185]],"topology":"shadow.png:::false|base.png::256,290:false|cradle.png:base:256,290:true|barrel.png:cradle:256,280:true|muzzle.png:barrel:256,160:true|enhancement_1.png:barrel:256,210:false|enhancement_2.png:base:256,290:false","factors":[0.858,0.999]},
  mineLayer: {"extent":98,"bounds":[[97,79,113,101],[80,166,175,174]],"topology":"shadow.png:::false|base.png::256,280:false|feed_tray.png:base:256,260:true|mine_dispenser.png:feed_tray:256,255:true|hatch.png:feed_tray:256,205:true|enhancement_1.png:feed_tray:256,160:false|enhancement_2.png:base:256,280:false","factors":[0.999,0.999]},
  rocketLauncher: {"extent":84,"bounds":[[102,76,154,84],[87,127,169,153]],"topology":"shadow.png:::false|base.png::256,280:false|block_2x2.png:base:256,270:true|rocket_ammo.png:block_2x2:256,195:true|enhancement_1.png:block_2x2:256,175:false|enhancement_2.png:base:256,280:false","factors":[0.999,0.8]},
};
const structuralUpgradeTopology = new WeakMap<PaperModel, string>();

export function paperStructuralUpgradeDrawMatrix(towerId: string | undefined, part: PaperPart, model: PaperModel,
  sprite: { image: { width: number; height: number }; bounds: readonly number[]; alphaBounds?: readonly number[] },
  matrix: PaperMatrix, center: Vec2, cell: number): PaperMatrix {
  const id = towerId ?? '';
  if (!Object.prototype.hasOwnProperty.call(structuralUpgradeProfiles, id) || !Object.prototype.hasOwnProperty.call(structuralUpgradeCalibration, id)) return matrix;
  const profile = structuralUpgradeProfiles[id];
  const stage = ['enhancement_1.png', 'enhancement_2.png'].indexOf(part.file);
  if (!profile || stage < 0 || !sprite.alphaBounds || !part.pivot || part.pivot.length < 2 || matrix.length !== 6) return matrix;
  const [width, height] = model.canvas, [iw, ih] = [sprite.image.width, sprite.image.height];
  const [l, t, r, b] = sprite.alphaBounds;
  if (![width, height, iw, ih, l, t, r, b, ...part.pivot.slice(0, 2), ...matrix, center.x, center.y, cell].every(Number.isFinite)
    || Math.min(width, height, iw, ih, cell) <= 0 || l < 0 || t < 0 || r > iw || b > ih || r <= l || b <= t) return matrix;
  const left = l * width / iw, right = r * width / iw, top = t * height / ih, bottom = b * height / ih;
  const x = Math.max(left, Math.min(right, part.pivot[0]));
  const y = stage === 1 ? bottom : Math.max(top, Math.min(bottom, part.pivot[1]));
  const [requestedX, requestedY] = profile[stage], [a, bb, c, d, e, f] = matrix;
  const ratio = Math.hypot(a, bb) / cell;
  if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(Math.hypot(c, d) / cell - ratio) > 1e-10) return matrix;
  const calibration = structuralUpgradeCalibration[id];
  if (width !== 512 || height !== 512 || iw !== 256 || ih !== 256 || sprite.alphaBounds.length !== 4
    || !sprite.alphaBounds.every((value, index) => value === calibration.bounds[stage][index])
    || Math.abs(ratio - .8 / (calibration.extent * 2)) > 1e-10 || !model.parts || model.parts.length > 32) return matrix;
  let topology = structuralUpgradeTopology.get(model);
  if (topology === undefined) {
    topology = model.parts.map(layer => [layer.file, layer.parent, layer.pivot, layer.rotates ?? false].join(':')).join('|');
    structuralUpgradeTopology.set(model, topology);
  }
  if (topology !== calibration.topology) return matrix;
  const factor = calibration.factors[stage];
  const sx = 1 + factor * (requestedX - 1), sy = 1 + factor * (requestedY - 1);
  return [a * sx, bb * sx, c * sy, d * sy,
    e - (sx - 1) * a * x - (sy - 1) * c * y, f - (sx - 1) * bb * x - (sy - 1) * d * y];
}

export function paperLaserArticulationDrawMatrix(towerId: string | undefined, part: PaperPart, matrix: PaperMatrix, shotAge: number, reducedMotion = false): PaperMatrix {
  if (reducedMotion || !Number.isFinite(shotAge) || shotAge <= 0 || shotAge >= .25
    || matrix.length !== 6 || !matrix.every(Number.isFinite) || !part.pivot || part.pivot.length < 2 || !part.pivot.slice(0, 2).every(Number.isFinite)) return matrix;
  let degrees = 0, delay = 0;
  if (towerId === 'simpleLaser' && part.file === 'reflector_flap.png') degrees = 16;
  else if (towerId === 'bouncingLaser') {
    const index = ['reflector_flap_1.png', 'reflector_flap_2.png', 'reflector_flap_3.png'].indexOf(part.file);
    if (index >= 0) { degrees = [16, -18, 14][index]; delay = index * .025; }
  } else if (towerId === 'straightLaser') degrees = part.file === 'vane_left.png' ? 18 : part.file === 'vane_right.png' ? -18 : 0;
  if (!degrees || shotAge <= delay) return matrix;
  const angle = degrees * Math.PI / 180 * Math.sin(Math.PI * (shotAge - delay) / (.25 - delay)) ** 2;
  const cos = Math.cos(angle), sin = Math.sin(angle), [x, y] = part.pivot;
  const tx = x - cos * x + sin * y, ty = y - sin * x - cos * y;
  const [a, b, c, d, e, f] = matrix;
  return [a * cos + c * sin, b * cos + d * sin, c * cos - a * sin, d * cos - b * sin,
    e + a * tx + c * ty, f + b * tx + d * ty];
}

export function paperTowerSocket(model: PaperModel, pose: PaperTowerPose, socketName = 'muzzle'): Vec2 | null {
  const sockets = model.sockets;
  if (!sockets) return null;
  const name = sockets[socketName] ? socketName : socketName === 'muzzle'
    ? ['muzzle_left', 'lens_center', 'discharge', 'launch_1', 'spray_center', 'portal_center'].find(key => sockets[key]) : undefined;
  const socket = name ? sockets[name] : undefined;
  const part = socket && pose.parts.find(p => p.part.file.replace('.png', '') === socket.part);
  if (!socket || !part || socket.position.length < 2 || !socket.position.slice(0, 2).every(Number.isFinite)) return null;
  return transformPaperPoint(part.matrix, socket.position);
}

export function normalizePaperSkinColor(color?: string, defaultColor?: string): string | null {
  const normalize = (value?: string) => {
    if (!value || !/^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(value.trim())) return null;
    const hex = value.trim().toLowerCase();
    return hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
  };
  const normalized = normalize(color);
  return normalized && normalized !== normalize(defaultColor) ? normalized : null;
}

export function tintPaperPixel(pixel: ArrayLike<number>, bodyAlpha: number, accentAlpha: number, color: readonly number[]): number[] {
  const mask = Math.max(bodyAlpha, accentAlpha) / 255;
  if (!pixel[3] || mask <= 0) return [pixel[0], pixel[1], pixel[2], pixel[3]];
  const accent = accentAlpha / Math.max(1, bodyAlpha, accentAlpha);
  const shade = .55 + .45 * (pixel[0] * .2126 + pixel[1] * .7152 + pixel[2] * .0722) / 255;
  const strength = mask * .7;
  return [0, 1, 2].map(index => Math.round(pixel[index] * (1 - strength)
    + (color[index] * (1 - accent * .28) + 246 * accent * .28) * shade * strength)).concat(pixel[3]);
}

export function rememberPaperTint<T>(cache: Map<string, T>, key: string, value: T, limit = 96): void {
  if (!cache.has(key) && cache.size >= limit) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
}

export function paperContainSize(sourceWidth: number, sourceHeight: number, width: number, height: number): [number, number] | null {
  if (![sourceWidth, sourceHeight, width, height].every(Number.isFinite) || Math.min(sourceWidth, sourceHeight, width, height) <= 0) return null;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  return [sourceWidth * scale, sourceHeight * scale];
}

export interface PaperEnemyLayer {
  key: string;
  width: number;
  height: number;
  bounds: readonly number[];
}

const paperLocomotionProfiles: Record<string, { hz: number; bob: number; hinges: Record<string, [number, number]> }> = {
  soldier: { hz: 1.8, bob: .012, hinges: { leg_left: [18, 0], leg_right: [18, Math.PI], arm_left: [12, Math.PI], arm_right: [12, 0] } },
  sprinter: { hz: 3.2, bob: .018, hinges: { leg_fl: [25, 0], leg_br: [25, 0], leg_fr: [25, Math.PI], leg_bl: [25, Math.PI], tail: [10, Math.PI / 2] } },
  brute: { hz: 1.1, bob: .02, hinges: { leg_left: [14, 0], leg_right: [14, Math.PI], arm_left: [8, Math.PI], arm_right: [8, 0] } },
  shieldbearer: { hz: 1.4, bob: .008, hinges: { leg_left: [12, 0], leg_right: [12, Math.PI], arm_right: [6, 0] } },
  flyer: { hz: 3.6, bob: .015, hinges: { wing_left: [24, 0], wing_right: [-24, 0], tail: [8, Math.PI / 2] } },
  blob: { hz: 1.2, bob: .006, hinges: { paper_lobe_1: [12, 0], paper_lobe_2: [-12, Math.PI / 3], paper_lobe_3: [9, Math.PI * 2 / 3] } },
  splitter: { hz: 1, bob: .005, hinges: { shell_left: [10, 0], shell_right: [-10, 0] } },
  swarm: { hz: 4.2, bob: .006, hinges: { leg_1: [22, 0], leg_4: [22, 0], leg_5: [22, 0], leg_2: [22, Math.PI], leg_3: [22, Math.PI], leg_6: [22, Math.PI] } },
  healer: { hz: 1.3, bob: .009, hinges: { leg_left: [14, 0], leg_right: [14, Math.PI], arm_left: [8, Math.PI], lantern: [8, Math.PI / 2] } },
  support: { hz: 1.5, bob: .01, hinges: { leg_left: [15, 0], leg_right: [15, Math.PI], arm_left: [8, Math.PI], pole: [4, 0] } },
  boss: { hz: .8, bob: .015, hinges: { leg_left: [10, 0], leg_right: [10, Math.PI], arm_left: [6, Math.PI], arm_right: [6, 0], cape_part_1: [12, Math.PI / 2], cape_part_2: [12, Math.PI / 2] } },
};

export function paperEnemyWalkPhaseDelta(id: string, baseSpeed: number, distance: number): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(paperLocomotionProfiles, id)
    || ![baseSpeed, distance].every(Number.isFinite) || baseSpeed <= 0 || distance < 0) return undefined;
  const delta = distance / baseSpeed * paperLocomotionProfiles[id].hz * Math.PI * 2 * Math.max(.6, Math.min(1.4, baseSpeed / CELL_PX));
  return Number.isFinite(delta) ? delta : undefined;
}

export function paperEnemyPose(model: PaperModel, layers: readonly PaperEnemyLayer[],
  enemy: Pick<Enemy, 'id' | 'uid' | 'pos' | 'speed' | 'paletteVariant' | 'visualScale' | 'stunUntil'>,
  time: number, moving: boolean, cell: number, reducedMotion = false, walkPhase?: number) {
  const [width, height] = model.canvas;
  if (!model.pivots || !layers.length || ![width, height, enemy.pos.x, enemy.pos.y, enemy.speed, time, cell].every(Number.isFinite)
    || Math.min(width, height, cell) <= 0) return null;
  const masterBounds = layers.map(layer => ({ key: layer.key, bounds: layer.bounds.map((value, index) =>
    value * (index % 2 === 0 ? width / layer.width : height / layer.height)) }));
  if (layers.some(layer => layer.bounds.length !== 4 || ![layer.width, layer.height, ...layer.bounds].every(Number.isFinite)
    || Math.min(layer.width, layer.height) <= 0 || layer.bounds[2] <= layer.bounds[0] || layer.bounds[3] <= layer.bounds[1])) return null;
  const visible = masterBounds.filter(layer => layer.key !== 'shadow');
  if (!visible.length) return null;
  const extent = Math.max(Math.max(...visible.map(l => l.bounds[2])) - Math.min(...visible.map(l => l.bounds[0])),
    Math.max(...visible.map(l => l.bounds[3])) - Math.min(...visible.map(l => l.bounds[1])));
  const variant = Math.max(0, Math.min(3, Math.floor(enemy.paletteVariant ?? 0)));
  const variantScale = Math.max(.6, Math.min(1.35, enemy.visualScale ?? 1 + variant * .04));
  const scale = cell * (enemy.id === 'boss' ? 1.05 : .62) * variantScale / extent;
  if (![extent, variant, scale].every(Number.isFinite) || extent <= 0 || scale <= 0) return null;
  const profile = Object.prototype.hasOwnProperty.call(paperLocomotionProfiles, enemy.id) ? paperLocomotionProfiles[enemy.id] : undefined;
  const active = !!profile && moving && !reducedMotion && enemy.speed > 0 && !(enemy.stunUntil! > time);
  const phase = active ? Number.isFinite(walkPhase) ? walkPhase! % (Math.PI * 2)
    : time * profile.hz * Math.PI * 2 * Math.max(.6, Math.min(1.4, enemy.speed / CELL_PX))
      + enemy.uid.split('').reduce((n, c) => n + c.charCodeAt(0), 0) : 0;
  const bob = active ? -Math.abs(Math.sin(phase)) * profile.bob * cell : 0;
  const hingeAngle = (key: string) => {
    const hinge = active && Object.prototype.hasOwnProperty.call(profile.hinges, key) ? profile.hinges[key] : undefined;
    return hinge ? Math.sin(phase + hinge[1]) * hinge[0] * Math.PI / 180 : 0;
  };
  const rotate = (angle: number, pivot: readonly number[]): PaperMatrix => {
    const cos = Math.cos(angle), sin = Math.sin(angle);
    return [cos, sin, -sin, cos, pivot[0] - cos * pivot[0] + sin * pivot[1], pivot[1] - sin * pivot[0] - cos * pivot[1]];
  };
  const order = (key: string) => key === 'shadow' ? -1 : /leg|cape|tail/.test(key) ? 0 : /body|core/.test(key) ? 1 : /head|face/.test(key) ? 2 : 3;
  const points: Vec2[] = [];
  const parts = [...masterBounds].sort((a, b) => order(a.key) - order(b.key)).map(layer => {
    const key = layer.key;
    const pivot = Object.prototype.hasOwnProperty.call(model.pivots, key) ? model.pivots![key] : [width / 2, height / 2];
    if (pivot.length < 2 || !pivot.slice(0, 2).every(Number.isFinite)) return { key, matrix: [NaN, 0, 0, 0, 0, 0] as PaperMatrix };
    let local = rotate(hingeAngle(key), pivot);
    if (enemy.id === 'boss' && /^cape_part_[12]$/.test(key)) {
      const left = model.pivots!.cape_part_1, right = model.pivots!.cape_part_2;
      if (Object.prototype.hasOwnProperty.call(model.pivots, 'cape_part_1') && Object.prototype.hasOwnProperty.call(model.pivots, 'cape_part_2')
        && left.length >= 2 && right.length >= 2 && [...left.slice(0, 2), ...right.slice(0, 2)].every(Number.isFinite)) {
        local = rotate(hingeAngle(key), [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2]);
      }
    }
    const parent = enemy.id === 'healer' && /^lantern_flap_[12]$/.test(key) ? 'lantern'
      : enemy.id === 'support' && /^(flag|fold_[12])$/.test(key) ? 'pole' : undefined;
    if (parent && Object.prototype.hasOwnProperty.call(model.pivots, parent)) {
      const parentPivot = model.pivots![parent];
      if (parentPivot.length < 2 || !parentPivot.slice(0, 2).every(Number.isFinite)) return { key, matrix: [NaN, 0, 0, 0, 0, 0] as PaperMatrix };
      const p = rotate(hingeAngle(parent), parentPivot), [a, b, c, d, e, f] = local;
      local = [p[0] * a + p[2] * b, p[1] * a + p[3] * b, p[0] * c + p[2] * d, p[1] * c + p[3] * d,
        p[0] * e + p[2] * f + p[4], p[1] * e + p[3] * f + p[5]];
    }
    const matrix: PaperMatrix = [local[0] * scale, local[1] * scale, local[2] * scale, local[3] * scale,
      enemy.pos.x + scale * (local[4] - width / 2), enemy.pos.y + scale * (local[5] - height / 2) + (key === 'shadow' ? 0 : bob)];
    if (key !== 'shadow') {
      const [left, top, right, bottom] = layer.bounds;
      points.push(...[[left, top], [right, top], [right, bottom], [left, bottom]].map(p => transformPaperPoint(matrix, p)));
    }
    return { key, matrix };
  });
  if (parts.some(part => !part.matrix.every(Number.isFinite))) return null;
  const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
  return { scale, variant, parts, bounds: { x, y,
    width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y } };
}
