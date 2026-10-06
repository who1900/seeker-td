const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
// Reuse actual PNG decoder/canvas fixture, not production imports or synthetic art.
const fixture = readFileSync(`${__dirname}/soldier-back-palette.regression.test.cjs`, 'utf8');
const { api, sprites, tintedParts } = new Function('require', '__dirname',
  fixture.slice(0, fixture.indexOf('const palettes =')) + '\nreturn {api,sprites,tintedParts};')(require, __dirname);
const luma = p => p[0] * .2126 + p[1] * .7152 + p[2] * .0722;
const linear = v => (v /= 255) <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
const luminance = p => .2126 * linear(p[0]) + .7152 * linear(p[1]) + .0722 * linear(p[2]);
const field = luminance([246, 245, 240]);
const contrast = p => (Math.max(field, luminance(p)) + .05) / (Math.min(field, luminance(p)) + .05);
let samples = 0, beforeTotal = 0, afterTotal = 0;
for (const view of ['front', 'back']) for (const variant of [0, 1, 2, 3]) {
  let count = 0, gain = 0;
  for (const part of ['body', 'leg_left', 'leg_right', 'bag']) {
    const deltas = [];
    const path = `mobs/soldier/${view}/${part}.png`, sprite = sprites.get(path).image;
    const actual = api.tintedPart(path, variant);
    for (let i = 0; i < sprite.data.length; i += 4) {
      const before = sprite.data.subarray(i, i + 4), after = actual.data.subarray(i, i + 4);
      assert.equal(after[3], before[3]);
      if (!before[3] || luma(before) <= 90) assert.deepEqual(after, before);
      if (before[3] >= 240 && luma(before) >= 230) {
        assert.ok(luma(before) - luma(after) >= 23.49 && luma(before) - luma(after) <= 24.51);
        // Near-white starts above cream: darkening crosses the field luminance before separating.
        // Actual front/body (56,56), variant0: 255 -> 231, contrast 1.092 -> 1.133, not +.15.
        const delta = contrast(after) - contrast(before);
        deltas.push(delta);
        gain += delta; count++; samples++; beforeTotal += contrast(before); afterTotal += contrast(after);
      }
    }
    if (deltas.length) {
      deltas.sort((a, b) => a - b);
      const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
      const q10 = deltas[Math.floor((deltas.length - 1) * .1)];
      assert.ok(mean > .15, `${path}/${variant}: bright-cloth mean gain ${mean}`);
      assert.ok(q10 > .02, `${path}/${variant}: bright-cloth lower-decile gain ${q10}`);
    }
    assert.equal(api.tintedPart(path, variant), actual);
  }
  assert.ok(count > 100 && gain / count > .2, `${view}/${variant} measurable bright-cloth separation`);
  for (const part of ['head', 'helmet', 'shadow', ...(view === 'front' ? ['arm_left', 'arm_right'] : [])]) {
    const path = `mobs/soldier/${view}/${part}.png`;
    assert.equal(api.tintedPart(path, variant), sprites.get(path).image);
  }
}
for (const variant of [0, 1, 2, 3]) {
  const a = api.soldierBackTintPixel([235, 235, 235, 255], api.soldierBackTintColor('mobs/soldier/back/body.png', variant));
  const b = api.soldierBackTintPixel([250, 250, 250, 255], api.soldierBackTintColor('mobs/soldier/back/body.png', variant));
  assert.ok(Math.abs(luma(b) - luma(a) - 15) <= 1, 'bright local crease/value differences retained');
}
const other = 'mobs/brute/front/body.png', original = sprites.get('mobs/soldier/front/body.png').image;
sprites.set(other, { image: original });
assert.equal(api.tintedPart(other, 0), original, 'other mobs palette0 unchanged');
assert.equal(api.soldierBackTintColor(other, 1), null);
assert.ok(tintedParts.size <= 32, 'only 8 semantic parts x4 variants cached');
console.log(`Soldier clothing contrast PASS: ${samples} actual-PNG bright samples, mean cream contrast ${(beforeTotal/samples).toFixed(3)} -> ${(afterTotal/samples).toFixed(3)}; no WCAG-art acceptance claim`);
