import { strict as assert } from 'node:assert';
import { AUDIO_LIMITS, initAudio, playSfx, startAmbient, stopAmbient, stopGameAudio, setMuted, isMuted, disposeAudio } from './audio';
import { createGame, placeTower, sellTower, upgradeTower, tick, startWave, cellToWorld } from './game/engine';
import { TOWERS } from './game/data';
import type { TowerId } from './game/types';

class FakeParam {
  value = 0;
  events: number[] = [];
  setValueAtTime(value: number) { this.value = value; this.events.push(value); }
  exponentialRampToValueAtTime(value: number) { this.events.push(value); }
  linearRampToValueAtTime(value: number) { this.events.push(value); }
  cancelScheduledValues() {}
}
class FakeNode {
  frequency = new FakeParam();
  gain = new FakeParam();
  type = '';
  buffer: unknown;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  disconnected = false;
  stopTime = Infinity;
  connect(_target: unknown) {}
  disconnect() { this.disconnected = true; }
  start(_time = 0) { this.started = true; }
  stop(time?: number) {
    this.stopTime = time ?? 0;
    if (time === undefined) this.stopped = true;
  }
}
class FakeContext {
  static instances: FakeContext[] = [];
  currentTime = 0;
  sampleRate = 1000;
  state = 'running';
  destination = new FakeNode();
  nodes: FakeNode[] = [];
  buffers = 0;
  constructor() { FakeContext.instances.push(this); }
  node() { const node = new FakeNode(); this.nodes.push(node); return node; }
  createGain() { return this.node(); }
  createOscillator() { return this.node(); }
  createBufferSource() { return this.node(); }
  createBiquadFilter() { return this.node(); }
  createBuffer(_channels: number, length: number) {
    this.buffers++;
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  async close() { this.state = 'closed'; }
  flush(seconds = 1) {
    this.currentTime += seconds;
    for (const node of this.nodes) {
      if (node.started && !node.stopped && node.stopTime <= this.currentTime) {
        node.stopped = true;
        node.onended?.();
      }
    }
  }
  liveSources() { return this.nodes.filter(node => node.started && !node.stopped && !node.disconnected); }
}

const towerTags: [TowerId, string][] = [
  ['canon', 'shot_canon'], ['dualCanon', 'shot_dualCanon'], ['machineGun', 'shot_machineGun'],
  ['simpleLaser', 'shot_simpleLaser'], ['bouncingLaser', 'shot_bounceChain'], ['straightLaser', 'shot_straightPierce'],
  ['mortar', 'shot_mortar'], ['mineLayer', 'shot_mine'], ['rocketLauncher', 'shot_rocket'],
  ['glueTower', 'shot_glueTower'], ['glueGun', 'shot_glueGun'], ['teleporter', 'sfx_teleport'],
];

async function run() {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const random = Math.random;
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeContext });
  Math.random = () => 0.5;
  try {
    stopGameAudio(); stopGameAudio();
    assert.equal(FakeContext.instances.length, 0, 'lifecycle stop must not initialize audio');
    setMuted(true);
    initAudio();
    assert.equal(FakeContext.instances.length, 0, 'muted init creates no context');
    setMuted(false);
    initAudio();
    initAudio();
    const ctx = FakeContext.instances[0];
    assert.equal(FakeContext.instances.length, 1);
    const signatures = new Set<string>();
    for (const [, tag] of towerTags) {
      const before = ctx.nodes.length;
      playSfx(tag);
      const created = ctx.nodes.slice(before);
      assert.ok(created.some(node => node.started), tag);
      signatures.add(JSON.stringify(created.map(node => [node.type, node.frequency.value, node.frequency.events])));
      ctx.flush();
      assert.ok(created.every(node => node.disconnected), 'ended nodes not disconnected');
    }
    assert.equal(signatures.size, 12, 'tower timbres not distinct');
    assert.equal(ctx.buffers, 1, 'noise buffer not cached');
    for (const tag of ['shot_bullet', 'shot_laser', 'shot_explosive', 'shot_glue', 'sfx_teleport', 'wave_start', 'build', 'enhance', 'sell', 'life_lost', 'victory', 'defeat']) {
      const before = ctx.nodes.length;
      playSfx(tag);
      assert.ok(ctx.nodes.length > before, `unsupported ${tag}`);
      ctx.flush();
    }
    const unknownBefore = ctx.nodes.length;
    playSfx('unknown');
    assert.equal(ctx.nodes.length, unknownBefore);

    for (const [, tag] of towerTags.slice(0, 6)) playSfx(tag);
    const ordinaryFull = ctx.nodes.length;
    playSfx('shot_mortar');
    playSfx('shot_mine');
    assert.equal(ctx.nodes.length, ordinaryFull, 'ordinary window cap not enforced');
    playSfx('life_lost');
    playSfx('defeat');
    assert.ok(ctx.nodes.length > ordinaryFull, 'critical cues had no reserved admission');
    const full = ctx.nodes.length;
    playSfx('wave_start');
    assert.equal(ctx.nodes.length, full, 'total window cap not enforced');
    assert.ok(ctx.liveSources().length <= AUDIO_LIMITS.maxVoices * 3);
    ctx.flush();
    playSfx('wave_start');
    for (const [, tag] of towerTags.slice(0, 6)) playSfx(tag);
    const beforeWavePriority = ctx.nodes.length;
    playSfx('life_lost');
    playSfx('defeat');
    assert.ok(ctx.nodes.length > beforeWavePriority, 'wave alert consumed life/result reserve');
    assert.equal(ctx.nodes.slice(beforeWavePriority).filter(node => node.started).length, 5,
      'life/result were not both admitted after wave alert');
    ctx.flush();
    playSfx('shot_bullet');
    const duplicateBefore = ctx.nodes.length;
    playSfx('shot_canon');
    assert.equal(ctx.nodes.length, duplicateBefore, 'alias bypasses same-tag limiter');
    ctx.flush();

    // Do not emit onended here: exercise the active-voice cap across windows.
    for (let i = 0; i < 20; i++) {
      ctx.currentTime += 0.051;
      playSfx('shot_canon');
    }
    assert.ok(ctx.liveSources().length <= AUDIO_LIMITS.maxVoices * 2, 'unbounded active voices');
    const beforePriority = ctx.liveSources();
    ctx.currentTime += 0.051;
    playSfx('life_lost');
    assert.ok(beforePriority.some(node => node.disconnected), 'priority did not preempt ordinary voice');
    ctx.flush();

    startAmbient();
    const ambient = ctx.liveSources();
    assert.equal(ambient.length, 3);
    startAmbient();
    assert.equal(ctx.liveSources().length, 3, 'duplicate ambient');
    stopAmbient();
    assert.ok(ambient.every(node => node.stopped && node.disconnected));
    startAmbient();
    stopAmbient();
    startAmbient();
    assert.equal(ctx.liveSources().length, 3, 'rapid start/stop duplicated ambient');
    const lifecycleStart = ctx.nodes.length;
    playSfx('victory');
    const scheduled = ctx.nodes.slice(lifecycleStart).filter(node => node.started);
    const endedCallbacks = scheduled.map(node => node.onended);
    assert.equal(scheduled.length, 3, 'including staggered scheduled notes');
    stopAmbient();
    assert.equal(ctx.liveSources().length, 3, 'ambient-only stop preserves necessary terminal cue');
    startAmbient();
    const lifecycleNodes = ctx.nodes.slice(lifecycleStart);
    stopGameAudio();
    assert.equal(ctx.liveSources().length, 0, 'lifecycle stop clears ambient and scheduled SFX');
    assert.ok(lifecycleNodes.every(node => node.disconnected), 'all lifecycle voice/ambient nodes disconnected');
    assert.ok(lifecycleNodes.filter(node => node.started).every(node => node.stopped && node.onended === null));
    endedCallbacks.forEach(callback => callback?.());
    const stoppedNodes = ctx.nodes.length;
    stopGameAudio();
    assert.equal(ctx.nodes.length, stoppedNodes, 'repeated stop allocates nothing');
    assert.equal(ctx.state, 'running', 'lifecycle stop preserves reusable context');
    assert.equal(isMuted(), false, 'lifecycle stop does not change sound preference');
    playSfx('victory');
    assert.equal(ctx.liveSources().length, 3, 'fresh terminal cue admitted after lifecycle stop');
    stopGameAudio();
    setMuted(true); stopGameAudio(); setMuted(false);
    await Promise.resolve();
    assert.equal(ctx.liveSources().length, 0, 'unmute does not revive stopped ambient');
    startAmbient();
    playSfx('shot_rocket');
    setMuted(true);
    assert.ok(isMuted());
    assert.equal(ctx.state, 'suspended');
    assert.equal(ctx.liveSources().length, 0, 'mute left active sources');
    const mutedBefore = ctx.nodes.length;
    playSfx('victory');
    startAmbient();
    assert.equal(ctx.nodes.length, mutedBefore, 'mute allocated sources');
    setMuted(false);
    await Promise.resolve();
    assert.equal(ctx.liveSources().length, 3, 'unmute failed to restore a single ambient');
    stopAmbient();
    ctx.state = 'suspended';
    playSfx('build');
    assert.equal(ctx.liveSources().length, 0, 'suspended context played SFX');
    const resume = ctx.resume;
    let finishResume!: () => void;
    ctx.resume = () => new Promise<void>(resolve => { finishResume = () => { ctx.state = 'running'; resolve(); }; });
    initAudio(); startAmbient(); stopGameAudio();
    finishResume(); await Promise.resolve();
    assert.equal(ctx.liveSources().length, 0, 'pending resume cannot revive stopped ambient');
    ctx.resume = resume;
    disposeAudio();
    stopGameAudio(); disposeAudio();
    assert.equal(ctx.state, 'closed');
    assert.ok(ctx.nodes.every(node => node.disconnected), 'teardown left connected nodes');
    initAudio();
    assert.equal(FakeContext.instances.length, 2, 'cannot reinitialize');

    for (const [towerId, expectedTag] of towerTags) {
      const state = createGame();
      state.gold = 1e9;
      assert.ok(placeTower(state, towerId, { x: 5, y: 1 }));
      assert.deepEqual(state.soundQueue, ['build']);
      state.soundQueue = [];
      const position = cellToWorld({ x: 6, y: 1 });
      state.enemies.push({ uid: 'audio-target', id: 'soldier', hp: 1e9, maxHp: 1e9,
        speed: 0, pos: position, path: [position, cellToWorld(state.exit)], pathIdx: 1, pathProgress: 0 });
      tick(state, 0);
      if (towerId === 'mineLayer' || towerId === 'rocketLauncher') {
        assert.ok(!state.soundQueue.includes(expectedTag), `${towerId} emitted before preparation/load`);
        for (let i = 0; i < 64 && !state.soundQueue.includes(expectedTag); i++) tick(state, 1 / 64);
      } else {
        assert.ok(!state.soundQueue.includes(expectedTag), 'shot emitted before initial Aimer refresh');
        for (let i = 0; i < 64 && !state.soundQueue.includes(expectedTag); i++) tick(state, 1 / 64);
      }
      assert.ok(state.soundQueue.includes(expectedTag), `wrong engine ${towerId} tag`);
      state.soundQueue = [];
      tick(state, 0);
      assert.equal(state.soundQueue.length, 0, 'cooldown emitted another shot');
      assert.ok(upgradeTower(state, state.towers[0].uid));
      assert.deepEqual(state.soundQueue, ['enhance']);
      state.soundQueue = [];
      state.towers[0].level = TOWERS[towerId].maxLevel - 1;
      if (TOWERS[towerId].upgradeCostToNext !== null) {
        assert.ok(upgradeTower(state, state.towers[0].uid));
        assert.deepEqual(state.soundQueue, ['enhance']);
        state.soundQueue = [];
      }
      sellTower(state, state.towers[0].uid);
      assert.deepEqual(state.soundQueue, ['sell']);
      state.soundQueue = [];
      sellTower(state, 'invalid');
      assert.equal(state.soundQueue.length, 0);
      state.gold = 0;
      assert.equal(placeTower(state, towerId, { x: 5, y: 3 }), false);
      assert.equal(upgradeTower(state, 'invalid'), false);
      assert.equal(state.soundQueue.length, 0, 'rejected operation emitted sound');
    }
    const loss = createGame();
    startWave(loss);
    assert.deepEqual(loss.soundQueue, ['wave_start']);
    loss.soundQueue = Array.from({ length: 32 }, () => 'shot_canon');
    loss.lives = 1;
    loss.enemies.push({ uid: 'leak', id: 'soldier', hp: 10, maxHp: 10, speed: 1,
      pos: cellToWorld(loss.exit), path: [cellToWorld(loss.exit)], pathIdx: 1 });
    tick(loss, 0);
    assert.ok(loss.soundQueue.includes('life_lost') && loss.soundQueue.includes('defeat'));
    assert.ok(loss.soundQueue.length <= 32);
    tick(loss, 0);
    assert.equal(loss.soundQueue.filter(tag => tag === 'defeat').length, 1, 'duplicate defeat');
    console.log('audio regression checks passed (fake AudioContext; no real audio)');
  } finally {
    disposeAudio();
    setMuted(false);
    Math.random = random;
    if (descriptor) Object.defineProperty(globalThis, 'AudioContext', descriptor);
    else Reflect.deleteProperty(globalThis, 'AudioContext');
  }
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
