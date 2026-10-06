const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');

const source = readFileSync(`${__dirname}/LeaderboardScreen.tsx`, 'utf8');
const ast = ts.createSourceFile('LeaderboardScreen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const screen = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'LeaderboardScreen');
const effects = screen.body.statements.filter(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === 'useEffect');
assert.equal(effects.length, 2);
assert.equal(screen.body.statements.filter(node => ts.isIfStatement(node)).length, 1,
  'Only the variant return may be conditional at render scope');
assert.equal(effects[1].expression.arguments[1].getText(ast), '[setState, source, playerRank, state.monthlyRank]');

function effect(index, bindings) {
  const callback = effects[index].expression.arguments[0].getText(ast);
  const js = ts.transpile(`const callback = ${callback};`, { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(bindings), `${js}\nreturn callback();`)(...Object.values(bindings));
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

(async () => {
  for (const outcome of ['live', 'empty', 'reject']) {
    const pending = [];
    const writes = [];
    const bindings = {
      isFirebaseEnabled: true,
      fetchTopScores: count => {
        assert.equal(count, 20);
        return new Promise((resolve, reject) => pending.push({ resolve, reject }));
      },
      setSource: value => writes.push(value),
      setLiveEntries: value => writes.push(value),
    };
    const oldCleanup = effect(0, bindings);
    oldCleanup();
    const newCleanup = effect(0, bindings);
    writes.length = 0;
    const data = outcome === 'live' ? [{ bestWave: 5 }] : [];
    for (const request of pending) {
      if (outcome === 'reject') request.reject(new Error('offline'));
      else request.resolve(data);
    }
    await flush();
    assert.deepEqual(writes, outcome === 'live' ? [data, 'live'] : ['local'],
      'StrictMode cleanup must silence the old effect, not the new one');
    newCleanup();

    writes.length = 0;
    const cleanup = effect(0, bindings);
    cleanup();
    writes.length = 0;
    const request = pending.at(-1);
    if (outcome === 'reject') request.reject(new Error('offline'));
    else request.resolve(data);
    await flush();
    assert.deepEqual(writes, [], 'No writes after unmount');
  }
  const localWrites = [];
  effect(0, { isFirebaseEnabled: false, setSource: value => localWrites.push(value) });
  assert.deepEqual(localWrites, ['local']);

  const updates = [];
  const setState = update => updates.push(update);
  const state = { monthlyRank: 8 };
  effect(1, { setState, source: 'loading', playerRank: 4, state });
  effect(1, { setState: undefined, source: 'local', playerRank: 4, state });
  for (const source of ['live', 'local']) {
    for (let i = 0; i < 2; i++) {
      effect(1, { setState: update => setState(update), source, playerRank: 4,
        state: { monthlyRank: 4 } });
    }
  }
  assert.equal(updates.length, 0);
  for (const source of ['live', 'local']) {
    effect(1, { setState, source, playerRank: 4, state });
    const update = updates.at(-1);
    const current = { monthlyRank: 4, tokens: 99, prizePool: 200, paidRuns: 7 };
    assert.equal(update(current), current, 'Equal rank preserves state identity');
    const changed = { ...current, monthlyRank: 8 };
    assert.deepEqual(update(changed), current, 'Only rank changes on functional current state');
    assert.equal(changed.monthlyRank, 8);
  }
  console.log('Leaderboard UI regression PASS: source AST + isolated effect callbacks (no browser).');
})().catch(error => { console.error(error); process.exitCode = 1; });
