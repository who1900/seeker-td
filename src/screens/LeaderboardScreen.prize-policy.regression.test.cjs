const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const source = readFileSync(`${__dirname}/LeaderboardScreen.tsx`, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
assert.doesNotMatch(source, /30%|20%|Apr\s*30|splits between top 3|state\.prizePool|\bPRIZES\b/);
assert.doesNotMatch(source, /\b(?:balance|tokens|prizePool)\s*:/);

const liveEntries = Array.from({ length: 6 }, (_, i) => ({
  walletAddr: `wallet-${i}`, bestWave: 50 - i, skrName: `Player ${i + 1}`,
}));
const state = Object.freeze({ bestWave: 2, walletAddr: 'local-wallet', monthlyRank: 9,
  prizePool: 987654, tokens: 123456 });

for (const dataSource of ['local', 'live', 'loading']) {
  for (const variant of [0, 1]) {
    let hook = 0;
    const exports = {};
    const writes = [];
    const mockRequire = name => {
      if (name === 'react') return { ...React,
        useState: () => [[ 'month', dataSource, liveEntries ][hook++], () => {}],
        useEffect: () => {},
      };
      if (name === '../firebase') return { isFirebaseEnabled: false };
      if (name === '../services/leaderboard') return {
        fetchTopScores: () => { throw new Error('No backend access allowed'); },
      };
      if (name === '../services/skr') return { displayName: (name, addr) => name || addr };
      return require(name);
    };
    new Function('require', 'exports', compiled)(mockRequire, exports);
    const html = renderToStaticMarkup(React.createElement(exports.LeaderboardScreen, {
      state, variant, nav: () => {}, setState: value => writes.push(value),
    }));
    assert.match(html, /Future prizes: top 5, funded by 10% of purchased runs only/);
    assert.match(html, /Eligibility rules and prize shares are not approved/);
    assert.match(html, /No real payouts yet/);
    assert.match(html, /same best-wave preview, not monthly standings/);
    assert.doesNotMatch(html.replace(/<[^>]*>/g, ''), /987[,.]?654|123[,.]?456|50%|30%|20%|Apr\s*30|STD/);
    assert.deepEqual(writes, []);
    if (dataSource === 'live') {
      assert.match(html, /Live scores do not verify prize eligibility; local scores may appear as YOU/);
    } else {
      assert.match(html, /local demo/i);
      assert.match(html, /no payout/);
    }
    if (variant === 1) {
      assert.match(html, /Future prize ranks: 1–5/);
      assert.equal((html.match(/Future prize rank ·/g) || []).length, 2,
        'Ranks 4 and 5 must remain visibly planned prize positions');
      assert.equal((html.match(/height:(140|110|90)px/g) || []).length, 3,
        'Keep the three decorative podium steps');
      assert.match(html, dataSource === 'live' ? /eligibility unverified/ : /demo — no payout/);
    }
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)];
    assert.equal(buttons.length, 3);
    for (const [button] of buttons) {
      assert.match(button, /min-width:48px/);
      assert.match(button, /min-height:48px/);
    }
    assert.match(html, /aria-label="Back to home"/);
  }
}
console.log('Leaderboard prize policy PASS: both variants, local/live/loading, future top 5, no payout claims, 48px controls.');
