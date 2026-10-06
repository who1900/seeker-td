import { strict as assert } from 'node:assert';
import { createGame, startWave, tick, cellToWorld } from './engine';
import type { BattleState, Enemy } from './types';

function leaker(state: BattleState, waveIndex?: number, hp = 10): Enemy {
  const pos = cellToWorld(state.exit);
  const enemy: Enemy = { uid: `leak-${state.uidCounter++}`, id: 'soldier', hp, maxHp: 10,
    speed: 1, pos, path: [pos], pathIdx: 1, pathProgress: 0, waveIndex, spawnedAt: state.time };
  state.enemies.push(enemy);
  return enemy;
}

const random = Math.random;
Math.random = () => 0.5;
try {
  const state = createGame();
  assert.equal(state.leakedWaveIndices.length, 0);
  startWave(state);
  for (let i = 0; i < 320; i++) tick(state, 1 / 64);
  startWave(state);
  assert.equal(state.waveIndex, 1);
  assert.ok(state.spawnQueue.some(entry => entry.waveIndex === 0));
  state.spawnQueue = [];
  leaker(state, 0);
  const deadNewWave = leaker(state, 1, 0);
  tick(state, 0);
  assert.deepEqual(state.leakedWaveIndices, [0], 'old leak attributed to newest overlapping wave');
  assert.ok(state.clearedWaveIndices.includes(1), 'new wave did not clear');
  assert.ok(!state.leakedWaveIndices.includes(1), 'dead mob counted as a leak');
  assert.equal(deadNewWave.hp, 0);
  leaker(state, 0);
  leaker(state, 0);
  tick(state, 0);
  assert.deepEqual(state.leakedWaveIndices, [0], 'duplicate wave leak record');
  for (let i = 0; i < 320; i++) tick(state, 1 / 64);
  startWave(state);
  assert.deepEqual(state.leakedWaveIndices, [0], 'startWave reset leak history');
  assert.equal(state.waveIndex, 2);
  state.spawnQueue = [];
  leaker(state); // Legacy missing provenance falls back to current wave.
  tick(state, 0);
  assert.deepEqual(state.leakedWaveIndices, [0, 2]);

  const mixed = createGame();
  mixed.waveIndex = 9;
  leaker(mixed, 4);
  leaker(mixed, 3);
  leaker(mixed, 4);
  tick(mixed, 0);
  assert.deepEqual(mixed.leakedWaveIndices, [4, 3]);
  assert.equal(mixed.lives, 17);
  const pos = cellToWorld(mixed.entry);
  mixed.enemies.push({ uid: 'flyer-leak', id: 'flyer', hp: 10, maxHp: 10,
    speed: 1e6, pos, flyProgress: 0, waveIndex: 5 });
  tick(mixed, 0.1);
  assert.deepEqual(mixed.leakedWaveIndices, [4, 3, 5], 'flyer leak not recorded');

  const defeat = createGame();
  defeat.waveIndex = 7;
  defeat.lives = 1;
  leaker(defeat, 6);
  tick(defeat, 0);
  assert.ok(defeat.gameOver);
  assert.deepEqual(defeat.leakedWaveIndices, [6], 'fatal leak lost before early return');
  tick(defeat, 1);
  assert.deepEqual(defeat.leakedWaveIndices, [6]);
  // UI continue toggles the existing state; no engine reset or new wave is required.
  defeat.gameOver = false;
  defeat.lives = 5;
  tick(defeat, 0);
  assert.deepEqual(defeat.leakedWaveIndices, [6], 'continue reset leak history');
  const restored = JSON.parse(JSON.stringify(defeat)) as BattleState;
  tick(restored, 0);
  assert.deepEqual(restored.leakedWaveIndices, [6], 'persisted history lost');

  const paused = createGame();
  leaker(paused, 0);
  paused.paused = true;
  tick(paused, 100);
  assert.equal(paused.leakedWaveIndices.length, 0, 'paused enemy leaked');
  paused.paused = false;
  tick(paused, 0);
  assert.deepEqual(paused.leakedWaveIndices, [0]);
  console.log('wave leak regression checks passed (provenance, overlaps, fatal leaks, continue persistence)');
} finally {
  Math.random = random;
}
