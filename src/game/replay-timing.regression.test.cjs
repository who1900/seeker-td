const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const { test } = require('node:test');
const compile = source => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
require.extensions['.ts'] = (module, filename) => module._compile(compile(fs.readFileSync(filename, 'utf8')), filename);
const { createReplayTiming } = require('./replayTiming.ts');
const { createGame, tick, startWave, canStartNextWave, getNextWaveWait } = require('./engine.ts');
const gameSource = fs.readFileSync(`${__dirname}/Game.tsx`, 'utf8');
const ast = ts.createSourceFile('Game.tsx', gameSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['engineFramePlan', 'activeRunDelta', 'runHasVictory', 'nextWaveBlockReason', 'shouldAutoStart'];
const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
assert.equal(declarations.length, names.length);
const helpers = {};
new Function('exports', compile(declarations.map(node => node.getText(ast)).join('\n')))(helpers);
const config = mode => ({ mode, waveLimit: 2, durationSeconds: 20 });
function fixture(mode = 'endless', changes = {}, snapshot) {
  const gs = { paused: false, gameOver: false, victory: false, waveActive: false, waveIndex: -1, completedWaves: 0, lives: 20 };
  const calls = [];
  const dependencies = { getState: () => gs,
    tick(state, dt) { calls.push(['tick', dt]); changes.tick?.(state, dt); },
    startWave(state) { calls.push(['start']); state.waveIndex++; state.waveActive = true; },
    canStartNextWave: () => changes.ready ?? true, getNextWaveWait: () => changes.wait ?? 0 };
  return { gs, calls, dependencies, wrapper: createReplayTiming(dependencies, config(mode), snapshot) };
}
function reference(gs, wrapper, cfg, dependencies, inputDelta) {
  const wallDt = wrapper.resetNextFrame ? 0 : inputDelta;
  wrapper.resetNextFrame = false;
  const running = !gs.paused && !gs.gameOver && !gs.victory && !wrapper.hidden;
  const frameDt = helpers.activeRunDelta(wallDt, wrapper.activeSeconds, cfg.durationSeconds, wrapper.clockStarted, !running, cfg.mode === 'timed');
  const wasActive = gs.waveActive;
  if (running && wrapper.clockStarted) wrapper.activeSeconds += frameDt;
  const plan = helpers.engineFramePlan(wallDt, frameDt, running, wasActive, wrapper.speed, wrapper.clockStarted);
  let ticks = 0, autoStarted = false;
  for (let i = 0; i < plan.steps && (!wasActive || gs.waveActive) && !gs.gameOver && !gs.victory; i++) {
    dependencies.tick(gs, plan.dt); ticks++;
    if (helpers.runHasVictory(cfg.mode, gs.completedWaves, cfg.waveLimit, 0, cfg.durationSeconds, wrapper.clockStarted, gs.lives > 0 && !gs.gameOver)) gs.victory = true;
  }
  if (running && cfg.mode === 'timed' && wrapper.clockStarted) {
    if (helpers.runHasVictory(cfg.mode, gs.completedWaves, cfg.waveLimit, wrapper.activeSeconds, cfg.durationSeconds, wrapper.clockStarted, gs.lives > 0 && !gs.gameOver)) gs.victory = true;
    if (!gs.waveActive && !gs.gameOver && !gs.victory) {
      wrapper.planningSeconds += wasActive ? 0 : frameDt;
      const blocked = helpers.nextWaveBlockReason(cfg.mode, gs.waveIndex + 1, cfg.waveLimit, wrapper.activeSeconds, cfg.durationSeconds,
        gs.paused, gs.gameOver || gs.victory, wrapper.hidden, dependencies.canStartNextWave(gs), dependencies.getNextWaveWait(gs));
      if (helpers.shouldAutoStart(cfg.mode, wrapper.clockStarted, !!blocked, gs.waveActive, wrapper.planningSeconds, dependencies.canStartNextWave(gs))) {
        const previous = gs.waveIndex; dependencies.startWave(gs);
        if (gs.waveIndex !== previous) { wrapper.planningSeconds = 0; autoStarted = true; }
      }
    }
  }
  return { wallDt, frameDt, dt: plan.dt, steps: plan.steps, ticks, autoStarted };
}

test('variable-delta wrapper matches extracted current Game helpers and frame order', () => {
  let cases = 0;
  for (const mode of ['waves', 'timed', 'endless']) for (const speed of [1, 2, 4]) {
    for (const elapsed of [0, 19.98, 20]) for (const delta of [0, .001, .016, .05, .2, 10000]) {
      for (const active of [false, true]) for (const outcome of ['none', 'clear', 'defeat', 'wavesVictory']) {
        const snapshot = { version: 1, speed, activeSeconds: elapsed, planningSeconds: mode === 'timed' ? 2.99 : 0,
          clockStarted: true, hidden: false, resetNextFrame: false };
        const onTick = gs => {
          if (outcome === 'clear') gs.waveActive = false;
          if (outcome === 'defeat') { gs.gameOver = true; gs.lives = 0; }
          if (outcome === 'wavesVictory') gs.completedWaves = 2;
        };
        const f = fixture(mode, { tick: onTick }, snapshot);
        f.gs.waveActive = active; f.gs.waveIndex = 0;
        const expectedState = structuredClone(f.gs), expectedWrapper = structuredClone(snapshot);
        const expected = reference(expectedState, expectedWrapper, config(mode), {
          ...f.dependencies, tick: onTick, startWave: gs => { gs.waveIndex++; gs.waveActive = true; },
        }, delta);
        assert.deepEqual(f.wrapper.frame(delta), expected);
        assert.deepEqual(f.gs, expectedState); assert.deepEqual(f.wrapper.snapshot(), expectedWrapper); cases++;
      }
    }
  }
  console.log(`replay timing extracted-helper parity ${cases} frames`);
});

test('manual starts overlap; pause/hidden resets, speed rules and three-second auto planning', () => {
  const f = fixture('timed');
  assert.equal(f.wrapper.frame(999).ticks, 0);
  f.wrapper.command({ type: 'startWave' });
  assert.equal(f.wrapper.frame(999).ticks, 0);
  f.wrapper.command({ type: 'speedCycle' }); f.wrapper.command({ type: 'speedCycle' });
  assert.equal(f.wrapper.frame(.02).ticks, 4);
  assert.equal(f.wrapper.snapshot().activeSeconds, .02);
  f.wrapper.command({ type: 'startWave' }); assert.equal(f.gs.waveIndex, 1, 'ready overlapping wave accepted');
  f.wrapper.frame(0);
  f.wrapper.command({ type: 'pause' }); assert.equal(f.wrapper.frame(10000).ticks, 0);
  assert.throws(() => f.wrapper.command({ type: 'speedCycle' }), /REPLAY_TIMING_INVALID/);
  f.wrapper.command({ type: 'resume' }); assert.equal(f.wrapper.frame(10000).ticks, 0);
  f.wrapper.command({ type: 'visibility', hidden: true }); assert.equal(f.gs.paused, true);
  assert.throws(() => f.wrapper.command({ type: 'resume' }), /REPLAY_TIMING_INVALID/);
  f.wrapper.command({ type: 'visibility', hidden: false }); assert.equal(f.gs.paused, true);
  f.wrapper.command({ type: 'resume' }); f.wrapper.frame(10000);
  f.gs.waveActive = false;
  assert.equal(f.wrapper.frame(2.99).autoStarted, false);
  assert.equal(f.wrapper.frame(.01).autoStarted, true);
  assert.equal(f.wrapper.snapshot().planningSeconds, 0);
  assert.equal(f.calls.filter(call => call[0] === 'tick').at(-1)[1], .01, 'BUILD variable dt at speed4 stays one step');
  const waves = fixture('waves');
  waves.wrapper.command({ type: 'startWave' }); waves.wrapper.command({ type: 'startWave' });
  assert.throws(() => waves.wrapper.command({ type: 'startWave' }), /REPLAY_TIMING_INVALID/);
  const blocked = fixture('endless', { ready: false, wait: 5 });
  assert.throws(() => blocked.wrapper.command({ type: 'startWave' }), /REPLAY_TIMING_INVALID/);
});

test('strict input/snapshot validation, detached snapshots and dependency failures fail closed', () => {
  const f = fixture();
  for (const delta of [-1, NaN, Infinity, '1', null]) assert.throws(() => f.wrapper.frame(delta), /REPLAY_TIMING_INVALID/);
  for (const command of [null, {}, { type: 'tick' }, { type: 'speedCycle', speed: 3 },
    { type: 'visibility', hidden: 1 }, { get type() { assert.fail('getter executed'); } }]) {
    assert.throws(() => f.wrapper.command(command), /REPLAY_TIMING_INVALID/);
  }
  const saved = f.wrapper.snapshot(); saved.speed = 4; assert.equal(f.wrapper.snapshot().speed, 1);
  const valid = f.wrapper.snapshot();
  for (const bad of [null, [], { ...valid, version: 2 }, { ...valid, speed: 3 }, { ...valid, activeSeconds: Infinity },
    { ...valid, activeSeconds: 1 }, { ...valid, planningSeconds: 1 }, { ...valid, extra: 0 },
    { ...valid, get speed() { assert.fail('snapshot getter executed'); } }]) {
    assert.throws(() => createReplayTiming(f.dependencies, config('endless'), bad), /REPLAY_TIMING_INVALID/);
  }
  const broken = fixture('endless', { tick() { throw new Error('injected failure'); } });
  broken.wrapper.frame(0); assert.throws(() => broken.wrapper.frame(.01), /injected failure/);
  assert.throws(() => broken.wrapper.snapshot(), /REPLAY_TIMING_INVALID/);
  for (const name of ['canStartNextWave', 'getNextWaveWait', 'startWave', 'getState']) {
    const callbackFailure = fixture();
    callbackFailure.dependencies[name] = () => { throw new Error(`failure ${name}`); };
    assert.throws(() => callbackFailure.wrapper.command({ type: 'startWave' }), new RegExp(`failure ${name}`));
    assert.throws(() => callbackFailure.wrapper.frame(0), /REPLAY_TIMING_INVALID/);
  }
  for (const jump of [0, 2]) {
    const saved = { version: 1, speed: 1, activeSeconds: 1, planningSeconds: 3,
      clockStarted: true, hidden: false, resetNextFrame: false };
    const invalidStart = fixture('timed', {}, saved);
    invalidStart.dependencies.startWave = state => { state.waveIndex += jump; };
    assert.throws(() => invalidStart.wrapper.frame(.01), /REPLAY_TIMING_INVALID/);
    assert.throws(() => invalidStart.wrapper.snapshot(), /REPLAY_TIMING_INVALID/);
  }
  const dead = fixture('timed', { tick(gs) { gs.gameOver = true; gs.lives = 0; } });
  dead.wrapper.command({ type: 'startWave' }); dead.wrapper.frame(0);
  dead.wrapper.frame(10000); assert.equal(dead.gs.victory, false, 'defeat wins at timed deadline');
});

test('actual engine variable substeps and plain JSON continuation preserve combat state/clocks', () => {
  const gs = createGame(12, 21, 1, { combatSeed: 42 });
  const dependencies = state => ({ getState: () => state, tick, startWave, canStartNextWave, getNextWaveWait });
  const cfg = config('endless');
  let wrapper = createReplayTiming(dependencies(gs), cfg);
  wrapper.frame(10); wrapper.command({ type: 'startWave' }); wrapper.frame(10);
  wrapper.command({ type: 'speedCycle' }); wrapper.command({ type: 'speedCycle' });
  for (const dt of [.001, .016, .2, .03]) wrapper.frame(dt);
  const restored = JSON.parse(JSON.stringify(gs));
  const other = createReplayTiming(dependencies(restored), cfg, JSON.parse(JSON.stringify(wrapper.snapshot())));
  const random = Math.random;
  try {
    Math.random = () => .5;
    for (let i = 0; i < 80; i++) {
      const delta = [.001, .016, .05, .1][i % 4];
      assert.deepEqual(wrapper.frame(delta), other.frame(delta));
      assert.deepEqual(gs, restored); assert.deepEqual(wrapper.snapshot(), other.snapshot());
    }
  } finally { Math.random = random; }
});
