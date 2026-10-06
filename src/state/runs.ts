// Local prototype ledger only: not server-authoritative or a money ledger.
import { applyDailyReset, applyChallengeReset, todayStr, STD_PER_WAVE, CONTINUE_COST } from './store';
import type { GameState } from './store';

export type RunConfig = {
  mode: 'waves' | 'timed' | 'endless';
  access: 'practice' | 'standard' | 'ranked';
  waveLimit: number;
  durationMinutes: 5 | 10 | 20 | 40;
};
export type RunSession = {
  id: string;
  config: RunConfig;
  startedAt: number;
  debit: 'none' | 'free' | 'paid';
};
export type RunSummary = {
  completedWaves: number;
  victory: boolean;
  uniqueTowerTypes: number;
  noLeakWave: boolean;
};
export type RunLedgerEntry = {
  run: RunSession;
  completedWaves: number;
  victoryCounted: boolean;
  settled: boolean;
  defeated: boolean;
  continuationAuthorized: boolean;
  abandoned?: boolean;
};

export function isCanonicalRun(run: unknown, entry: RunLedgerEntry | undefined): run is RunSession {
  if (!run || typeof run !== 'object' || !entry?.run) return false;
  const r = run as RunSession;
  return typeof r.id === 'string' && /^local-[1-9]\d*$/.test(r.id)
    && isRunConfig(r.config) && isRunConfig(entry.run.config)
    && entry.run.id === r.id && sameConfig(entry.run.config, r.config)
    && Number.isFinite(r.startedAt) && r.startedAt >= 0 && r.startedAt <= 8.64e15
    && entry.run.startedAt === r.startedAt && entry.run.debit === r.debit
    && (r.config.access === 'practice' ? r.debit === 'none' : r.debit === 'free' || r.debit === 'paid')
    && Number.isSafeInteger(entry.completedWaves) && entry.completedWaves >= 0
    && typeof entry.settled === 'boolean' && typeof entry.victoryCounted === 'boolean'
    && typeof entry.defeated === 'boolean' && typeof entry.continuationAuthorized === 'boolean';
}

export function isRunConfig(value: unknown): value is RunConfig {
  if (!value || typeof value !== 'object') return false;
  const c = value as RunConfig;
  return ['waves', 'timed', 'endless'].includes(c.mode)
    && ['practice', 'standard', 'ranked'].includes(c.access)
    && Number.isSafeInteger(c.waveLimit) && c.waveLimit > 0
    && [5, 10, 20, 40].includes(c.durationMinutes);
}

function sameConfig(a: RunConfig, b: RunConfig): boolean {
  return a.mode === b.mode && a.access === b.access && a.waveLimit === b.waveLimit
    && a.durationMinutes === b.durationMinutes;
}

export function admitRun(state: GameState, config: RunConfig, now = Date.now()): { state: GameState; run: RunSession | null } {
  if (!isRunConfig(config) || !Number.isFinite(now) || now < 0 || now > 8.64e15) return { state, run: null };
  if (state.activeRun) {
    const active = state.activeRun;
    const entry = state.runLedger?.[active.id];
    return { state, run: isCanonicalRun(active, entry) && !entry!.abandoned
      && (!entry!.settled || entry!.continuationAuthorized) && sameConfig(entry!.run.config, config) ? entry!.run : null };
  }
  const practice = config.access === 'practice';
  const next = practice ? state : applyDailyReset(state, now);
  const debit = practice ? 'none' : next.dailyFreeLeft > 0 ? 'free' : next.paidRuns > 0 ? 'paid' : null;
  if (!debit) return { state: next, run: null };
  const sequence = (next.runSequence ?? 0) + 1;
  if (!Number.isSafeInteger(sequence)) return { state: next, run: null };
  const run: RunSession = { id: `local-${sequence}`, config: { ...config }, startedAt: now, debit };
  if (next.runLedger?.[run.id]) return { state: next, run: null };
  return { run, state: {
    ...next, runSequence: sequence, activeRun: run,
    dailyFreeLeft: next.dailyFreeLeft - (debit === 'free' ? 1 : 0),
    paidRuns: next.paidRuns - (debit === 'paid' ? 1 : 0),
    totalRuns: next.totalRuns + (practice ? 0 : 1),
    lastPlayed: practice ? next.lastPlayed : now,
    // A new engine supersedes prior sessions; retain only its recoverable ledger entry.
    runLedger: { [run.id]: { run, completedWaves: 0, victoryCounted: false, settled: false, defeated: false, continuationAuthorized: false } },
  } };
}

export function continueRun(state: GameState, run: RunSession, now = Date.now()): { state: GameState; run: RunSession | null } {
  const entry = run && state.runLedger?.[run.id];
  if (!isCanonicalRun(run, entry) || !entry || entry.abandoned
    || !Number.isFinite(now) || now < run.startedAt || now > 8.64e15
    || entry.run.config.access === 'ranked' || !entry.defeated) return { state, run: null };
  if (state.activeRun) return { state, run: state.activeRun.id === run.id && entry.continuationAuthorized ? entry.run : null };
  if (!entry.settled) return { state, run: null };
  const cost = entry.run.config.access === 'practice' ? 0 : CONTINUE_COST;
  if (!Number.isFinite(state.tokens) || state.tokens < cost) return { state, run: null };
  return { run: entry.run, state: { ...state, tokens: state.tokens - cost, activeRun: entry.run,
    runLedger: { ...state.runLedger, [run.id]: { ...entry, continuationAuthorized: true } } } };
}

export function abandonRun(state: GameState, run: RunSession): GameState {
  const entry = run && state.runLedger?.[run.id];
  if (!isCanonicalRun(run, entry) || !entry || entry.abandoned || state.activeRun?.id !== run.id) return state;
  return { ...state, activeRun: null, runLedger: { ...state.runLedger,
    [run.id]: { ...entry, settled: true, defeated: false, abandoned: true, continuationAuthorized: false } } };
}

export function settleRun(state: GameState, run: RunSession, summary: RunSummary, now = Date.now()): GameState {
  const entry = run && state.runLedger?.[run.id];
  if (!isCanonicalRun(run, entry) || !entry || entry.abandoned
    || !summary || !Number.isSafeInteger(summary.completedWaves) || summary.completedWaves < 0
    || !Number.isSafeInteger(summary.uniqueTowerTypes) || summary.uniqueTowerTypes < 0
    || typeof summary.victory !== 'boolean' || typeof summary.noLeakWave !== 'boolean'
    || !Number.isFinite(now) || now < run.startedAt || now > 8.64e15) return state;
  const config = entry.run.config;
  if (config.mode === 'waves' && summary.completedWaves > config.waveLimit) return state;
  if (state.activeRun?.id !== run.id || (entry.settled && !entry.continuationAuthorized)) return state;
  if (summary.completedWaves < entry.completedWaves) return state;
  const completed = summary.completedWaves;
  const victory = summary.victory && completed > 0
    && (config.mode !== 'waves' || completed === config.waveLimit);
  const updated: RunLedgerEntry = { ...entry, settled: true, defeated: !summary.victory, continuationAuthorized: false, completedWaves: completed,
    victoryCounted: entry.victoryCounted || victory };
  const base = { ...state, activeRun: state.activeRun?.id === run.id ? null : state.activeRun,
    runLedger: { ...state.runLedger, [run.id]: updated } };
  if (config.access === 'practice') return base;
  const settlementDate = todayStr(now);
  const currentChallenges = !base.challengesResetDate || base.challengesResetDate <= settlementDate;
  const next = currentChallenges ? applyChallengeReset(base, now) : base;
  const progress = { ...next.challengeProgress };
  if (victory && !entry.victoryCounted) progress.win_3 = Math.min(3, (progress.win_3 ?? 0) + 1);
  progress.use_4 = Math.min(4, Math.max(progress.use_4 ?? 0, summary.uniqueTowerTypes));
  if (completed > entry.completedWaves && summary.noLeakWave) progress.no_leak = 1;
  const scores = next.localScores.filter(score => score.runId !== run.id);
  if (completed > 0) scores.push({ runId: run.id, wave: completed, ts: run.startedAt });
  return { ...next, tokens: next.tokens + (completed - entry.completedWaves) * STD_PER_WAVE,
    bestWave: Math.max(next.bestWave, completed), challengeProgress: currentChallenges ? progress : next.challengeProgress,
    localScores: scores.sort((a, b) => b.wave - a.wave).slice(0, 20) };
}
