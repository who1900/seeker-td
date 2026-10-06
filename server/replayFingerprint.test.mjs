import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createReplayFingerprint } from './replayFingerprint.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'replay-fingerprint-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project');
  mkdirSync(path.join(root, 'src/game'), { recursive: true });
  for (const source of createReplayFingerprint(project).sourceHashes) {
    copyFileSync(path.join(project, source.path), path.join(root, source.path));
  }
  return { root, directory, engine: path.join(root, 'src/game/engine.ts') };
}

test('actual sources: deterministic ordered raw-byte hashes and strict frozen server DTO', () => {
  const result = createReplayFingerprint(project);
  assert.deepEqual(result, createReplayFingerprint(project));
  assert.deepEqual(Object.keys(result), ['version', 'hash', 'sourceHashes', 'runtimeProfile']);
  assert.equal(result.version, 1); assert.match(result.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.sourceHashes.map(source => source.path), ['types', 'data', 'engine', 'combatShots',
    'combatStatus', 'waveManager', 'pathfinding', 'gameplayRandom', 'replayTiming', 'replayCommands', 'replayChunk']
    .map(name => `src/game/${name}.ts`));
  for (const source of result.sourceHashes) {
    assert.equal(source.hash, createHash('sha256').update(readFileSync(path.join(project, source.path))).digest('hex'));
    assert.ok(Object.isFrozen(source));
  }
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.sourceHashes) && Object.isFrozen(result.runtimeProfile));
  assert.equal(result.runtimeProfile.declaration, 'compatibility-target-only-not-cross-platform-proof');
});

test('outside palette ignored; engine edits and line endings change identity', t => {
  const { root, engine } = fixture(t), before = createReplayFingerprint(root);
  writeFileSync(path.join(root, 'src/game/palette.ts'), 'export const palette = "cream";');
  assert.deepEqual(createReplayFingerprint(root), before);
  writeFileSync(path.join(root, 'src/game/palette.ts'), 'export const palette = "dark";');
  assert.deepEqual(createReplayFingerprint(root), before);
  const original = readFileSync(engine, 'utf8');
  writeFileSync(engine, `${original}\n// changed engine\n`);
  assert.notEqual(createReplayFingerprint(root).hash, before.hash);
  writeFileSync(engine, original.replace(/\r?\n/g, '\n'));
  const lf = createReplayFingerprint(root);
  writeFileSync(engine, original.replace(/\r?\n/g, '\r\n'));
  assert.notEqual(createReplayFingerprint(root).hash, lf.hash);
});

test('missing source and realpath escape denied', t => {
  const { root, engine, directory } = fixture(t);
  unlinkSync(engine); assert.throws(() => createReplayFingerprint(root), /ENOENT/);
  const outside = path.join(directory, 'outside'); mkdirSync(outside);
  copyFileSync(path.join(project, 'src/game/engine.ts'), path.join(outside, 'engine.ts'));
  rmSync(path.join(root, 'src/game'), { recursive: true });
  symlinkSync(outside, path.join(root, 'src/game'), 'junction');
  copyFileSync(path.join(project, 'src/game/types.ts'), path.join(outside, 'types.ts'));
  assert.throws(() => createReplayFingerprint(root), /REPLAY_FINGERPRINT_INVALID/);
});

test('AST closure includes type imports/reexports and rejects unknown or dynamic dependencies', t => {
  const { root, engine } = fixture(t), original = readFileSync(engine, 'utf8');
  for (const statement of ['import type { X } from "./palette";', 'export * from "./palette";',
    'type X = import("./palette").X;', 'import fs from "node:fs";', 'import("./types");',
    'require("./types");', 'const load = require;', 'globalThis["require"]("./types");',
    'import X = require("./types");',
    '/// <reference path="./palette.ts" />']) {
    writeFileSync(engine, `${statement}\n${original}`);
    assert.throws(() => createReplayFingerprint(root), /REPLAY_FINGERPRINT_INVALID/, statement);
  }
  writeFileSync(engine, `import type { Vec2 } from "./types.ts";\nexport * from "./types";\ntype Fixture = import("./types").Vec2;\n${original}`);
  assert.match(createReplayFingerprint(root).hash, /^[a-f0-9]{64}$/);
});

test('file/total bounds, malformed UTF8, trusted root and caller hash rejection', t => {
  const { root, engine } = fixture(t);
  const sizes = createReplayFingerprint(root).sourceHashes.map(source => readFileSync(path.join(root, source.path)).length);
  const total = sizes.reduce((sum, size) => sum + size, 0), largest = Math.max(...sizes);
  assert.deepEqual(createReplayFingerprint(root, { maxFileBytes: largest, maxTotalBytes: total }), createReplayFingerprint(root));
  assert.throws(() => createReplayFingerprint(root, { maxFileBytes: largest - 1 }), /RESOURCE_LIMITED/);
  assert.throws(() => createReplayFingerprint(root, { maxTotalBytes: total - 1 }), /RESOURCE_LIMITED/);
  assert.throws(() => createReplayFingerprint(root, { maxFileBytes: 1 }), /RESOURCE_LIMITED/);
  assert.throws(() => createReplayFingerprint(root, { maxTotalBytes: 1 }), /RESOURCE_LIMITED/);
  for (const bounds of [{ maxFileBytes: 1048577 }, { maxTotalBytes: 8388609 }, { maxFileBytes: 0 },
    { maxFileBytes: NaN }, { hash: 'a'.repeat(64) }, { get maxFileBytes() { assert.fail('getter executed'); } }]) {
    assert.throws(() => createReplayFingerprint(root, bounds), /REPLAY_FINGERPRINT_INVALID/);
  }
  assert.throws(() => createReplayFingerprint('src/game'), /REPLAY_FINGERPRINT_INVALID/);
  writeFileSync(engine, Buffer.from([0xff]));
  assert.throws(() => createReplayFingerprint(root), /encoded data|encoding/i);
});
