const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const root = path.resolve(__dirname, '..');
const componentNames = ['HomeScreen', 'WalletScreen', 'ShopScreen', 'LeaderboardScreen', 'ChallengesScreen', 'ReferralScreen', 'DailyBonusScreen', 'RunSetupScreen', 'ContextDialog', 'ContextualCheckout', 'GameEx'];
function moduleLoader(overrides = {}, react = React, stubScreens = false) {
  const cache = new Map();
  const stubs = Object.fromEntries(componentNames.map(name => [name, function Stub() {}]));
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    let source = fs.readFileSync(file, 'utf8');
    if (file.endsWith('App.tsx')) source += '\nexport { Phone, readSavedState };';
    const code = ts.transpileModule(source, { fileName: file, compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText;
    const localRequire = id => {
      if (id === 'react') return react;
      if (id.endsWith('.css')) return {};
      if (stubScreens && id.endsWith('/utcReset')) return { useUTCClock: () => Date.now(), resetLabel: () => '00:00 UTC' };
      if (stubScreens && /(?:\/screens\/|\/components\/ContextualCheckout|\/game\/Game$)/.test(id)) return stubs;
      if (id.startsWith('.')) {
        const base = path.resolve(path.dirname(file), id);
        const target = ['.ts', '.tsx'].map(ext => base + ext).find(candidate => fs.existsSync(candidate));
        if (overrides[target]) return overrides[target];
        return load(target);
      }
      return require(id);
    };
    new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
    return module.exports;
  }
  return { load, stubs };
}

const actual = moduleLoader();
const store = actual.load(path.join(root, 'state/store.ts'));
const runs = actual.load(path.join(root, 'state/runs.ts'));
function fresh(extra = {}) {
  return { ...structuredClone(store.DEFAULT_STATE), lastRunReset: store.todayStr(), challengesResetDate: store.todayStr(), ...extra };
}
const standard = { mode: 'waves', access: 'standard', waveLimit: 20, durationMinutes: 10 };
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
    const found = find(child, predicate); if (found) return found;
  }
  return null;
}

function fixture(initial = fresh(), options = {}) {
  let disk = structuredClone(initial), failure = !!options.writeFailure, readFailure = options.readFailure;
  let writes = 0, current;
  const listeners = new Map();
  const react = { ...React,
    useState(initializer) {
      const owner = current, index = owner.index++;
      if (!(index in owner.hooks)) owner.hooks[index] = typeof initializer === 'function' ? initializer() : initializer;
      return [owner.hooks[index], value => { owner.hooks[index] = typeof value === 'function' ? value(owner.hooks[index]) : value; }];
    },
    useRef(value) { const index = current.index++; return current.hooks[index] ?? (current.hooks[index] = { current: value }); },
    useCallback(callback) { return callback; },
    useEffect(callback, deps) {
      const index = current.index++, previous = current.hooks[index];
      if (!previous || deps.some((value, i) => value !== previous[i])) current.effects.push(callback);
      current.hooks[index] = deps;
    },
  };
  const loader = moduleLoader({ [path.join(root, 'state/store.ts')]: { ...store,
    loadState() { if (readFailure) throw readFailure; return structuredClone(disk); },
    saveState(next) { writes++; if (failure) { if (options.ambiguousFailure) disk = structuredClone(next); return false; } disk = structuredClone(next); return true; },
    retryStatePersistence(next) { writes++; if (failure) return false; disk = structuredClone(next); return true; },
  } }, react, true);
  const app = loader.load(path.join(root, 'App.tsx'));
  const appHooks = { hooks: [], effects: [], index: 0 }, phoneHooks = { hooks: [], effects: [], index: 0 };
  let tree, phone;
  function render() {
    current = appHooks; current.index = 0; tree = app.default();
    const node = find(tree, node => node.type === app.Phone);
    phone = null;
    if (node) { current = phoneHooks; current.index = 0; phone = app.Phone(node.props); }
    return phone ?? tree;
  }
  function element(name) { return find(phone ?? tree, node => node.type === loader.stubs[name]); }
  function button(text) { return find(phone, node => node.type === 'button' && node.props.children === text) ?? find(tree, node => node.type === 'button' && node.props.children === text); }
  function begin(config = standard) {
    element('HomeScreen').props.nav('game'); render(); element('RunSetupScreen').props.onBegin(config); render();
  }
  render();
  return { render, element, button, begin, tree: () => phone ?? tree, state: () => disk, writes: () => writes,
    setFailure: value => { failure = value; }, setReadFailure: value => { readFailure = value; },
    flushEffects() {
      global.document = { querySelector: () => null, addEventListener() {}, removeEventListener() {} };
      global.window = { addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener() {} };
      for (const owner of [appHooks, phoneHooks]) for (const effect of owner.effects.splice(0)) effect();
    }, listeners,
  };
}

test('zero-quota Standard and Ranked show contextual checkout; cancel spends nothing and preserves setup', async () => {
  for (const access of ['standard', 'ranked']) {
    const f = fixture(fresh({ dailyFreeLeft: 0, paidRuns: 0 }));
    const config = { ...standard, access, mode: 'timed', durationMinutes: 40 };
    f.begin(config);
    const checkout = f.element('ContextualCheckout'); assert.equal(checkout.props.kind, 'runs');
    assert.ok(checkout.props.nextReset.includes('UTC')); assert.equal(f.writes(), 0);
    checkout.props.onClose(); f.render();
    assert.ok(f.element('RunSetupScreen')); assert.equal(f.state().runSequence, 0);
    await Promise.resolve();
  }
});

test('verified recovered credit rechecks fresh state and admits preserved configuration exactly once', async () => {
  const f = fixture(fresh({ dailyFreeLeft: 0, paidRuns: 0 }));
  const config = { ...standard, access: 'ranked', mode: 'timed', durationMinutes: 40 };
  f.begin(config); await Promise.resolve();
  const checkout = f.element('ContextualCheckout');
  checkout.props.onComplete(); assert.equal(f.state().runSequence, 0, 'signal without credited quota cannot start');
  assert.equal(checkout.props.setState(s => ({ ...s, paidRuns: 2 })), true);
  checkout.props.onComplete(); checkout.props.onComplete(); f.render();
  assert.equal(f.state().paidRuns, 1); assert.equal(f.state().runSequence, 1); assert.equal(f.state().totalRuns, 1);
  assert.deepEqual(f.element('GameEx').props.run.config, { ...config, speed: 1 });
  assert.ok(f.state().battleCheckpoint); assert.equal(f.element('GameEx').props.initialCheckpoint, undefined, 'fresh Begin is not Resume');
  assert.equal(f.element('ContextualCheckout'), null);
});

test('quota checkout Practice alternative keeps the format and spends no run', async () => {
  const f = fixture(fresh({ dailyFreeLeft: 0, paidRuns: 0 }));
  const config = { ...standard, mode: 'timed', durationMinutes: 20 };
  f.begin(config); await Promise.resolve(); f.element('ContextualCheckout').props.onPractice(); f.render();
  assert.deepEqual(f.element('GameEx').props.run.config, { ...config, access: 'practice' });
  assert.equal(f.state().dailyFreeLeft, 0); assert.equal(f.state().paidRuns, 0); assert.equal(f.state().totalRuns, 0);
});

test('durable admission failure never advances app stateRef, debits, or navigates', async () => {
  const f = fixture(fresh(), { writeFailure: true });
  f.begin(); assert.equal(f.state().dailyFreeLeft, 3); assert.equal(f.state().runSequence, 0);
  assert.ok(f.element('RunSetupScreen')); assert.equal(f.element('GameEx'), null);
  await Promise.resolve(); f.setFailure(false); f.button('Retry saving').props.onClick(); f.render();
  assert.ok(f.element('RunSetupScreen')); f.button('Resume').props.onClick(); f.render();
  assert.equal(f.state().dailyFreeLeft, 2); assert.equal(f.state().runSequence, 1);
  assert.equal(f.element('GameEx').props.run.id, 'local-1');
});

test('reload resumes the charged run and paused full checkpoint without a second debit', () => {
  const admitted = runs.admitRun(fresh({ dailyFreeLeft: 0, paidRuns: 1 }), standard);
  admitted.state.battleCheckpoint.activeSeconds = 37;
  admitted.state.battleCheckpoint.backlogSeconds = 0.5;
  admitted.state.battleCheckpoint.battle.gold = 321;
  const f = fixture(admitted.state);
  assert.equal(f.writes(), 0); assert.ok(f.button('Resume'));
  f.button('Resume').props.onClick(); f.render();
  const game = f.element('GameEx'); assert.equal(game.props.run.id, admitted.run.id);
  assert.equal(game.props.initialCheckpoint.battle.gold, 321); assert.equal(game.props.initialCheckpoint.activeSeconds, 37);
  assert.equal(game.props.initialCheckpoint.backlogSeconds, 0.5);
  assert.equal(game.props.initialCheckpoint.battle.paused, true); assert.equal(f.state().paidRuns, 0); assert.equal(f.writes(), 0);
});

test('ambiguous write locks new debits and Retry confirms the exact pending admission once', async () => {
  const f = fixture(fresh(), { writeFailure: true, ambiguousFailure: true });
  f.begin(); const pending = structuredClone(f.state());
  assert.equal(pending.dailyFreeLeft, 2); assert.equal(pending.runSequence, 1);
  assert.ok(f.element('RunSetupScreen')); assert.equal(f.element('GameEx'), null);
  await Promise.resolve(); f.element('RunSetupScreen').props.onBegin(standard); f.render();
  assert.equal(f.writes(), 1, 'no second attempted economic write while acknowledgement is pending');
  f.setFailure(false); f.button('Retry saving').props.onClick(); f.render();
  assert.deepEqual(f.state(), pending); assert.ok(f.element('RunSetupScreen'));
  f.button('Resume').props.onClick(); f.render();
  assert.equal(f.element('GameEx').props.run.id, pending.activeRun.id); assert.equal(f.state().dailyFreeLeft, 2);
});

test('STD top-up preserves mounted defeated battle/run ID and never auto-Continues', () => {
  const admitted = runs.admitRun(fresh({ tokens: 0, lives: 0, commerceAccount: 'owner:wallet', walletConnected: true, walletAddr: 'wallet' }), standard);
  admitted.state.battleCheckpoint.battle.gameOver = true; admitted.state.battleCheckpoint.battle.lives = 0;
  const state = runs.settleRun(admitted.state, admitted.run, { completedWaves: 0, victory: false, uniqueTowerTypes: 0, noLeakWave: false });
  const f = fixture(state); f.button('Resume').props.onClick(); f.render();
  const game = f.element('GameEx'), checkpoint = structuredClone(f.state().battleCheckpoint);
  game.props.onTopUp(); f.render();
  assert.equal(f.element('GameEx').key, game.key); assert.equal(f.element('GameEx').props.suspended, true);
  f.element('ContextualCheckout').props.onClose(); f.render();
  assert.deepEqual(f.state().battleCheckpoint, checkpoint); assert.equal(f.state().tokens, 0);
  game.props.onTopUp(); f.render(); const checkout = f.element('ContextualCheckout');
  checkout.props.setState(s => ({ ...s, tokens: 100 })); checkout.props.onComplete(); f.render();
  assert.equal(f.element('GameEx').key, game.key); assert.equal(f.state().tokens, 100);
  assert.equal(f.state().runLedger[admitted.run.id].continuedCount, 0);
  f.setFailure(true); assert.equal(f.element('GameEx').props.onContinue(), false); f.render();
  assert.equal(f.state().tokens, 100); assert.equal(f.state().activeRun, null);
  f.setFailure(false); assert.ok(f.element('GameEx').props.onRetryPersistence()); f.render();
  assert.equal(f.element('GameEx').props.onContinue(), true); f.render();
  assert.equal(f.state().tokens, 50); assert.equal(f.state().runLedger[admitted.run.id].continuedCount, 1);
  assert.equal(f.state().runSequence, 1);
  assert.equal(f.state().battleCheckpoint.battle.gameOver, false, 'revived checkpoint is atomic with Continue debit');
  assert.equal(f.state().battleCheckpoint.battle.lives, 10);
  const reloaded = fixture(f.state()); reloaded.button('Resume').props.onClick(); reloaded.render();
  assert.equal(reloaded.element('GameEx').props.initialCheckpoint.battle.lives, 10);
  assert.equal(reloaded.element('GameEx').props.initialCheckpoint.battle.gameOver, false);
  assert.equal(reloaded.state().tokens, 50); assert.equal(reloaded.state().runSequence, 1);
});

test('unreadable startup has Retry, performs no autosave, and safely reloads original balances', () => {
  const f = fixture(fresh({ tokens: 999, paidRuns: 7 }), { readFailure: new Error('storage blocked') });
  assert.ok(f.button('Retry')); f.flushEffects(); assert.equal(f.writes(), 0);
  f.setReadFailure(null); f.button('Retry').props.onClick(); f.render();
  assert.ok(f.element('HomeScreen')); assert.equal(f.state().tokens, 999); assert.equal(f.state().paidRuns, 7);
});

test('legacy active run without checkpoint does not crash or auto-discard', () => {
  const admitted = runs.admitRun(fresh(), standard); admitted.state.battleCheckpoint = null;
  const f = fixture(admitted.state);
  assert.ok(f.button('Resume').props.disabled); assert.ok(f.button('Discard')); assert.equal(f.writes(), 0);
  f.button('Discard').props.onClick(); f.render(); assert.ok(f.element('ContextDialog'));
  f.element('ContextDialog').props.onClose(); f.render(); assert.equal(f.state().activeRun.id, admitted.run.id);
});

test('native Back is synchronously consumed only by App-owned navigation and confirms Game exit', () => {
  const admitted = runs.admitRun(fresh(), standard), f = fixture(admitted.state);
  f.button('Resume').props.onClick(); f.render(); f.flushEffects();
  const event = new Event('seeker-native-back', { cancelable: true }); f.listeners.get('seeker-native-back')(event);
  assert.equal(event.defaultPrevented, true); f.render(); assert.ok(f.element('ContextDialog')); assert.ok(f.element('GameEx'));
  f.element('ContextDialog').props.onClose(); f.render(); assert.equal(f.state().activeRun.id, admitted.run.id);
});

test('button exit uses the same one Phone confirmation and failed discard stays mounted until one Retry', () => {
  const admitted = runs.admitRun(fresh(), standard), f = fixture(admitted.state);
  f.button('Resume').props.onClick(); f.render(); const game = f.element('GameEx');
  game.props.onExit(); f.render(); assert.ok(f.element('ContextDialog')); assert.equal(f.element('GameEx').key, game.key);
  f.setFailure(true); f.button('Discard and leave').props.onClick(); f.render();
  assert.equal(f.element('GameEx').key, game.key); assert.ok(f.element('ContextDialog'));
  f.setFailure(false); f.button('Retry saving').props.onClick(); f.render();
  assert.ok(f.element('HomeScreen')); assert.equal(f.state().activeRun, null); assert.equal(f.state().battleCheckpoint, null);
});

test('foreign account transition is rejected before persistence and cannot lock a guest battle', () => {
  const admitted = runs.admitRun(fresh(), standard), f = fixture(admitted.state);
  f.button('Resume').props.onClick(); f.render();
  assert.equal(f.element('GameEx').props.setState(s => ({ ...s, commerceAccount: 'other:wallet' })), false); f.render();
  assert.equal(f.writes(), 0); assert.equal(f.state().activeRun.id, admitted.run.id);
  assert.ok(f.element('GameEx').props.onRetryPersistence()); f.render();
  assert.equal(f.element('GameEx').props.onCheckpoint(f.state().battleCheckpoint), true);
});

test('guest/foreign checkout cannot mount impossible wallet connection or purchase; same owner can', () => {
  const marker = label => () => React.createElement('span', null, label);
  const loader = moduleLoader({
    [path.join(root, 'components/CommercePurchases.tsx')]: { CommercePurchases: marker('Purchase store marker') },
    [path.join(root, 'screens/WalletScreen.tsx')]: { WalletScreen: marker('Wallet connect marker') },
  });
  const { ContextualCheckout } = loader.load(path.join(root, 'components/ContextualCheckout.tsx'));
  const admitted = runs.admitRun(fresh(), standard);
  function html(state) { return renderToStaticMarkup(React.createElement(ContextualCheckout, {
    state, kind: 'std', setState() { throw new Error('No SSR write'); }, onClose() {}, onComplete() {}, nextReset: '00:00 UTC',
  })); }
  const guest = html(admitted.state); assert.match(guest, /Wallet top-ups are unavailable for this guest run/);
  assert.doesNotMatch(guest, /Purchase store marker|Wallet connect marker/);
  const owned = structuredClone(admitted.state); owned.activeRun.commerceAccount = 'owner:wallet';
  owned.runLedger[owned.activeRun.id].run.commerceAccount = 'owner:wallet'; owned.commerceAccount = 'other:wallet';
  assert.match(html(owned), /Return to the wallet that started this run/); assert.doesNotMatch(html(owned), /Purchase store marker/);
  owned.commerceAccount = 'owner:wallet'; owned.walletConnected = true;
  assert.match(html(owned), /Purchase store marker/);
});

test('bonus UI uses atomic helper, UTC schedule and cumulative streak; no Day 8 promise', () => {
  const code = fs.readFileSync(path.join(__dirname, 'DailyBonusScreen.tsx'), 'utf8');
  assert.match(code, /setState\(s => claimDailyBonus\(s\)\)/); assert.match(code, /DAILY_BONUS_SCHEDULE\.map/);
  assert.doesNotMatch(code, /DAILY_BONUS_AMOUNT|Day 8|2×|multiplier/);
  const utc = Date.UTC(2026, 9, 7, 23, 59);
  let state = fresh({ tokens: 100, streak: 0, lastBonusClaim: null });
  for (let day = 0; day < 8; day++) {
    const now = utc + day * 86400000, display = store.getDailyBonusDisplay(state, now), before = state.tokens;
    state = store.claimDailyBonus(state, now); assert.equal(state.tokens - before, [50, 60, 70, 90, 120, 150, 240, 50][day]);
    assert.equal(state.streak, day + 1); assert.equal(display.amount, state.tokens - before);
    assert.equal(store.claimDailyBonus(state, now), state);
  }
});

test('local ranked filtering isolates period, mode, continuation, seed, speed, rules and account; demo never ranks', () => {
  const { rankedRulesKey, selectLocalRankedScores } = actual.load(path.join(__dirname, 'LeaderboardScreen.tsx'));
  const now = Date.UTC(2026, 9, 7), score = { runId: 'local-1', wave: 5, ts: now - 1000,
    config: { ...standard, access: 'ranked' }, continuedCount: 0, speed: 1, seed: 42, engineVersion: 'test-v1', accountScope: 'guest' };
  const cases = [score, { ...score, runId: 'local-2', wave: 7, ts: Date.UTC(2026, 8, 1) },
    { ...score, runId: 'local-3', config: standard }, { ...score, runId: 'local-4', continuedCount: 1 },
    { ...score, runId: 'local-5', config: { ...score.config, mode: 'timed', durationMinutes: 40 } },
    { ...score, runId: 'local-6', speed: 2 }, { ...score, runId: 'local-7', engineVersion: 'other' },
    { ...score, runId: 'local-8', seed: 9 }, { ...score, runId: 'local-9', accountScope: 'other:wallet' },
    { wave: 999, ts: now - 1000 }];
  const state = fresh({ localScores: cases }), key = rankedRulesKey(score);
  assert.deepEqual(selectLocalRankedScores(state, 'month', key, now).map(s => s.runId), ['local-1']);
  assert.deepEqual(selectLocalRankedScores(state, 'all-time', key, now).map(s => s.runId), ['local-2', 'local-1']);
  const renderState = fresh({ localScores: [{ ...score, ts: Date.now() - 1000 }] });
  const html = renderToStaticMarkup(React.createElement(actual.load(path.join(__dirname, 'LeaderboardScreen.tsx')).LeaderboardScreen, { state: renderState, nav() {}, variant: 1 }));
  assert.match(html, /Preview · no prizes/); assert.match(html, /Demo podium/); assert.match(html, /Demo players, not local rankings/);
  for (const name of ['0xSer_kit', 'seeker_fan', 'ledgerbear', 'ren.sol', 'nocturne', 'halftone', 'foxwell', 'mink', 'bismuth', 'plume', '0xTurret', 'ghostwave', 'ser_8bit']) assert.ok(html.includes(name));
  assert.equal((html.match(/#1<\/span>/g) || []).length, 1, 'only actual local records get a ranked ordinal');
});
