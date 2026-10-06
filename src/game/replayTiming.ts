export const SIMULATION_STEP = 1 / 60;
export const MAX_FRAME_TICKS = 480;

export interface ReplayTimingState {
  paused: boolean;
  gameOver: boolean;
  victory: boolean;
  waveActive: boolean;
  waveIndex: number;
  completedWaves: number;
  lives: number;
  speed?: number;
}

export interface ReplayTimingConfig {
  mode: 'waves' | 'timed' | 'endless';
  waveLimit: number;
  durationSeconds: number;
  speedLimit?: 1 | 2 | 4;
}

export interface ReplayTimingSnapshot {
  version: 1;
  speed: 1 | 2 | 4;
  activeSeconds: number;
  planningSeconds: number;
  clockStarted: boolean;
  hidden: boolean;
  resetNextFrame: boolean;
  backlogSeconds?: number;
}

export type ReplayTimingCommand = { type: 'startWave' | 'pause' | 'resume' | 'speedCycle' }
  | { type: 'visibility'; hidden: boolean };

function deny(): never { throw new Error('REPLAY_TIMING_INVALID'); }
const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
const exact = (value: unknown, keys: string[]): boolean => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) return false;
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && own(descriptor, 'value');
  });
};
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function createReplayTiming<S extends ReplayTimingState>(dependencies: {
  getState: () => S;
  tick: (state: S, dt: number) => void;
  startWave: (state: S) => void;
  canStartNextWave: (state: S) => boolean;
  getNextWaveWait: (state: S) => number;
}, config: ReplayTimingConfig, continuation?: ReplayTimingSnapshot) {
  if (!exact(config, ['mode', 'waveLimit', 'durationSeconds', ...(config && own(config, 'speedLimit') ? ['speedLimit'] : [])]) || !['waves', 'timed', 'endless'].includes(config.mode)
    || (config.speedLimit !== undefined && ![1, 2, 4].includes(config.speedLimit))
    || !Number.isSafeInteger(config.waveLimit) || config.waveLimit <= 0
    || !nonnegative(config.durationSeconds) || config.durationSeconds === 0
    || !dependencies || ['getState', 'tick', 'startWave', 'canStartNextWave', 'getNextWaveWait']
      .some(key => typeof dependencies[key as keyof typeof dependencies] !== 'function')) deny();
  const trusted = { ...config };
  const keys = ['version', 'speed', 'activeSeconds', 'planningSeconds', 'clockStarted', 'hidden', 'resetNextFrame'];
  const initial: ReplayTimingSnapshot = { version: 1, speed: 1, activeSeconds: 0, planningSeconds: 0,
    clockStarted: false, hidden: false, resetNextFrame: true };
  const candidate = continuation === undefined ? initial : continuation;
  if (!exact(candidate, [...keys, ...(candidate && own(candidate, 'backlogSeconds') ? ['backlogSeconds'] : [])]) || candidate.version !== 1 || ![1, 2, 4].includes(candidate.speed)
    || candidate.speed > (trusted.speedLimit ?? 4)
    || (candidate.backlogSeconds !== undefined && !nonnegative(candidate.backlogSeconds))
    || !nonnegative(candidate.activeSeconds) || !nonnegative(candidate.planningSeconds)
    || ['clockStarted', 'hidden', 'resetNextFrame'].some(key => typeof candidate[key as keyof ReplayTimingSnapshot] !== 'boolean')
    || (!candidate.clockStarted && (candidate.activeSeconds !== 0 || candidate.planningSeconds !== 0))
    || (trusted.mode !== 'timed' && candidate.planningSeconds !== 0)
    || (trusted.mode === 'timed' && candidate.activeSeconds > trusted.durationSeconds)) deny();
  const wrapper = { ...candidate, backlogSeconds: candidate.backlogSeconds ?? 0 };
  let failed = false;
  const state = () => {
    if (failed) deny();
    let gs: S;
    try { gs = dependencies.getState(); }
    catch (error) { failed = true; throw error; }
    if (!gs || ['paused', 'gameOver', 'victory', 'waveActive'].some(key => typeof gs[key as keyof S] !== 'boolean')
      || !Number.isSafeInteger(gs.waveIndex) || gs.waveIndex < -1
      || !Number.isSafeInteger(gs.completedWaves) || gs.completedWaves < 0
      || !nonnegative(gs.lives) || (gs.gameOver && gs.victory)
      || (wrapper.hidden && !gs.paused && !gs.gameOver && !gs.victory)
      || (trusted.mode === 'waves' && gs.waveIndex + 1 > trusted.waveLimit)) deny();
    return gs;
  };
  const initialState = state();
  if ('speed' in initialState) initialState.speed = wrapper.speed;
  const terminal = (gs: S) => gs.gameOver || gs.victory;
  const victory = (gs: S, elapsed: number) => gs.lives > 0 && !gs.gameOver
    && (trusted.mode === 'waves' ? gs.completedWaves >= trusted.waveLimit
      : trusted.mode === 'timed' && wrapper.clockStarted && elapsed >= trusted.durationSeconds);
  const blockedWave = (gs: S) => {
    let ready: boolean, wait: number;
    try {
      ready = dependencies.canStartNextWave(gs); wait = dependencies.getNextWaveWait(gs);
      if (typeof ready !== 'boolean' || !nonnegative(wait)) deny();
    } catch (error) { failed = true; throw error; }
    return terminal(gs) || gs.paused || wrapper.hidden
      || (trusted.mode === 'waves' && gs.waveIndex + 1 >= trusted.waveLimit)
      || (trusted.mode === 'timed' && wrapper.activeSeconds >= trusted.durationSeconds) || !ready;
  };
  const invoke = (action: () => void, gs: S) => {
    try { action(); if (state() !== gs) deny(); }
    catch (error) { failed = true; throw error; }
  };
  return Object.freeze({
    snapshot(): ReplayTimingSnapshot { state(); return { ...wrapper }; },
    command(input: ReplayTimingCommand) {
      const descriptor = input && Object.getOwnPropertyDescriptor(input, 'type');
      const kind = descriptor && own(descriptor, 'value') ? descriptor.value : undefined;
      if (!exact(input, kind === 'visibility' ? ['type', 'hidden'] : ['type'])
        || !['startWave', 'pause', 'resume', 'speedCycle', 'visibility'].includes(input.type)) deny();
      const gs = state();
      if (input.type === 'visibility') {
        if (typeof input.hidden !== 'boolean' || input.hidden === wrapper.hidden) deny();
        wrapper.hidden = input.hidden; wrapper.resetNextFrame = true;
        if (input.hidden && !terminal(gs)) gs.paused = true;
        return;
      }
      if (terminal(gs) || wrapper.hidden) deny();
      if (input.type === 'pause' || input.type === 'resume') {
        if (gs.paused !== (input.type === 'resume')) deny();
        gs.paused = input.type === 'pause'; wrapper.resetNextFrame = true; return;
      }
      if (gs.paused) deny();
      if (input.type === 'speedCycle') {
        if (trusted.speedLimit === 1) deny();
        wrapper.speed = wrapper.speed >= (trusted.speedLimit ?? 4) ? 1 : wrapper.speed === 1 ? 2 : 4;
        if ('speed' in gs) gs.speed = wrapper.speed;
        return;
      }
      if (blockedWave(gs)) deny();
      const previous = gs.waveIndex;
      invoke(() => dependencies.startWave(gs), gs);
      if (gs.waveIndex !== previous + 1) { failed = true; deny(); }
      wrapper.clockStarted = true; wrapper.planningSeconds = 0; wrapper.resetNextFrame = true;
    },
    frame(inputDelta: number, trustedMaxTicks = MAX_FRAME_TICKS) {
      if (!nonnegative(inputDelta) || !Number.isSafeInteger(trustedMaxTicks) || trustedMaxTicks < 0 || trustedMaxTicks > MAX_FRAME_TICKS) deny();
      const gs = state();
      const wallDt = wrapper.resetNextFrame ? 0 : inputDelta;
      const running = !gs.paused && !terminal(gs) && !wrapper.hidden;
      wrapper.resetNextFrame = false;
      if (running) wrapper.backlogSeconds += wallDt;
      if (!nonnegative(wrapper.backlogSeconds)) deny();
      let ticks = 0, frameDt = 0, dt = 0, autoStarted = false;
      // Bound foreground work, but retain every unprocessed second for later frames.
      while (running && !terminal(gs) && !gs.paused && ticks < trustedMaxTicks) {
        const wasActive = gs.waveActive;
        const rate = wasActive ? wrapper.speed : 1;
        const remaining = trusted.mode === 'timed' && wrapper.clockStarted
          ? Math.max(0, trusted.durationSeconds - wrapper.activeSeconds) : Infinity;
        if (remaining <= 1e-9) {
          if (victory(gs, trusted.durationSeconds)) { wrapper.activeSeconds = trusted.durationSeconds; gs.victory = true; }
          break;
        }
        const wallStep = Math.min(SIMULATION_STEP / rate, remaining);
        if (wrapper.backlogSeconds + 1e-10 < wallStep) break;
        dt = Math.min(SIMULATION_STEP, wallStep * rate);
        invoke(() => dependencies.tick(gs, dt), gs);
        ticks++;
        wrapper.backlogSeconds = Math.max(0, wrapper.backlogSeconds - wallStep);
        frameDt += wallStep;
        if (wrapper.clockStarted) wrapper.activeSeconds = Math.min(
          trusted.mode === 'timed' ? trusted.durationSeconds : Infinity, wrapper.activeSeconds + wallStep);
        if (victory(gs, wrapper.activeSeconds)) gs.victory = true;
        if (trusted.mode === 'timed' && wrapper.clockStarted && !terminal(gs)) {
          wrapper.planningSeconds = wasActive ? 0 : wrapper.planningSeconds + wallStep;
          if (!gs.waveActive && !blockedWave(gs) && wrapper.planningSeconds + 1e-9 >= 3) {
            const previous = gs.waveIndex;
            invoke(() => dependencies.startWave(gs), gs);
            if (gs.waveIndex !== previous + 1) { failed = true; deny(); }
            wrapper.planningSeconds = 0; autoStarted = true;
          }
        }
      }
      let remaining = trusted.mode === 'timed' && wrapper.clockStarted
        ? Math.max(0, trusted.durationSeconds - wrapper.activeSeconds) : Infinity;
      if (running && !terminal(gs) && !gs.paused && remaining <= 1e-9) {
        wrapper.activeSeconds = trusted.durationSeconds;
        if (victory(gs, trusted.durationSeconds)) gs.victory = true;
        remaining = 0;
      }
      const nextStep = Math.min(SIMULATION_STEP / (gs.waveActive ? wrapper.speed : 1), remaining);
      const budgetExhausted = running && !terminal(gs) && !gs.paused && remaining > 1e-9
        && wrapper.backlogSeconds + 1e-10 >= nextStep;
      return { wallDt, frameDt, dt, steps: ticks, ticks, autoStarted, budgetExhausted };
    },
  });
}
