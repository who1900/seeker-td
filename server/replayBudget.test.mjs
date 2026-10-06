import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReplayRuntime } from './replayRuntime.mjs';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const config = { mode: 'endless', waveLimit: 1, durationSeconds: 300 };
const frame = delta => ({ type: 'frame', delta });
const envelope = (p, events) => ({ version: 1, index: p.status().nextIndex, previousHash: p.status().previousHash, events });
const start = (bounds = {}, cfg = config) => createReplayRuntime({ projectRoot, version: 1, budgets: { processorBounds: bounds } })
  .start({ seed: 42, config: cfg });
function finish(p, events, workTicks = 128) {
  let result = p.submit(envelope(p, events)), previousTicks = 0, resumes = 0;
  for (;;) {
    if (result.status !== 'resourceLimited') {
      assert.ok(result.ticks - previousTicks <= workTicks, 'per-call actual work bound');
      previousTicks = result.ticks;
    }
    if (result.status !== 'pending') return result;
    assert.ok(++resumes < 1000, 'bounded frame continuation progress'); result = p.resume();
  }
}

test('captured processor supports default128/small budgets without endless pending or altered per-event hashes', () => {
  const events = [frame(0), frame(1e9), { type: 'action', action: { type: 'place', towerId: 'canon', cell: { x: 5, y: 3 } } }, frame(0)];
  const whole = start({ workTicks: 1024 });
  assert.equal(finish(whole, events, 1024).ticks, 960);
  for (const workTicks of [4, 128, 479]) {
    const p = start({ workTicks });
    const result = finish(p, events, workTicks);
    assert.equal(result.status, 'historyValid'); assert.equal(result.ticks, 960);
    assert.deepEqual(p.status(), whole.status());
  }
});

test('actual total chunk ceiling, zero-delta backlog and late expensive events rollback without false historyValid', () => {
  const p = start({ workTicks: 128, maxChunkTicks: 960 });
  assert.equal(finish(p, [frame(0), frame(1e9), frame(0)]).ticks, 960);
  const before = p.status();
  assert.equal(finish(p, [frame(0), frame(0), frame(0)]).status, 'resourceLimited');
  assert.deepEqual(p.status(), before); assert.throws(() => p.resume(), /REPLAY_CHUNK_INVALID/);
  assert.equal(finish(p, [frame(0)]).ticks, 480, 'zero uploaded delta does not hide retained server backlog');
  const cheap = start({ maxChunkTicks: 1 });
  assert.equal(finish(cheap, Array.from({ length: 256 }, () => frame(0))).status, 'historyValid');
});

test('exact chunk boundary accepts completion and no-cost tail; one more eligible tick rejects before execution', () => {
  const p = start({ workTicks: 4, maxChunkTicks: 4 });
  assert.equal(finish(p, [frame(0), frame(4 / 60), frame(0)], 4).ticks, 4);
  const before = p.status();
  assert.equal(finish(p, [frame(5 / 60)], 4).status, 'resourceLimited');
  assert.deepEqual(p.status(), before);
});

test('existing processor byte/event/state/work ceilings are unchanged', () => {
  for (const bounds of [{ workTicks: 1 }, { workTicks: 1025 }, { maxChunkTicks: 1025 }, { maxEvents: 257 },
    { workEvents: 0 }, { workEvents: 257 }, { maxChunkBytes: 65537 }, { maxStateBytes: 1048577 }]) {
    assert.throws(() => start(bounds), /REPLAY_CHUNK_INVALID/);
  }
});

test('server trusted speedLimit1 survives processor creation and cannot be bypassed by uploaded timing command', () => {
  const cfg = { ...config, speedLimit: 1 }, p = start({ workTicks: 4 }, cfg), before = p.status();
  cfg.speedLimit = 4;
  assert.throws(() => finish(p, [{ type: 'timing', command: { type: 'speedCycle' } }], 4), /REPLAY_TIMING_INVALID/);
  assert.deepEqual(p.status(), before);
  assert.equal(finish(p, [{ type: 'timing', command: { type: 'startWave' } }, frame(0), frame(.1)], 4).status, 'historyValid');
});

test('bounded codec/schema rejects oversized/cyclic/accessor and uploaded budget/cost fields without checkpoint mutation', () => {
  const p = start(), before = p.status();
  const oversized = envelope(p, [frame(0)]); oversized.padding = 'x'.repeat(65536);
  assert.equal(p.submit(oversized).status, 'resourceLimited');
  const cyclic = envelope(p, []); cyclic.events.push(cyclic);
  assert.throws(() => p.submit(cyclic), /REPLAY_CHUNK_INVALID/);
  let touched = false;
  const event = { get type() { touched = true; return 'frame'; }, delta: 0 };
  assert.throws(() => p.submit(envelope(p, [event])), /REPLAY_CHUNK_INVALID/); assert.equal(touched, false);
  for (const bad of [{ ...frame(0), ticks: 0 }, { ...frame(0), trustedMaxTicks: 0 }, { ...frame(0), workTicks: 999 },
    frame(-1), frame(Infinity), frame('0')]) {
    assert.throws(() => p.submit(envelope(p, [bad])), /REPLAY_CHUNK_INVALID/);
  }
  assert.deepEqual(p.status(), before);
});
