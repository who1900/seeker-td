const { strict: assert } = require('node:assert');
const { readFileSync } = require('node:fs');
const { inflateSync } = require('node:zlib');
const ts = require('typescript');
const source = readFileSync(`${__dirname}/paperAssets.ts`, 'utf8');
const ast = ts.createSourceFile('paperAssets.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const compile = code => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2020 } }).outputText;
function png(file) {
  const bytes = readFileSync(file), width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert.equal(bytes[24], 8); assert.equal(bytes[25], 6); assert.equal(bytes[28], 0);
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    if (bytes.subarray(offset + 4, offset + 8).toString() === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * 4, data = new Uint8ClampedArray(width * height * 4);
  const paeth = (a, b, c) => { const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x, a = x >= 4 ? data[i - 4] : 0, b = y ? data[i - stride] : 0, c = y && x >= 4 ? data[i - stride - 4] : 0;
      data[i] = (raw[y * (stride + 1) + x + 1] + (filter === 1 ? a : filter === 2 ? b
        : filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ? paeth(a, b, c) : 0)) & 255;
    }
  }
  const bounds = [width, height, 0, 0];
  for (let i = 3; i < data.length; i += 4) if (data[i] > 24) {
    const index = (i - 3) / 4, x = index % width, y = Math.floor(index / width);
    bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x + 1); bounds[3] = Math.max(bounds[3], y + 1);
  }
  return { width, height, data, bounds };
}
const manifest = JSON.parse(readFileSync(`${__dirname}/../../public/paper-assets/manifest.json`, 'utf8'));
const sprites = new Map(), tintedParts = new Map();
for (const view of ['front', 'back']) {
  const parts = ['shadow', ...Object.keys(manifest.mobs.soldier.pivots)].filter(p => view !== 'back' || !p.startsWith('arm_'));
  for (const key of [...parts, ...(view === 'front' ? ['body_mask', 'accent_mask'] : [])]) {
    const path = `mobs/soldier/${view}/${key}.png`, image = png(`${__dirname}/../../public/paper-assets/runtime/${path}`);
    image.path = path; sprites.set(path, { image, bounds: image.bounds });
  }
}
let pixelReads = 0;
function canvas() {
  const c = { width: 0, height: 0, data: null };
  const ctx = { globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '',
    drawImage(image) {
      if (!c.data) { c.data = new Uint8ClampedArray(image.data); return; }
      if (this.globalCompositeOperation === 'destination-in') {
        for (let i = 3; i < c.data.length; i += 4) c.data[i] = Math.round(c.data[i] * image.data[i] / 255);
        return;
      }
      for (let i = 0; i < c.data.length; i += 4) {
        const sa = image.data[i + 3] / 255 * this.globalAlpha, da = c.data[i + 3] / 255, out = sa + da * (1 - sa);
        for (let channel = 0; channel < 3; channel++) c.data[i + channel] = out ? Math.round(
          (image.data[i + channel] * sa + c.data[i + channel] * da * (1 - sa)) / out) : 0;
        c.data[i + 3] = Math.round(out * 255);
      }
    },
    fillRect() {
      assert.equal(this.globalCompositeOperation, 'source-in');
      const color = this.fillStyle.slice(1).match(/../g).map(v => parseInt(v, 16));
      for (let i = 0; i < c.data.length; i += 4) c.data.set(color, i);
    },
    getImageData() { pixelReads++; return { data: new Uint8ClampedArray(c.data) }; },
    putImageData(pixels) { c.data = new Uint8ClampedArray(pixels.data); },
  };
  c.getContext = () => ctx; return c;
}
const geometry = {};
new Function('exports', 'require', compile(readFileSync(`${__dirname}/paperGeometry.ts`, 'utf8')))(geometry,
  name => { assert.equal(name, './data'); return { CELL_PX: 28 }; });
const names = ['load', 'soldierBackTintColor', 'soldierBackTintPixel', 'tintedPart', 'enemyGeometry', 'createPaperEnemyFrame',
  'getPaperEnemyVisibleBounds', 'drawPaperEnemy'];
const functions = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text));
assert.equal(functions.length, names.length);
const api = new Function('exports', 'manifest', 'sprites', 'tintedParts', 'document', 'paperEnemyPose',
  'Image', 'paperUrl', compile(functions.map(n => n.getText(ast)).join('\n')) + '\nreturn {...exports, tintedPart, load};')(
  {}, manifest, sprites, tintedParts, { createElement: tag => { assert.equal(tag, 'canvas'); return canvas(); } }, geometry.paperEnemyPose,
  class { set src(path) {
    const image = png(`${__dirname}/../../public/paper-assets/runtime/${path}`);
    Object.assign(this, image, { path }); queueMicrotask(() => this.onload());
  } }, path => path);
const palettes = [[[193, 178, 161], [178, 164, 190]], [[164, 177, 188], [178, 184, 153]], [[188, 163, 160], [192, 175, 140]]];
const luma = p => p[0] * .2126 + p[1] * .7152 + p[2] * .0722;
let changed = 0, pixels = 0;
for (const [path, sprite] of sprites) for (const variant of [0, 1, 2, 3]) {
  const actual = api.tintedPart(path, variant), role = /^mobs\/soldier\/(?:front|back)\/(body|leg_left|leg_right|bag)\.png$/.exec(path)?.[1];
  if (!role) assert.equal(actual, sprite.image, 'non-clothing Soldier parts unchanged');
  if (!role) continue;
  assert.deepEqual(api.soldierBackTintColor(path, variant), variant === 0 ? [0, 0, 0] : palettes[variant - 1][role === 'bag' ? 1 : 0]);
  let partChanged = 0;
  for (let i = 0; i < actual.data.length; i += 4) {
    const before = sprite.image.data.subarray(i, i + 4), after = actual.data.subarray(i, i + 4);
    assert.equal(after[3], before[3], 'alpha exactly preserved');
    const reduction = 24 * Math.max(0, Math.min(1, (luma(before) - 190) / 40));
    assert.ok(!before[3] || Math.abs(luma(after) - luma(before) + reduction) <= .500001,
      'approved clothing contrast curve preserves local shade, not old invariant luminance');
    if (!before[3] || luma(before) <= 90) assert.deepEqual(after, before, 'transparent pixels and dark contours unchanged');
    if (before.some((value, index) => value !== after[index])) partChanged++;
    pixels++;
  }
  if (variant || role !== 'bag') assert.ok(partChanged > 0, `${path}: actual PNG clothing changes some pixels`);
  changed += partChanged;
  const reads = pixelReads;
  assert.equal(api.tintedPart(path, variant), actual); assert.equal(pixelReads, reads, 'cached repeat draw never rewrites pixels');
}
for (const path of ['mobs/soldier/back/head.png', 'mobs/soldier/back/helmet.png', 'mobs/soldier/back/shadow.png',
  'mobs/soldier/back/unknown.png', 'mobs/brute/back/body.png', 'mobs/soldier/back/../body.png']) {
  for (const variant of [0, 1, 2, 3, NaN, -1, 4, .5]) assert.equal(api.soldierBackTintColor(path, variant), null);
}
for (const variant of [NaN, -1, 4, .5]) assert.equal(api.tintedPart('mobs/soldier/back/body.png', variant),
  sprites.get('mobs/soldier/back/body.png').image);
const unknown = 'mobs/soldier/back/unknown.png';
sprites.set(unknown, sprites.get('mobs/soldier/back/body.png'));
assert.equal(api.tintedPart(unknown, 1), sprites.get(unknown).image);
function recording() {
  const calls = [], stack = [];
  return { calls, globalAlpha: 1, filter: 'none', save() { stack.push([this.globalAlpha, this.filter]); },
    restore() { [this.globalAlpha, this.filter] = stack.pop(); }, transform(...matrix) { calls.push({ matrix }); },
    drawImage(image, ...size) { calls.push({ image, size, alpha: this.globalAlpha, filter: this.filter }); } };
}
let poses = 0;
for (const view of ['front', 'back']) for (const cell of [28, 34]) for (const variant of [0, 1, 2, 3]) {
  const heading = view === 'back' ? -Math.PI / 2 : Math.PI / 2;
  const enemy = { id: 'soldier', uid: 'palette-fixture', pos: { x: 100, y: 120 }, speed: 28,
    visualScale: 1.12, paletteVariant: variant, hp: 50, hitFlash: 0 };
  const before = JSON.stringify(enemy), ctx = recording();
  assert.equal(api.drawPaperEnemy(ctx, enemy, .375, heading, true, cell), true);
  const keys = ['shadow', ...Object.keys(manifest.mobs.soldier.pivots)].filter(p => view !== 'back' || !p.startsWith('arm_'));
  const layers = keys.map(key => ({ key, ...sprites.get(`mobs/soldier/${view}/${key}.png`).image }));
  const expected = geometry.paperEnemyPose(manifest.mobs.soldier, layers, enemy, .375, true, cell);
  assert.deepEqual(ctx.calls.filter(c => c.matrix).map(c => c.matrix), expected.parts.map(p => p.matrix));
  assert.deepEqual(api.getPaperEnemyVisibleBounds(enemy, .375, heading, true, cell), expected.bounds);
  const baseline = geometry.paperEnemyPose(manifest.mobs.soldier, layers, { ...enemy, paletteVariant: 0 }, .375, true, cell);
  assert.deepEqual(expected.parts.map(p => p.matrix), baseline.parts.map(p => p.matrix), 'palette does not move actors/layers');
  assert.equal(JSON.stringify(enemy), before);
  const reads = pixelReads;
  api.drawPaperEnemy(recording(), enemy, .375, heading, true, cell);
  assert.equal(pixelReads, reads);
  poses++;
}
async function prewarm() {
  for (const view of ['front', 'back']) for (const key of ['body', 'leg_left', 'leg_right', 'bag']) {
    const path = `mobs/soldier/${view}/${key}.png`;
    for (const variant of [0, 1, 2, 3]) tintedParts.delete(`${path}:${variant}`);
    await api.load(path);
    const reads = pixelReads;
    for (const variant of [0, 1, 2, 3]) {
      assert.ok(tintedParts.has(`${path}:${variant}`), 'actual loader prewarms all clothing variants');
      api.tintedPart(path, variant);
    }
    assert.equal(pixelReads, reads, 'first post-load draw performs no pixel rewrite');
  }
  console.log(`soldier clothing palette PASS: ${poses} actual-PNG front/back variant/cell recorded poses; ${pixels} pixels, ${changed} recolored; alpha/approved contrast/matrices/cache + actual-load prewarm preserved`);
}
const legacyTint = new Function('manifest', 'sprites', 'tintedParts', 'document',
  compile(functions.find(n => n.name.text === 'tintedPart').getText(ast)
    .replace('soldierBackTintColor(path, variant)', 'null')) + '\nreturn tintedPart;')(
  manifest, sprites, new Map(), { createElement: () => canvas() });
const otherMobs = Object.keys(manifest.mobs).filter(id => id !== 'soldier');
assert.equal(otherMobs.length, 10);
for (const id of otherMobs) {
  for (const key of ['shadow', ...Object.keys(manifest.mobs[id].pivots), 'body_mask', 'accent_mask']) {
    const path = `mobs/${id}/front/${key}.png`;
    const image = png(`${__dirname}/../../public/paper-assets/runtime/${path}`);
    sprites.set(path, { image, bounds: image.bounds });
  }
  for (const key of ['shadow', ...Object.keys(manifest.mobs[id].pivots)]) for (const variant of [0, 1, 2, 3]) {
    const path = `mobs/${id}/front/${key}.png`;
    assert.deepEqual(api.tintedPart(path, variant).data, legacyTint(path, variant).data,
      `${id}/${key}/${variant}: other mob actual PNG matches unchanged legacy palette`);
  }
}
console.log('Other 10 mobs PASS: actual PNG pixels match legacy palette for variants 0..3');
prewarm().catch(error => { console.error(error); process.exitCode = 1; });
