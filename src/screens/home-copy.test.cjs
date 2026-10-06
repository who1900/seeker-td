const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const file = path.join(__dirname, 'HomeScreen.tsx');
const moduleFixture = { exports: {} };
const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
vm.runInNewContext(code, {
  module: moduleFixture, exports: moduleFixture.exports,
  require: id => {
    if (id === '../components/Shapes') return { TokenBadge: () => null, SolBadge: () => null, LifeHeart: () => null, SketchRule: () => null };
    if (id === '../game/paperAssets') return { usePaperAssets: () => 'ready', PaperImage: () => null };
    if (id === '../state/store') return { SKINS: [], applyDailyReset: s => s, getDailyBonusDisplay: () => ({ amount: 50, canClaim: true }) };
    if (id === './utcReset') return { useUTCClock: () => Date.now(), resetLabel: () => 'in 1h · 00:00 UTC' };
    if (id.startsWith('.')) throw new Error(`Unexpected Home dependency: ${id}`);
    return require(id);
  },
}, { filename: file });
const { HomeScreen } = moduleFixture.exports;
const address = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijk';
const state = { walletConnected: true, walletAddr: address, tokens: 420, sol: 2.48294532, dailyFreeLeft: 1,
  dailyFreeMax: 3, paidRuns: 2, bestWave: 7, streak: 1, challengesDone: [false, false, false], challengeClaimed: {}, unlockedSkins: [], prizePool: 0, monthlyRank: 1 };
function render(variant, connected = true) {
  return renderToStaticMarkup(React.createElement(HomeScreen, {
    state: { ...state, walletConnected: connected }, variant, setState() { throw new Error('Unexpected state write'); }, nav() {},
  }));
}

test('all Home variants truncate wallet addresses while preserving full accessible titles', () => {
  for (const variant of [0, 1, 2]) {
    const html = render(variant);
    assert.ok(html.includes(`>${address.slice(0, 4)}...${address.slice(-4)}<`));
    assert.ok(html.includes(`title="${address}"`));
    assert.ok(html.includes(`aria-label="Wallet address: ${address}"`));
    assert.ok(!html.includes(`>${address}<`));
  }
});
test('Home hero uses concise game copy and Play CTA with unchanged destination', () => {
  const html = render(1);
  assert.ok(html.includes('Build your maze. Defend the paper world.'));
  assert.ok(html.includes('Practice unlimited'));
  assert.match(html, />Play<\/button>/);
  assert.doesNotMatch(html, /Ranked is local, not prize-verified|Choose mode · Practice is free/);
  assert.doesNotMatch(html, /Buy Runs|Prize pool|Ends April/);
  const source = fs.readFileSync(file, 'utf8');
  assert.match(source, /onClick=\{\(\)\s*=>\s*nav\('game'\)\}>\s+Play/);
});
test('Home disconnected variants keep connect and not-connected labels without exposing cached address', () => {
  for (const variant of [0, 1, 2]) {
    const html = render(variant, false);
    assert.ok(html.includes(variant === 2 ? 'Not connected' : '>Connect</button>'));
    assert.ok(!html.includes(address));
  }
});
