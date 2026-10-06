import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import * as ts from 'typescript';
import { createGame, placeTower, tick } from './engine';
import { CELL_PX, ENEMIES, TOWERS } from './data';
import { enemyHealthPresentation, enemyHealthAnchor } from './enemyReadability';
import { paperEnemyPose, transformPaperPoint } from './paperGeometry';
import type { PaperModel, PaperEnemyLayer } from './paperGeometry';
import type { Enemy, EnemyId } from './types';

let checks = 0;
function check(value: unknown, message: string): asserts value { checks++; assert.ok(value, message); }
const balance = JSON.stringify({ TOWERS, ENEMIES });
const roster = Object.keys(ENEMIES) as EnemyId[];
const state = createGame();
state.spawning = true;
state.spawnQueue = roster.map(id => ({ id, delay: 0, waveIndex: 0, healthModifier: 100 }));
tick(state, 0);
check(state.enemies.length === 11, 'actual ordinary spawn roster incomplete');
const born = JSON.stringify(state);
for (const enemy of state.enemies) {
  check(enemy.spawnedAt === state.time && enemy.hp === enemy.maxHp, `${enemy.id}: actual birth/full HP invalid`);
  const health = enemyHealthPresentation(enemy.hp, enemy.maxHp, enemy.id === 'boss');
  check(health.visible === (enemy.id === 'boss') && health.ratio === 1, `${enemy.id}: full ordinary clutter/boss hidden during grace`);
  check(enemyHealthPresentation(enemy.hp, enemy.maxHp, enemy.id === 'boss', true).visible,
    `${enemy.id}: explicit targeted/status relevance hidden`);
  const damaged = enemyHealthPresentation(enemy.hp * .5, enemy.maxHp, enemy.id === 'boss');
  check(damaged.visible && damaged.ratio === .5, `${enemy.id}: damaged HP not represented`);
}
check(JSON.stringify(state) === born, 'health presentation mutated born HP/positions/engine state');
state.paused = true;
const paused = JSON.stringify(state);
const presentations = state.enemies.map(e => enemyHealthPresentation(e.hp, e.maxHp, e.id === 'boss'));
tick(state, 100);
assert.deepEqual(state.enemies.map(e => enemyHealthPresentation(e.hp, e.maxHp, e.id === 'boss')), presentations); checks++;
check(JSON.stringify(state) === paused, 'paused draw/health advanced birth grace or HP/positions');
const extremes = [-Infinity, -1, 0, Number.MIN_VALUE, 1, 10, Number.MAX_VALUE, Infinity, NaN];
for (const hp of extremes) for (const maxHp of extremes) for (const boss of [false, true]) for (const relevant of [false, true]) {
  const health = enemyHealthPresentation(hp, maxHp, boss, relevant);
  const valid = Number.isFinite(hp) && Number.isFinite(maxHp) && hp > 0 && maxHp > 0;
  check(Number.isFinite(health.ratio) && health.ratio >= 0 && health.ratio <= 1, `nonfinite/unclamped ratio ${hp}/${maxHp}`);
  check(health.visible === (valid && (boss || hp < maxHp || relevant)), `unsafe visibility ${hp}/${maxHp}`);
  if (!valid) check(health.ratio === 0, 'invalid health has nonzero fill');
}

const combat = createGame();
combat.gold = 1e6;
check(placeTower(combat, 'canon', { x: 5, y: 0 }), 'ordinary HP real-combat fixture');
combat.spawning = true;
combat.spawnQueue = [{ id: 'soldier', delay: 0, waveIndex: 0, healthModifier: 100 }];
tick(combat, 0);
const victim = combat.enemies[0];
check(!enemyHealthPresentation(victim.hp, victim.maxHp, false).visible, 'ordinary fresh full HP has bar');
tick(combat, .5);
check(combat.shots.length === 0 && victim.hp === victim.maxHp, 'spawn grace changed HP');
tick(combat, .625);
check(Number(combat.shots.length) === 1 && victim.hp === victim.maxHp, 'actual launch not isolated from impact');
combat.towers[0].cooldown = 100;
for (let i = 0; i < 64 && victim.hp === victim.maxHp; i++) tick(combat, 1 / 64);
check(victim.hp > 0 && victim.hp < victim.maxHp, 'ordinary real shot failed to damage');
const afterImpact = JSON.stringify(combat);
check(enemyHealthPresentation(victim.hp, victim.maxHp, false).visible, 'ordinary real damage has no health presentation');
check(JSON.stringify(combat) === afterImpact, 'damaged health presentation mutates engine');
check(JSON.stringify({ TOWERS, ENEMIES }) === balance, 'readability test changed balance');

const gameSource = readFileSync('src/game/Game.tsx', 'utf8');
check(gameSource.includes('enemyHealthPresentation(enemy.hp, enemy.maxHp'), 'actual Game does not use validated health helper');

function near(actual: number, expected: number, message: string) {
  check(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} != ${expected}`);
}
function layer(id: string, view: string, key: string): PaperEnemyLayer {
  const png = readFileSync(`public/paper-assets/runtime/mobs/${id}/${view}/${key}.png`);
  check(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${id}/${key}: PNG signature`);
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20), stride = width * 4;
  check(png[24] === 8 && png[25] === 6 && png[28] === 0, `${id}/${key}: RGBA8 PNG required`);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset);
    check(offset + 12 + size <= png.length, `${id}/${key}: invalid PNG chunk`);
    if (png.subarray(offset + 4, offset + 8).toString() === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const bytes = inflateSync(Buffer.concat(chunks)), pixels = new Uint8Array(width * height * 4);
  check(bytes.length === height * (stride + 1), `${id}/${key}: invalid pixel payload`);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c);
    return x <= y && x <= z ? a : y <= z ? b : c;
  };
  let left = width, top = height, right = 0, bottom = 0;
  for (let y = 0; y < height; y++) {
    const filter = bytes[y * (stride + 1)];
    check(filter <= 4, `${id}/${key}: invalid row filter`);
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x, a = x >= 4 ? pixels[index - 4] : 0;
      const b = y ? pixels[index - stride] : 0, c = y && x >= 4 ? pixels[index - stride - 4] : 0;
      pixels[index] = (bytes[y * (stride + 1) + x + 1] + (filter === 1 ? a : filter === 2 ? b
        : filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ? paeth(a, b, c) : 0)) & 255;
      if (x % 4 === 3 && pixels[index] > 24) {
        const px = Math.floor(x / 4);
        left = Math.min(left, px); right = Math.max(right, px + 1);
        top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
      }
    }
  }
  check(right > left && bottom > top, `${id}/${key}: empty sprite`);
  return { key, width, height, bounds: [left, top, right, bottom] };
}
const manifest = JSON.parse(readFileSync('public/paper-assets/manifest.json', 'utf8')) as { mobs: Record<EnemyId, PaperModel> };
let poseCount = 0;
for (const id of roster) {
  const model = manifest.mobs[id];
  check(!!model.pivots, `${id}: model pivots absent`);
  for (const view of id === 'soldier' ? ['front', 'back'] : ['front']) {
    const keys: string[] = ['shadow', ...Object.keys(model.pivots)].filter(key => view !== 'back' || !key.startsWith('arm_'));
    const layers: PaperEnemyLayer[] = keys.map(key => layer(id, view, key));
    const originalLayers = JSON.stringify(layers);
    for (const palette of [0, 1, 2, 3]) for (const cell of [28, 34]) for (const moving of [false, true]) for (const time of [0, .375]) {
      const enemy: Enemy = { uid: `read-${id}`, id, hp: 50, maxHp: 100, speed: ENEMIES[id].speed * CELL_PX,
        pos: { x: 200, y: 250 }, paletteVariant: palette, visualScale: ENEMIES[id].visualScale ?? 1 };
      const originalEnemy = JSON.stringify(enemy);
      const pose = paperEnemyPose(model, layers, enemy, time, moving, cell);
      check(!!pose && pose.variant === palette, `${id}: missing/noncanonical palette pose`);
      check([pose.bounds.x, pose.bounds.y, pose.bounds.width, pose.bounds.height, pose.scale].every(Number.isFinite)
        && pose.bounds.width > 0 && pose.bounds.height > 0, `${id}: unsafe visible envelope`);
      const corners = layers.filter(part => part.key !== 'shadow').flatMap(part => {
        const matrix = pose.parts.find(p => p.key === part.key)?.matrix;
        check(!!matrix && matrix.every(Number.isFinite), `${id}/${part.key}: missing shared matrix`);
        const [left, top, right, bottom] = part.bounds;
        return [[left, top], [right, top], [right, bottom], [left, bottom]].map(([x, y]) =>
          transformPaperPoint(matrix, [x * model.canvas[0] / part.width, y * model.canvas[1] / part.height]));
      });
      const left = Math.min(...corners.map(p => p.x)), top = Math.min(...corners.map(p => p.y));
      near(pose.bounds.x, left, `${id}: transformed alpha left`);
      near(pose.bounds.y, top, `${id}: transformed alpha top`);
      near(pose.bounds.width, Math.max(...corners.map(p => p.x)) - left, `${id}: transformed alpha width`);
      near(pose.bounds.height, Math.max(...corners.map(p => p.y)) - top, `${id}: transformed alpha height`);
      const fallback = { x: enemy.pos.x, y: enemy.pos.y, radius: cell * .45 };
      const anchor = enemyHealthAnchor(pose.bounds, fallback);
      check([anchor.x, anchor.y, anchor.radius].every(Number.isFinite) && anchor.radius > 0, `${id}: unsafe health anchor`);
      near(anchor.x, pose.bounds.x + pose.bounds.width / 2, `${id}: actual bounds anchor x`);
      near(anchor.y, pose.bounds.y + pose.bounds.height / 2, `${id}: actual bounds anchor y`);
      check(corners.every(p => Math.hypot(p.x - anchor.x, p.y - anchor.y) < anchor.radius),
        `${id}: ring intersects actual visible envelope`);
      const noShadow = paperEnemyPose(model, layers.filter(p => p.key !== 'shadow'), enemy, time, moving, cell);
      check(!!noShadow, `${id}: non-shadow envelope absent`);
      assert.deepEqual(noShadow.bounds, pose.bounds); checks++;
      const frozen = paperEnemyPose(model, layers, enemy, time, false, cell);
      check(!!frozen, `${id}: paused pose absent`);
      assert.deepEqual(frozen, paperEnemyPose(model, layers, enemy, time + 100, false, cell)); checks++;
      check(JSON.stringify(enemy) === originalEnemy && JSON.stringify(layers) === originalLayers,
        `${id}: bounds presentation changed HP/positions/asset geometry`);
      poseCount++;
    }
  }
}
const paperSource = readFileSync('src/game/paperAssets.ts', 'utf8');
check(paperSource.includes('paperEnemyPose(model, layers, enemy, time, moving, cell, reducedMotion, walkPhase)'), 'actual draw/bounds bypass tested pose');
check(paperSource.includes('return (frame ?? enemyGeometry)(enemy, time, heading, moving, cell, reducedMotion, walkPhase)?.pose.bounds'), 'actual bounds API must share frame/geometry path');
check(paperSource.includes('const geometry = (frame ?? enemyGeometry)(enemy, time, heading, moving, cell, reducedMotion, walkPhase);'), 'actual drawing must share frame/geometry path');
const drawStart = gameSource.indexOf('const draw = useCallback(() => {');
const frameStart = gameSource.indexOf('const paperEnemyFrame = createPaperEnemyFrame();');
const drawEnd = gameSource.indexOf('}, [', drawStart);
check(drawStart >= 0 && frameStart > drawStart && drawEnd > frameStart, 'enemy frame must be created inside each draw callback');
check((gameSource.match(/createPaperEnemyFrame\(\)/g) ?? []).length === 1, 'enemy frame must not have persistent factory calls');
check(gameSource.includes('gs.time - motion.movedAt < .1, gs.gluePatches, paperEnemyFrame, reducedMotionRef.current, walkPhase);'), 'Game enemy drawing must receive local frame');
check(gameSource.includes('moving && !statuses.stunned, ENGINE_CELL_PX, frame, reducedMotion, walkPhase);'), 'enemy canvas must forward local frame with stun state');
check(gameSource.includes('gs.time - motion.movedAt < .1 && !statuses.stunned, ENGINE_CELL_PX, paperEnemyFrame, reducedMotionRef.current, walkPhase),'), 'Game bounds must receive same frame and movement/stun state');

const fallback = { x: 30, y: 40, radius: 12 };
for (const bounds of [null, { x: NaN, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 1 },
  { x: 0, y: Infinity, width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: -1 }]) {
  const anchor = enemyHealthAnchor(bounds, fallback);
  assert.deepEqual(anchor, fallback); checks++;
  check(anchor !== fallback, 'fallback aliases mutable caller object');
}

const parsed = ts.createSourceFile('paperAssets.ts', paperSource, ts.ScriptTarget.Latest, true);
const names = ['enemyGeometry', 'createPaperEnemyFrame', 'getPaperEnemyVisibleBounds', 'drawPaperEnemy'];
const declarations = names.map(name => {
  const node = parsed.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  check(!!node, `actual renderer missing ${name}`);
  return node.getText(parsed);
}).join('\n');
const js = ts.transpileModule(declarations, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const sprites = new Map<string, { image: { path: string; width: number; height: number }; bounds: readonly number[] }>();
let geometryCalls = 0;
const api = new Function('exports', 'manifest', 'sprites', 'paperEnemyPose', 'tintedPart',
  `${js}; return { draw: drawPaperEnemy, bounds: getPaperEnemyVisibleBounds, frame: createPaperEnemyFrame };`)({}, manifest, sprites,
  (...args: Parameters<typeof paperEnemyPose>) => { geometryCalls++; return paperEnemyPose(...args); },
  (path: string) => sprites.get(path)?.image) as {
    draw(ctx: object, enemy: Enemy, time: number, heading: number, moving: boolean, cell: number, frame?: unknown): boolean;
    bounds(enemy: Enemy, time: number, heading: number, moving: boolean, cell: number, frame?: unknown): { x: number; y: number; width: number; height: number } | null;
    frame(): unknown;
  };
let recordedDraws = 0;
for (const id of roster) {
  const model = manifest.mobs[id];
  for (const view of id === 'soldier' ? ['front', 'back'] : ['front']) {
    const heading = view === 'back' ? -Math.PI / 2 : 0;
    const keys: string[] = ['shadow', ...Object.keys(model.pivots!)].filter(key => view !== 'back' || !key.startsWith('arm_'));
    const layers = keys.map(key => layer(id, view, key));
    for (const part of layers) sprites.set(`mobs/${id}/${view}/${part.key}.png`, {
      image: { path: `mobs/${id}/${view}/${part.key}.png`, width: part.width, height: part.height }, bounds: part.bounds,
    });
    for (const palette of [0, 1, 2, 3]) for (const cell of [28, 34]) {
      const enemy: Enemy = { uid: 'recorded', id, hp: 50, maxHp: 100, speed: ENEMIES[id].speed * CELL_PX,
        pos: { x: 200, y: 250 }, paletteVariant: palette, visualScale: ENEMIES[id].visualScale ?? 1 };
      const before = JSON.stringify(enemy);
      const pose = paperEnemyPose(model, layers, enemy, .375, true, cell)!;
      const matrices: number[][] = [], paths: string[] = [], stack: number[] = [];
      const ctx = {
        globalAlpha: 1, filter: 'none',
        save() { stack.push(this.globalAlpha); }, restore() { this.globalAlpha = stack.pop()!; },
        transform(...values: number[]) { matrices.push(values); },
        drawImage(image: { path: string }, ...args: number[]) {
          paths.push(image.path);
          assert.deepEqual(args, [0, 0, ...model.canvas]); checks++;
        },
      };
      check(api.draw(ctx, enemy, .375, heading, true, cell), `${id}: actual renderer failed real loaded layers`);
      assert.deepEqual(matrices, pose.parts.map(part => part.matrix)); checks++;
      assert.deepEqual(paths, pose.parts.map(part => `mobs/${id}/${view}/${part.key}.png`)); checks++;
      assert.deepEqual(api.bounds(enemy, .375, heading, true, cell), pose.bounds); checks++;
      const frame = api.frame();
      const callsBefore = geometryCalls;
      matrices.length = 0; paths.length = 0;
      check(api.draw(ctx, enemy, .375, heading, true, cell, frame), `${id}: frame renderer failed actual PNG layers`);
      assert.deepEqual(api.bounds(enemy, .375, heading, true, cell, frame), pose.bounds); checks++;
      assert.deepEqual(matrices, pose.parts.map(part => part.matrix)); checks++;
      assert.deepEqual(paths, pose.parts.map(part => `mobs/${id}/${view}/${part.key}.png`)); checks++;
      check(geometryCalls === callsBefore + 1, `${id}: draw/bounds must reuse exactly one real PNG pose`);
      assert.deepEqual(api.bounds(enemy, .375, heading, true, cell, api.frame()), pose.bounds); checks++;
      check(geometryCalls === callsBefore + 2, `${id}: next frame must not reuse persistent pose`);
      check(stack.length === 0 && ctx.globalAlpha === 1 && JSON.stringify(enemy) === before,
        `${id}: actual draw/anchor mutated canvas or engine HP/positions`);
      recordedDraws++;
    }
    const missingPath = `mobs/${id}/${view}/${keys.find(key => key !== 'shadow')}.png`;
    const removed = sprites.get(missingPath)!;
    sprites.delete(missingPath);
    const enemy: Enemy = { uid: 'missing', id, hp: 10, maxHp: 10, speed: 28, pos: { x: 20, y: 20 } };
    check(api.bounds(enemy, 0, heading, false, 28) === null && api.draw({}, enemy, 0, heading, false, 28) === false,
      `${id}: missing real layer does not signal procedural fallback`);
    assert.deepEqual(enemyHealthAnchor(api.bounds(enemy, 0, heading, false, 28), fallback), fallback); checks++;
    sprites.set(missingPath, removed);
    check(paperEnemyPose(model, [], enemy, 0, false, 28) === null, `${id}: empty layer set accepted`);
    check(paperEnemyPose(model, layers, enemy, 0, false, NaN) === null, `${id}: invalid cell accepted`);
  }
}
check(gameSource.includes('enemyHealthAnchor(getPaperEnemyVisibleBounds('), 'actual Game health rings not anchored to loaded paper bounds');
check(JSON.stringify({ TOWERS, ENEMIES }) === balance, 'paper readability mutated production balance');
console.log(`Dense readability PASS: ${poseCount} actual-PNG poses, ${recordedDraws} recorded real draw calls, ${checks} checks; health/grace/pause and bounds/fallback, no browser claim.`);
