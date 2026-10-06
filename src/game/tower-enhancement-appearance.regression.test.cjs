const { strict: assert } = require('node:assert');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const data = {};
new Function('exports', compile(readFileSync(`${__dirname}/data.ts`, 'utf8')))(data);
const source = readFileSync(`${__dirname}/paperGeometry.ts`, 'utf8');
function geometry(text) {
  const api = {};
  new Function('exports', 'require', compile(text))(api, name => { assert.equal(name, './data'); return data; });
  return api;
}
const api = geometry(source);
const oldFilter = "const visible = model.parts.filter(p => !p.optional || tower.level >= (p.file === 'enhancement_1.png' ? 2 : 5));";
const changedFilter = /const visible = model\.parts\.filter\([^\n]+/;
assert.match(source, changedFilter);
const old = geometry(source.replace(changedFilter, oldFilter));
const manifest = JSON.parse(readFileSync(`${__dirname}/../../public/paper-assets/manifest.json`, 'utf8'));
assert.equal(Object.keys(manifest.towers).length, 12);
const short = new Set(['glueTower', 'glueGun', 'teleporter']);
let cases = 0;
for (const [towerId, model] of Object.entries(manifest.towers)) {
  const max = data.TOWERS[towerId].maxLevel;
  const threshold = short.has(towerId) ? 4 : 5;
  let reached = false;
  for (let level = 0; level < max; level++) for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    for (const shotAge of [-1, 0, .08, .16]) {
      const tower = { towerId, worldX: 50, worldY: 60, level };
      const before = JSON.stringify({ tower, model });
      const pose = api.paperTowerPose(model, [10, 20, 240, 245], tower, angle, shotAge, 28, 256);
      const baseline = old.paperTowerPose(model, [10, 20, 240, 245], tower, angle, shotAge, 28, 256);
      assert.ok(pose && baseline);
      const files = pose.parts.map(part => part.part.file);
      assert.equal(files.includes('enhancement_1.png'), level >= 2);
      assert.equal(files.includes('enhancement_2.png'), level >= threshold);
      if (files.includes('enhancement_2.png')) reached = true;
      assert.equal(pose.scale, baseline.scale);
      for (const part of baseline.parts) {
        const actual = pose.parts.find(candidate => candidate.part.file === part.part.file);
        assert.deepEqual(actual, part, `${towerId}/${level}: existing part/matrix changed`);
      }
      const expectedFiles = baseline.parts.map(part => part.part.file);
      if (short.has(towerId) && level === 4) {
        assert.deepEqual(files.filter(file => file !== 'enhancement_2.png'), expectedFiles);
        const added = pose.parts.find(part => part.part.file === 'enhancement_2.png');
        assert.ok(added.matrix.every(Number.isFinite));
      } else assert.deepEqual(pose, baseline, `${towerId}/${level}: unrelated pose changed`);
      for (const socket of ['muzzle', ...Object.keys(model.sockets ?? {})]) {
        assert.deepEqual(api.paperTowerSocket(model, pose, socket), old.paperTowerSocket(model, baseline, socket), `${towerId}/${level}/${socket}: socket changed`);
      }
      assert.equal(JSON.stringify({ tower, model }), before);
      cases++;
    }
  }
  assert.ok(reached, `${towerId}: second enhancement unreachable at valid levels`);
  const legacyTower = { worldX: 50, worldY: 60, level: 4 };
  assert.deepEqual(api.paperTowerPose(model, [10, 20, 240, 245], legacyTower, 0, .08, 28), old.paperTowerPose(model, [10, 20, 240, 245], legacyTower, 0, .08, 28), 'id-less API behavior unchanged');
}
console.log(`tower enhancement appearance regression: passed (12 models, ${cases} valid-level/rotation/recoil poses)`);
