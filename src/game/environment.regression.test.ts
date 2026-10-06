import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import * as ts from 'typescript';
import { createGame } from './engine';
import { TOWERS, ENEMIES } from './data';
import { PAPER_ENVIRONMENT_ALIASES, PAPER_ENVIRONMENT_PATHS, paperEnvironmentFiles,
  paperEnvironmentBounds, paperEnvironmentPose, paperEnvironmentSocket } from './paperEnvironment';
import type { PaperEnvironmentId, PaperEnvironmentModel } from './paperEnvironment';

let checks = 0;
function check(value: unknown, message: string): asserts value { checks++; assert.ok(value, message); }
function near(a: number, b: number, message: string) { check(Math.abs(a - b) < 1e-8, `${message}: ${a} != ${b}`); }
function png(path: string, alpha = true) {
  const data = readFileSync(`public/paper-assets/runtime/${path}`);
  check(data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${path}: PNG signature`);
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  check(width > 0 && height > 0 && data[24] === 8 && data[28] === 0, `${path}: PNG size/depth/interlace`);
  if (!alpha) return { width, height, bounds: [0, 0, width, height] };
  check(data[25] === 6, `${path}: expected RGBA layers`);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < data.length;) {
    const size = data.readUInt32BE(offset);
    check(offset + 12 + size <= data.length, `${path}: PNG chunk outside data`);
    if (data.subarray(offset + 4, offset + 8).toString() === 'IDAT') chunks.push(data.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const bytes = inflateSync(Buffer.concat(chunks)), stride = width * 4;
  check(bytes.length === height * (stride + 1), `${path}: decompressed pixel payload size`);
  const decoded = new Uint8Array(height * stride);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c);
    return x <= y && x <= z ? a : y <= z ? b : c;
  };
  let left = width, top = height, right = 0, bottom = 0;
  for (let y = 0; y < height; y++) {
    const filter = bytes[y * (stride + 1)];
    check(filter <= 4, `${path}: invalid PNG row filter`);
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x, a = x >= 4 ? decoded[index - 4] : 0;
      const b = y ? decoded[index - stride] : 0, c = y && x >= 4 ? decoded[index - stride - 4] : 0;
      const prediction = filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ? paeth(a, b, c) : 0;
      decoded[index] = (bytes[y * (stride + 1) + x + 1] + prediction) & 255;
      if (x % 4 === 3 && decoded[index] > 24) {
        const pixel = Math.floor(x / 4);
        left = Math.min(left, pixel); right = Math.max(right, pixel + 1);
        top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
      }
    }
  }
  check(right > left && bottom > top, `${path}: empty actual alpha bounds`);
  return { width, height, bounds: [left, top, right, bottom] };
}
const manifest = JSON.parse(readFileSync('public/paper-assets/manifest.json', 'utf8')) as {
  coordinate_system: { runtime_scaling_ratio: { textures: number } };
  environment: { structures: Record<PaperEnvironmentId, PaperEnvironmentModel>; textures: { paper_field: { size: number[] } } };
};
const expected = {
  entry_gate: ['environment/entry_gate_shadow.png', 'environment/entry_gate_frame.png', 'environment/entry_gate_flap_left.png', 'environment/entry_gate_flap_right.png'],
  exit_goal: ['environment/exit_goal_shadow.png', 'environment/exit_goal_body.png', 'environment/exit_goal_fold_1.png', 'environment/exit_goal_fold_2.png'],
};
const sprites = new Map<string, { image: { path: string; width: number; height: number }; bounds: number[] }>();
const state = createGame(12, 21);
const beforeState = JSON.stringify(state), beforeBalance = JSON.stringify({ TOWERS, ENEMIES });
const paperSource = readFileSync('src/game/paperAssets.ts', 'utf8');
const gameSource = readFileSync('src/game/Game.tsx', 'utf8');
const helperSource = readFileSync('src/game/paperEnvironment.ts', 'utf8');
check(!/from\s+['"][^'"]*(?:engine|store|payment)/.test(helperSource), 'pure environment helper acquires engine/economy dependency');
check(/\.\.\.PAPER_ENVIRONMENT_PATHS/.test(paperSource), 'loader misses real environment paths');
check(/drawPaperEnvironmentStructure\(ctx,\s*'entry_gate',\s*gs\.entry,\s*ENGINE_CELL_PX\)/.test(gameSource)
  && /drawPaperEnvironmentStructure\(ctx,\s*'exit_goal',\s*gs\.exit,\s*ENGINE_CELL_PX\)/.test(gameSource), 'actual renderer misses entry/exit');
check(/drawPaperGround\(ctx,\s*gs\.gridW,\s*gs\.gridH,\s*ENGINE_CELL_PX\)/.test(gameSource), 'ground reserves/changes full field geometry');
assert.deepEqual(new Set(PAPER_ENVIRONMENT_PATHS), new Set(['environment/paper_field.png', ...expected.entry_gate, ...expected.exit_goal])); checks++;
const texture = png('environment/paper_field.png', false);
check(texture.width === manifest.environment.textures.paper_field.size[0] * manifest.coordinate_system.runtime_scaling_ratio.textures
  && texture.height === manifest.environment.textures.paper_field.size[1] * manifest.coordinate_system.runtime_scaling_ratio.textures,
  'supplied texture runtime scaling differs from manifest');

for (const id of ['entry_gate', 'exit_goal'] as const) {
  const model = manifest.environment.structures[id];
  assert.deepEqual(paperEnvironmentFiles(id, model.parts), expected[id]); checks++;
  assert.deepEqual(Object.keys(PAPER_ENVIRONMENT_ALIASES[id]).sort(), [...model.parts].sort()); checks++;
  check(paperEnvironmentFiles(id, model.parts.slice(1)) === null, `${id}: missing manifest layer accepted`);
  check(paperEnvironmentFiles(id, [...model.parts.slice(1), 'absent.png']) === null, `${id}: absent alias accepted`);
  const layers = expected[id].map(path => {
    const image = png(path);
    check(image.width * 2 === model.canvas[0] && image.height * 2 === model.canvas[1], `${path}: shared runtime canvas size`);
    sprites.set(path, { image: { path, width: image.width, height: image.height }, bounds: image.bounds });
    return image;
  });
  const bounds = paperEnvironmentBounds(model.canvas, layers);
  check(!!bounds, `${id}: actual PNG union not renderable`);
  const union = [Math.min(...layers.map(p => p.bounds[0] * 2)), Math.min(...layers.map(p => p.bounds[1] * 2)),
    Math.max(...layers.map(p => p.bounds[2] * 2)), Math.max(...layers.map(p => p.bounds[3] * 2))];
  assert.deepEqual(bounds, union); checks++;
  for (const cell of [12, 28, 34]) for (let y = 0; y < 21; y++) for (let x = 0; x < 12; x++) {
    const pose = paperEnvironmentPose(bounds, { x, y }, cell);
    check(!!pose && pose.matrix.every(Number.isFinite), `${id}: invalid ${x},${y}/${cell} pose`);
    assert.deepEqual(pose.clip, { x: x * cell, y: y * cell, width: cell, height: cell }); checks++;
    check(pose.bounds[0] >= x * cell && pose.bounds[1] >= y * cell
      && pose.bounds[2] <= (x + 1) * cell && pose.bounds[3] <= (y + 1) * cell, `${id}: actual bounds overflow reserved cell`);
    check(pose.clip.x + cell <= 12 * cell && pose.clip.y + cell <= 21 * cell, `${id}: clip changes 12x21 field bounds`);
    check(pose.matrix[1] === 0 && pose.matrix[2] === 0 && pose.bounds[1] > pose.label.y, `${id}: static art rotated/overlaps label stripe`);
    const center = paperEnvironmentSocket(pose, [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]);
    check(!!center, `${id}: shared socket missing`);
    near(center.x, (x + .5) * cell, `${id}: shared center x`);
    near(center.y, (y + .64) * cell, `${id}: shared center y`);
  }
}

const parsed = ts.createSourceFile('paperAssets.ts', paperSource, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'drawPaperEnvironmentStructure');
check(!!declaration, 'actual structure draw function missing');
const js = ts.transpileModule(declaration.getText(parsed), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const draw = new Function('exports', 'manifest', 'sprites', 'paperEnvironmentFiles', 'paperEnvironmentBounds', 'paperEnvironmentPose',
  `${js}; return drawPaperEnvironmentStructure;`)({}, manifest, sprites, paperEnvironmentFiles, paperEnvironmentBounds, paperEnvironmentPose) as
  (ctx: object, id: PaperEnvironmentId, cell: { x: number; y: number }, size: number) => boolean;
for (const id of ['entry_gate', 'exit_goal'] as const) for (const size of [12, 28, 34]) {
  const selected = id === 'entry_gate' ? state.entry : state.exit;
  const records: { path: string; alpha: number; args: number[] }[] = [];
  const transforms: number[][] = [], clips: number[][] = [], stack: number[] = [];
  let clipping = false;
  const ctx = {
    globalAlpha: 1,
    save() { stack.push(this.globalAlpha); },
    restore() { this.globalAlpha = stack.pop()!; },
    beginPath() {}, rect(...args: number[]) { clips.push(args); }, clip() { clipping = true; },
    transform(...args: number[]) { transforms.push(args); },
    drawImage(image: { path: string }, ...args: number[]) {
      check(clipping && transforms.length === 1, `${id}: part drawn before shared clip/transform`);
      records.push({ path: image.path, alpha: this.globalAlpha, args });
    },
  };
  check(draw(ctx, id, selected, size), `${id}: actual draw failed with all real parts`);
  assert.deepEqual(records.map(record => record.path), expected[id]); checks++;
  assert.deepEqual(clips, [[selected.x * size, selected.y * size, size, size]]); checks++;
  check(records.every(record => JSON.stringify(record.args) === JSON.stringify([0, 0, 512, 512])), `${id}: per-layer crop broke shared canvas`);
  check(records[0].alpha === .14 && records.slice(1).every(record => record.alpha === 1), `${id}: shadow/art alpha contract`);
  check(stack.length === 0 && ctx.globalAlpha === 1, `${id}: draw leaked canvas state`);
}
const missing = sprites.get(expected.exit_goal[2])!;
sprites.delete(expected.exit_goal[2]);
check(draw({}, 'exit_goal', state.exit, 28) === false, 'missing actual fold does not return visible-fallback signal');
sprites.set(expected.exit_goal[2], missing);
check(JSON.stringify(state) === beforeState && JSON.stringify({ TOWERS, ENEMIES }) === beforeBalance, 'environment renderer reserved/mutated engine space/balance');
console.log(`Environment structural PASS: 9 supplied PNG paths, 2 models x 252 cells x 3 sizes, ${checks} checks; recording context only, no browser claim.`);
