const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
require.extensions['.ts'] = (module, filename) => module._compile(compile(fs.readFileSync(filename, 'utf8')), filename);
const { createGame, placeTower, tick, cellToWorld, towerStats } = require('./engine.ts');
const { gameplayRandom, createGameplayRandom } = require('./gameplayRandom.ts');
const combat = require('./combatShots.ts');
const source = fs.readFileSync(`${__dirname}/combatShots.ts`, 'utf8');
const baseline = {};
new Function('exports', 'require', compile(source.replaceAll('gameplayRandom(s)', 'Math.random()')))(baseline,
  name => require(path.join(__dirname, `${name}.ts`)));
const random = Math.random;
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const seeded = seed => createGame(undefined, undefined, undefined, { combatSeed: seed });
try {
  assert.deepEqual(createGame(), createGame(undefined, undefined, undefined, {}));
  check(!Object.hasOwn(createGame(), 'combatRandom'), 'legacy JSON has no seeded field');
  assert.equal(createGame(12, 21, 0, { combatSeed: 0 }).spawnTargetGraceSeconds, 0);
  assert.deepEqual(createGameplayRandom(0), { algorithm: 'mulberry32', version: 1, state: 0, cursor: 0 });
  for (const seed of [undefined, null, -1, .5, NaN, Infinity, 0x100000000, '1']) {
    assert.throws(() => seeded(seed), /COMBAT_RANDOM_INVALID/); checks++;
  }
  for (const options of [null, [], { extra: 1 }, { get combatSeed() { assert.fail('seed getter executed'); } }]) {
    assert.throws(() => createGame(12, 21, 1, options), /COMBAT_RANDOM_INVALID/); checks++;
  }
  const one = seeded(1);
  const known = [0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741, 0.9683778982143849];
  assert.deepEqual(known.map(() => gameplayRandom(one)), known);
  assert.equal(gameplayRandom(seeded(0)), 0.26642920868471265);
  for (const seed of [0, 1, 42, 0xffffffff]) {
    const a = seeded(seed), b = seeded(seed);
    for (let i = 0; i < 1024; i++) {
      const value = gameplayRandom(a); assert.equal(value, gameplayRandom(b));
      check(value >= 0 && value < 1, 'uniform range');
    }
    const restored = JSON.parse(JSON.stringify(a));
    for (let i = 0; i < 128; i++) assert.equal(gameplayRandom(a), gameplayRandom(restored));
    assert.deepEqual(a.combatRandom, restored.combatRandom);
  }
  check(gameplayRandom(seeded(0)) !== gameplayRandom(seeded(1)), 'different seeds');
  Math.random = () => { assert.fail('seeded malformed state fell through to Math.random'); };
  const good = createGameplayRandom(0);
  const malformed = [undefined, null, {}, [], { ...good, algorithm: 'other' }, { ...good, version: 2 },
    { ...good, state: -1 }, { ...good, state: Infinity }, { ...good, state: .5 },
    { ...good, cursor: NaN }, { ...good, cursor: -1 }, { ...good, cursor: 0xffffffff },
    { ...good, extra: true }, Object.freeze({ ...good }), Object.create(good)];
  const accessor = { ...good }; Object.defineProperty(accessor, 'state', { get() { assert.fail('state getter executed'); } }); malformed.push(accessor);
  for (const record of malformed) {
    assert.throws(() => gameplayRandom({ combatRandom: record }), /COMBAT_RANDOM_INVALID/); checks++;
  }
  assert.throws(() => gameplayRandom(Object.create({ combatRandom: good })), /COMBAT_RANDOM_INVALID/);
  assert.throws(() => gameplayRandom({ get combatRandom() { assert.fail('holder getter executed'); } }), /COMBAT_RANDOM_INVALID/);
  const exhausted = { combatRandom: { ...good, cursor: 0xfffffffe } };
  gameplayRandom(exhausted); const final = structuredClone(exhausted);
  assert.throws(() => gameplayRandom(exhausted), /COMBAT_RANDOM_INVALID/); assert.deepEqual(exhausted, final);

  function scene(seed) {
    const state = seed === undefined ? createGame() : seeded(seed);
    state.gold = 100000;
    assert.ok(placeTower(state, 'mortar', { x: 5, y: 3 }));
    const pos = cellToWorld({ x: 6, y: 3 });
    const enemy = { uid: 'target', id: 'soldier', hp: 1000, maxHp: 1000, speed: 0, pos,
      path: [{ ...pos }, { x: pos.x, y: pos.y + 280 }], pathIdx: 1, pathProgress: 0 };
    state.enemies.push(enemy); return { state, tower: state.towers[0], enemy };
  }
  function run(api, fixture) {
    const { state, tower, enemy } = fixture;
    const mine = api.sampleMineRoute(state, { x: 180, y: 100 }, 90);
    api.sampleMineRoute(state, { x: -1000, y: -1000 }, 1); // Empty route still consumed one draw before the patch.
    api.launchCombat(state, tower, enemy, towerStats(tower), 'Explosive');
    return { mine, state };
  }
  for (const values of [[.1, .2, .3, .4], [0, 0, 0, 0], [.99, .9, .8, .7]]) {
    const current = scene(), previous = scene();
    let cursor = 0; Math.random = () => { assert.ok(cursor < values.length); return values[cursor++]; };
    const a = run(combat, current); assert.equal(cursor, 4);
    cursor = 0; const b = run(baseline, previous); assert.equal(cursor, 4);
    assert.deepEqual(a, b, 'same unseeded uniforms => exact original combat/state parity');
  }
  Math.random = () => { assert.fail('direct seeded combat used cosmetic/global RNG'); };
  const a = run(combat, scene(42)), b = run(combat, scene(42)); assert.deepEqual(a, b);
  assert.equal(a.state.combatRandom.cursor, 4);
  const partial = scene(42);
  combat.sampleMineRoute(partial.state, { x: 180, y: 100 }, 90);
  const saved = JSON.parse(JSON.stringify(partial.state));
  assert.deepEqual(run(combat, partial), run(combat, { state: saved, tower: saved.towers[0], enemy: saved.enemies[0] }),
    'actual combat positions continue exactly after JSON restore');
  const c = scene(42); Math.random = () => .123;
  for (let i = 0; i < 500; i++) Math.random();
  assert.deepEqual(run(combat, c), a, 'cosmetic random calls cannot alter seeded combat');
  assert.notDeepEqual(run(combat, scene(43)).state.shots[0].to, a.state.shots[0].to);

  for (const seed of [undefined, 42]) {
    const state = seed === undefined ? createGame() : seeded(seed); state.gold = 100000;
    assert.ok(placeTower(state, 'mineLayer', { x: 5, y: 3 }));
    let draws = 0; Math.random = () => { draws++; return .25; };
    tick(state, .01);
    assert.equal(seed === undefined ? draws : state.combatRandom.cursor, 1, 'arming route precheck draw retained');
    tick(state, .3);
    assert.equal(seed === undefined ? draws : state.combatRandom.cursor, 2, 'release route sample draw retained');
    assert.equal(state.mines.length, 1);
  }
  console.log(`gameplay random PASS: ${checks} bounded checks; Mulberry32 known vectors, seed0/restore, actual mortar/mine, unseeded original parity/draw counts, cosmetic independence`);
} finally { Math.random = random; }
