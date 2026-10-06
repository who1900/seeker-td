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
    ...Array.from({ length: 24 }, (_, i) => frame([.001, .016, .05, .2][i % 4]))];
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
  assert.equal(finish(ticks, envelope(ticks, [frame(0), frame(1)])).status, 'resourceLimited');
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
    Math.random = () => { randomCalls++; return .1; };
    assert.equal(finish(low, envelope(low, history)).status, 'historyValid');
    const lowCalls = randomCalls;
    Math.random = () => { randomCalls++; return .9; };
    assert.equal(finish(high, envelope(high, history)).status, 'historyValid');
    assert.ok(lowCalls > 0 && randomCalls > lowCalls, 'actual enemy deaths produced cosmetic randomness');
    assert.deepEqual(low.status(), high.status()); assert.ok(low.status().uidCounter > 10, 'actual FX/spawns retain UID allocations');
    const p = createReplayProcessor(settings());
    for (let wave = 0; wave < 3; wave++) {
      const events = [timing('startWave'), frame(0), timing('speedCycle'), timing('speedCycle'),
        ...Array.from({ length: 110 }, () => frame(.05))];
      if (wave > 0) events.splice(2, 2);
      for (let i = 0; i < events.length; i += 20) {
        assert.equal(finish(p, envelope(p, events.slice(i, i + 20))).status, 'historyValid');
      }
    }
    assert.equal(p.status().waveIndex, 2, 'no artificial endless cap at configured waveLimit1');
  } finally { Math.random = random; }
});

test('default128/small work budgets bound real tick calls and retain event cursor/backlog until one full frame completes', () => {
  const engine = require('./engine.ts'), original = engine.tick;
  let calls = 0;
  engine.tick = (...args) => { calls++; return original(...args); };
  try {
    const history = [frame(0), frame(1e9), place(), frame(0)];
    const whole = createReplayProcessor(settings({ workTicks: 1024 }));
    assert.equal(finish(whole, envelope(whole, history)).status, 'historyValid');
    for (const workTicks of [4, 7, 128]) {
      const p = createReplayProcessor(settings({ workTicks, workEvents: 2 })), before = p.status();
      const chunk = envelope(p, structuredClone(history));
      let measured = calls, result = p.submit(chunk), resumes = 0;
      assert.ok(calls - measured <= workTicks);
      assert.equal(result.status, 'pending'); assert.equal(result.cursor, 1, 'partial frame not advanced to place');
      assert.equal(result.ticks, workTicks); assert.deepEqual(p.status(), before);
      chunk.events[1].delta = 0; chunk.events.length = 0;
      while (result.status === 'pending') {
        assert.ok(++resumes < 300, 'no infinite pending at workTicks<MAX_FRAME_TICKS');
        const previous = result; measured = calls; result = p.resume();
        assert.ok(calls - measured <= workTicks, 'budget enforced BEFORE next real tick');
        if (result.status === 'pending') {
          assert.ok(result.cursor > previous.cursor || result.ticks > previous.ticks, 'every yield makes progress');
        }
      }
      assert.equal(result.status, 'historyValid'); assert.equal(result.ticks, 960);
      assert.deepEqual(p.status(), whole.status(), 'same frame/action ordering, RNG, UID, backlog and chunk hash');
    }
  } finally { engine.tick = original; }
});

test('actual chunk tick ceiling aborts BEFORE overrun and rolls back; exact ceiling permits zero-cost events', () => {
  const engine = require('./engine.ts'), original = engine.tick;
  let calls = 0;
  engine.tick = (...args) => { calls++; return original(...args); };
  try {
    for (const maxChunkTicks of [1, 4, 128, 479, 481, 959, 1024]) {
      const p = createReplayProcessor(settings({ workTicks: 7, maxChunkTicks })), before = p.status(), measured = calls;
      const events = [frame(0), frame(1e9), frame(0), frame(0)];
      const result = finish(p, envelope(p, events));
      assert.equal(result.status, 'resourceLimited'); assert.equal(calls - measured, maxChunkTicks);
      assert.deepEqual(p.status(), before); assert.throws(() => p.resume(), /REPLAY_CHUNK_INVALID/);
      assert.equal(finish(p, envelope(p, [place()])).status, 'historyValid', 'rejected draft leaves processor reusable');
    }
    const exact = createReplayProcessor(settings({ workTicks: 4, maxChunkTicks: 4 }));
    const measured = calls;
    assert.equal(finish(exact, envelope(exact, [frame(0), frame(4 / 60), frame(0), place()])).status, 'historyValid');
    assert.equal(calls - measured, 4);
    const free = createReplayProcessor(settings({ maxChunkTicks: 1 }));
    assert.equal(finish(free, envelope(free, Array.from({ length: 256 }, () => frame(0)))).status, 'historyValid');
  } finally { engine.tick = original; }
});

test('a 300-tick frame finishes at exhausted backlog, not at the 480 cap; continuation never reinjects delta', () => {
  const p = createReplayProcessor(settings()), whole = createReplayProcessor(settings({ workTicks: 1024 }));
  for (const processor of [p, whole]) assert.equal(finish(processor, envelope(processor, [frame(0)])).status, 'historyValid');
  const history = [frame(5)];
  let result = p.submit(envelope(p, history));
  assert.equal(result.status, 'pending'); assert.equal(result.ticks, 128); assert.equal(result.cursor, 0);
  result = p.resume();
  assert.equal(result.status, 'pending'); assert.equal(result.ticks, 256); assert.equal(result.cursor, 0);
  result = p.resume();
  assert.equal(result.status, 'historyValid'); assert.equal(result.ticks, 300, 'no unnecessary wait for full 480-frame cap');
  assert.equal(finish(whole, envelope(whole, history)).status, 'historyValid');
  assert.deepEqual(p.status(), whole.status()); assert.throws(() => p.resume(), /REPLAY_CHUNK_INVALID/);
  assert.equal(finish(p, envelope(p, [frame(0)])).ticks, 0, 'delta=5 was injected exactly once');
});

test('server-owned ranked speedLimit1 is copied, hashed and enforced; uploaded tick-budget fields denied', () => {
  const opts = { ...settings({ workTicks: 4 }), config: { ...settings().config, speedLimit: 1 } };
  const p = createReplayProcessor(opts), same = createReplayProcessor({ ...opts, config: { ...opts.config } });
  opts.config.speedLimit = 4;
  const before = p.status();
  assert.throws(() => finish(p, envelope(p, [timing('speedCycle')])), /REPLAY_TIMING_INVALID/);
  assert.deepEqual(p.status(), before);
  const events = [timing('startWave'), frame(0), frame(.2)];
  assert.equal(finish(p, envelope(p, events)).status, 'historyValid');
  assert.equal(finish(same, envelope(same, events)).status, 'historyValid');
  assert.deepEqual(p.status(), same.status());
  for (const key of ['trustedMaxTicks', 'maxTicks', 'workTicks', 'budgetExhausted', 'ticks']) {
    assert.throws(() => finish(p, envelope(p, [{ ...frame(1), [key]: 0 }])), /REPLAY_CHUNK_INVALID/);
  }
  for (const speedLimit of [0, 3, 5, '1', NaN]) {
    assert.throws(() => createReplayProcessor({ ...settings(), config: { ...settings().config, speedLimit } }));
  }
});
