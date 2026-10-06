import { createGame, tick, startWave, canStartNextWave, getNextWaveWait } from './engine';
import { createReplayTiming } from './replayTiming';
import type { ReplayTimingConfig, ReplayTimingCommand, ReplayTimingSnapshot } from './replayTiming';
import { createReplayCommands } from './replayCommands';
import type { ReplayAction } from './replayCommands';
import type { BattleState } from './types';

const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
function deny(): never { throw new Error('REPLAY_CHUNK_INVALID'); }
class ResourceLimit extends Error { constructor() { super('REPLAY_RESOURCE_LIMITED'); } }
const exact = (value: unknown, keys: string[]) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) return false;
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && own(descriptor, 'value') && descriptor.enumerable;
  });
};

export interface CanonicalBounds { maxBytes: number; maxNodes: number }
function encode(value: unknown, bounds: CanonicalBounds) {
  if (!exact(bounds, ['maxBytes', 'maxNodes']) || !Number.isSafeInteger(bounds.maxBytes) || bounds.maxBytes < 1
    || bounds.maxBytes > 4194304 || !Number.isSafeInteger(bounds.maxNodes) || bounds.maxNodes < 1 || bounds.maxNodes > 1000000) deny();
  const buffer = new Uint8Array(bounds.maxBytes), view = new DataView(buffer.buffer), ancestors = new Set<object>();
  const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
  let offset = 0, nodes = 0;
  const reserve = (bytes: number) => { if (offset + bytes > buffer.length) throw new ResourceLimit(); };
  const byte = (n: number) => { reserve(1); buffer[offset++] = n; };
  const size = (n: number) => { reserve(4); view.setUint32(offset, n, false); offset += 4; };
  const string = (text: string) => {
    if (text.length > bounds.maxBytes) throw new ResourceLimit();
    const bytes = encoder.encode(text);
    if (decoder.decode(bytes) !== text) deny();
    size(bytes.length); reserve(bytes.length); buffer.set(bytes, offset); offset += bytes.length;
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > bounds.maxNodes || depth > 64) throw new ResourceLimit();
    if (item === undefined) { byte(0); return; }
    if (item === null) { byte(1); return; }
    if (typeof item === 'boolean') { byte(item ? 3 : 2); return; }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) deny();
      byte(4); reserve(8); view.setFloat64(offset, item, false); offset += 8; return;
    }
    if (typeof item === 'string') { byte(5); string(item); return; }
    if (typeof item !== 'object' || ancestors.has(item)) deny();
    const array = Array.isArray(item);
    if (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype)) deny();
    if (array && item.length > bounds.maxNodes - nodes) throw new ResourceLimit();
    const keys = Reflect.ownKeys(item);
    if (keys.some(key => typeof key !== 'string')) deny();
    if (keys.length > bounds.maxNodes - nodes) throw new ResourceLimit();
    ancestors.add(item);
    if (array) {
      if (keys.length !== item.length + 1) deny();
      byte(6); size(item.length);
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor || !own(descriptor, 'value') || !descriptor.enumerable) deny();
        visit(descriptor.value, depth + 1);
      }
    } else {
      const sorted = (keys as string[]).sort(); byte(7); size(sorted.length);
      for (const key of sorted) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!own(descriptor, 'value') || !descriptor.enumerable) deny();
        if (++nodes > bounds.maxNodes) throw new ResourceLimit();
        string(key); visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  return buffer.slice(0, offset);
}

export function canonicalReplayBytes(value: unknown, bounds: CanonicalBounds = { maxBytes: 1048576, maxNodes: 100000 }): Uint8Array {
  return encode(value, bounds);
}

export type ReplayChunkEvent = { type: 'frame'; delta: number }
  | { type: 'action'; action: ReplayAction } | { type: 'timing'; command: ReplayTimingCommand };
export interface ReplayChunkInput { version: 1; index: number; previousHash: string; events: ReplayChunkEvent[] }
export function projectReplayGameplayState(gs: BattleState) {
  const projection: Partial<BattleState> = { ...gs };
  delete projection.particles; delete projection.soundQueue; delete projection.lifeFlashUntil;
  return projection;
}
const defaults = { maxChunkBytes: 65536, maxEvents: 256, maxChunkTicks: 1024,
  workTicks: 128, workEvents: 64, maxStateBytes: 1048576, maxStateNodes: 100000 };
type Budgets = typeof defaults;

export function createReplayProcessor(options: {
  config: ReplayTimingConfig;
  seed: number;
  fingerprint: string;
  digest: (bytes: Uint8Array) => Uint8Array;
  budgets?: Partial<Budgets>;
}) {
  const keys = options && own(options, 'budgets') ? ['config', 'seed', 'fingerprint', 'digest', 'budgets'] : ['config', 'seed', 'fingerprint', 'digest'];
  if (!exact(options, keys) || typeof options.digest !== 'function' || typeof options.fingerprint !== 'string'
    || !/^[\x21-\x7e]{1,200}$/.test(options.fingerprint)) deny();
  const overrides = options.budgets ?? {};
  if (!exact(overrides, Object.keys(overrides)) || Object.keys(overrides).some(key => !own(defaults, key))) deny();
  const budgets: Budgets = { ...defaults, ...overrides };
  for (const [key, value] of Object.entries(budgets)) {
    const minimum = key === 'workTicks' ? 4 : 1;
    if (!Number.isSafeInteger(value) || value < minimum || value > defaults[key as keyof Budgets]
      && key !== 'workTicks' && key !== 'workEvents') deny();
  }
  if (budgets.workTicks > 1024 || budgets.workEvents > 256) deny();
  if (!exact(options.config, ['mode', 'waveLimit', 'durationSeconds'])) deny();
  const config = { ...options.config };
  const fingerprint = options.fingerprint, seed = options.seed, digest = options.digest;
  const stateBounds = { maxBytes: budgets.maxStateBytes, maxNodes: budgets.maxStateNodes };
  const hash = (value: unknown, bounds = stateBounds) => {
    const result = digest(encode(value, bounds));
    if (!(result instanceof Uint8Array) || result.length !== 32) deny();
    return Array.from(result, n => n.toString(16).padStart(2, '0')).join('');
  };
  const timingFor = (gs: BattleState, snapshot?: ReplayTimingSnapshot) => createReplayTiming({ getState: () => gs,
    tick, startWave, canStartNextWave, getNextWaveWait }, config, snapshot);
  let checkpoint = createGame(undefined, undefined, undefined, { combatSeed: seed });
  let timingSnapshot = timingFor(checkpoint).snapshot();
  const trustedConfig = { ...config };
  const gameplay = (gs: BattleState, timing: ReplayTimingSnapshot) => {
    return { version: 1, fingerprint, config: trustedConfig, seed, engine: projectReplayGameplayState(gs), timing };
  };
  encode(checkpoint, stateBounds);
  let gameplayHash = hash(gameplay(checkpoint, timingSnapshot));
  let previousHash = hash({ version: 1, fingerprint, config: trustedConfig, seed, gameplayHash });
  let nextIndex = 0, busy = false;
  type Pending = { chunk: ReplayChunkInput; gs: BattleState; timing: ReturnType<typeof timingFor>;
    commands: ReturnType<typeof createReplayCommands>; cursor: number; ticks: number };
  let pending: Pending | undefined;
  const status = () => ({ nextIndex, previousHash, gameplayHash, uidCounter: checkpoint.uidCounter,
    waveIndex: checkpoint.waveIndex, completedWaves: checkpoint.completedWaves });
  const validate = (chunk: ReplayChunkInput) => {
    encode(chunk, { maxBytes: budgets.maxChunkBytes, maxNodes: 32768 });
    if (!exact(chunk, ['version', 'index', 'previousHash', 'events']) || chunk.version !== 1
      || !Number.isSafeInteger(chunk.index) || chunk.index !== nextIndex || nextIndex === Number.MAX_SAFE_INTEGER
      || chunk.previousHash !== previousHash || !Array.isArray(chunk.events)) deny();
    if (chunk.events.length > budgets.maxEvents) throw new ResourceLimit();
    let frames = 0;
    for (const event of chunk.events) {
      const descriptor = event && Object.getOwnPropertyDescriptor(event, 'type');
      const type = descriptor && own(descriptor, 'value') ? descriptor.value : undefined;
      if (type === 'frame') {
        if (!exact(event, ['type', 'delta']) || event.type !== 'frame' || typeof event.delta !== 'number' || !Number.isFinite(event.delta) || event.delta < 0) deny();
        frames++;
      } else if (type === 'action') { if (!exact(event, ['type', 'action'])) deny(); }
      else if (type === 'timing') { if (!exact(event, ['type', 'command'])) deny(); }
      else deny();
    }
    if (frames * 4 > budgets.maxChunkTicks) throw new ResourceLimit();
  };
  const work = () => {
    const draft = pending!;
    let workTicks = 0, workEvents = 0;
    while (draft.cursor < draft.chunk.events.length) {
      const event = draft.chunk.events[draft.cursor];
      if (workEvents >= budgets.workEvents || event.type === 'frame' && workTicks + 4 > budgets.workTicks) {
        return { status: 'pending' as const, index: draft.chunk.index, cursor: draft.cursor, ticks: draft.ticks };
      }
      encode(draft.gs, stateBounds);
      if (event.type === 'frame') {
        const result = draft.timing.frame(event.delta); workTicks += result.ticks; draft.ticks += result.ticks;
      } else if (event.type === 'action') draft.commands.action(event.action);
      else draft.commands.timingCommand(event.command);
      encode(draft.gs, stateBounds);
      draft.cursor++; workEvents++;
    }
    const savedTiming = draft.timing.snapshot();
    const nextGameplayHash = hash(gameplay(draft.gs, savedTiming));
    const nextHash = hash({ version: 1, fingerprint, index: draft.chunk.index, previousHash,
      events: draft.chunk.events, gameplayHash: nextGameplayHash }, { maxBytes: 131072, maxNodes: 65536 });
    checkpoint = draft.gs; timingSnapshot = savedTiming; gameplayHash = nextGameplayHash;
    previousHash = nextHash; nextIndex++; pending = undefined;
    return { status: 'historyValid' as const, ...status(), ticks: draft.ticks };
  };
  const execute = (action: () => ReturnType<typeof work>) => {
    if (busy) deny();
    busy = true;
    try { return action(); }
    catch (error) {
      pending = undefined;
      if (error instanceof ResourceLimit) return { status: 'resourceLimited' as const, ...status() };
      throw error;
    } finally { busy = false; }
  };
  return Object.freeze({
    status,
    submit(chunk: ReplayChunkInput) {
      if (pending) deny();
      return execute(() => {
        validate(chunk); encode(checkpoint, stateBounds);
        const gs = structuredClone(checkpoint), timing = timingFor(gs, timingSnapshot);
        pending = { chunk: structuredClone(chunk), gs, timing, commands: createReplayCommands({ getState: () => gs, timing }), cursor: 0, ticks: 0 };
        return work();
      });
    },
    resume() { if (!pending) deny(); return execute(work); },
  });
}
