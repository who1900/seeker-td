const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const load = (path, mockRequire = require) => {
  const source = readFileSync(path, 'utf8');
  const exports = {};
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  new Function('require', 'exports', js)(mockRequire, exports);
  return exports;
};
const helper = load(`${__dirname}/referrals.ts`);
const state = Object.freeze({ referralCode: 'ABC234', referredBy: null, tokens: 920,
  paidRuns: 3, dailyFreeLeft: 2, prizePool: 555, referralsCount: 9,
  runLedger: Object.freeze({ old: {} }), unlockedSkins: Object.freeze(['legacy']),
  activeRun: { id: 'legacy' }, localScores: [], bestWave: 12 });
for (const code of ['', 'ABC23', 'ABC2345', 'ABC23I', 'ABC23O', 'ABC230', 'ABC231', 'ab c23', '!!!!!!', ' abc234 ']) {
  assert.equal(helper.applyLocalReferral(state, code), state);
}
const saved = helper.applyLocalReferral(state, ' def567 ');
assert.deepEqual(saved, { ...state, referredBy: 'DEF567' });
for (const key of Object.keys(state).filter(key => key !== 'referredBy')) assert.equal(saved[key], state[key]);
assert.equal(helper.applyLocalReferral(saved, 'DEF567'), saved);
assert.equal(helper.applyLocalReferral(saved, 'GHJ789'), saved);
const legacy = { ...state, referredBy: 'old invalid record' };
assert.equal(helper.applyLocalReferral(legacy, 'DEF567'), legacy);
const staleUpdater = current => helper.applyLocalReferral(current, 'DEF567');
assert.equal(staleUpdater(staleUpdater(state)).tokens, state.tokens);
assert.equal(staleUpdater({ ...state, referralCode: 'DEF567' }).referredBy, null);

const screenPath = `${__dirname}/../screens/ReferralScreen.tsx`;
const source = readFileSync(screenPath, 'utf8');
assert.doesNotMatch(source, /REFERRAL_BONUS|5%|10%|15%|30 days|exclusive skin|Real invite count tracked/);
assert.match(source, /setState!\(\(s: GameState\) => applyLocalReferral\(s, inputCode\)\)/);
assert.doesNotMatch(source, /outline:\s*['"]none/);
assert.doesNotMatch(readFileSync(`${__dirname}/../screens/HomeScreen.tsx`, 'utf8'), /up to 2,000 STD/);
for (const referredBy of [null, 'legacy-code']) {
  const writes = [];
  let hook = 0;
  const screen = load(screenPath, name => {
    if (name === 'react') return { ...React, useEffect: () => {},
      useState: () => [[ '', '', '', false ][hook++], () => {}],
      useRef: () => ({ current: null }) };
    if (name === '../state/store') return { ensureReferralCode: s => s };
    if (name === '../state/referrals') return helper;
    return require(name);
  });
  const html = renderToStaticMarkup(React.createElement(screen.ReferralScreen, {
    state: { ...state, referredBy }, setState: s => writes.push(s), nav: () => {},
  }));
  assert.match(html, /No referral rewards are credited/);
  assert.match(html, /Stored invite count \(unverified\)/);
  assert.match(html, /Future verified referrals/);
  assert.deepEqual(writes, []);
  for (const [button] of html.matchAll(/<button\b[^>]*>/g)) {
    assert.match(button, /min-width:48px/);
    assert.match(button, /min-height:48px/);
  }
  if (!referredBy) {
    assert.match(html, /for="referral-code"/);
    assert.match(html, /aria-describedby="referral-hint referral-error"/);
    assert.match(html, /role="alert"/);
    assert.match(html, /min-height:48px/);
  } else assert.match(html, /Saved locally \(unverified\): legacy-code/);
}

const ast = ts.createSourceFile('screen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const screen = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'ReferralScreen');
const share = screen.body.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'handleShare');
const apply = screen.body.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'handleApply');
const applyJs = ts.transpile(apply.getText(ast), { target: ts.ScriptTarget.ES2022 });
const queued = [];
const errors = [];
const invokeApply = new Function('state', 'inputCode', 'setState', 'setError', 'inputRef', 'referralError', 'applyLocalReferral',
  applyJs + '; return handleApply;')(state, 'DEF567', update => queued.push(update), value => errors.push(value),
  { current: { focus() {} } }, helper.referralError, helper.applyLocalReferral);
invokeApply({ preventDefault() {} });
invokeApply({ preventDefault() {} });
assert.equal(queued.length, 2);
const once = queued[0](state);
assert.equal(queued[1](once), once);
const beforeErrors = errors.length;
queued[0](state);
queued[0](state);
assert.equal(errors.length, beforeErrors, 'Updater replay has no UI side effects');
assert.equal(queued[0]({ ...state, referralCode: 'DEF567' }).referredBy, null);
const noSetter = new Function('state', 'inputCode', 'setState', 'setError', 'inputRef', 'referralError', 'applyLocalReferral',
  applyJs + '; return handleApply;')(state, 'DEF567', undefined, value => errors.push(value),
  { current: { focus() {} } }, helper.referralError, helper.applyLocalReferral);
noSetter({ preventDefault() {} });
assert.equal(errors.at(-1), 'Saving is unavailable in this preview.');
const shareJs = ts.transpile(share.getText(ast), { target: ts.ScriptTarget.ES2022 });
async function exercise(copy, navigator, expected) {
  const statuses = [];
  const busy = [];
  const sharingRef = { current: false };
  const invoke = new Function('navigator', 'code', 'sharingRef', 'setBusy', 'setShareStatus', 'shareText',
    shareJs + '; return handleShare;')(navigator, 'ABC234', sharingRef,
    value => busy.push(value), value => statuses.push(value), 'demo');
  await invoke(copy);
  assert.equal(statuses.at(-1), expected);
  assert.deepEqual(busy, [true, false]);
  assert.equal(sharingRef.current, false);
}
(async () => {
  await exercise(true, { clipboard: { writeText: async () => {} } }, 'Code copied.');
  await exercise(true, {}, 'Copy unavailable. Select and copy the code manually.');
  await exercise(true, { clipboard: { writeText: async () => { throw new Error(); } } }, 'Copy failed. Try again or copy manually.');
  await exercise(false, {}, 'Sharing unavailable. Use Copy to send the demo code.');
  await exercise(false, { share: async () => {} }, 'Share action completed; no invite is verified.');
  await exercise(false, { share: async () => { const e = new Error(); e.name = 'AbortError'; throw e; } }, 'Sharing cancelled.');
  await exercise(false, { share: async () => { throw new Error(); } }, 'Sharing failed. Try again or use Copy.');
  console.log('Referral LOCAL regression PASS: pure atomic dedup/self/format, unchanged economy/legacy records, SSR form/48px, async Copy/Share outcomes.');
})().catch(error => { console.error(error); process.exitCode = 1; });
