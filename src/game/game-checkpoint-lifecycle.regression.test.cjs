const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const { test } = require('node:test');
const compile = code => ts.transpileModule(code, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
require.extensions['.ts'] = (module, filename) => module._compile(compile(fs.readFileSync(filename, 'utf8')), filename);
const { createGame, tick, startWave, canStartNextWave, getNextWaveWait } = require('./engine.ts');
const { createReplayTiming } = require('./replayTiming.ts');
const { createRunCheckpoint, restoreRunCheckpoint } = require('../state/checkpoints.ts');
const { DEFAULT_STATE, persistBattleCheckpoint } = require('../state/store.ts');
const { admitRun, settleRun, continueRun } = require('../state/runs.ts');
const source = fs.readFileSync(`${__dirname}/Game.tsx`, 'utf8');
const ast = ts.createSourceFile('Game.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map(), effects = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node.getText(ast));
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect') effects.push(node.arguments[0].getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
const names = ['settleCurrentRun', 'syncTiming', 'failPersistence', 'saveCheckpoint', 'retrySaving', 'reconcileContinuation', 'cleanCompletedSince',
  'haltGameAudio', 'haltAmbient', 'planGameAudio'];
const loop = effects.find(effect => effect.includes('const loop = (now: number)'));
const persistenceEffect = effects.find(effect => effect.includes('persistenceWasBlockedRef.current'));
assert.ok(loop);
const effectCode = compile(`${names.map(name => declarations.get(name)).join('\n')}
  return { ${names.join(',')}, mountLoop: ${loop}, persistenceEffect: ${persistenceEffect} };`);
function fixture() {
  const admitted = admitRun(structuredClone(DEFAULT_STATE), { mode: 'timed', access: 'standard', durationMinutes: 5, waveLimit: 10 }, 1000);
  let app = admitted.state, saveFails = false, settleFails = false, draws = 0, stops = 0, renders = 0, saves = 0;
  const run = admitted.run, gs = createGame(undefined, undefined, undefined, { combatSeed: run.seed });
  const gsRef = { current: gs }, pending = new Map(); let id = 0;
  const ref = current => ({ current });
  const timing = createReplayTiming({ getState: () => gsRef.current, tick, startWave, canStartNextWave, getNextWaveWait },
    { mode: 'timed', waveLimit: 10, durationSeconds: 300 });
  const environment = {
    exports: {}, isFixture: false, run, gsRef, timing, settleRun, createRunCheckpoint, restoreRunCheckpoint,
    rewardedRef: ref(false), activeSecondsRef: ref(0), planningSecondsRef: ref(0), clockStartedRef: ref(false),
    speedRef: ref(1), placedTowerTypesRef: ref(new Set(['canon', 'simpleLaser'])),
    checkpointAtRef: ref(-1), lastTimeRef: ref(null), persistenceErrorRef: ref(false),
    persistenceWasBlockedRef: ref(false), persistenceBlocked: false,
    ambientStartedRef: ref(true), resultSoundSeenRef: ref(false), hadLeakRef: ref(false), rafRef: ref(0),
    callbacksRef: ref({ state: app,
      onCheckpoint(checkpoint) { saves++; if (saveFails) return false; app = persistBattleCheckpoint(app, checkpoint); environment.callbacksRef.current.state = app; return true; },
      setState(updater) { const next = updater(app); if (settleFails) return false; app = next; environment.callbacksRef.current.state = app; return true; },
      onPersistenceError() {},
    }),
    document: { hidden: false }, loopRunning: true,
    setPersistenceError() {}, setRenderTick() { renders++; },
    stopGameAudio() { stops++; }, stopAmbient() { stops++; }, playSfx() {}, isMuted: () => false,
    drawRef: ref(() => { draws++; }),
    requestAnimationFrame(callback) { pending.set(++id, callback); return id; }, cancelAnimationFrame(key) { pending.delete(key); },
  };
  const make = () => new Function(...Object.keys(environment), effectCode)(...Object.values(environment));
  const api = make();
  return { api, environment, get gs() { return gsRef.current; }, timing, run, pending, get app() { return app; },
    replaceApp(next) { app = next; environment.callbacksRef.current.state = next; },
    rootBlocked(value) { environment.persistenceBlocked = value; make().persistenceEffect(); },
    failSave(value) { saveFails = value; }, failSettlement(value) { settleFails = value; },
    counts: () => ({ draws, stops, renders, saves }),
    mount(running) { environment.loopRunning = running; return make().mountLoop(); },
    frame(now) { const [key, callback] = pending.entries().next().value; pending.delete(key); callback(now); },
  };
}

test('actual Game loop has zero continuous RAF/draw/audio work when paused or terminal', () => {
  for (const status of ['paused', 'gameOver', 'victory']) {
    const f = fixture(); f.gs[status] = true;
    const cleanup = f.mount(false), initial = f.counts();
    for (let event = 0; event < 600; event++) assert.equal(f.pending.size, 0);
    assert.equal(initial.draws, 1);
    assert.deepEqual(f.counts(), initial);
    cleanup?.();
  }
  const f = fixture();
  let cleanup = f.mount(true); assert.equal(f.pending.size, 1);
  f.frame(1000); f.frame(1017);
  f.gs.paused = true; cleanup();
  cleanup = f.mount(false); assert.equal(f.pending.size, 0);
  const pausedTime = f.gs.time;
  f.gs.paused = false; f.environment.lastTimeRef.current = null;
  f.timing.command({ type: 'pause' }); f.timing.command({ type: 'resume' });
  cleanup = f.mount(true); f.frame(1000000);
  assert.equal(f.gs.time, pausedTime, 'one resume reset excludes foreground/background gap');
  f.frame(1000017); assert.ok(f.gs.time > pausedTime);
  cleanup(); assert.equal(f.pending.size, 0);
  assert.match(source, /\[draw, paperStatus, cellPx, motionRevision, _appState\.skinsEnabled, _appState\.equippedSkins\]/,
    'idle redraw remains subscribed to art, cell size, reduced motion and skins');
});

test('Game checkpoint false pauses; retry preserves seeded authoritative engine and full timing', () => {
  const f = fixture(); f.timing.command({ type: 'startWave' }); f.timing.frame(0); f.timing.frame(20.001);
  f.failSave(true);
  assert.equal(f.api.saveCheckpoint(), false);
  assert.equal(f.gs.paused, true);
  assert.equal(f.environment.persistenceErrorRef.current, true);
  const before = JSON.stringify(f.gs), snapshot = f.timing.snapshot();
  f.failSave(false); f.api.retrySaving();
  assert.equal(f.environment.persistenceErrorRef.current, false);
  assert.equal(f.gs.paused, true, 'recovery does not fake-resume');
  assert.equal(JSON.stringify(f.gs), before);
  const checkpoint = f.app.battleCheckpoint;
  assert.deepEqual(checkpoint.battle.combatRandom, f.gs.combatRandom);
  assert.equal(checkpoint.battle.uidCounter, f.gs.uidCounter);
  assert.equal(checkpoint.backlogSeconds, snapshot.backlogSeconds);
  assert.equal(checkpoint.activeSeconds, snapshot.activeSeconds);
  assert.deepEqual(checkpoint.placedTowerTypes, ['canon', 'simpleLaser']);
});

test('Game marks settlement rewarded only after durable success, retry is idempotent under rollback', () => {
  const f = fixture(); f.gs.gameOver = true; f.gs.lives = 0; f.gs.completedWaves = 2;
  f.gs.clearedWaveIndices = [0, 1];
  const tokens = f.app.tokens;
  f.failSettlement(true);
  assert.equal(f.api.settleCurrentRun(), false);
  assert.equal(f.environment.rewardedRef.current, false);
  assert.equal(f.app.tokens, tokens);
  const now = Date.now; Date.now = () => 1;
  try { f.failSettlement(false); f.api.retrySaving(); } finally { Date.now = now; }
  assert.equal(f.environment.rewardedRef.current, true);
  assert.equal(f.app.tokens, tokens + 10);
  f.api.retrySaving(); f.api.settleCurrentRun();
  assert.equal(f.app.tokens, tokens + 10);
});

test('Continue crash-window persists revival and debit atomically before Game can resume', () => {
  const f = fixture(); f.gs.gameOver = true; f.gs.lives = 0;
  assert.equal(f.api.settleCurrentRun(), true);
  const defeated = JSON.stringify(f.gs), tokens = f.app.tokens;
  const continued = continueRun(f.app, f.run, 1001);
  assert.ok(continued.run);
  const durableAfterCrash = JSON.parse(JSON.stringify(continued.state));
  const restored = restoreRunCheckpoint(durableAfterCrash.battleCheckpoint, f.run);
  assert.equal(restored.battle.gameOver, false);
  assert.equal(restored.battle.lives, 10);
  assert.equal(restored.battle.paused, true);
  assert.equal(durableAfterCrash.tokens, tokens - 50);
  const repeated = continueRun(durableAfterCrash, f.run, 1002);
  assert.ok(repeated.run);
  assert.equal(repeated.state.tokens, durableAfterCrash.tokens, 'authorized resume cannot debit twice');
  assert.equal(repeated.state.runLedger[f.run.id].continuedCount, 1);
  assert.equal(JSON.stringify(f.gs), defeated, 'economic transition does not mutate pre-confirmation live battlefield');
});

test('one Game Retry resolves root pending Continue before any stale defeated checkpoint can overwrite it', () => {
  const f = fixture(); f.gs.gameOver = true; f.gs.lives = 0;
  assert.equal(f.api.settleCurrentRun(), true);
  const continued = continueRun(f.app, f.run, 1001), tokens = f.app.tokens;
  assert.ok(continued.run);
  f.api.failPersistence();
  let retries = 0;
  f.environment.callbacksRef.current.onRetryPersistence = () => {
    retries++; f.replaceApp(continued.state); return f.app;
  };
  f.api.retrySaving();
  assert.equal(retries, 1);
  assert.equal(f.gs.gameOver, false);
  assert.equal(f.gs.lives, 10);
  assert.equal(f.gs.paused, true);
  assert.equal(f.app.battleCheckpoint.battle.gameOver, false);
  assert.equal(f.app.tokens, tokens - 50);
  assert.equal(f.environment.persistenceErrorRef.current, false);
  assert.equal(f.environment.rewardedRef.current, false, 'new life can settle a later defeat exactly once');
  f.api.retrySaving();
  assert.equal(f.app.tokens, tokens - 50);
});

test('external dialog Retry clears Game failure overlay without requiring a second canvas Retry', () => {
  const f = fixture();
  f.rootBlocked(true);
  assert.equal(f.environment.persistenceErrorRef.current, true);
  let retries = 0;
  f.environment.callbacksRef.current.onRetryPersistence = () => { retries++; return f.app; };
  f.rootBlocked(false);
  assert.equal(retries, 1);
  assert.equal(f.environment.persistenceErrorRef.current, false);
  assert.equal(f.gs.paused, true, 'dialog retry cannot auto-run a formerly failed battle');
});
