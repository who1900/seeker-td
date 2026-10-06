import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createReplayFingerprint } from './replayFingerprint.mjs';
import { createReplayRuntime } from './replayRuntime.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const config = () => ({ mode: 'endless', waveLimit: 1, durationSeconds: 300 });
const start = runtime => runtime.start({ seed: 42, config: config() });
const create = (root = projectRoot, budgets) => createReplayRuntime({ projectRoot: root, version: 1,
  ...(budgets === undefined ? {} : { budgets }) });
const envelope = (processor, events) => ({ version: 1, index: processor.status().nextIndex,
  previousHash: processor.status().previousHash, events });
const place = { type: 'action', action: { type: 'place', towerId: 'canon', cell: { x: 5, y: 3 } } };
const wave = { type: 'timing', command: { type: 'startWave' } };
const frame = delta => ({ type: 'frame', delta });
function finish(processor, events) {
  let result = processor.submit(envelope(processor, events)), count = 0;
  while (result.status === 'pending') { assert.ok(++count < 1000); result = processor.resume(); }
  return result;
}
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'replay-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'src/game'), { recursive: true });
  for (const source of createReplayFingerprint(projectRoot).sourceHashes) {
    copyFileSync(path.join(projectRoot, source.path), path.join(root, source.path));
  }
  return root;
}

test('actual seeded historyValid; runtime identity binds compiler/profile; no global pollution', () => {
  const require = createRequire(import.meta.url), extensions = Object.getOwnPropertyDescriptors(require.extensions);
  const random = Math.random, globals = Reflect.ownKeys(globalThis);
  const budgets = { processorBounds: { workTicks: 128 } };
  const runtime = create(projectRoot, budgets), a = start(runtime), b = start(create(projectRoot, budgets));
  const history = [place, wave, frame(0), frame(.05)];
  assert.equal(finish(a, history).status, 'historyValid'); assert.equal(finish(b, history).status, 'historyValid');
  for (let i = 0; i < 15; i++) {
    assert.equal(finish(a, [frame(.05), frame(.05)]).status, 'historyValid');
    assert.equal(finish(b, [frame(.05), frame(.05)]).status, 'historyValid');
  }
  assert.deepEqual(a.status(), b.status()); assert.ok(a.status().uidCounter > 2);
  assert.notEqual(runtime.fingerprint.hash, createReplayFingerprint(projectRoot).hash);
  const ts = createRequire(new URL('../package.json', import.meta.url))('typescript');
  assert.equal(runtime.fingerprint.runtimeProfile.compiler, `typescript-${ts.version}`);
  assert.equal(runtime.fingerprint.runtimeProfile.node, process.version);
  assert.deepEqual(runtime.fingerprint.sourceHashes, createReplayFingerprint(projectRoot).sourceHashes);
  assert.deepEqual(Object.keys(runtime.fingerprint), ['version', 'hash', 'sourceHashes', 'runtimeProfile']);
  assert.deepEqual(Object.keys(runtime), ['version', 'fingerprint', 'start']);
  const identity = profile => {
    const hash = createHash('sha256');
    const frame = value => {
      const bytes = Buffer.from(value, 'utf8'), length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length); hash.update(length); hash.update(bytes);
    };
    frame('seeker-td:replay-runtime-fingerprint:v1'); frame(createReplayFingerprint(projectRoot).hash);
    for (const [key, value] of Object.entries(profile)) { frame(key); frame(value); }
    return hash.digest('hex');
  };
  assert.equal(identity(runtime.fingerprint.runtimeProfile), runtime.fingerprint.hash);
  assert.notEqual(identity({ ...runtime.fingerprint.runtimeProfile, compiler: 'typescript-different' }), runtime.fingerprint.hash);
  assert.notEqual(identity({ ...runtime.fingerprint.runtimeProfile, compilerOptions: '{}' }), runtime.fingerprint.hash);
  assert.ok(Object.isFrozen(runtime) && Object.isFrozen(runtime.fingerprint.runtimeProfile));
  assert.equal(Math.random, random); assert.deepEqual(Reflect.ownKeys(globalThis), globals);
  assert.deepEqual(Object.getOwnPropertyDescriptors(require.extensions), extensions);
});

test('captured code survives source deletion; new runtime binds changed engine, separate module caches', t => {
  const root = fixture(t), runtime = create(root, { processorBounds: { workTicks: 480 } }), before = start(runtime);
  const engine = path.join(root, 'src/game/engine.ts');
  writeFileSync(engine, `${readFileSync(engine, 'utf8')}\n// new runtime source identity\n`);
  assert.notEqual(create(root).fingerprint.hash, runtime.fingerprint.hash);
  writeFileSync(engine, `${readFileSync(engine, 'utf8')}\nthrow new Error('changed engine executed');\n`);
  assert.throws(() => create(root), /changed engine executed/);
  assert.deepEqual(start(runtime).status(), before.status());
  rmSync(path.join(root, 'src'), { recursive: true });
  const after = start(runtime), history = [place, wave, frame(0), frame(.05)];
  assert.equal(finish(after, history).status, 'historyValid');
  assert.equal(finish(before, history).status, 'historyValid'); assert.deepEqual(after.status(), before.status());
});

test('unknown/external/dynamic imports, require and compiler syntax errors reject before execution', t => {
  const root = fixture(t), engine = path.join(root, 'src/game/engine.ts'), original = readFileSync(engine, 'utf8');
  for (const addition of ['import "./palette";', 'import "node:fs";', 'import("./data");',
    'require("node:fs");', 'export const broken: = 1;']) {
    writeFileSync(engine, `${addition}\n${original}`);
    assert.throws(() => create(root), /REPLAY_(FINGERPRINT_INVALID|RUNTIME_COMPILER_ERROR)/);
  }
});

test('constructor limits, strict trusted options and start errors', () => {
  assert.throws(() => create(projectRoot, { sourceBounds: { maxFileBytes: 1 } }), /RESOURCE_LIMITED/);
  assert.throws(() => create(projectRoot, { processorBounds: { maxStateBytes: 1 } }), /RESOURCE_LIMITED/);
  assert.throws(() => create(projectRoot, { processorBounds: { workTicks: 1 } }), /REPLAY_CHUNK_INVALID/);
  assert.throws(() => createReplayRuntime({ projectRoot, version: 2 }), /REPLAY_RUNTIME_INVALID/);
  assert.throws(() => createReplayRuntime({ projectRoot, version: 1, snapshot: {} }), /REPLAY_RUNTIME_INVALID/);
  assert.throws(() => createReplayRuntime({ projectRoot, version: 1, seed: 42 }), /REPLAY_RUNTIME_INVALID/);
  const runtime = create();
  assert.throws(() => runtime.start({ seed: -1, config: config() }), /COMBAT_RANDOM_INVALID/);
  assert.throws(() => runtime.start({ seed: 42, config: { ...config(), mode: 'invalid' } }), /REPLAY_TIMING_INVALID/);
  assert.throws(() => runtime.start({ seed: 42, config: config(), fingerprint: 'caller' }), /REPLAY_RUNTIME_INVALID/);
});

test('pending rollback and successful retry; factory budget ownership', () => {
  const processorBounds = { workTicks: 4, workEvents: 2 }, runtime = create(projectRoot, { processorBounds });
  processorBounds.workEvents = 256;
  const processor = start(runtime), before = processor.status();
  const result = processor.submit(envelope(processor, [place, wave,
    { type: 'action', action: { type: 'sell', uid: 'missing' } }]));
  assert.equal(result.status, 'pending'); assert.deepEqual(processor.status(), before);
  assert.throws(() => processor.resume(), /REPLAY_COMMAND_INVALID/);
  assert.deepEqual(processor.status(), before); assert.throws(() => processor.resume(), /REPLAY_CHUNK_INVALID/);
  assert.equal(finish(processor, [place]).status, 'historyValid'); assert.equal(processor.status().uidCounter, 2);
});

test('server resumable frame ceiling follows captured timing export; missing/invalid export never falls back to four', t => {
  const root = fixture(t), timingPath = path.join(root, 'src/game/replayTiming.ts');
  const timing = readFileSync(timingPath, 'utf8');
  assert.ok(timing.includes('export const MAX_FRAME_TICKS = 480;'));
  writeFileSync(timingPath, timing.replace('export const MAX_FRAME_TICKS = 480;', 'export const MAX_FRAME_TICKS = 600;'));
  const runtime = create(root, { processorBounds: { workTicks: 480 } }), processor = start(runtime), before = processor.status();
  assert.equal(finish(processor, [frame(0)]).status, 'historyValid');
  assert.equal(finish(processor, [frame(1e9)]).ticks, 600);
  assert.equal(processor.status().nextIndex, before.nextIndex + 2);
  assert.notEqual(runtime.fingerprint.hash, create(projectRoot).fingerprint.hash);
  for (const replacement of ['const MAX_FRAME_TICKS = 480;', 'export const MAX_FRAME_TICKS = NaN;']) {
    writeFileSync(timingPath, timing.replace('export const MAX_FRAME_TICKS = 480;', replacement));
    assert.throws(() => create(root), /REPLAY_CHUNK_INVALID/);
  }
});
