import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { createSourceFile, isFunctionDeclaration, transpileModule, ModuleKind, ScriptTarget, ScriptKind } from 'typescript';
import { normalizePaperSkinColor, paperContainSize, paperTowerPose, paperTowerSocket, paperEnhancementDrawMatrix, paperStructuralUpgradeDrawMatrix, paperLaserArticulationDrawMatrix, rememberPaperTint, tintPaperPixel, transformPaperPoint } from './paperGeometry';
import type { PaperModel } from './paperGeometry';
import { paperBeamTiles } from './paperBeamGeometry';

let assertions = 0;
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
  assertions++;
}
function near(actual: number, expected: number, message: string) {
  check(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} != ${expected}`);
}

function pngBounds(file: string): { width: number; bounds: number[] } {
  const png = readFileSync(file);
  check(png.subarray(1, 4).toString() === 'PNG', 'PNG signature');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  check(png[24] === 8 && png[25] === 6 && png[28] === 0, 'expected non-interlaced RGBA8 runtime PNG');
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.subarray(offset + 4, offset + 8).toString() === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const bytes = inflateSync(Buffer.concat(chunks));
  const stride = width * 4, decoded = new Uint8Array(stride * height);
  let left = width, top = height, right = 0, bottom = 0;
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c);
    return x <= y && x <= z ? a : y <= z ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = bytes[y * (stride + 1)];
    check(filter <= 4, 'PNG row filter');
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const a = x >= 4 ? decoded[index - 4] : 0;
      const b = y ? decoded[index - stride] : 0;
      const c = y && x >= 4 ? decoded[index - stride - 4] : 0;
      const prediction = filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ? paeth(a, b, c) : 0;
      decoded[index] = bytes[y * (stride + 1) + x + 1] + prediction;
      if (x % 4 === 3 && decoded[index] > 24) {
        const px = Math.floor(x / 4);
        left = Math.min(left, px); top = Math.min(top, y);
        right = Math.max(right, px + 1); bottom = Math.max(bottom, y + 1);
      }
    }
  }
  return { width, bounds: [left, top, right, bottom] };
}

const manifest = JSON.parse(readFileSync('public/paper-assets/manifest.json', 'utf8')) as { towers: Record<string, PaperModel>; beam_strips: Record<string, unknown> };
const assetSource = createSourceFile('paperAssets.ts', readFileSync('src/game/paperAssets.ts', 'utf8'), ScriptTarget.Latest, true, ScriptKind.TS);
const drawingSource = assetSource.statements.filter(statement => isFunctionDeclaration(statement)
  && ['drawPaperTower', 'getPaperTowerSocket', 'drawPaperSprite', 'drawPaperBeam'].includes(statement.name?.text ?? '')).map(statement => statement.getText(assetSource)).join('\n');
const drawingExports: Record<string, (...args: unknown[]) => unknown> = {};
const drawingSprites = new Map<string, { image: { width: number; height: number }; bounds: number[] }>();
let drawingGeometry: { model: PaperModel; path: string; pose: NonNullable<ReturnType<typeof paperTowerPose>> } | null = null;
new Function('exports', 'sprites', 'manifest', 'towerGeometry', 'paperTowerSocket', 'paperSkinColor', 'tintedTowerPart', 'paperContainSize', 'paperEnhancementDrawMatrix', 'paperStructuralUpgradeDrawMatrix', 'paperLaserArticulationDrawMatrix', 'paperBeamTiles', transpileModule(drawingSource,
  { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020 } }).outputText)(drawingExports, drawingSprites,
  { beam_strips: manifest.beam_strips }, () => drawingGeometry, paperTowerSocket, () => null, () => { throw new Error('default must not tint'); }, paperContainSize, paperEnhancementDrawMatrix, paperStructuralUpgradeDrawMatrix, paperLaserArticulationDrawMatrix, paperBeamTiles);
const drawCalls: unknown[][] = [], drawMatrices: number[][] = [], rotations: number[] = [], translations: number[][] = [], alphas: number[] = [], alphaStack: number[] = [];
const drawContext = {
  globalAlpha: 1,
  save() { alphaStack.push(this.globalAlpha); }, restore() { this.globalAlpha = alphaStack.pop()!; },
  transform(...matrix: number[]) { drawMatrices.push(matrix); },
  translate(...point: number[]) { translations.push(point); }, rotate(angle: number) { rotations.push(angle); },
  drawImage(...args: unknown[]) { drawCalls.push(args); alphas.push(this.globalAlpha); },
};
check(Object.keys(manifest.towers).length === 12, 'all twelve models');
const tower = { worldX: 119, worldY: 203, level: 0 };
const defaultSockets: Record<string, string> = {
  canon: 'muzzle', dualCanon: 'muzzle_left', machineGun: 'muzzle', simpleLaser: 'muzzle',
  bouncingLaser: 'lens_center', straightLaser: 'muzzle', mortar: 'muzzle', mineLayer: 'discharge',
  rocketLauncher: 'launch_1', glueTower: 'spray_center', glueGun: 'muzzle', teleporter: 'portal_center',
};
let poses = 0;
for (const [id, model] of Object.entries(manifest.towers)) {
  const base = model.parts!.find(p => p.file === 'base.png' || p.file === 'pedestal.png')!;
  const runtime = pngBounds(`public/paper-assets/runtime/towers/${id}/${base.file}`);
  const partBounds = new Map(model.parts!.map(part => [part.file, pngBounds(`public/paper-assets/runtime/towers/${id}/${part.file}`)]));
  const expectedScale = 34 * .8 / ((runtime.bounds[2] - runtime.bounds[0]) * 2);
  for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    for (const level of [0, 2, 5]) for (const shotAge of [-1, .08, .16]) for (const cell of [28, 34]) {
      const placed = { ...tower, towerId: id, level };
      const pose = paperTowerPose(model, runtime.bounds, placed, angle, shotAge, cell, runtime.width);
      check(pose, `pose ${id}`); poses++;
      const path = `towers/${id}/`;
      for (const layer of pose.parts) {
        const asset = partBounds.get(layer.part.file)!;
        drawingSprites.set(path + layer.part.file, { image: { width: asset.width, height: asset.width }, bounds: asset.bounds });
      }
      drawingGeometry = { model, path, pose };
      drawMatrices.length = 0; drawCalls.length = 0; alphas.length = 0;
      check(drawingExports.drawPaperTower(drawContext, placed, angle, shotAge, cell) === true, 'actual tower draw API');
      check(drawMatrices.length === pose.parts.length, 'draw all visible layers');
      for (let i = 0; i < pose.parts.length; i++) {
        const part = pose.parts[i];
        const enhanced = paperEnhancementDrawMatrix(id, part.part, model, drawingSprites.get(path + part.part.file)!, part.matrix);
        const expected = paperLaserArticulationDrawMatrix(id, part.part, enhanced, shotAge);
        check(JSON.stringify(drawMatrices[i]) === JSON.stringify(expected), 'actual renderer uses exact enhancement draw matrix');
        if (expected === part.matrix) {
          check(JSON.stringify(drawMatrices[i]) === JSON.stringify(part.matrix), 'nonenhancement renderer retains exact socket matrix');
        }
        check(JSON.stringify(drawCalls[i].slice(1)) === '[0,0,512,512]', 'master shared-canvas draw dimensions');
        near(alphas[i], pose.parts[i].part.file === 'shadow.png' ? .16 : 1, 'isolated shadow opacity');
      }
      near(pose.scale, expectedScale * cell / 34, 'alpha-bound base scale');
      const recoil = shotAge >= 0 && shotAge < .16 ? Math.sin(shotAge / .16 * Math.PI) * 12 : 0;
      const inherited = new Map<string, { moving: boolean; recoil: boolean; pivot: number[] }>();
      for (const { part, matrix } of pose.parts) {
        const parent = part.parent ? inherited.get(part.parent) : undefined;
        const moving = !!(parent?.moving || part.rotates);
        const pivot = parent?.moving ? parent.pivot : part.pivot ?? [256, 256];
        const kicks = !!(parent?.recoil || /barrel|bolt|nozzle|rocket_ammo/.test(part.file));
        inherited.set(part.file.replace('.png', ''), { moving, pivot, recoil: kicks });
        // Independent sequential Canvas S/R/T reference, matching the previous renderer.
        for (const point of [[0, 0], [256, 256], [512, 512], ...(Object.values(model.sockets ?? {}).filter(s => s.part === part.file.replace('.png', '')).map(s => s.position))]) {
          const localX = point[0] - pivot[0], localY = point[1] - pivot[1] + (kicks ? recoil : 0);
          const rotation = moving ? angle : 0;
          const rotatedX = pivot[0] + localX * Math.cos(rotation) - localY * Math.sin(rotation);
          const rotatedY = pivot[1] + localX * Math.sin(rotation) + localY * Math.cos(rotation);
          const actual = transformPaperPoint(matrix, point);
          near(actual.x, tower.worldX + (rotatedX - 256) * pose.scale, `${id} render X`);
          near(actual.y, tower.worldY + (rotatedY - 256) * pose.scale, `${id} render Y`);
        }
      }
      for (const [name, socket] of Object.entries(model.sockets!)) {
        const actual = paperTowerSocket(model, pose, name);
        const drawn = pose.parts.find(p => p.part.file.replace('.png', '') === socket.part)!;
        check(actual, `${id} socket ${name}`);
        const expected = transformPaperPoint(drawn.matrix, socket.position);
        near(actual.x, expected.x, 'socket/render X'); near(actual.y, expected.y, 'socket/render Y');
      }
      check(JSON.stringify(paperTowerSocket(model, pose)) === JSON.stringify(paperTowerSocket(model, pose, defaultSockets[id])), `${id} default weapon alias`);
      check(JSON.stringify(drawingExports.getPaperTowerSocket(placed, angle, shotAge, cell)) === JSON.stringify(paperTowerSocket(model, pose)), 'public socket API matches drawn layers');
      check(paperTowerSocket(model, pose, 'unknown_socket') === null, 'unknown socket safe fallback');
    }
  }
  check(paperTowerPose(model, runtime.bounds, tower, NaN, 0, 34) === null, 'invalid angle');
  check(paperTowerPose(model, [0, 0, 0, 0], tower, 0, 0, 34) === null, 'empty bounds');
  check(paperTowerPose(model, runtime.bounds, tower, 0, 0, 0) === null, 'invalid cell');
}
drawingGeometry = null;
check(drawingExports.getPaperTowerSocket(tower, 0, 0, 34) === null, 'unloaded tower socket safe');
check(drawingExports.drawPaperTower(drawContext, tower, 0, 0, 34) === false, 'unloaded tower renderer fallback');
drawingSprites.set('projectiles/projectile_cannon.png', { image: { width: 64, height: 64 }, bounds: [10, 20, 30, 50] });
drawingSprites.set('projectiles/beam_simple_strip.png', { image: { width: 128, height: 32 }, bounds: [16, 12, 112, 20] });
check(drawingExports.drawPaperSprite(drawContext, 'projectiles/projectile_cannon.png', 7, 9, 12, 18, Math.PI / 2, .5) === true, 'sprite draw API');
check(JSON.stringify(drawCalls[drawCalls.length - 1].slice(1)) === '[10,20,20,30,-6,-9,12,18]', 'sprite alpha-bound centering');
near(rotations[rotations.length - 1], Math.PI / 2, 'sprite native art rotation');
near(alphas[alphas.length - 1], .5, 'sprite alpha applied');
near(drawContext.globalAlpha, 1, 'sprite restores caller alpha');
check(drawingExports.drawPaperSprite(drawContext, 'projectiles/beam_simple_strip.png', 0, 0, 20, 4) === true, 'strip sprite draw');
check(JSON.stringify(drawCalls[drawCalls.length - 1].slice(1)) === '[0,0,128,32,-10,-2,20,4]', 'strip sprite retains full X/Y canvas');
for (const [x, y, angle] of [[10, 0, 0], [0, 10, Math.PI / 2], [-10, 0, Math.PI], [0, -10, -Math.PI / 2]]) {
  check(drawingExports.drawPaperBeam(drawContext, 'projectiles/beam_simple_strip.png', { x: 2, y: 3 }, { x: 2 + x, y: 3 + y }, 4, .6) === true, 'beam API cardinal direction');
  near(rotations[rotations.length - 1], angle, 'beam direction');
  check(JSON.stringify(translations[translations.length - 1]) === '[2,3]', 'beam starts from origin');
  const lastTile = drawCalls[drawCalls.length - 1].slice(1) as number[];
  near(lastTile[0], 118, 'short beam crops right cap without stretching');
  near(lastTile[4] + lastTile[6], 10, 'beam tile coverage ends at segment length');
}
check(drawingExports.drawPaperBeam(drawContext, 'projectiles/beam_simple_strip.png', { x: 0, y: 0 }, { x: 0, y: 0 }, 4) === false, 'zero beam safe');
check(drawingExports.drawPaperBeam(drawContext, 'projectiles/projectile_cannon.png', { x: 0, y: 0 }, { x: 10, y: 0 }, 4) === false, 'nonbeam path safe');
check(drawingExports.drawPaperSprite(drawContext, 'missing.png', 0, 0, 10) === false, 'unloaded sprite safe');
check(drawingExports.drawPaperSprite(drawContext, 'projectiles/projectile_cannon.png', NaN, 0, 10) === false, 'invalid sprite coordinates');
check(JSON.stringify(paperContainSize(8, 56, 14, 14)) === '[2,14]', 'long rocket retains aspect within square');
check(JSON.stringify(paperContainSize(40, 10, 12, 12)) === '[12,3]', 'wide FX petal retains aspect within square');
drawingSprites.set('projectiles/projectile_rocket.png', { image: { width: 64, height: 64 }, bounds: [10, 4, 18, 60] });
check(drawingExports.drawPaperSprite(drawContext, 'projectiles/projectile_rocket.png', 0, 0, 14) === true, 'long rocket sprite');
check(JSON.stringify(drawCalls[drawCalls.length - 1].slice(1)) === '[10,4,8,56,-1,-7,2,14]', 'long rocket actual API contain dimensions');
for (const classic of ['#2b2b2b', '#595959', '#6b7a5a']) {
  check(normalizePaperSkinColor(classic.toUpperCase(), classic) === null, 'classic must remain original');
}
check(normalizePaperSkinColor() === null, 'undefined skin original');
check(normalizePaperSkinColor('red') === null, 'invalid color original');
check(normalizePaperSkinColor('#ABC') === '#aabbcc', 'short color canonical');
check(normalizePaperSkinColor('#4a5a8a', '#595959') === '#4a5a8a', 'nonclassic skin');
const original = [190, 170, 160, 128], color = [74, 90, 138];
check(JSON.stringify(tintPaperPixel(original, 0, 0, color)) === JSON.stringify(original), 'unmasked pixel unchanged, including shadow');
check(JSON.stringify(tintPaperPixel([0, 0, 0, 0], 255, 255, color)) === '[0,0,0,0]', 'transparent pixel unchanged');
const body = tintPaperPixel(original, 255, 0, color), accent = tintPaperPixel(original, 0, 255, color);
check(body[3] === original[3] && accent[3] === original[3], 'mask tint preserves exact alpha');
check(body[0] !== original[0] && accent[0] > body[0], 'colored body and lighter accent');
check(tintPaperPixel([90, 80, 70, 255], 255, 0, color)[0] < tintPaperPixel([220, 210, 200, 255], 255, 0, color)[0], 'fold lighting retained');
const activeKeys = Object.entries(manifest.towers).flatMap(([id, model]) => model.parts!.filter(part => part.file !== 'shadow.png').map(part => `${id}:${part.file}:equipped`));
check(activeKeys.length === 74, 'current manifest has 74 nonshadow tower parts including upgrades');
activeKeys.push(...Array.from({ length: 8 }, (_, i) => `paid-preview:${i}`), ...Array.from({ length: 4 }, (_, i) => `picker:${i}`));
const tintCache = new Map<string, object>();
for (const key of activeKeys.slice(0, 6)) rememberPaperTint(tintCache, key, {});
for (let i = 0; i < 90; i++) rememberPaperTint(tintCache, `previous-skin:${i}`, {});
for (let frame = 0; frame < 4; frame++) {
  let misses = 0;
  for (const key of activeKeys) {
    if (!tintCache.has(key)) { misses++; rememberPaperTint(tintCache, key, {}); }
    check(tintCache.size <= 96, 'tower tint cache bounded');
  }
  if (frame >= 2) check(misses === 0, 'dense steady-state does not recalculate tinted pixels');
}
console.log(`paper geometry regression: PASS ${assertions} assertions; 12 models x 4 angles, ${poses} poses with recoil/levels/cell sizes; defaults/mask pixels`);
