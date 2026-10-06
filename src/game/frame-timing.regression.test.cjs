const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const { test } = require('node:test');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const { createReplayTiming, SIMULATION_STEP, MAX_FRAME_TICKS } = require('./replayTiming.ts');
const { createGame, tick, startWave, placeTower, canStartNextWave, getNextWaveWait } = require('./engine.ts');
const { createRunCheckpoint, restoreRunCheckpoint } = require('../state/checkpoints.ts');
const { createReplayProcessor, canonicalReplayBytes, projectReplayGameplayState } = require('./replayChunk.ts');
const { createReplayCommands } = require('./replayCommands.ts');
const { createHash } = require('node:crypto');
const dependencies = gs => ({ getState: () => gs, tick, startWave, canStartNextWave, getNextWaveWait });
const config = { mode: 'timed', waveLimit: 10, durationSeconds: 300 };
function begin(timing, speed) {
  timing.command({ type: 'startWave' }); timing.frame(0);
  if (speed >= 2) timing.command({ type: 'speedCycle' });
  if (speed === 4) timing.command({ type: 'speedCycle' });
}

test('real seeded engine outcome matches at 60/10/1 FPS and a 2400-second foreground gap', () => {
  const random = Math.random; Math.random = () => .5;
  try {
    for (const speed of [1, 2, 4]) for (const defense of [false, true]) {
      function run(delta, stall = false) {
        const gs = createGame(12, 21, 1, { combatSeed: 42 });
        if (defense) {
          assert.equal(placeTower(gs, 'canon', { x: 4, y: 8 }), true);
          assert.equal(placeTower(gs, 'simpleLaser', { x: 7, y: 13 }), true);
        }
        const timing = createReplayTiming(dependencies(gs), config); begin(timing, speed);
        if (stall) {
          const frame = timing.frame(2400);
          assert.ok(frame.ticks <= MAX_FRAME_TICKS);
          assert.equal(gs.victory, false, 'long gap cannot free-win');
          assert.ok(timing.snapshot().backlogSeconds > 2000);
          assert.ok(timing.snapshot().activeSeconds <= 8 + 1e-8);
        }
        for (let frame = 0; frame < 20000 && !gs.gameOver && !gs.victory; frame++) timing.frame(stall ? 0 : delta);
        assert.equal(gs.gameOver || gs.victory, true);
        if (!defense) assert.equal(gs.gameOver, true, 'no-defense low-FPS run must lose');
        const snapshot = timing.snapshot();
        return { battle: gs, activeSeconds: snapshot.activeSeconds, planningSeconds: snapshot.planningSeconds };
      }
      const expected = run(1 / 60);
      assert.deepEqual(run(.1), expected);
      assert.deepEqual(run(1), expected);
      assert.deepEqual(run(0, true), expected);
    }
  } finally { Math.random = random; }
});

test('real x1/x2/x4 clock contract and partial deadline use only processed combat', () => {
  for (const speed of [1, 2, 4]) {
    const gs = createGame(12, 21, 1, { combatSeed: 42 });
    const timing = createReplayTiming(dependencies(gs), config); begin(timing, speed);
    const result = timing.frame(1);
    assert.equal(result.ticks, Math.round(speed / SIMULATION_STEP));
    assert.ok(Math.abs(gs.time - speed) < 1e-8);
    assert.ok(Math.abs(timing.snapshot().activeSeconds - 1) < 1e-8);
  }
  const gs = createGame(12, 21, 1, { combatSeed: 42 }); startWave(gs);
  const timing = createReplayTiming(dependencies(gs), config, { version: 1, speed: 4,
    activeSeconds: 299.99, planningSeconds: 0, clockStarted: true, hidden: false, resetNextFrame: false });
  timing.frame(100);
  assert.equal(gs.victory, true);
  assert.ok(Math.abs(gs.time - .04) < 1e-8);
  assert.equal(timing.snapshot().activeSeconds, 300);
});

test('checkpoint paused restoration preserves clocks, unique tower types, RNG, uid and backlog', () => {
  const gs = createGame(12, 21, 1, { combatSeed: 123 });
  assert.equal(placeTower(gs, 'canon', { x: 4, y: 8 }), true);
  const timing = createReplayTiming(dependencies(gs), config); begin(timing, 4);
  timing.frame(.016); timing.frame(20);
  const snapshot = timing.snapshot();
  const checkpoint = createRunCheckpoint({ runId: 'local-1', battle: gs,
    activeSeconds: snapshot.activeSeconds, planningSeconds: snapshot.planningSeconds,
    clockStarted: snapshot.clockStarted, speed: snapshot.speed, placedTowerTypes: ['canon'],
    backlogSeconds: snapshot.backlogSeconds, savedAt: 100 });
  const saved = JSON.stringify(checkpoint);
  const restored = restoreRunCheckpoint(JSON.parse(saved), 'local-1');
  assert.equal(restored.battle.paused, true);
  assert.deepEqual(restored.battle.combatRandom, gs.combatRandom);
  assert.equal(restored.battle.uidCounter, gs.uidCounter);
  assert.deepEqual(restored.placedTowerTypes, ['canon']);
  const other = createReplayTiming(dependencies(restored.battle), config, { ...snapshot, hidden: false, resetNextFrame: true,
    backlogSeconds: restored.backlogSeconds });
  assert.equal(other.frame(10000).ticks, 0, 'offline time never counts');
  other.command({ type: 'resume' });
  gs.paused = true; timing.command({ type: 'resume' });
  const random = Math.random; Math.random = () => .5;
  try {
    for (const delta of [0, .001, .016, 1, .1]) {
      assert.deepEqual(other.frame(delta), timing.frame(delta));
      assert.deepEqual(restored.battle, gs);
      assert.deepEqual(other.snapshot(), timing.snapshot());
    }
  } finally { Math.random = random; }
  assert.equal(JSON.stringify(checkpoint), saved, 'restore never mutates persisted snapshot');
});

test('client shared timing/actions matches actual ReplayProcessor after every committed event', () => {
  const fingerprint = 'fixed-step-client-replay-parity', seed = 42;
  const digest = bytes => createHash('sha256').update(bytes).digest();
  for (const mode of ['waves', 'timed', 'endless']) for (const speed of [1, 2, 4]) {
    const cfg = { ...config, mode }, gs = createGame(undefined, undefined, undefined, { combatSeed: seed });
    const timing = createReplayTiming(dependencies(gs), cfg);
    const commands = createReplayCommands({ getState: () => gs, timing });
    const processor = createReplayProcessor({ config: cfg, seed, fingerprint, digest });
    const command = type => ({ type: 'timing', command: { type } });
    const frame = delta => ({ type: 'frame', delta });
    const events = [{ type: 'action', action: { type: 'place', towerId: 'canon', cell: { x: 5, y: 3 } } },
      command('startWave'), frame(0)];
    if (speed >= 2) events.push(command('speedCycle'));
    if (speed === 4) events.push(command('speedCycle'));
    events.push(frame(.1), command('pause'), frame(1000),
      { type: 'timing', command: { type: 'visibility', hidden: true } }, frame(1000),
      { type: 'timing', command: { type: 'visibility', hidden: false } }, command('resume'), frame(0),
      frame(.016), frame(1), frame(.25), frame(20), frame(0));
    for (const event of events) {
      if (event.type === 'frame') timing.frame(event.delta);
      else if (event.type === 'timing') commands.timingCommand(event.command);
      else commands.action(event.action);
      const status = processor.status();
      let result = processor.submit({ version: 1, index: status.nextIndex, previousHash: status.previousHash, events: [event] });
      let resumes = 0;
      while (result.status === 'pending') { assert.ok(++resumes < 1000); result = processor.resume(); }
      assert.equal(result.status, 'historyValid');
      const expected = digest(canonicalReplayBytes({ version: 1, fingerprint, config: cfg, seed,
        engine: projectReplayGameplayState(gs), timing: timing.snapshot() })).toString('hex');
      assert.equal(processor.status().gameplayHash, expected, `${mode}/x${speed}/${JSON.stringify(event)}`);
    }
  }
});

test('trusted frame budget yields preserve exactly one client frame and zero-budget eligibility probes', () => {
  const gs = createGame(undefined, undefined, undefined, { combatSeed: 42 });
  const copy = structuredClone(gs);
  const one = createReplayTiming(dependencies(gs), config), split = createReplayTiming(dependencies(copy), config);
  begin(one, 4); begin(split, 4);
  const result = one.frame(20);
  let ticks = 0, part = split.frame(20, 3); ticks += part.ticks;
  assert.equal(part.budgetExhausted, true);
  const snapshot = split.snapshot();
  assert.equal(split.frame(0, 0).budgetExhausted, true);
  assert.deepEqual(split.snapshot(), snapshot, 'zero probe cannot consume time or combat');
  while (ticks < MAX_FRAME_TICKS && part.budgetExhausted) {
    part = split.frame(0, Math.min(7, MAX_FRAME_TICKS - ticks)); ticks += part.ticks;
  }
  assert.equal(ticks, result.ticks);
  assert.deepEqual(copy, gs); assert.deepEqual(split.snapshot(), one.snapshot());
  for (const limit of [-1, .5, NaN, Infinity, MAX_FRAME_TICKS + 1, '1']) {
    assert.throws(() => split.frame(0, limit), /REPLAY_TIMING_INVALID/);
  }
  const idle = createReplayTiming(dependencies(createGame()), config);
  idle.frame(0);
  assert.equal(idle.frame(0, 0).budgetExhausted, false);
});

test('actual Game ranked timing config enforces 1x in shared commands, not merely the HUD', () => {
  const source = fs.readFileSync(`${__dirname}/Game.tsx`, 'utf8');
  const ast = ts.createSourceFile('Game.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let configExpression;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'createReplayTiming' && node.arguments.length === 3) {
      configExpression = node.arguments[1].getText(ast);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(configExpression);
  const getConfig = new Function('run', ts.transpileModule(`return (${configExpression});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText);
  const cfg = getConfig({ config: { access: 'ranked', mode: 'timed', durationMinutes: 20, waveLimit: 10 } });
  assert.equal(cfg.speedLimit, 1);
  const gs = createGame(undefined, undefined, undefined, { combatSeed: 42 });
  const timing = createReplayTiming(dependencies(gs), cfg);
  const commands = createReplayCommands({ getState: () => gs, timing });
  assert.throws(() => commands.timingCommand({ type: 'speedCycle' }), /REPLAY_TIMING_INVALID/);
  assert.equal(timing.snapshot().speed, 1); assert.equal(gs.speed, 1);
});

test('exact or near deadline at the trusted tick ceiling normalizes victory before eligibility probe', () => {
  for (const durationSeconds of [.1, .1 + 5e-10]) {
    const cfg = { ...config, durationSeconds };
    const gs = createGame(undefined, undefined, undefined, { combatSeed: 42 }), copy = structuredClone(gs);
    const whole = createReplayTiming(dependencies(gs), cfg), sliced = createReplayTiming(dependencies(copy), cfg);
    begin(whole, 1); begin(sliced, 1);
    whole.frame(.1);
    const result = sliced.frame(.1, 6);
    assert.equal(result.ticks, 6);
    assert.equal(result.budgetExhausted, false);
    assert.equal(copy.victory, true);
    assert.equal(sliced.snapshot().activeSeconds, durationSeconds);
    assert.deepEqual(copy, gs); assert.deepEqual(sliced.snapshot(), whole.snapshot());
    assert.equal(sliced.frame(0, 0).budgetExhausted, false);
  }
});
