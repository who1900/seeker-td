const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function harness(request) {
  let now = 0;
  let nextId = 0;
  let reads = 0;
  let cleared = 0;
  const timers = new Map();
  const warnings = [];
  const sandbox = {
    console: { warn: (...args) => warnings.push(args) },
    setTimeout: (callback, delay) => {
      const id = ++nextId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: id => { cleared++; timers.delete(id); },
  };
  const firestore = {
    collection: () => 'players',
    query: (...args) => args,
    orderBy: () => 'bestWave',
    limit: value => value,
    getDocs: () => { reads++; return request; },
    getDoc: () => { throw new Error('write path touched'); },
    setDoc: () => { throw new Error('write path touched'); },
  };
  function load(name) {
    const filename = path.join(__dirname, `${name}.ts`);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(code, {
      ...sandbox,
      exports: module.exports,
      module,
      require: id => {
        if (id === 'firebase/firestore') return firestore;
        if (id === '../firebase') return { isFirebaseEnabled: true, getDb: () => ({}) };
        if (id === './networkDeadline') return load('networkDeadline');
        throw new Error(`Unexpected import: ${id}`);
      },
    }, { filename });
    return module.exports;
  }
  return {
    fetch: load('leaderboard').fetchTopScores,
    timers,
    warnings,
    get reads() { return reads; },
    get cleared() { return cleared; },
    advance(ms) {
      now += ms;
      for (const [id, timer] of timers) {
        if (timer.at <= now) { timers.delete(id); timer.callback(); }
      }
    },
  };
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test('never-resolving cloud read falls back at 5s, not before', async () => {
  const h = harness(new Promise(() => {}));
  let settled = false;
  const result = h.fetch().then(value => { settled = true; return value; });
  h.advance(4999);
  await flush();
  assert.equal(settled, false);
  h.advance(1);
  assert.equal((await result).length, 0);
  assert.equal(h.reads, 1);
  assert.equal(h.warnings.length, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.cleared, 1);
});

test('late rejection after fallback is handled without retry', async () => {
  let reject;
  const h = harness(new Promise((_, fail) => { reject = fail; }));
  const unhandled = [];
  const listener = error => unhandled.push(error);
  process.on('unhandledRejection', listener);
  try {
    const result = h.fetch();
    h.advance(5000);
    assert.equal((await result).length, 0);
    reject(new Error('late offline failure'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.equal(h.reads, 1);
    assert.equal(h.warnings.length, 1);
    assert.equal(h.timers.size, 0);
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('successful read preserves entry mapping and clears deadline', async () => {
  const h = harness(Promise.resolve({ docs: [{
    id: 'player',
    data: () => ({ walletAddr: 'wallet', skrName: 'name', bestWave: 12,
      updatedAt: { toMillis: () => 123 } }),
  }] }));
  const entries = await h.fetch(3);
  assert.deepEqual(JSON.parse(JSON.stringify(entries)), [{
    uid: 'player', walletAddr: 'wallet', skrName: 'name', bestWave: 12, updatedAt: 123,
  }]);
  assert.equal(h.timers.size, 0);
  assert.equal(h.cleared, 1);
  h.advance(5000);
  await flush();
  assert.equal(h.warnings.length, 0);
});

test('immediate rejection falls back and clears deadline', async () => {
  const h = harness(Promise.reject(new Error('offline')));
  assert.equal((await h.fetch()).length, 0);
  assert.equal(h.warnings.length, 1);
  assert.equal(h.cleared, 1);
  assert.equal(h.timers.size, 0);
  h.advance(5000);
  await flush();
  assert.equal(h.warnings.length, 1);
});

test('late success cannot replace fallback or leave a timer', async () => {
  let resolve;
  const h = harness(new Promise(done => { resolve = done; }));
  const result = h.fetch();
  h.advance(5000);
  const fallback = await result;
  resolve({ docs: [{ id: 'late', data: () => ({ bestWave: 99 }) }] });
  await flush();
  assert.equal(fallback.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.cleared, 1);
  assert.equal(h.reads, 1);
});
