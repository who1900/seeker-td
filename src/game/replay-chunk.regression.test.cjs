const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const compile = source => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
} }).outputText;
require.extensions['.ts'] = (module, filename) => module._compile(compile(fs.readFileSync(filename, 'utf8')), filename);
const { createReplayProcessor, canonicalReplayBytes } = require('./replayChunk.ts');
const { createGame } = require('./engine.ts');
const digest = bytes => createHash('sha256').update(bytes).digest();
const settings = budgets => ({ config: { mode: 'endless', waveLimit: 1, durationSeconds: 300 }, seed: 42,
  fingerprint: 'test-engine-source-version:1', digest, ...(budgets ? { budgets } : {}) });
const frame = delta => ({ type: 'frame', delta });
const timing = type => ({ type: 'timing', command: { type } });
const place = (x = 5, y = 3) => ({ type: 'action', action: { type: 'place', towerId: 'canon', cell: { x, y } } });
const envelope = (processor, events) => ({ version: 1, index: processor.status().nextIndex,
  previousHash: processor.status().previousHash, events });
function finish(processor, chunk) {
  let result = processor.submit(chunk), resumes = 0;
  while (result.status === 'pending') {
    assert.ok(++resumes < 1000, 'bounded fixture resume count'); result = processor.resume();
  }
  return result;
}

test('canonical codec preserves binary64/undefined/key and array order; rejects unsafe structures and bounds', () => {
  const bytes = value => Buffer.from(canonicalReplayBytes(value));
  assert.deepEqual(bytes({ b: 1, a: undefined }), bytes({ a: undefined, b: 1 }));
  assert.notDeepEqual(bytes({ a: undefined }), bytes({}));
  assert.notDeepEqual(bytes([1, 2]), bytes([2, 1]));
  assert.notDeepEqual(bytes(-0), bytes(0));
  assert.notDeepEqual(bytes(.016), bytes(.016000000000000004));
  for (const value of [Number.MIN_VALUE, Number.MAX_VALUE, Math.PI, .016, -0]) {
    const encoded = bytes(value); assert.equal(encoded[0], 4);
    assert.ok(Object.is(encoded.readDoubleBE(1), value));
  }
  const cyclic = {}; cyclic.self = cyclic;
  const extra = [1]; extra.named = 1;
  const accessor = { get value() { assert.fail('codec getter executed'); } };
  for (const value of [NaN, Infinity, -Infinity, cyclic, extra, new Array(2), Object.create(null), new Date(),
    accessor, { [Symbol('extra')]: 1 }, () => 1, 1n, '\ud800']) assert.throws(() => bytes(value), /REPLAY_CHUNK_INVALID/);
  assert.throws(() => canonicalReplayBytes('oversize', { maxBytes: 3, maxNodes: 10 }), /REPLAY_RESOURCE_LIMITED/);
  assert.throws(() => canonicalReplayBytes({ a: 1 }, { maxBytes: 100, maxNodes: 1 }), /REPLAY_RESOURCE_LIMITED/);
  let deep = {}; for (let i = 0; i < 66; i++) deep = { deep };
  assert.throws(() => bytes(deep), /REPLAY_RESOURCE_LIMITED/);
});

test('whole vs split actual-engine chunks, pending cursor and input ownership preserve gameplay hash/UID', () => {
  const all = [place(), timing('startWave'), frame(999), timing('speedCycle'), timing('speedCycle'),
    ...Array.from({ length: 100 }, (_, i) => frame([.001, .016, .05, .2][i % 4]))];
  const whole = createReplayProcessor(settings({ workTicks: 1024, workEvents: 256 }));
  const split = createReplayProcessor(settings({ workTicks: 4, workEvents: 2 }));
  const yielded = createReplayProcessor(settings({ workTicks: 4, workEvents: 2 }));
  assert.equal(finish(whole, envelope(whole, all)).status, 'historyValid');
  for (let i = 0; i < all.length; i += 17) assert.equal(finish(split, envelope(split, all.slice(i, i + 17))).status, 'historyValid');
  const chunk = envelope(yielded, all), checkpoint = yielded.status();
  let result = yielded.submit(chunk);
  assert.equal(result.status, 'pending'); assert.deepEqual(yielded.status(), checkpoint);
  const cursor = result.cursor; chunk.events.length = 0;
  assert.throws(() => yielded.submit(envelope(yielded, [])), /REPLAY_CHUNK_INVALID/);
  result = yielded.resume(); assert.ok(result.cursor > cursor);
  while (result.status === 'pending') result = yielded.resume();
  assert.equal(result.status, 'historyValid');
  assert.equal(whole.status().gameplayHash, split.status().gameplayHash);
  assert.equal(whole.status().gameplayHash, yielded.status().gameplayHash);
  assert.equal(whole.status().previousHash, yielded.status().previousHash, 'same chunk not replayed across yields');
  assert.equal(whole.status().uidCounter, split.status().uidCounter);
  assert.ok(whole.status().uidCounter > 2);
  assert.throws(() => yielded.resume(), /REPLAY_CHUNK_INVALID/);
});

test('late invalid event aborts draft; schema/order/hash/client snapshot failures cannot commit', () => {
  const p = createReplayProcessor(settings({ workTicks: 4, workEvents: 2 }));
  const before = p.status();
  const invalid = envelope(p, [place(), timing('startWave'), frame(0), frame(.05),
    { type: 'action', action: { type: 'sell', uid: 'not-real' } }]);
  assert.throws(() => finish(p, invalid), /REPLAY_COMMAND_INVALID/); assert.deepEqual(p.status(), before);
  assert.equal(finish(p, envelope(p, [place()])).status, 'historyValid');
  assert.equal(p.status().uidCounter, 2, 'failed draft UID allocations rolled back');
  for (const mutate of [c => c.version = 2, c => c.index--, c => c.index++, c => c.previousHash = '0'.repeat(64),
    c => c.snapshot = {}, c => c.state = {}, c => c.events = [{ type: 'exit' }],
    c => c.events = [{ type: 'frame', delta: NaN }], c => c.events = [{ type: 'frame', delta: -1 }],
    c => c.events = [{ type: 'frame', delta: .05, steps: 4 }],
    c => c.events = [{ type: 'action', action: { type: 'sell', uid: '1', gold: 999 } }],
    c => Object.defineProperty(c, 'events', { enumerable: true, get() { assert.fail('events getter'); } })]) {
    const before = p.status(), chunk = envelope(p, []); mutate(chunk);
    assert.throws(() => finish(p, chunk), /REPLAY_(CHUNK|COMMAND)_INVALID/); assert.deepEqual(p.status(), before);
  }
});

test('resource-limited state/chunk never accepts, digest must be synchronous32bytes, configuration is owned', () => {
  const p = createReplayProcessor(settings({ maxEvents: 2 })), before = p.status();
  assert.equal(p.submit(envelope(p, [frame(0), frame(.01), frame(.01)])).status, 'resourceLimited');
  assert.deepEqual(p.status(), before);
  const ticks = createReplayProcessor(settings({ maxChunkTicks: 4 }));
  assert.equal(ticks.submit(envelope(ticks, [frame(0), frame(.01)])).status, 'resourceLimited');
  assert.throws(() => createReplayProcessor(settings({ maxStateBytes: 1 })), /REPLAY_RESOURCE_LIMITED/);
  const initialSizes = [canonicalReplayBytes(createGame(undefined, undefined, undefined, { combatSeed: 42 })).length];
  createReplayProcessor({ ...settings(), digest: bytes => { initialSizes.push(bytes.length); return digest(bytes); } });
  const maxStateBytes = Math.max(...initialSizes);
  const small = createReplayProcessor(settings({ maxStateBytes }));
  const saved = small.status();
  assert.equal(finish(small, envelope(small, [timing('startWave')])).status, 'resourceLimited');
  assert.deepEqual(small.status(), saved);
  assert.equal(finish(small, envelope(small, [])).status, 'historyValid', 'processor remains usable after resource rollback');
  for (const invalidDigest of [() => new Uint8Array(31), () => Promise.resolve(new Uint8Array(32)), () => 'a'.repeat(64)]) {
    assert.throws(() => createReplayProcessor({ ...settings(), digest: invalidDigest }), /REPLAY_CHUNK_INVALID/);
  }
  let fail = false;
  const fallible = createReplayProcessor({ ...settings(), digest: bytes => { if (fail) throw new Error('digest failure'); return digest(bytes); } });
  const old = fallible.status(); fail = true;
  assert.throws(() => finish(fallible, envelope(fallible, [place()])), /digest failure/);
  assert.deepEqual(fallible.status(), old);
  const opts = settings(), owned = createReplayProcessor(opts), same = createReplayProcessor(settings());
  opts.config.mode = 'waves'; opts.config.waveLimit = 999;
  finish(owned, envelope(owned, [timing('startWave'), frame(0), frame(.01)]));
  finish(same, envelope(same, [timing('startWave'), frame(0), frame(.01)]));
  assert.deepEqual(owned.status(), same.status());
});

test('different real death-particle RNG produces same hash and FX UID allocations; endless exceeds waveLimit', () => {
  const random = Math.random;
  const history = [place(6, 3), timing('startWave'), frame(0), ...Array.from({ length: 230 }, () => frame(.05))];
  const low = createReplayProcessor(settings()), high = createReplayProcessor(settings());
  let randomCalls = 0;
  try {
    Math.random = () => { randomCalls++; return .1; }; finish(low, envelope(low, history));
    const lowCalls = randomCalls;
    Math.random = () => { randomCalls++; return .9; }; finish(high, envelope(high, history));
    assert.ok(lowCalls > 0 && randomCalls > lowCalls, 'actual enemy deaths produced cosmetic randomness');
    assert.deepEqual(low.status(), high.status()); assert.ok(low.status().uidCounter > 10, 'actual FX/spawns retain UID allocations');
    const p = createReplayProcessor(settings());
    for (let wave = 0; wave < 3; wave++) {
      const events = [timing('startWave'), frame(0), timing('speedCycle'), timing('speedCycle'),
        ...Array.from({ length: 110 }, () => frame(.05))];
      if (wave > 0) events.splice(2, 2);
      assert.equal(finish(p, envelope(p, events)).status, 'historyValid');
    }
    assert.equal(p.status().waveIndex, 2, 'no artificial endless cap at configured waveLimit1');
  } finally { Math.random = random; }
});
