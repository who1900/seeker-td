import { useEffect, useState, createElement } from 'react';
import type { Enemy, PlacedTower, Vec2 } from './types';
import { CELL_PX } from './data';
import { SKINS, TOWER_FAMILY } from '../state/store';
import { normalizePaperSkinColor, paperContainSize, paperEnemyPose, paperTowerPose, paperTowerSocket, paperEnhancementDrawMatrix, paperStructuralUpgradeDrawMatrix, paperLaserArticulationDrawMatrix, rememberPaperTint, tintPaperPixel } from './paperGeometry';
import type { PaperModel } from './paperGeometry';
import { paperLateUpgradeDrawCommands } from './paperLateUpgrade';
import { paperBeamTiles } from './paperBeamGeometry';
import type { PaperBeamStrip, PaperBeamViewport } from './paperBeamGeometry';
import { PAPER_ENVIRONMENT_PATHS, paperEnvironmentFiles, paperEnvironmentBounds, paperEnvironmentPose } from './paperEnvironment';
import type { PaperEnvironmentId, PaperEnvironmentModel } from './paperEnvironment';

interface Manifest { towers: Record<string, PaperModel>; mobs: Record<string, PaperModel>; projectiles?: Record<string, unknown>; beam_strips?: Record<string, unknown>; environment?: { structures?: Partial<Record<PaperEnvironmentId, PaperEnvironmentModel>> } }
interface Sprite { image: HTMLImageElement; bounds: number[]; alphaBounds?: number[]; lateUpgrade?: typeof paperLateUpgradeDrawCommands }
const root = `${import.meta.env.BASE_URL}paper-assets/`;
const sprites = new Map<string, Sprite>();
const tintedParts = new Map<string, HTMLCanvasElement>();
const towerTints = new Map<string, HTMLCanvasElement | HTMLImageElement>();
const towerTintUrls = new Map<string, string>();
const maskPixels = new Map<string, Uint8ClampedArray>();
const groundPatterns = new WeakMap<CanvasRenderingContext2D, CanvasPattern>();
export const PAPER_FX_PATHS = [
  'armor_status', 'buff_ribbon', 'buff_status', 'buff_symbol', 'build_fold_piece', 'chain_contact', 'dust_mark',
  'glue_spray_drop', 'heal_spark', 'heal_status', 'heal_symbol', 'hit_bullet_mark', 'hit_laser_mark',
  'muzzle_heavy', 'muzzle_small', 'portal_fold_segment', 'portal_inner', 'portal_ring', 'rocket_exhaust',
  'shield_contact', 'slow_ribbon', 'slow_status', 'upgrade_fold_piece',
  ...Array.from({ length: 4 }, (_, i) => `explosion_petal_${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 3 }, (_, i) => `glue_splat_${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 3 }, (_, i) => `smoke_puff_${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 12 }, (_, i) => `paper_scrap_${String(i + 1).padStart(2, '0')}`),
].map(name => `fx_parts/${name}.png`);
let manifest: Manifest | undefined;
let loading: Promise<void> | undefined;
let attempts = 0;
let generation = 0;
export const PAPER_ASSET_TIMEOUT_MS = 12000;
let status = 'loading';
const listeners = new Set<() => void>();
export const paperUrl = (path: string) => `${root}runtime/${path}`;

function load(path: string, currentGeneration = generation) {
  return new Promise<void>((resolve, reject) => {
    const image = new Image();
    let finished = false;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      image.onload = null; image.onerror = null;
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`Asset timeout: ${path}`)), PAPER_ASSET_TIMEOUT_MS);
    image.onload = () => {
      if (finished || currentGeneration !== generation) { finish(new Error('Stale asset attempt')); return; }
      try {
        const canvas = document.createElement('canvas');
        canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
        let left = image.width, top = image.height, right = 0, bottom = 0;
        const alphaBounds = [image.width, image.height, 0, 0];
        for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
          if (pixels[(y * image.width + x) * 4 + 3] > 0) {
            alphaBounds[0] = Math.min(alphaBounds[0], x); alphaBounds[1] = Math.min(alphaBounds[1], y);
            alphaBounds[2] = Math.max(alphaBounds[2], x + 1); alphaBounds[3] = Math.max(alphaBounds[3], y + 1);
          }
          if (pixels[(y * image.width + x) * 4 + 3] > 24) {
            left = Math.min(left, x); top = Math.min(top, y);
            right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
          }
        }
        if (right <= left) throw new Error(`Empty asset: ${path}`);
        sprites.set(path, { image, bounds: [left, top, right, bottom], alphaBounds });
        if (path === 'towers/rocketLauncher/enhancement_2.png') sprites.get(path)!.lateUpgrade = paperLateUpgradeDrawCommands;
        if (/^mobs\/soldier\/(front|back)\/(body|leg_left|leg_right|bag)\.png$/.test(path)) {
          for (const variant of [0, 1, 2, 3]) tintedPart(path, variant);
        }
        finish();
      } catch (error) { finish(error); }
    };
    image.onerror = () => finish(new Error(path));
    image.src = paperUrl(path);
  });
}

export function canRetryPaperAssets() {
  return status !== 'loading' && status !== 'ready' && attempts < 3;
}

export function loadPaperAssets({ retry = false }: { retry?: boolean } = {}) {
  if (retry && canRetryPaperAssets()) loading = undefined;
  if (!loading) {
    attempts++;
    const currentGeneration = ++generation;
    status = 'loading';
    loading = (async () => {
    try {
      if (!manifest) {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            (async () => {
              const response = await fetch(`${root}manifest.json`, { signal: controller.signal });
              if (!response.ok) throw new Error('Manifest unavailable');
              return await response.json() as Manifest;
            })(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => { controller.abort(); reject(new Error('Manifest timeout')); }, PAPER_ASSET_TIMEOUT_MS);
            }),
          ]);
          if (currentGeneration !== generation) return;
          manifest = result;
        } finally { clearTimeout(timer); }
      }
      const paths: string[] = [];
      for (const [id, model] of Object.entries(manifest!.towers)) {
        paths.push(...model.parts!.map(p => `towers/${id}/${p.file}`), `towers/${id}/icon.png`, `towers/${id}/preview.png`);
        paths.push(...(model.masks ?? ['body_mask.png', 'accent_mask.png']).map(file => `towers/${id}/${file}`));
      }
      for (const id of Object.keys(manifest!.mobs)) {
        for (const view of id === 'soldier' ? ['front', 'back'] : ['front']) {
          paths.push(...['shadow', ...Object.keys(manifest!.mobs[id].pivots ?? {})].filter(p => view !== 'back' || !p.startsWith('arm_')).map(p => `mobs/${id}/${view}/${p}.png`));
          if (view === 'front') paths.push(`mobs/${id}/${view}/body_mask.png`, `mobs/${id}/${view}/accent_mask.png`);
        }
      }
      paths.push('ui/illustrations/home_hero.png', 'ui/illustrations/armory_pedestal.png', 'branding/wordmark.png');
      paths.push(...Object.keys(manifest!.projectiles ?? {}).map(name => `projectiles/${name}.png`),
        ...Object.keys(manifest!.beam_strips ?? {}).map(name => `projectiles/${name}.png`), ...PAPER_FX_PATHS, ...PAPER_ENVIRONMENT_PATHS);
      const pending = [...new Set(paths)].filter(path => !sprites.has(path));
      const results = await Promise.allSettled(pending.map(path => load(path, currentGeneration)));
      if (currentGeneration !== generation) return;
      const failures = pending.filter((_, index) => results[index].status === 'rejected');
      if (failures.length) console.warn('Paper assets failed:', failures);
      status = failures.length ? `Paper assets failed: ${failures.join(', ')} — fallback active` : 'ready';
    } catch { if (currentGeneration !== generation) return; status = 'Paper assets unavailable — fallback active'; }
    listeners.forEach(listener => listener());
    })();
    listeners.forEach(listener => listener());
  }
  return loading;
}

export function usePaperAssets() {
  const [value, setValue] = useState(status);
  useEffect(() => {
    const update = () => setValue(status);
    listeners.add(update); void loadPaperAssets(); update();
    return () => { listeners.delete(update); };
  }, []);
  return value;
}

export function PaperImage({ path, label, width = 80, height = typeof width === 'number' ? width : 80, skinColor }: { path: string; label: string; width?: number | string; height?: number; skinColor?: string }) {
  usePaperAssets();
  const sprite = sprites.get(path);
  if (!sprite) return createElement('span', { role: 'img', 'aria-label': label, style: { display: 'inline-block', minHeight: height, fontSize: 12 } }, status === 'loading' ? '…' : `${label} · image unavailable`);
  const towerId = path.startsWith('towers/') ? path.split('/')[1] : undefined;
  const model = towerId ? manifest?.towers[towerId] : undefined;
  const modelBounds = model?.parts?.filter(p => p.file !== 'shadow.png' && !p.optional).map(p => sprites.get(`towers/${towerId}/${p.file}`)?.bounds).filter((b): b is number[] => !!b);
  const bounds = modelBounds?.length && path.endsWith('/preview.png') ? [Math.min(...modelBounds.map(b => b[0])), Math.min(...modelBounds.map(b => b[1])), Math.max(...modelBounds.map(b => b[2])), Math.max(...modelBounds.map(b => b[3]))] : sprite.bounds;
  const [x, y, r, b] = bounds;
  const color = paperSkinColor(path, skinColor);
  let href = sprite.image.src;
  if (color) {
    const tinted = tintedTowerPart(path, color);
    if (tinted instanceof HTMLCanvasElement) {
      const key = `${path}:${color}`;
      href = towerTintUrls.get(key) ?? tinted.toDataURL();
      if (!towerTintUrls.has(key)) {
        rememberPaperTint(towerTintUrls, key, href, 48);
      }
    }
  }
  return createElement('svg', { width, height, viewBox: `${x} ${y} ${r - x} ${b - y}`, role: 'img', 'aria-label': label },
    createElement('image', { href, width: sprite.image.width, height: sprite.image.height }));
}

function paperSkinColor(path: string, color?: string) {
  if (!path.startsWith('towers/') || path.endsWith('/shadow.png')) return null;
  const family = TOWER_FAMILY[path.split('/')[1]];
  return normalizePaperSkinColor(color, SKINS.find(skin => skin.family === family && skin.price === 0)?.color);
}

function getMaskPixels(path: string, width: number, height: number) {
  const key = `${path}:${width}:${height}`;
  const cached = maskPixels.get(key);
  if (cached) return cached;
  const sprite = sprites.get(path);
  if (!sprite) return null;
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(sprite.image, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height).data;
  maskPixels.set(key, pixels); return pixels;
}

function tintedTowerPart(path: string, color: string): HTMLImageElement | HTMLCanvasElement {
  const sprite = sprites.get(path)!;
  if (path.endsWith('/shadow.png')) return sprite.image;
  const key = `${path}:${color}`;
  const cached = towerTints.get(key);
  if (cached) return cached;
  const { width, height } = sprite.image;
  const directory = path.slice(0, path.lastIndexOf('/') + 1);
  const body = getMaskPixels(directory + 'body_mask.png', width, height);
  const accent = getMaskPixels(directory + 'accent_mask.png', width, height);
  if (!body || !accent) return sprite.image;
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d')!; ctx.drawImage(sprite.image, 0, 0);
  const pixels = ctx.getImageData(0, 0, width, height);
  const rgb = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
  let affected = false;
  for (let i = 0; i < pixels.data.length; i += 4) {
    if (!pixels.data[i + 3] || (!body[i + 3] && !accent[i + 3])) continue;
    const tinted = tintPaperPixel(pixels.data.subarray(i, i + 4), body[i + 3], accent[i + 3], rgb);
    pixels.data.set(tinted, i);
    affected = true;
  }
  if (!affected) {
    rememberPaperTint(towerTints, key, sprite.image);
    return sprite.image;
  }
  ctx.putImageData(pixels, 0, 0);
  rememberPaperTint(towerTints, key, canvas); return canvas;
}

export function soldierBackTintColor(path: string, variant: number): number[] | null {
  const part = /^mobs\/soldier\/(?:front|back)\/(body|leg_left|leg_right|bag)\.png$/.exec(path)?.[1];
  if (!part || !Number.isInteger(variant) || variant < 0 || variant > 3) return null;
  if (variant === 0) return [0, 0, 0];
  const colors = variant === 1 ? ['#c1b2a1', '#b2a4be'] : variant === 2 ? ['#a4b1bc', '#b2b899'] : ['#bca3a0', '#c0af8c'];
  return colors[part === 'bag' ? 1 : 0].slice(1).match(/../g)!.map(value => parseInt(value, 16));
}

export function soldierBackTintPixel(pixel: ArrayLike<number>, color: readonly number[]): number[] {
  const original = [pixel[0], pixel[1], pixel[2], pixel[3]];
  if (!pixel[3] || color.length !== 3 || !color.every(value => Number.isFinite(value) && value >= 0 && value <= 255)) return original;
  const luminance = (rgb: ArrayLike<number>) => rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  const light = luminance(pixel);
  if (light <= 90) return original;
  const targetLuminance = luminance(color);
  const delta = color.map(value => (value - targetLuminance) * .18);
  const shade = 24 * Math.max(0, Math.min(1, (light - 190) / 40));
  const strength = Math.min(1, ...delta.map((value, index) => value > 0 ? (255 - pixel[index] + shade) / value
    : value < 0 ? -pixel[index] / value : 1));
  return delta.map((value, index) => Math.round(pixel[index] - shade + value * strength)).concat(pixel[3]);
}

function tintedPart(path: string, variant: number): CanvasImageSource {
  const sprite = sprites.get(path)!;
  const match = /^mobs\/([^/]+)\/(front|back)\/([^/]+)\.png$/.exec(path);
  const backColor = soldierBackTintColor(path, variant);
  if (!Number.isInteger(variant) || variant < 0 || variant > 3 || !match
    || (!backColor && (variant === 0 || match[1] === 'soldier'))
    || !manifest?.mobs[match[1]]?.pivots?.[match[3]] || (match[2] === 'back' && !backColor)) return sprite.image;
  const key = `${path}:${variant}`;
  const cached = tintedParts.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = sprite.image.width; canvas.height = sprite.image.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(sprite.image, 0, 0);
  if (backColor) {
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      pixels.data.set(soldierBackTintPixel(pixels.data.subarray(i, i + 4), backColor), i);
    }
    ctx.putImageData(pixels, 0, 0);
    tintedParts.set(key, canvas); return canvas;
  }
  const directory = path.slice(0, path.lastIndexOf('/') + 1);
  const colors = variant === 1 ? ['#c1b2a1', '#b2a4be'] : variant === 2 ? ['#a4b1bc', '#b2b899'] : ['#bca3a0', '#c0af8c'];
  for (const [maskName, color] of [['body_mask.png', colors[0]], ['accent_mask.png', colors[1]]]) {
    const mask = sprites.get(directory + maskName);
    if (!mask) continue;
    const overlay = document.createElement('canvas');
    overlay.width = canvas.width; overlay.height = canvas.height;
    const paint = overlay.getContext('2d')!;
    paint.drawImage(mask.image, 0, 0); paint.globalCompositeOperation = 'source-in';
    paint.fillStyle = color; paint.fillRect(0, 0, canvas.width, canvas.height);
    paint.globalCompositeOperation = 'destination-in'; paint.drawImage(sprite.image, 0, 0);
    ctx.globalAlpha = .18; ctx.drawImage(overlay, 0, 0);
  }
  tintedParts.set(key, canvas); return canvas;
}

function towerGeometry(tower: PlacedTower, angle: number, shotAge: number, cell: number) {
  const model = manifest?.towers[tower.towerId];
  if (!model?.parts) return null;
  const path = `towers/${tower.towerId}/`;
  const base = model.parts.find(p => p.file === 'base.png' || p.file === 'pedestal.png');
  const sprite = base && sprites.get(path + base.file);
  if (!sprite) return null;
  const pose = paperTowerPose(model, sprite.bounds, tower, angle, shotAge, cell, sprite.image.width);
  if (!pose || pose.parts.some(p => !sprites.has(path + p.part.file))) return null;
  return { model, path, pose };
}

export function getPaperTowerSocket(tower: PlacedTower, angle: number, shotAge: number, cell: number, socketName = 'muzzle'): Vec2 | null {
  const geometry = towerGeometry(tower, angle, shotAge, cell);
  return geometry ? paperTowerSocket(geometry.model, geometry.pose, socketName) : null;
}

export function drawPaperTower(ctx: CanvasRenderingContext2D, tower: PlacedTower, angle: number, shotAge: number, cell: number, skinColor?: string, reducedMotion = false): boolean {
  const geometry = towerGeometry(tower, angle, shotAge, cell);
  if (!geometry) return false;
  const { model, path, pose } = geometry;
  for (const { part: layer, matrix } of pose.parts) {
    const sprite = sprites.get(path + layer.file)!;
    const color = paperSkinColor(path + layer.file, skinColor);
    const drawMatrix = paperLaserArticulationDrawMatrix(tower.towerId, layer,
      paperStructuralUpgradeDrawMatrix(tower.towerId, layer, model, sprite,
        paperEnhancementDrawMatrix(tower.towerId, layer, model, sprite, matrix),
        { x: tower.worldX, y: tower.worldY }, cell), shotAge, reducedMotion);
    const commands = sprite.lateUpgrade?.(tower, layer, model, sprite, drawMatrix, cell);
    const image = color ? tintedTowerPart(path + layer.file, color) : sprite.image;
    if (commands) {
      for (const command of commands) {
        ctx.save(); ctx.transform(...command.matrix);
        ctx.drawImage(image, ...command.source, ...command.destination); ctx.restore();
      }
    } else {
      ctx.save(); ctx.globalAlpha *= layer.file === 'shadow.png' ? .16 : 1;
      ctx.transform(...drawMatrix);
      ctx.drawImage(image, 0, 0, model.canvas[0], model.canvas[1]); ctx.restore();
    }
  }
  return true;
}

// Sprite angle preserves native art: projectiles point UP, beam strips point RIGHT.
export function drawPaperSprite(ctx: CanvasRenderingContext2D, path: string, x: number, y: number, width: number, height = width, angle = 0, alpha = 1): boolean {
  const sprite = sprites.get(path);
  if (!sprite || ![x, y, width, height, angle, alpha].every(Number.isFinite) || width <= 0 || height <= 0) return false;
  const strip = !!manifest?.beam_strips?.[path.split('/').pop()!.replace('.png', '')];
  const [left, top, right, bottom] = strip ? [0, 0, sprite.image.width, sprite.image.height] : sprite.bounds;
  const size = strip ? [width, height] : paperContainSize(right - left, bottom - top, width, height);
  if (!size) return false;
  ctx.save(); ctx.globalAlpha *= Math.max(0, Math.min(1, alpha)); ctx.translate(x, y); ctx.rotate(angle);
  ctx.drawImage(sprite.image, left, top, right - left, bottom - top, -size[0] / 2, -size[1] / 2, size[0], size[1]);
  ctx.restore(); return true;
}

export function canDrawPaperLaserFx(kind: string): boolean {
  const strip = kind === 'chain' ? 'beam_simple_strip' : kind === 'chain_bounce' ? 'beam_chain_strip' : kind === 'chain_straight' ? 'beam_pierce_strip' : undefined;
  return !!strip && !!manifest?.beam_strips?.[strip] && sprites.has(`projectiles/${strip}.png`)
    && (kind === 'chain_straight' || sprites.has(`fx_parts/${kind === 'chain_bounce' ? 'chain_contact' : 'hit_laser_mark'}.png`));
}

export function drawPaperBeam(ctx: CanvasRenderingContext2D, path: string, from: Vec2, to: Vec2, width: number, alpha = 1, viewport?: PaperBeamViewport, visibleRange?: readonly number[]): boolean {
  const sprite = sprites.get(path);
  const strip = manifest?.beam_strips?.[path.split('/').pop()!.replace('.png', '')];
  if (!sprite || !strip || !Number.isFinite(alpha)) return false;
  const plan = paperBeamTiles(strip as PaperBeamStrip, sprite.image, sprite.bounds, from, to, width, viewport, visibleRange);
  if (!plan) return false;
  ctx.save(); ctx.globalAlpha *= Math.max(0, Math.min(1, alpha));
  ctx.translate(plan.from.x, plan.from.y); ctx.rotate(plan.angle);
  for (const tile of plan.tiles) ctx.drawImage(sprite.image, tile.sx, tile.sy, tile.sw, tile.sh, tile.x, tile.y, tile.width, tile.height);
  ctx.restore(); return true;
}

export function drawPaperGround(ctx: CanvasRenderingContext2D, gridW: number, gridH: number, cell = CELL_PX): boolean {
  const sprite = sprites.get('environment/paper_field.png');
  if (!sprite || ![gridW, gridH, cell].every(n => Number.isFinite(n) && n > 0)) return false;
  const pattern = groundPatterns.get(ctx) ?? ctx.createPattern(sprite.image, 'repeat');
  if (!pattern) return false;
  groundPatterns.set(ctx, pattern);
  const scale = cell * 16 / sprite.image.width;
  ctx.save(); ctx.globalAlpha *= .38; ctx.scale(scale, scale); ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, gridW * cell / scale, gridH * cell / scale); ctx.restore();
  return true;
}

export function drawPaperEnvironmentStructure(ctx: CanvasRenderingContext2D, id: PaperEnvironmentId, gridCell: Vec2, cell = CELL_PX): boolean {
  const model = manifest?.environment?.structures?.[id];
  const files = model && paperEnvironmentFiles(id, model.parts);
  if (!model || !files || files.some(path => !sprites.has(path))) return false;
  const layers = files.map(path => sprites.get(path)!);
  const bounds = paperEnvironmentBounds(model.canvas, layers.map(layer => ({ width: layer.image.width, height: layer.image.height, bounds: layer.bounds })));
  const pose = bounds && paperEnvironmentPose(bounds, gridCell, cell);
  if (!pose) return false;
  ctx.save(); ctx.beginPath(); ctx.rect(pose.clip.x, pose.clip.y, pose.clip.width, pose.clip.height); ctx.clip();
  ctx.transform(...pose.matrix);
  for (let i = 0; i < layers.length; i++) {
    ctx.save(); ctx.globalAlpha *= files[i].endsWith('_shadow.png') ? .14 : 1;
    ctx.drawImage(layers[i].image, 0, 0, model.canvas[0], model.canvas[1]); ctx.restore();
  }
  ctx.restore(); return true;
}

function enemyGeometry(enemy: Enemy, time: number, heading: number, moving: boolean, cell: number, reducedMotion = false, walkPhase?: number) {
  if (!manifest?.mobs || !Object.prototype.hasOwnProperty.call(manifest.mobs, enemy.id)) return null;
  const model = manifest.mobs[enemy.id];
  if (!model?.pivots || !Number.isFinite(heading)) return null;
  const path = `mobs/${enemy.id}/${enemy.id === 'soldier' && Math.sin(heading) < 0 ? 'back' : 'front'}/`;
  const keys = ['shadow', ...Object.keys(model.pivots)].filter(key => !path.includes('/back/') || !key.startsWith('arm_'));
  if (keys.some(key => !sprites.has(`${path}${key}.png`))) return null;
  const layers = keys.map(key => {
    const sprite = sprites.get(`${path}${key}.png`)!;
    return { key, width: sprite.image.width, height: sprite.image.height, bounds: sprite.bounds };
  });
  const pose = paperEnemyPose(model, layers, enemy, time, moving, cell, reducedMotion, walkPhase);
  return pose ? { model, path, pose } : null;
}

export function createPaperEnemyFrame() {
  const geometries = new WeakMap<Enemy, { inputs: unknown[]; geometry: ReturnType<typeof enemyGeometry> }>();
  return (enemy: Enemy, time: number, heading: number, moving: boolean, cell: number, reducedMotion = false, walkPhase?: number) => {
    const inputs = [manifest, sprites.size, enemy.id, enemy.uid, enemy.pos.x, enemy.pos.y, enemy.speed, enemy.paletteVariant, enemy.visualScale, enemy.stunUntil, time, heading, moving, cell, reducedMotion, walkPhase];
    const cached = geometries.get(enemy);
    if (cached && inputs.every((value, index) => Object.is(value, cached.inputs[index]))) return cached.geometry;
    const geometry = enemyGeometry(enemy, time, heading, moving, cell, reducedMotion, walkPhase);
    geometries.set(enemy, { inputs, geometry });
    return geometry;
  };
}

// World-space envelope of transformed alpha>24 rectangles, excluding shadow.
export function getPaperEnemyVisibleBounds(enemy: Enemy, time: number, heading: number, moving: boolean, cell: number, frame?: ReturnType<typeof createPaperEnemyFrame>, reducedMotion = false, walkPhase?: number): { x: number; y: number; width: number; height: number } | null {
  return (frame ?? enemyGeometry)(enemy, time, heading, moving, cell, reducedMotion, walkPhase)?.pose.bounds ?? null;
}

export function drawPaperEnemy(ctx: CanvasRenderingContext2D, enemy: Enemy, time: number, heading: number, moving: boolean, cell: number, frame?: ReturnType<typeof createPaperEnemyFrame>, reducedMotion = false, walkPhase?: number) {
  const geometry = (frame ?? enemyGeometry)(enemy, time, heading, moving, cell, reducedMotion, walkPhase);
  if (!geometry) return false;
  const { model, path, pose } = geometry;
  ctx.save();
  for (const { key, matrix } of pose.parts) {
    ctx.save(); ctx.globalAlpha *= key === 'shadow' ? .14 : 1;
    ctx.filter = key !== 'shadow' && (enemy.hitFlash ?? 0) > 0 ? 'brightness(1.8)' : 'none';
    ctx.transform(...matrix);
    ctx.drawImage(tintedPart(`${path}${key}.png`, pose.variant), 0, 0, model.canvas[0], model.canvas[1]);
    ctx.restore();
  }
  ctx.restore(); return true;
}
