// Local prototype ledger only: not server-authoritative or a money ledger.
import { applyDailyReset, applyChallengeReset, todayStr, STD_PER_WAVE, CONTINUE_LIVES, STD_PER_LIFE, MAX_STANDARD_CONTINUES } from './store';
import type { GameState } from './store';
import { createInitialRunCheckpoint, CHECKPOINT_ENGINE_VERSION, validateRunCheckpoint } from './checkpoints';
export { getRecoverableCheckpoint, persistBattleCheckpoint } from './store';
export { CONTINUE_LIVES, MAX_STANDARD_CONTINUES } from './store';
export const LOCAL_RANKED_RULES_VERSION = 'local-ranked-v1';
export const LOCAL_RANKED_SPEED = 1 as const;

export function localRankedSeed(config: RunConfig, now = Date.now()): number {
  const period = todayStr(now).slice(0, 7);
  const rules = `${period}|${LOCAL_RANKED_RULES_VERSION}|${CHECKPOINT_ENGINE_VERSION}|${config.mode}|`
    + (config.mode === 'waves' ? config.waveLimit : config.mode === 'timed' ? config.durationMinutes : 'endless');
  let value = 0x811c9dc5;
  for (let i = 0; i < rules.length; i++) value = Math.imul(value ^ rules.charCodeAt(i), 0x01000193) >>> 0;
  return value;
}

export type RunConfig = {
  mode: 'waves' | 'timed' | 'endless';
  access: 'practice' | 'standard' | 'ranked';
  waveLimit: number;
  durationMinutes: 5 | 10 | 20 | 40;
  speed?: 1 | 2 | 4;
};
export type RunSession = {
  id: string;
  config: RunConfig;
  startedAt: number;
  debit: 'none' | 'free' | 'paid';
  commerceAccount?: string;
  seed?: number;
  speed?: 1 | 2 | 4;
  engineVersion?: string;
  rulesVersion?: string;
  period?: string;
};
export type RunSummary = {
  completedWaves: number;
  victory: boolean;
  uniqueTowerTypes: number;
  noLeakWave: boolean;
  speed?: 1 | 2 | 4;
};
export type RunLedgerEntry = {
  run: RunSession;
  completedWaves: number;
  victoryCounted: boolean;
  settled: boolean;
  defeated: boolean;
  continuationAuthorized: boolean;
  abandoned?: boolean;
  continuedCount?: number;
};

export function runOwnedByState(state: GameState, run: RunSession): boolean {
  return (run.commerceAccount || 'guest') === (state.commerceAccount || 'guest');
}

export function continuedCount(state: GameState, run: RunSession | null = state.activeRun): number {
  const entry = run ? state.runLedger?.[run.id] : undefined;
  return entry?.continuedCount ?? (entry?.continuationAuthorized ? 1 : 0);
}
export const continueCount = continuedCount;

export function continuePrice(state: GameState, run?: RunSession | null): number {
  const session = run ?? state.activeRun ?? (state.battleCheckpoint ? state.runLedger?.[state.battleCheckpoint.runId]?.run : null);
  if (session && state.activeRun?.id === session.id && state.runLedger?.[session.id]?.continuationAuthorized
    && runOwnedByState(state, session)) return 0;
  if (session?.config.access === 'practice') return 0;
  if (session?.config.access === 'ranked' || (session && continuedCount(state, session) >= MAX_STANDARD_CONTINUES)) return Infinity;
  const credit = Number.isSafeInteger(state.lives) && state.lives >= 0 ? Math.min(CONTINUE_LIVES, state.lives) : 0;
  return (CONTINUE_LIVES - credit) * STD_PER_LIFE;
}

export function canContinueRun(state: GameState, run: RunSession): boolean {
  const entry = state.runLedger?.[run.id];
  return isCanonicalRun(run, entry) && runOwnedByState(state, run) && !!entry && !entry.abandoned
    && entry.defeated && entry.run.config.access !== 'ranked'
    && validateRunCheckpoint(state.battleCheckpoint, entry.run)
    && (entry.continuationAuthorized && state.activeRun?.id === run.id || (entry.settled && !state.activeRun
      && Number.isSafeInteger(state.tokens) && state.tokens >= continuePrice(state, run)));
}

export function isCanonicalRun(run: unknown, entry: RunLedgerEntry | undefined): run is RunSession {
  if (!run || typeof run !== 'object' || !entry?.run) return false;
  const r = run as RunSession;
  return typeof r.id === 'string' && /^local-[1-9]\d*$/.test(r.id)
    && r.id.length <= 32 && Number.isSafeInteger(Number(r.id.slice(6)))
    && isRunConfig(r.config) && isRunConfig(entry.run.config)
    && entry.run.id === r.id && sameConfig(entry.run.config, r.config)
    && Number.isFinite(r.startedAt) && r.startedAt >= 0 && r.startedAt <= 8.64e15
    && entry.run.startedAt === r.startedAt && entry.run.debit === r.debit
    && (r.commerceAccount === undefined || typeof r.commerceAccount === 'string' && r.commerceAccount.length <= 512)
    && r.commerceAccount === entry.run.commerceAccount
    && (r.seed === undefined || Number.isInteger(r.seed) && r.seed >= 0 && r.seed <= 0xffffffff)
    && r.seed === entry.run.seed
    && (r.speed === undefined || [1, 2, 4].includes(r.speed)) && r.speed === entry.run.speed
    && (r.engineVersion === undefined || typeof r.engineVersion === 'string' && r.engineVersion.length <= 128)
    && r.engineVersion === entry.run.engineVersion
    && (r.rulesVersion === undefined || typeof r.rulesVersion === 'string' && r.rulesVersion.length <= 128)
    && r.rulesVersion === entry.run.rulesVersion
    && (r.period === undefined || typeof r.period === 'string' && /^\d{4}-\d{2}$/.test(r.period))
    && r.period === entry.run.period
    && (r.config.access === 'practice' ? r.debit === 'none' : r.debit === 'free' || r.debit === 'paid')
    && Number.isSafeInteger(entry.completedWaves) && entry.completedWaves >= 0 && entry.completedWaves <= 1000000
    && typeof entry.settled === 'boolean' && typeof entry.victoryCounted === 'boolean'
    && typeof entry.defeated === 'boolean' && typeof entry.continuationAuthorized === 'boolean'
    && (entry.continuedCount === undefined || Number.isSafeInteger(entry.continuedCount) && entry.continuedCount >= 0
      && (r.config.access === 'practice' || entry.continuedCount <= MAX_STANDARD_CONTINUES));
}

export function isRunConfig(value: unknown): value is RunConfig {
  if (!value || typeof value !== 'object') return false;
  const c = value as RunConfig;
  return ['waves', 'timed', 'endless'].includes(c.mode)
    && ['practice', 'standard', 'ranked'].includes(c.access)
    && Number.isSafeInteger(c.waveLimit) && c.waveLimit > 0 && c.waveLimit <= 1000000
    && [5, 10, 20, 40].includes(c.durationMinutes)
    && (c.speed === undefined || [1, 2, 4].includes(c.speed));
}

function sameConfig(a: RunConfig, b: RunConfig): boolean {
  return a.mode === b.mode && a.access === b.access && a.waveLimit === b.waveLimit
    && a.durationMinutes === b.durationMinutes && (a.speed ?? 1) === (b.speed ?? 1);
}

export function admitRun(state: GameState, config: RunConfig, now = Date.now()): { state: GameState; run: RunSession | null } {
  if (!isRunConfig(config) || !Number.isFinite(now) || now < 0 || now > 8.64e15) return { state, run: null };
  if (config.access === 'ranked') config = { ...config, speed: LOCAL_RANKED_SPEED };
  if (state.activeRun) {
    const active = state.activeRun;
    const entry = state.runLedger?.[active.id];
    return { state, run: isCanonicalRun(active, entry) && runOwnedByState(state, active) && !entry!.abandoned
      && (!entry!.settled || entry!.continuationAuthorized) && sameConfig(entry!.run.config, config) ? entry!.run : null };
  }
  const practice = config.access === 'practice';
  const next = practice ? state : applyDailyReset(state, now);
  const debit = practice ? 'none' : next.dailyFreeLeft > 0 ? 'free' : next.paidRuns > 0 ? 'paid' : null;
  if (!debit) return { state: next, run: null };
  const sequence = (next.runSequence ?? 0) + 1;
  if (!Number.isSafeInteger(sequence)) return { state: next, run: null };
  const run: RunSession = { id: `local-${sequence}`, config: { ...config }, startedAt: now, debit,
    commerceAccount: next.commerceAccount || 'guest', seed: config.access === 'ranked' ? localRankedSeed(config, now)
      : globalThis.crypto.getRandomValues(new Uint32Array(1))[0],
    speed: config.speed ?? 1, engineVersion: CHECKPOINT_ENGINE_VERSION,
    ...(config.access === 'ranked' ? { rulesVersion: LOCAL_RANKED_RULES_VERSION, period: todayStr(now).slice(0, 7) } : {}) };
  if (next.runLedger?.[run.id]) return { state: next, run: null };
  const battleCheckpoint = createInitialRunCheckpoint(run, now);
  return { run, state: {
    ...next, runSequence: sequence, activeRun: run, battleCheckpoint,
    dailyFreeLeft: next.dailyFreeLeft - (debit === 'free' ? 1 : 0),
    paidRuns: next.paidRuns - (debit === 'paid' ? 1 : 0),
    totalRuns: next.totalRuns + (practice ? 0 : 1),
    lastPlayed: practice ? next.lastPlayed : now,
    // A new engine supersedes prior sessions; retain only its recoverable ledger entry.
    runLedger: { [run.id]: { run, completedWaves: 0, victoryCounted: false, settled: false, defeated: false, continuationAuthorized: false, continuedCount: 0 } },
  } };
}

export function continueRun(state: GameState, run: RunSession, now = Date.now()): { state: GameState; run: RunSession | null } {
  const entry = run && state.runLedger?.[run.id];
  if (!isCanonicalRun(run, entry) || !entry || entry.abandoned
    || !runOwnedByState(state, run) || !Number.isFinite(now) || now < 0 || now > 8.64e15
    || entry.run.config.access === 'ranked' || !entry.defeated) return { state, run: null };
  if (state.activeRun) return { state, run: state.activeRun.id === run.id && entry.continuationAuthorized ? entry.run : null };
  if (!entry.settled) return { state, run: null };
  const cost = continuePrice(state, run);
  if (!Number.isSafeInteger(state.tokens) || state.tokens < cost
    || !Number.isSafeInteger(state.lives) || state.lives < 0) return { state, run: null };
  if (!validateRunCheckpoint(state.battleCheckpoint, entry.run)) return { state, run: null };
  const checkpoint = structuredClone(state.battleCheckpoint);
  checkpoint.battle.lives = CONTINUE_LIVES;
  checkpoint.battle.gameOver = false;
  checkpoint.battle.victory = false;
  checkpoint.battle.paused = true;
  const practice = entry.run.config.access === 'practice';
  const credit = practice ? 0 : Math.min(CONTINUE_LIVES, Math.max(0, state.lives));
  return { run: entry.run, state: { ...state, tokens: state.tokens - cost, lives: state.lives - credit,
    battleCheckpoint: checkpoint, activeRun: entry.run,
    runLedger: { ...state.runLedger, [run.id]: { ...entry, continuationAuthorized: true,
      continuedCount: continuedCount(state, run) + 1 } } } };
}

export function abandonRun(state: GameState, run: RunSession): GameState {
  const entry = run && state.runLedger?.[run.id];
  if (!isCanonicalRun(run, entry) || !runOwnedByState(state, run) || !entry || entry.abandoned
    || (state.activeRun?.id !== run.id && !(entry.settled && state.battleCheckpoint?.runId === run.id))) return state;
  return { ...state, activeRun: null, battleCheckpoint: null, runLedger: { ...state.runLedger,
    [run.id]: { ...entry, settled: true, defeated: false, abandoned: true, continuationAuthorized: false } } };
}

export function settleRun(state: GameState, run: RunSession, summary: RunSummary, now = Date.now()): GameState {
  const entry = run && state.runLedger?.[run.id];
  if (!isCanonicalRun(run, entry) || !entry || entry.abandoned
    || !runOwnedByState(state, run)
    || !summary || !Number.isSafeInteger(summary.completedWaves) || summary.completedWaves < 0 || summary.completedWaves > 1000000
    || !Number.isSafeInteger(summary.uniqueTowerTypes) || summary.uniqueTowerTypes < 0 || summary.uniqueTowerTypes > 12
    || typeof summary.victory !== 'boolean' || typeof summary.noLeakWave !== 'boolean'
    || (summary.speed !== undefined && ![1, 2, 4].includes(summary.speed))
    || !Number.isFinite(now) || now < 0 || now > 8.64e15) return state;
  const config = entry.run.config;
  if (config.access === 'ranked' && run.rulesVersion === LOCAL_RANKED_RULES_VERSION
    && (summary.speed ?? state.battleCheckpoint?.speed ?? run.speed) !== LOCAL_RANKED_SPEED) return state;
  if (config.mode === 'waves' && summary.completedWaves > config.waveLimit) return state;
  if (state.activeRun?.id !== run.id || (entry.settled && !entry.continuationAuthorized)) return state;
  if (summary.completedWaves < entry.completedWaves) return state;
  const completed = summary.completedWaves;
  const victory = summary.victory && completed > 0
    && (config.mode !== 'waves' || completed === config.waveLimit);
  const updated: RunLedgerEntry = { ...entry, settled: true, defeated: !summary.victory, continuationAuthorized: false, completedWaves: completed,
    victoryCounted: entry.victoryCounted || victory };
  const base = { ...state, activeRun: state.activeRun?.id === run.id ? null : state.activeRun,
    battleCheckpoint: state.battleCheckpoint,
    runLedger: { ...state.runLedger, [run.id]: updated } };
  if (config.access === 'practice') return base;
  const settlementDate = todayStr(now);
  const currentChallenges = !base.challengesResetDate || base.challengesResetDate <= settlementDate;
  const next = currentChallenges ? applyChallengeReset(base, now) : base;
  const progress = { ...next.challengeProgress };
  if (victory && !entry.victoryCounted) progress.win_3 = Math.min(3, (progress.win_3 ?? 0) + 1);
  progress.use_4 = Math.min(4, Math.max(progress.use_4 ?? 0, summary.uniqueTowerTypes));
  if (completed > entry.completedWaves && summary.noLeakWave) progress.no_leak = 1;
  const speed = summary.speed ?? state.battleCheckpoint?.speed ?? run.speed ?? 1;
  const count = continuedCount(state, run);
  const partition = [config.access, config.mode, config.mode === 'waves' ? config.waveLimit : config.mode === 'timed'
    ? config.durationMinutes : 'unbounded', speed, count, run.engineVersion ?? 'legacy',
    run.rulesVersion ?? 'local-standard', run.period ?? 'unperiodized'].join(':');
  const scores = (Array.isArray(next.localScores) ? next.localScores : []).filter(score => score && score.runId !== run.id);
  if (completed > 0) scores.push({ runId: run.id, wave: completed, ts: run.startedAt, config: { ...config },
    speed, seed: run.seed, engineVersion: run.engineVersion ?? 'legacy', continuedCount: count,
    accountScope: run.commerceAccount || 'guest', partition, verified: false,
    ...(run.rulesVersion ? { rulesVersion: run.rulesVersion, period: run.period } : {}) });
  const buckets = new Map<string, number>();
  const localScores = scores.sort((a, b) => b.wave - a.wave).filter(score => {
    const key = `${score.accountScope ?? ''}|${score.partition ?? 'legacy-unclassified'}`;
    const size = (buckets.get(key) ?? 0) + 1;
    buckets.set(key, size);
    return size <= 20;
  }).slice(0, 1000);
  const tokens = next.tokens + (completed - entry.completedWaves) * STD_PER_WAVE;
  if (!Number.isSafeInteger(tokens) || tokens < 0) return state;
  return { ...next, tokens,
    bestWave: Math.max(next.bestWave, completed), challengeProgress: currentChallenges ? progress : next.challengeProgress,
    localScores };
}
