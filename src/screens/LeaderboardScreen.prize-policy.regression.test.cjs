const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const source = readFileSync(`${__dirname}/LeaderboardScreen.tsx`, 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 } }).outputText;
assert.doesNotMatch(source, /30%|20%|Apr\s*30|state\.prizePool|\bPRIZES\b/);
const state = Object.freeze({ localScores: [], bestWave: 999, walletAddr: 'local-wallet', monthlyRank: 9, prizePool: 987654, tokens: 123456 });
const exportsFixture = {};
new Function('require', 'exports', compiled)(id => {
  if (id === './utcReset') return { useUTCClock: () => Date.UTC(2026, 9, 7) };
  if (id.startsWith('.')) throw new Error('No backend access allowed');
  return require(id);
}, exportsFixture);
for (const variant of [0, 1]) {
  const writes = [];
  const html = renderToStaticMarkup(React.createElement(exportsFixture.LeaderboardScreen, { state, variant, nav() {}, setState: value => writes.push(value) }));
  assert.match(html, /Preview · no prizes/);
  assert.match(html, /monthly top 5 SKR rewards funded by 10% of run purchases only/);
  assert.match(html, /Not live; eligibility and payouts are unapproved/);
  assert.match(html, /<details/);
  assert.match(html, /No matching Ranked results this month/);
  assert.doesNotMatch(html, /987[,.]?654|123[,.]?456|Your rank|#1|live scores/);
  assert.deepEqual(writes, []);
  assert.equal((html.match(/<button\b/g) || []).length, 3);
  assert.match(html, /aria-label="Back to home"/);
  if (variant === 1) {
    assert.match(html, /Demo podium/);
    assert.equal((html.match(/class="demo-pedestal"/g) || []).length, 3);
  }
}
const css = readFileSync(`${__dirname}/../styles.css`, 'utf8');
assert.match(css, /min-height:\s*48px/);
assert.match(css, /min-width:\s*48px/);
assert.match(css, /:focus-visible/);
console.log('Leaderboard prize policy PASS: both variants, planned run-only SKR funding, separate demo podium, no live/prize/rank claims.');
