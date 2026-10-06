const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const { test } = require('node:test');
const compile = source => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
} }).outputText;
require.extensions['.ts'] = (module, filename) => module._compile(compile(fs.readFileSync(filename, 'utf8')), filename);
const engine = require('./engine.ts');
const { BASE_TOWER_ORDER, TOWER_ORDER, TOWERS, UPGRADE_GRAPH } = require('./data.ts');
const { createReplayTiming } = require('./replayTiming.ts');
const { createReplayCommands } = require('./replayCommands.ts');
function fixture(width = 12, height = 21, gold) {
  const gs = engine.createGame(width, height, 1, { combatSeed: 42 });
  if (gold !== undefined) gs.gold = gold; // Server-owned action fixture, never event-supplied currency.
  const timing = createReplayTiming({ getState: () => gs, tick: engine.tick, startWave: engine.startWave,
    canStartNextWave: engine.canStartNextWave, getNextWaveWait: engine.getNextWaveWait },
  { mode: 'endless', waveLimit: 10, durationSeconds: 300 });
  return { gs, timing, commands: createReplayCommands({ getState: () => gs, timing }) };
}
const place = (f, towerId = 'canon', x = 1, y = 3) => f.commands.action({ type: 'place', towerId, cell: { x, y } });
const action = (f, type, uid) => f.commands.action({ type, uid });
function rejected(f, input) {
  const before = structuredClone(f.gs);
  assert.throws(() => f.commands.action(input), /REPLAY_COMMAND_INVALID/);
  assert.deepEqual(f.gs, before, 'rejected event leaves actual engine state unchanged');
}

test('exact base placement roster; engine-derived economy, enhancement limits and early promotions', () => {
  let actions = 0;
  for (const base of BASE_TOWER_ORDER) {
    const f = fixture(12, 21, 1000000), reference = structuredClone(f.gs);
    const result = place(f, base);
    assert.equal(engine.placeTower(reference, base, { x: 1, y: 3 }), true);
    assert.deepEqual(f.gs, reference); assert.equal(result.gold, 1000000 - TOWERS[base].cost); actions++;
    const uid = result.uid;
    while (true) {
      const tower = f.gs.towers[0], spec = TOWERS[tower.towerId];
      const before = f.gs.gold, cost = engine.getEnhanceCost(tower);
      action(f, 'enhance', uid); assert.equal(engine.enhanceTower(reference, uid), true);
      assert.equal(f.gs.gold, before - cost); assert.deepEqual(f.gs, reference); actions++;
      if (tower.level === spec.maxLevel - 1) break;
    }
    rejected(f, { type: 'enhance', uid });
    const oldValue = f.gs.towers[0].value;
    const beforePromote = f.gs.gold, promoteCost = TOWERS[base].upgradeCostToNext;
    action(f, 'promote', uid); assert.equal(engine.promoteTower(reference, uid), true);
    assert.equal(f.gs.gold, beforePromote - promoteCost); assert.equal(f.gs.towers[0].level, 0);
    assert.equal(f.gs.towers[0].value, oldValue + promoteCost); assert.deepEqual(f.gs, reference); actions++;
    action(f, 'promote', uid); assert.equal(engine.promoteTower(reference, uid), true);
    assert.equal(f.gs.towers[0].towerId, UPGRADE_GRAPH[UPGRADE_GRAPH[base]]);
    assert.deepEqual(f.gs, reference); rejected(f, { type: 'promote', uid }); actions++;
    const value = f.gs.towers[0].value, beforeSell = f.gs.gold;
    assert.equal(action(f, 'sell', uid).gold, beforeSell + value); engine.sellTower(reference, uid);
    assert.deepEqual(f.gs, reference); assert.equal(f.gs.towers.length, 0); actions++;
    rejected(f, { type: 'sell', uid });
  }
  const affordable = fixture(); place(affordable);
  affordable.gs.gold = 0;
  rejected(affordable, { type: 'enhance', uid: affordable.gs.towers[0].uid });
  rejected(affordable, { type: 'promote', uid: affordable.gs.towers[0].uid });
  rejected(affordable, { type: 'place', towerId: 'canon', cell: { x: 2, y: 3 } });
  const f = fixture();
  for (const towerId of TOWER_ORDER.filter(id => !BASE_TOWER_ORDER.includes(id))) {
    rejected(f, { type: 'place', towerId, cell: { x: 1, y: 3 } });
  }
  console.log(`replay commands engine-derived economy ${actions} accepted actions; 4 base/12 promoted models`);
});

test('all aiming models cycle five modes and toggle lock; non-aimers reject and defaults propagate', () => {
  let models = 0;
  for (const base of BASE_TOWER_ORDER) {
    const f = fixture(12, 21, 1000000), uid = place(f, base).uid;
    for (let tier = 0; tier < 3; tier++) {
      const tower = f.gs.towers[0]; models++;
      if (['glueTower', 'mineLayer'].includes(tower.towerId)) {
        rejected(f, { type: 'cycleTarget', uid }); rejected(f, { type: 'toggleLock', uid });
      } else {
        for (const mode of ['first', 'last', 'strongest', 'weakest', 'closest']) {
          action(f, 'cycleTarget', uid);
          assert.equal(tower.targetingMode, mode); assert.equal(f.gs.defaultTargetingMode, mode);
        }
        action(f, 'toggleLock', uid); assert.equal(tower.targetLock, false); assert.equal(f.gs.defaultTargetLock, false);
        action(f, 'toggleLock', uid); assert.equal(tower.targetLock, true);
      }
      if (tier < 2) action(f, 'promote', uid);
    }
  }
  assert.equal(models, 12);
  const f = fixture(12, 21, 100000), uid = place(f).uid;
  action(f, 'cycleTarget', uid); action(f, 'toggleLock', uid);
  place(f, 'simpleLaser', 2, 3);
  assert.equal(f.gs.towers[1].targetingMode, 'first'); assert.equal(f.gs.towers[1].targetLock, false);
});

test('actual labyrinth actions reroute live enemies without teleport and reject sealing route', () => {
  const f = fixture(6, 8, 100000);
  f.commands.timingCommand({ type: 'startWave' }); f.timing.frame(0);
  for (let i = 0; i < 8; i++) f.timing.frame(.05);
  assert.ok(f.gs.enemies.length > 0);
  const positions = f.gs.enemies.map(enemy => ({ uid: enemy.uid, pos: { ...enemy.pos } }));
  const beforePath = structuredClone(f.gs.currentPath), beforeEnemyPath = structuredClone(f.gs.enemies[0].path);
  place(f, 'canon', 3, 3);
  assert.notDeepEqual(f.gs.currentPath, beforePath);
  assert.notDeepEqual(f.gs.enemies[0].path, beforeEnemyPath);
  assert.deepEqual(f.gs.enemies.map(enemy => ({ uid: enemy.uid, pos: { ...enemy.pos } })), positions);
  assert.equal(f.gs.teleports.length, 0);
  for (const x of [0, 1, 2, 3, 5]) place(f, 'canon', x, 4);
  rejected(f, { type: 'place', towerId: 'canon', cell: { x: 4, y: 4 } });
  const uid = f.gs.towers.find(tower => tower.cell.y === 4 && tower.cell.x === 3).uid;
  action(f, 'sell', uid); assert.equal(f.gs.grid[4][3], false); assert.equal(f.gs.teleports.length, 0);
  assert.deepEqual(f.gs.enemies.map(enemy => ({ uid: enemy.uid, pos: { ...enemy.pos } })), positions);
  const transit = fixture(6, 8, 100000);
  transit.commands.timingCommand({ type: 'startWave' }); transit.timing.frame(0);
  for (let i = 0; i < 20; i++) transit.timing.frame(.05);
  const enemy = transit.gs.enemies[0], next = enemy.path[enemy.pathIdx];
  for (const point of [enemy.pos, next]) {
    rejected(transit, { type: 'place', towerId: 'canon', cell: { x: Math.floor(point.x / 28), y: Math.floor(point.y / 28) } });
  }
  assert.equal(transit.gs.teleports.length, 0);
});

test('strict event schemas reject client state/snapshots/accessors and UI-blocked actions', () => {
  const f = fixture(), uid = place(f).uid;
  for (const input of [null, {}, [], { type: 'exit' }, { type: 'startWave' },
    { type: 'sell', uid, gold: 100000 }, { type: 'sell', uid, state: {} }, { type: 'sell', uid, snapshot: {} },
    { type: 'sell', uid, wallet: 'address' }, { type: 'sell', uid, tokens: 1000 }, { type: 'sell', uid, std: 1000 },
    { type: 'cycleTarget', uid, mode: 'strongest' }, { type: 'toggleLock', uid, lock: false },
    { type: 'place', towerId: '__proto__', cell: { x: 2, y: 3 } },
    { type: 'place', towerId: 'canon', cell: { x: 1.5, y: 3 } },
    { type: 'place', towerId: 'canon', cell: { x: -1, y: 3 } },
    { type: 'place', towerId: 'canon', cell: { x: 12, y: 3 } },
    { type: 'place', towerId: 'canon', cell: { x: 2, y: 3, gold: 1000 } },
    { type: 'place', towerId: 'canon', cell: { x: f.gs.entry.x, y: 0 } },
    { type: 'place', towerId: 'canon', cell: { x: f.gs.exit.x, y: f.gs.exit.y } },
    { type: 'place', towerId: 'canon', cell: { x: 1, y: 3 } },
    { type: 'sell', uid: 'missing' }, { type: 'sell', uid: '' }, { type: 'sell', uid: 'x'.repeat(129) },
    { type: 'sell', uid: '\u0000' }, { get type() { assert.fail('event getter executed'); } },
    { type: 'sell', get uid() { assert.fail('uid getter executed'); } },
    { type: 'place', towerId: 'canon', cell: { get x() { assert.fail('cell getter executed'); }, y: 3 } },
    Object.create({ type: 'sell', uid }), { type: 'sell', uid, [Symbol('extra')]: 1 }]) rejected(f, input);
  for (const block of ['paused', 'gameOver', 'victory', 'hidden']) {
    const blocked = fixture(), uid = place(blocked).uid;
    if (block === 'hidden') blocked.commands.timingCommand({ type: 'visibility', hidden: true });
    else blocked.gs[block] = true;
    for (const type of ['enhance', 'promote', 'sell', 'cycleTarget', 'toggleLock']) rejected(blocked, { type, uid });
    rejected(blocked, { type: 'place', towerId: 'canon', cell: { x: 2, y: 3 } });
  }
  f.commands.timingCommand({ type: 'pause' }); assert.equal(f.gs.paused, true);
  f.commands.timingCommand({ type: 'resume' }); assert.equal(f.gs.paused, false);
  assert.throws(() => f.commands.timingCommand({ type: 'speedCycle', speed: 4 }), /REPLAY_TIMING_INVALID/);
  assert.throws(() => createReplayCommands({ getState: () => engine.createGame(), timing: f.timing }), /REPLAY_COMMAND_INVALID/);
  const broken = fixture();
  assert.throws(() => createReplayCommands({ getState: () => broken.gs, timing: broken.timing, snapshot: {} }), /REPLAY_COMMAND_INVALID/);
  const failure = fixture();
  const commands = createReplayCommands({ getState: () => failure.gs,
    timing: { snapshot: () => failure.timing.snapshot(), command() { throw new Error('timing dependency failure'); } } });
  assert.throws(() => commands.timingCommand({ type: 'pause' }), /timing dependency failure/);
  assert.throws(() => commands.action({ type: 'place', towerId: 'canon', cell: { x: 2, y: 3 } }), /REPLAY_COMMAND_INVALID/);
  const failSnapshot = createReplayCommands({ getState: () => failure.gs,
    timing: { snapshot() { throw new Error('snapshot dependency failure'); }, command() {} } });
  assert.throws(() => failSnapshot.action({ type: 'place', towerId: 'canon', cell: { x: 2, y: 3 } }), /snapshot dependency failure/);
  assert.throws(() => failSnapshot.action({ type: 'place', towerId: 'canon', cell: { x: 2, y: 3 } }), /REPLAY_COMMAND_INVALID/);
});
