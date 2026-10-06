// Global game state + helpers. Stored in localStorage.
import type { RunSession, RunLedgerEntry } from './runs';
import { isCanonicalRun, isRunConfig, runOwnedByState } from './runs';
import { validateRunCheckpoint } from './checkpoints';
import type { RunCheckpoint } from './checkpoints';
import { generateReferralCode } from './referrals';
export const LS_KEY = 'seekdef_v1';
export const LS_BACKUP_KEY = `${LS_KEY}:backup`;
export const LS_RECOVERY_KEY = `${LS_KEY}:recovery-raw`;
export const STATE_VERSION = 2;
export const STARTER_STD = 100;

export type CommerceAccountProfile = {
  tokens: number; paidRuns: number; commerceReceiptIds?: string[];
  paymentReceiptIds?: string[]; paymentSignatures?: string[];
  commerceQuoteIds?: string[]; commerceSignatures?: string[];
  lives?: number; unlockedSkins?: string[]; equippedSkins?: Record<TowerFamily, string>;
  streak?: number; lastBonusClaim?: number | null; loginClaimedToday?: boolean;
  challengeProgress?: Record<string, number>; challengeClaimed?: Record<string, boolean>;
  challengesResetDate?: string | null; challengesDone?: boolean[];
};
export type LocalScore = {
  wave: number; ts: number; runId?: string; config?: RunSession['config'];
  speed?: 1 | 2 | 4; seed?: number; engineVersion?: string; continuedCount?: number;
  accountScope?: string; partition?: string; verified?: false;
  rulesVersion?: string; period?: string;
};

// ── Tower families (4 upgrade lineages) ───────────────────────────────────
export type TowerFamily = 'canon' | 'laser' | 'mortar' | 'glue';

// Maps every real towerId → its family
export const TOWER_FAMILY: Record<string, TowerFamily> = {
  canon: 'canon', dualCanon: 'canon', machineGun: 'canon',
  simpleLaser: 'laser', bouncingLaser: 'laser', straightLaser: 'laser',
  mortar: 'mortar', mineLayer: 'mortar', rocketLauncher: 'mortar',
  glueTower: 'glue', glueGun: 'glue', teleporter: 'glue',
};

export interface GameState {
  schemaVersion?: number;
  battleCheckpoint?: RunCheckpoint | null;
  tokens: number;
  lives: number;
  dailyFreeLeft: number;
  dailyFreeMax: number;
  paidRuns: number;
  commerceAccount?: string;
  commerceReceiptIds?: string[];
  paymentReceiptIds?: string[];
  paymentSignatures?: string[];
  commerceQuoteIds?: string[];
  commerceSignatures?: string[];
  commerceAccounts?: Record<string, CommerceAccountProfile>;
  runSequence: number;
  activeRun: RunSession | null;
  runLedger: Record<string, RunLedgerEntry>;
  sol: number;
  streak: number;
  walletConnected: boolean;
  walletAddr: string;
  skinsEnabled: boolean;
  dark: boolean;
  prizePool: number;
  monthlyRank: number;
  equippedSkins: Record<TowerFamily, string>;
  unlockedSkins: string[];
  loginClaimedToday: boolean;
  challengesDone: boolean[];
  lastPlayed: number | null;
  // off-chain economy fields
  bestWave: number;
  totalRuns: number;
  totalEnemiesKilled: number;
  lastBonusClaim: number | null;
  lastRunReset: string | null;
  localScores: LocalScore[];
  // social layer fields
  referralCode: string | null;
  referredBy: string | null;
  referralsCount: number;
  challengeProgress: Record<string, number>;
  challengeClaimed: Record<string, boolean>;
  challengesResetDate: string | null;
  soundEnabled: boolean;
}

export const DEFAULT_STATE: GameState = {
  schemaVersion: STATE_VERSION,
  battleCheckpoint: null,
  tokens: STARTER_STD,
  lives: 0,
  dailyFreeLeft: 3,
  dailyFreeMax: 3,
  paidRuns: 0,
  commerceAccount: 'guest',
  runSequence: 0,
  activeRun: null,
  runLedger: {},
  sol: 0,
  streak: 0,
  walletConnected: false,
  walletAddr: '',
  skinsEnabled: true,
  dark: false,
  prizePool: 0,
  monthlyRank: 0,
  equippedSkins: { canon: 'canon-default', laser: 'laser-default', mortar: 'mortar-default', glue: 'glue-default' },
  unlockedSkins: [],
  loginClaimedToday: false,
  challengesDone: [false, false, false],
  lastPlayed: null,
  bestWave: 0,
  totalRuns: 0,
  totalEnemiesKilled: 0,
  lastBonusClaim: null,
  lastRunReset: null,
  localScores: [],
  // social layer defaults
  referralCode: null,
  referredBy: null,
  referralsCount: 0,
  challengeProgress: {},
  challengeClaimed: {},
  challengesResetDate: null,
  soundEnabled: true,
};

// ── Economy constants ──────────────────────────────────────────────────────
export const BONUS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const DAILY_BONUS_AMOUNT = 50;
export const CONTINUE_COST = 50;
export const CONTINUE_LIVES = 10;
export const STD_PER_LIFE = 5;
export const MAX_STANDARD_CONTINUES = 1;
export const DAILY_BONUS_SCHEDULE = [50, 60, 70, 90, 120, 150, 240] as const;
export const STD_PER_WAVE = 5;

// ── Helper: today's date string (local, YYYY-MM-DD) ────────────────────────
export function todayStr(now = Date.now()): string {
  if (!Number.isFinite(now) || now < 0 || now > 8.64e15) throw new RangeError('INVALID_CALENDAR_TIME');
  return new Date(now).toISOString().slice(0, 10);
}

export function migrateRunState(s: GameState): GameState {
  const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
  const max = count(s.dailyFreeMax);
  const left = count(s.dailyFreeLeft);
  const paid = s.paidRuns === undefined ? Math.max(0, left - max) : count(s.paidRuns);
  const ledger = s.runLedger && typeof s.runLedger === 'object' && !Array.isArray(s.runLedger) ? s.runLedger : {};
  const active = s.activeRun;
  const entry = active && ledger[active.id];
  const validActive = isCanonicalRun(active, entry || undefined) && !entry!.abandoned
    && (!entry!.settled || entry!.continuationAuthorized);
  const runLedger = validActive ? ledger : Object.fromEntries(Object.entries(ledger).map(([id, record]) =>
    [id, record && (!record.settled || record.continuationAuthorized)
      ? { ...record, settled: true, defeated: false, continuationAuthorized: false, abandoned: true } : record]));
  const sequence = Object.keys(ledger).reduce((highest, id) => Math.max(highest,
    /^local-[1-9]\d*$/.test(id) ? count(Number(id.slice(6))) : 0), count(s.runSequence));
  return { ...s, dailyFreeMax: max, dailyFreeLeft: Math.min(left, max), paidRuns: paid,
    runSequence: sequence, activeRun: validActive ? active : null, runLedger };
}

// ── Reset free runs if it's a new day ────────────────────────────────────
export function applyDailyReset(s: GameState, now = Date.now()): GameState {
  const next = migrateRunState(s);
  const date = todayStr(now);
  if (next.lastRunReset && next.lastRunReset >= date) return next;
  return { ...next, dailyFreeLeft: next.dailyFreeMax, lastRunReset: date,
    loginClaimedToday: next.lastBonusClaim != null && todayStr(next.lastBonusClaim) === date };
}

// ── Can user claim daily bonus? ───────────────────────────────────────────
export function canClaimBonus(s: GameState, now = Date.now()): boolean {
  return s.lastBonusClaim == null || todayStr(s.lastBonusClaim) < todayStr(now);
}

export function getDailyBonusDisplay(s: GameState, now = Date.now()): { day: number; amount: number; canClaim: boolean } {
  const today = todayStr(now);
  const previous = s.lastBonusClaim == null ? null : todayStr(s.lastBonusClaim);
  const yesterday = now >= BONUS_COOLDOWN_MS ? todayStr(now - BONUS_COOLDOWN_MS) : null;
  const day = previous === today ? ((Math.max(1, s.streak) - 1) % 7) + 1
    : previous != null && previous === yesterday ? (s.streak % 7) + 1 : 1;
  return { day, amount: DAILY_BONUS_SCHEDULE[day - 1], canClaim: previous == null || previous < today };
}

export function claimDailyBonus(s: GameState, now = Date.now()): GameState {
  const display = getDailyBonusDisplay(s, now);
  if (!display.canClaim || !Number.isSafeInteger(s.tokens) || s.tokens < 0
    || !Number.isSafeInteger(s.tokens + display.amount)) return s;
  const consecutive = s.lastBonusClaim != null && now >= BONUS_COOLDOWN_MS
    && todayStr(s.lastBonusClaim) === todayStr(now - BONUS_COOLDOWN_MS);
  const streak = consecutive ? s.streak + 1 : 1;
  if (!Number.isSafeInteger(streak) || streak < 1) return s;
  return { ...s, tokens: s.tokens + display.amount, streak,
    lastBonusClaim: now, loginClaimedToday: true };
}

export function claimChallengeReward(s: GameState, id: string, now = Date.now()): GameState {
  const challenge = CHALLENGES.find(c => c.id === id);
  if (!challenge || s.challengesResetDate !== todayStr(now) || s.challengeClaimed?.[id]
    || !Number.isFinite(s.challengeProgress?.[id]) || s.challengeProgress[id] < challenge.goal
    || !Number.isSafeInteger(s.tokens) || s.tokens < 0 || !Number.isSafeInteger(s.tokens + challenge.reward)) return s;
  return { ...s, tokens: s.tokens + challenge.reward, challengeClaimed: { ...s.challengeClaimed, [id]: true } };
}

// ── Referral helpers ──────────────────────────────────────────────────────
export const REFERRAL_BONUS = 100;

/** 6-char [A-Z0-9] code. Deterministic from seed (walletAddr) if provided. */
export function genReferralCode(seed?: string): string {
  return generateReferralCode(seed);
}

/** Ensure player has a referral code; returns updated state. */
export function ensureReferralCode(s: GameState): GameState {
  if (s.referralCode) return s;
  return { ...s, referralCode: genReferralCode(s.walletConnected ? s.walletAddr || undefined : undefined) };
}

// ── Challenge helpers ─────────────────────────────────────────────────────

/** Reset daily challenge progress if it's a new day. */
export function applyChallengeReset(s: GameState, now = Date.now()): GameState {
  if (s.challengesResetDate && s.challengesResetDate >= todayStr(now)) return s;
  return {
    ...s,
    challengeProgress: {},
    challengeClaimed: {},
    challengesResetDate: todayStr(now),
  };
}

export class StorageRecoveryError extends Error {
  constructor(public readonly code: 'STORAGE_UNREADABLE' | 'STORAGE_WRITE_UNCERTAIN' | 'SAVE_CORRUPT' | 'CHECKPOINT_RECOVERY_REQUIRED',
    message: string, public readonly raw?: string) {
    super(message);
    this.name = 'StorageRecoveryError';
  }
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'
  && Object.getPrototypeOf(v) === Object.prototype;
const safeCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const timestamp = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 8.64e15;
const safeKey = (k: string) => k.length > 0 && k.length <= 512 && !['__proto__', 'constructor', 'prototype'].includes(k);
const dateString = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const stringList = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 100000
  && v.every(s => typeof s === 'string' && s.length > 0 && s.length <= 512);
function corrupt(field: string): never {
  throw new StorageRecoveryError('SAVE_CORRUPT',
    `Cannot safely recover ${field}; original save retained. No balances or inventory were reset.`);
}

function numericMap(v: unknown, boolean = false): Record<string, number> | Record<string, boolean> {
  if (!object(v)) return {};
  return Object.fromEntries(Object.entries(v).slice(0, 256).filter(([k, n]) => safeKey(k)
    && (boolean ? typeof n === 'boolean' : safeCount(n)))) as Record<string, number> | Record<string, boolean>;
}

function equipment(v: unknown): Record<TowerFamily, string> {
  if (!object(v)) return corrupt('equippedSkins');
  const out = { ...DEFAULT_STATE.equippedSkins };
  for (const family of Object.keys(out) as TowerFamily[]) {
    if (v[family] === undefined) continue;
    if (typeof v[family] !== 'string' || (v[family] as string).length > 512) return corrupt('equippedSkins');
    out[family] = v[family] as string;
  }
  return out;
}

function profileFields(p: Record<string, unknown>): Partial<CommerceAccountProfile> {
  const result: Partial<CommerceAccountProfile> = {};
  for (const key of ['lives', 'streak'] as const) {
    if (p[key] !== undefined) { if (!safeCount(p[key])) corrupt(key); result[key] = p[key]; }
  }
  if (p.unlockedSkins !== undefined) {
    if (!stringList(p.unlockedSkins)) corrupt('unlockedSkins');
    result.unlockedSkins = [...p.unlockedSkins];
  }
  if (p.equippedSkins !== undefined) result.equippedSkins = equipment(p.equippedSkins);
  if (p.lastBonusClaim !== undefined) {
    if (p.lastBonusClaim !== null && !timestamp(p.lastBonusClaim)) corrupt('lastBonusClaim');
    result.lastBonusClaim = p.lastBonusClaim;
  }
  if (p.loginClaimedToday !== undefined) {
    if (typeof p.loginClaimedToday !== 'boolean') corrupt('loginClaimedToday');
    result.loginClaimedToday = p.loginClaimedToday;
  }
  if (p.challengeProgress !== undefined) result.challengeProgress = numericMap(p.challengeProgress) as Record<string, number>;
  if (p.challengeClaimed !== undefined) {
    if (!object(p.challengeClaimed) || Object.values(p.challengeClaimed).some(v => typeof v !== 'boolean')) corrupt('challengeClaimed');
    result.challengeClaimed = numericMap(p.challengeClaimed, true) as Record<string, boolean>;
  }
  if (p.challengesResetDate !== undefined) {
    if (p.challengesResetDate !== null && !dateString(p.challengesResetDate)) corrupt('challengesResetDate');
    result.challengesResetDate = p.challengesResetDate;
  }
  if (p.challengesDone !== undefined) {
    if (!Array.isArray(p.challengesDone) || p.challengesDone.length > 3
      || p.challengesDone.some(v => typeof v !== 'boolean')) corrupt('challengesDone');
    result.challengesDone = [...p.challengesDone];
  }
  return result;
}

export function sanitizeState(value: unknown, recovery: { allowMissingCheckpoint?: boolean } = {}): GameState {
  if (!object(value) || !safeCount(value.tokens)) return corrupt('profile/tokens');
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1 && value.schemaVersion !== STATE_VERSION) corrupt('schemaVersion');
  const s = structuredClone(DEFAULT_STATE);
  s.schemaVersion = STATE_VERSION;
  s.tokens = value.tokens;
  for (const k of ['paidRuns', 'dailyFreeLeft', 'dailyFreeMax', 'runSequence', 'bestWave', 'totalRuns',
    'totalEnemiesKilled', 'monthlyRank', 'referralsCount'] as const) {
    if (value[k] !== undefined) { if (!safeCount(value[k])) corrupt(k); s[k] = value[k]; }
  }
  Object.assign(s, profileFields(value));
  for (const k of ['sol', 'prizePool'] as const) {
    if (value[k] !== undefined) {
      if (typeof value[k] !== 'number' || !Number.isFinite(value[k]) || value[k] < 0 || value[k] > Number.MAX_SAFE_INTEGER) corrupt(k);
      s[k] = value[k];
    }
  }
  for (const k of ['walletConnected', 'skinsEnabled', 'dark', 'soundEnabled'] as const) {
    if (typeof value[k] === 'boolean') s[k] = value[k];
  }
  for (const k of ['walletAddr', 'commerceAccount'] as const) {
    if (value[k] !== undefined) {
      if (typeof value[k] !== 'string' || value[k].length > 512) corrupt(k);
      s[k] = value[k];
    }
  }
  for (const k of ['referralCode', 'referredBy'] as const) {
    if (value[k] !== undefined && value[k] !== null) {
      if (typeof value[k] !== 'string' || value[k].length > 512) corrupt(k);
      s[k] = value[k];
    }
  }
  for (const k of ['lastPlayed', 'lastBonusClaim'] as const) {
    if (value[k] !== undefined && value[k] !== null) {
      if (!timestamp(value[k])) corrupt(k); s[k] = value[k];
    }
  }
  if (value.lastRunReset !== undefined && value.lastRunReset !== null) {
    if (!dateString(value.lastRunReset)) corrupt('lastRunReset'); s.lastRunReset = value.lastRunReset;
  }
  s.challengesDone = Array.isArray(value.challengesDone)
    ? value.challengesDone.slice(0, 3).map(v => v === true) : [...DEFAULT_STATE.challengesDone];
  for (const k of ['commerceReceiptIds', 'commerceQuoteIds', 'commerceSignatures', 'paymentReceiptIds', 'paymentSignatures'] as const) {
    if (value[k] !== undefined) { if (!stringList(value[k])) corrupt(k); s[k] = [...value[k]]; }
  }
  if (value.commerceAccounts !== undefined) {
    if (!object(value.commerceAccounts) || Object.keys(value.commerceAccounts).length > 10000) corrupt('commerceAccounts');
    s.commerceAccounts = {};
    for (const [key, p] of Object.entries(value.commerceAccounts)) {
      if (!safeKey(key) || !object(p) || !safeCount(p.tokens) || !safeCount(p.paidRuns)) corrupt('commerceAccounts');
      const account: CommerceAccountProfile = { tokens: p.tokens, paidRuns: p.paidRuns, ...profileFields(p) };
      for (const marker of ['commerceReceiptIds', 'commerceQuoteIds', 'commerceSignatures', 'paymentReceiptIds', 'paymentSignatures'] as const) {
        if (p[marker] !== undefined) { if (!stringList(p[marker])) corrupt(marker); account[marker] = [...p[marker]]; }
      }
      s.commerceAccounts[key] = account;
    }
  }
  if (value.runLedger !== undefined) {
    if (!object(value.runLedger) || Object.keys(value.runLedger).length > 10000) corrupt('runLedger');
    for (const [id, e] of Object.entries(value.runLedger)) {
      if (!safeKey(id) || !object(e) || !object(e.run) || id !== e.run.id
        || !isCanonicalRun(e.run, e as unknown as RunLedgerEntry)
        || (e.abandoned !== undefined && typeof e.abandoned !== 'boolean')) corrupt('runLedger');
      s.runLedger[id] = structuredClone(e) as unknown as RunLedgerEntry;
    }
  }
  if (value.activeRun !== undefined && value.activeRun !== null) {
    if (!object(value.activeRun) || typeof value.activeRun.id !== 'string'
      || !isCanonicalRun(value.activeRun, s.runLedger[value.activeRun.id])) corrupt('activeRun');
    s.activeRun = structuredClone(value.activeRun) as RunSession;
  }
  s.localScores = Array.isArray(value.localScores) ? value.localScores.slice(0, 10000).flatMap(v => {
    if (!object(v) || !safeCount(v.wave) || !timestamp(v.ts)) return [];
    const score: LocalScore = { wave: v.wave, ts: v.ts, verified: false };
    for (const k of ['runId', 'engineVersion', 'accountScope', 'partition', 'rulesVersion', 'period'] as const) {
      if (typeof v[k] === 'string' && v[k].length <= 512) score[k] = v[k];
    }
    if (isRunConfig(v.config)) score.config = { ...v.config };
    if ([1, 2, 4].includes(v.speed as number)) score.speed = v.speed as 1 | 2 | 4;
    if (safeCount(v.seed) && v.seed <= 0xffffffff) score.seed = v.seed;
    if (safeCount(v.continuedCount)) score.continuedCount = v.continuedCount;
    return [score];
  }).sort((a, b) => b.wave - a.wave).slice(0, 1000) : [];
  if (value.paidRuns === undefined) s.paidRuns = Math.max(0, s.dailyFreeLeft - s.dailyFreeMax);
  const migrated = migrateRunState(s);
  if (s.activeRun && !migrated.activeRun) corrupt('active run lifecycle');
  if (Object.entries(s.runLedger).some(([id, entry]) => (!entry.settled || entry.continuationAuthorized)
    && (!migrated.activeRun || migrated.activeRun.id !== id))) corrupt('orphaned run lifecycle');
  if (value.battleCheckpoint !== undefined && value.battleCheckpoint !== null) {
    const checkpoint = value.battleCheckpoint;
    if (!validateRunCheckpoint(checkpoint) || !migrated.runLedger[checkpoint.runId]
      || !validateRunCheckpoint(checkpoint, migrated.runLedger[checkpoint.runId].run)
      || (migrated.activeRun && checkpoint.runId !== migrated.activeRun.id)) {
      throw new StorageRecoveryError('CHECKPOINT_RECOVERY_REQUIRED', 'Battle recovery is required; original save retained.');
    }
    migrated.battleCheckpoint = structuredClone(checkpoint);
    migrated.battleCheckpoint.battle.paused = true;
  }
  if (migrated.activeRun && !migrated.battleCheckpoint && !recovery.allowMissingCheckpoint) {
    throw new StorageRecoveryError('CHECKPOINT_RECOVERY_REQUIRED', 'Active run has no battle checkpoint. Explicit recovery/discard is required; no refund was issued.');
  }
  const checkpointRun = migrated.battleCheckpoint && migrated.runLedger[migrated.battleCheckpoint.runId]?.run;
  if (!recovery.allowMissingCheckpoint && ((migrated.activeRun && !runOwnedByState(migrated, migrated.activeRun))
    || (checkpointRun && !runOwnedByState(migrated, checkpointRun)))) {
    throw new StorageRecoveryError('CHECKPOINT_RECOVERY_REQUIRED', 'Battle belongs to another account. Restore its owner before continuing.');
  }
  return migrated;
}

let recoveryBlocked = false;
let persistenceRecoveryError: StorageRecoveryError | null = null;
let pendingPersistence: { next: string; previous: string | null } | null = null;
export function getPersistenceRecoveryError(): StorageRecoveryError | null { return persistenceRecoveryError; }
export function isPersistenceRecoveryRequired(): boolean { return recoveryBlocked; }
function decodeState(raw: string): GameState {
  if (raw.length > 16 * 1024 * 1024) return corrupt('save size');
  try { return sanitizeState(JSON.parse(raw)); }
  catch (error) {
    if (error instanceof StorageRecoveryError) throw new StorageRecoveryError(error.code, error.message, raw);
    throw new StorageRecoveryError('SAVE_CORRUPT', 'Save is unreadable or corrupt; original data retained.', raw);
  }
}

export function loadState(): GameState {
  try {
    let raw: string | null;
    try { raw = localStorage.getItem(LS_KEY); }
    catch { throw new StorageRecoveryError('STORAGE_UNREADABLE', 'Storage cannot be read. Retry before changing progress.'); }
    if (raw === null) {
      let backup: string | null;
      try { backup = localStorage.getItem(LS_BACKUP_KEY); }
      catch { throw new StorageRecoveryError('STORAGE_UNREADABLE', 'Recovery storage cannot be read.'); }
      if (backup !== null) {
        decodeState(backup);
        throw new StorageRecoveryError('SAVE_CORRUPT', 'Primary save is missing; backup requires explicit recovery. No values were reset.', backup);
      }
      const archived = readRecoveryStorage(LS_RECOVERY_KEY);
      if (archived !== null) throw new StorageRecoveryError('SAVE_CORRUPT', 'Primary save is missing but archived recovery data exists. Refusing to create a fresh profile.', archived);
      recoveryBlocked = false;
      persistenceRecoveryError = null;
      pendingPersistence = null;
      return ensureReferralCode(structuredClone(DEFAULT_STATE));
    }
    const state = decodeState(raw);
    recoveryBlocked = false;
    persistenceRecoveryError = null;
    pendingPersistence = null;
    return state;
  } catch (error) {
    recoveryBlocked = true;
    persistenceRecoveryError = error instanceof StorageRecoveryError ? error
      : new StorageRecoveryError('STORAGE_UNREADABLE', 'Storage recovery is required.');
    throw error;
  }
}

export function saveState(s: GameState): boolean {
  if (recoveryBlocked) return false;
  persistenceRecoveryError = null;
  let primaryWriteAttempted = false;
  let candidateValidated = false;
  let attempted: { next: string; previous: string | null } | null = null;
  try {
    const next = JSON.stringify(sanitizeState(s));
    decodeState(next);
    candidateValidated = true;
    const previous = localStorage.getItem(LS_KEY);
    attempted = { next, previous };
    if (previous !== null) {
      decodeState(previous);
      if (previous !== next) {
        localStorage.setItem(LS_BACKUP_KEY, previous);
        if (localStorage.getItem(LS_BACKUP_KEY) !== previous) return false;
      }
    } else if (localStorage.getItem(LS_BACKUP_KEY) !== null || localStorage.getItem(LS_RECOVERY_KEY) !== null) return false;
    primaryWriteAttempted = true;
    localStorage.setItem(LS_KEY, next);
    if (localStorage.getItem(LS_KEY) !== next) throw new Error('WRITE_NOT_ACKNOWLEDGED');
    pendingPersistence = null;
    return true;
  } catch (error) {
    if (primaryWriteAttempted) {
      recoveryBlocked = true;
      pendingPersistence = attempted;
      persistenceRecoveryError = new StorageRecoveryError('STORAGE_WRITE_UNCERTAIN',
        'Write was not durably acknowledged. The operation may already be saved. Pause and reload progress before retrying; do not assume no debit occurred.');
    } else if (error instanceof StorageRecoveryError) {
      recoveryBlocked = candidateValidated;
      persistenceRecoveryError = error;
    }
    return false;
  }
}

export function retryStatePersistence(pending: GameState): boolean {
  if (!recoveryBlocked) return saveState(pending);
  if (!pendingPersistence) return false;
  try {
    const desired = JSON.stringify(sanitizeState(pending));
    if (desired !== pendingPersistence.next) return false;
    const current = readRecoveryStorage(LS_KEY);
    if (current === desired) {
      decodeState(current);
      recoveryBlocked = false;
      persistenceRecoveryError = null;
      pendingPersistence = null;
      return true;
    }
    if (current !== pendingPersistence.previous) return false;
    if (current !== null) decodeState(current);
    recoveryBlocked = false;
    return saveState(pending);
  } catch { return false; }
}
export const retryPendingState = retryStatePersistence;

function readRecoveryStorage(key: string): string | null {
  try { return localStorage.getItem(key); }
  catch { throw new StorageRecoveryError('STORAGE_UNREADABLE', 'Storage cannot be read; recovery is blocked until reads succeed.'); }
}

function writeRecoveryState(raw: string, previous: string | null): GameState {
  const state = decodeState(raw);
  try {
    if (previous !== null) {
      localStorage.setItem(LS_RECOVERY_KEY, previous);
      if (localStorage.getItem(LS_RECOVERY_KEY) !== previous) throw new Error('archive verification');
    }
    localStorage.setItem(LS_KEY, raw);
    if (localStorage.getItem(LS_KEY) !== raw) throw new Error('restore verification');
    recoveryBlocked = false;
    persistenceRecoveryError = null;
    return state;
  } catch {
    recoveryBlocked = true;
    throw new StorageRecoveryError('STORAGE_UNREADABLE', 'Recovery was not durably acknowledged. Original raw remains archived.');
  }
}

export function restoreStateBackup(): GameState {
  const primary = readRecoveryStorage(LS_KEY);
  const backup = readRecoveryStorage(LS_BACKUP_KEY);
  if (backup === null) throw new StorageRecoveryError('SAVE_CORRUPT', 'No backup is available.');
  decodeState(backup);
  if (primary !== null) {
    let valid = false;
    try { decodeState(primary); valid = true; } catch { /* Explicit recovery may replace corrupt, but never unreadable, data. */ }
    if (valid) throw new StorageRecoveryError('SAVE_CORRUPT', 'Primary save is valid. Refusing to roll back paid values.');
  }
  return writeRecoveryState(backup, primary);
}

export function discardUnrecoverableRun(): GameState {
  const raw = readRecoveryStorage(LS_KEY);
  if (raw === null) throw new StorageRecoveryError('SAVE_CORRUPT', 'No primary run to discard. Restore a validated backup instead.');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new StorageRecoveryError('SAVE_CORRUPT', 'Profile is corrupt; run-only discard is unsafe.', raw); }
  if (!object(value)) return corrupt('profile');
  const state = sanitizeState({ ...value, battleCheckpoint: null }, { allowMissingCheckpoint: true });
  const checkpointId = object(value.battleCheckpoint) && typeof value.battleCheckpoint.runId === 'string'
    ? value.battleCheckpoint.runId : null;
  const run = state.activeRun ?? (checkpointId ? state.runLedger[checkpointId]?.run : null);
  if (!run || !runOwnedByState(state, run)) {
    throw new StorageRecoveryError('CHECKPOINT_RECOVERY_REQUIRED', 'Cannot discard a run belonging to another account or an unknown run.');
  }
  const entry = state.runLedger[run.id];
  const discarded = { ...state, activeRun: null, battleCheckpoint: null, runLedger: { ...state.runLedger,
    [run.id]: { ...entry, settled: true, defeated: false, abandoned: true, continuationAuthorized: false } } };
  return writeRecoveryState(JSON.stringify(discarded), raw);
}
export const discardLostRun = discardUnrecoverableRun;

export function nextUTCReset(now = Date.now()): number {
  return Date.parse(`${todayStr(now)}T00:00:00Z`) + BONUS_COOLDOWN_MS;
}

export function persistBattleCheckpoint(s: GameState, checkpoint: RunCheckpoint): GameState {
  const entry = s.runLedger?.[checkpoint?.runId];
  if (!entry || !runOwnedByState(s, entry.run) || !validateRunCheckpoint(checkpoint, entry.run)
    || (s.activeRun?.id !== entry.run.id && !(entry.settled && !entry.abandoned))) {
    throw new StorageRecoveryError('CHECKPOINT_RECOVERY_REQUIRED', 'Checkpoint does not belong to the current run/account.');
  }
  if (entry.continuationAuthorized && checkpoint.battle.gameOver && s.battleCheckpoint
    && !s.battleCheckpoint.battle.gameOver && checkpoint.battle.time <= s.battleCheckpoint.battle.time) {
    throw new StorageRecoveryError('CHECKPOINT_RECOVERY_REQUIRED', 'A durable Continue is already revived. Restore that snapshot; stale defeat cannot overwrite it.');
  }
  return { ...s, battleCheckpoint: structuredClone(checkpoint) };
}

export function getRecoverableCheckpoint(s: GameState): RunCheckpoint | null {
  const id = s.activeRun?.id ?? s.battleCheckpoint?.runId;
  if (!id) return null;
  const entry = s.runLedger[id];
  if (!entry || entry.abandoned || !runOwnedByState(s, entry.run)) {
    throw new StorageRecoveryError('CHECKPOINT_RECOVERY_REQUIRED', 'Run ownership/lifecycle requires recovery.');
  }
  const checkpoint = s.battleCheckpoint;
  if (!checkpoint || !validateRunCheckpoint(checkpoint, entry.run)) {
    throw new StorageRecoveryError('CHECKPOINT_RECOVERY_REQUIRED', 'No compatible battle checkpoint. Do not abandon or refund automatically.');
  }
  const restored = structuredClone(checkpoint);
  restored.battle.paused = true;
  return restored;
}

// ── Tower specs (8 types) ─────────────────────────────────────────────────
export const TOWERS = [
  { id:'arrow',   name:'Fletcher',   cost:50,  dmg: 8,  rate: 900,  range: 110, color:'#595959', shape:'triangle', desc:'Cheap, fast arrows.' },
  { id:'cannon',  name:'Bombard',    cost:120, dmg: 28, rate: 1600, range: 120, color:'#2b2b2b', shape:'circle',   desc:'Splash damage.' },
  { id:'spark',   name:'Tesla',      cost:150, dmg: 12, rate: 700,  range: 100, color:'#595959', shape:'square',   desc:'Chains lightning.' },
  { id:'frost',   name:'Glacier',    cost:140, dmg: 4,  rate: 1400, range: 95,  color:'#8a9aa0', shape:'hex',      desc:'Slows enemies 40%.' },
  { id:'sniper',  name:'Marksman',   cost:200, dmg: 70, rate: 2000, range: 200, color:'#2b2b2b', shape:'diamond',  desc:'Long range, pierces.' },
  { id:'venom',   name:'Apothecary', cost:130, dmg: 3,  rate: 600,  range: 90,  color:'#6b7a5a', shape:'teardrop', desc:'Poison damage over time.' },
  { id:'mortar',  name:'Howitzer',   cost:220, dmg: 40, rate: 2400, range: 220, color:'#595959', shape:'pentagon', desc:'Targets far, big splash.' },
  { id:'totem',   name:'Bastion',    cost:180, dmg: 0,  rate: 0,    range: 80,  color:'#a58a4a', shape:'star',     desc:'+25% dmg to nearby towers.' },
];

// ── Enemy types ───────────────────────────────────────────────────────────
export const ENEMIES = [
  { id:'grunt',  name:'Grunt',   hp: 30,  speed: 0.8, bounty: 6,  color:'#595959', shape:'circle' },
  { id:'scout',  name:'Scout',   hp: 18,  speed: 1.5, bounty: 5,  color:'#2b2b2b', shape:'triangle' },
  { id:'tank',   name:'Tank',    hp: 140, speed: 0.5, bounty: 18, color:'#2b2b2b', shape:'square' },
  { id:'swarm',  name:'Swarm',   hp: 10,  speed: 1.2, bounty: 3,  color:'#595959', shape:'diamond' },
  { id:'boss',   name:'Warden',  hp: 600, speed: 0.4, bounty: 90, color:'#2b2b2b', shape:'hex' },
];

// ── Daily challenges ──────────────────────────────────────────────────────
export const CHALLENGES = [
  { id:'win_3',    title:'Win 3 games',            goal: 3, reward: 120 },
  { id:'no_leak',  title:'Clear a wave w/o leaks', goal: 1, reward: 80  },
  { id:'use_4',    title:'Place 4 tower types',    goal: 4, reward: 150 },
];

// ── Skins catalogue (4 families × 3 skins = 12 total) ────────────────────
// default skins are always available — no purchase needed.
export interface SkinDef {
  id: string;
  name: string;
  family: TowerFamily;
  price: number;  // STD; 0 = default (always free)
  color: string;  // hex override for the tower fill
  desc: string;
}

export const SKINS: SkinDef[] = [
  // ── Canon family ──────────────────────────────────────────────────
  { id:'canon-default', name:'Classic',     family:'canon',  price:0,   color:'#2b2b2b', desc:'Stock iron casing.' },
  { id:'canon-steel',   name:'Blue Steel',  family:'canon',  price:400, color:'#4a5a8a', desc:'Tempered steel finish.' },
  { id:'canon-brass',   name:'Brass Bolt',  family:'canon',  price:700, color:'#a58a4a', desc:'Steampunk bronzework.' },
  // ── Laser family ──────────────────────────────────────────────────
  { id:'laser-default', name:'Classic',     family:'laser',  price:0,   color:'#595959', desc:'Stock crystal prism.' },
  { id:'laser-ruby',    name:'Ruby Ray',    family:'laser',  price:450, color:'#8a4a4a', desc:'Deep crimson lenses.' },
  { id:'laser-jade',    name:'Jade Beam',   family:'laser',  price:650, color:'#4a6a5a', desc:'Resonant green crystal.' },
  // ── Mortar family ─────────────────────────────────────────────────
  { id:'mortar-default',name:'Classic',     family:'mortar', price:0,   color:'#595959', desc:'Stock siege hull.' },
  { id:'mortar-siege',  name:'Siege Works', family:'mortar', price:500, color:'#4a5a8a', desc:'Forged fortress cannon.' },
  { id:'mortar-ochre',  name:'Ochre Shell', family:'mortar', price:800, color:'#a58a4a', desc:'Burnished brass barrel.' },
  // ── Glue family ───────────────────────────────────────────────────
  { id:'glue-default',  name:'Classic',     family:'glue',   price:0,   color:'#6b7a5a', desc:'Stock resin dispenser.' },
  { id:'glue-vine',     name:'Vine Grip',   family:'glue',   price:300, color:'#4a6a5a', desc:'Overgrown with ivy.' },
  { id:'glue-wine',     name:'Merlot',      family:'glue',   price:900, color:'#8a4a4a', desc:'Deep burgundy lacquer.' },
];

// ── Extended data ─────────────────────────────────────────────────────────
export const DMG_TABLE: Record<string, Record<string, number>> = {
  LIGHT:    { physical:1.25, explosive:0.75, energy:1.00, poison:1.25, magic:1.00 },
  HEAVY:    { physical:0.60, explosive:1.40, energy:0.90, poison:0.70, magic:1.00 },
  FLYING:   { physical:0.80, explosive:0.20, energy:1.20, poison:0.50, magic:1.00 },
  SHIELDED: { physical:0.50, explosive:0.70, energy:1.60, poison:0.40, magic:1.10 },
  NONE:     { physical:1.00, explosive:1.00, energy:1.00, poison:1.00, magic:1.00 },
};

export const TOWERS_EX = [
  { id:'arrow',   name:'Fletcher',   shape:'triangle', color:'#595959', air:false,
    type:'physical', target:'first',
    tiers: [
      { dmg: 8,  rate: 900, range: 110, cost: 50  },
      { dmg: 14, rate: 820, range: 120, cost: 80,  name:'Longbow' },
      { dmg: 26, rate: 720, range: 135, cost: 140, name:'Ballista' },
    ], desc:'Cheap, fast physical arrows.' },

  { id:'cannon',  name:'Bombard',    shape:'circle', color:'#2b2b2b', air:false, splash:24,
    type:'explosive', target:'first',
    tiers: [
      { dmg: 28, rate: 1600, range: 120, cost: 120 },
      { dmg: 48, rate: 1500, range: 130, cost: 180, name:'Mortar' },
      { dmg: 82, rate: 1400, range: 150, cost: 260, name:'Thunderer' },
    ], desc:'Splash explosive. Bad vs flyers.' },

  { id:'spark',   name:'Tesla',      shape:'square', color:'#595959', air:true, chain:2,
    type:'energy', target:'first',
    tiers: [
      { dmg: 12, rate: 700, range: 100, cost: 150 },
      { dmg: 20, rate: 640, range: 110, cost: 200, name:'Arc Coil',  chain:3 },
      { dmg: 34, rate: 560, range: 125, cost: 290, name:'Storm Pylon', chain:4 },
    ], desc:'Chains lightning. Great vs shielded.' },

  { id:'frost',   name:'Glacier',    shape:'hex', color:'#8a9aa0', air:false,
    type:'magic', target:'first', slow: 0.4, slowMs: 800,
    tiers: [
      { dmg: 4,  rate: 1400, range: 95,  cost: 140 },
      { dmg: 8,  rate: 1300, range: 105, cost: 200, name:'Rimeward', slow:0.5, slowMs:1000 },
      { dmg: 14, rate: 1200, range: 120, cost: 300, name:'Winter King', slow:0.6, slowMs:1200 },
    ], desc:'Slows. AOE ring.' },

  { id:'sniper',  name:'Marksman',   shape:'diamond', color:'#2b2b2b', air:true,
    type:'physical', target:'strongest', pierce:true,
    tiers: [
      { dmg: 70,  rate: 2000, range: 200, cost: 200 },
      { dmg: 120, rate: 1800, range: 230, cost: 280, name:'Sharpshooter' },
      { dmg: 220, rate: 1600, range: 270, cost: 400, name:'Oracle Eye' },
    ], desc:'Long-range, pierces. Targets strongest.' },

  { id:'venom',   name:'Apothecary', shape:'teardrop', color:'#6b7a5a', air:false,
    type:'poison', target:'first', dot: 8, dotMs: 2500,
    tiers: [
      { dmg: 3,  rate: 600, range: 90,  cost: 130 },
      { dmg: 5,  rate: 520, range: 100, cost: 190, name:'Herbalist', dot:14, dotMs: 3000 },
      { dmg: 9,  rate: 460, range: 115, cost: 280, name:'Hemlock Druid', dot: 22, dotMs: 3500 },
    ], desc:'Poison DOT. Excels vs LIGHT.' },

  { id:'mortar',  name:'Howitzer',   shape:'pentagon', color:'#595959', air:false, splash:34,
    type:'explosive', target:'last',
    tiers: [
      { dmg: 40, rate: 2400, range: 220, cost: 220 },
      { dmg: 66, rate: 2200, range: 240, cost: 300, name:'Siege Works', splash:40 },
      { dmg:110, rate: 2000, range: 270, cost: 420, name:'Fortress Gun', splash:48 },
    ], desc:'Long splash. Targets last.' },

  { id:'totem',   name:'Bastion',    shape:'star', color:'#a58a4a', air:false,
    type:null, target:null, aura: 0.25,
    tiers: [
      { dmg: 0, rate: 0, range: 80,  cost: 180 },
      { dmg: 0, rate: 0, range: 95,  cost: 240, name:'Warden Stone', aura: 0.35 },
      { dmg: 0, rate: 0, range: 115, cost: 360, name:'Ancestor Monolith', aura: 0.50 },
    ], desc:'Support: +% dmg to nearby towers.' },
];

export const ENEMIES_EX = [
  { id:'grunt',  name:'Grunt',   hp: 30,  speed: 0.8, bounty: 6,  color:'#595959', shape:'circle',   armor:'NONE' },
  { id:'scout',  name:'Scout',   hp: 18,  speed: 1.5, bounty: 5,  color:'#2b2b2b', shape:'triangle', armor:'LIGHT' },
  { id:'tank',   name:'Tank',    hp: 140, speed: 0.5, bounty: 18, color:'#2b2b2b', shape:'square',   armor:'HEAVY' },
  { id:'swarm',  name:'Swarm',   hp: 10,  speed: 1.2, bounty: 3,  color:'#595959', shape:'diamond',  armor:'LIGHT' },
  { id:'crow',   name:'Crow',    hp: 40,  speed: 1.3, bounty: 10, color:'#2b2b2b', shape:'triangle', armor:'FLYING' },
  { id:'warden', name:'Warden',  hp: 90,  speed: 0.6, bounty: 14, color:'#595959', shape:'hex',      armor:'SHIELDED' },
  { id:'medic',  name:'Medic',   hp: 60,  speed: 0.7, bounty: 12, color:'#6b7a5a', shape:'circle',   armor:'LIGHT',
    ability:'heal', healAmt: 0.4, healRange: 40, healRate: 1200 },
  { id:'splitter', name:'Splitter', hp: 70, speed: 0.9, bounty: 12, color:'#595959', shape:'hex', armor:'NONE',
    ability:'split', splitInto:'swarm', splitCount:3 },
  { id:'boss',   name:'Warlord', hp: 900, speed: 0.4, bounty:120, color:'#2b2b2b', shape:'hex',      armor:'HEAVY' },
];

export const WAVES_EX = [
  [{e:'scout', n:6, gap:550}],
  [{e:'grunt', n:8, gap:500}, {e:'swarm', n:4, gap:300, delay:3500}],
  [{e:'scout', n:10, gap:380}, {e:'grunt', n:4, gap:600, delay:2500}],
  [{e:'crow',  n:6, gap:500}],
  [{e:'swarm', n:18, gap:260}, {e:'medic', n:2, gap:1500, delay:3000}],
  [{e:'tank',  n:2, gap:1200}, {e:'grunt', n:10, gap:480, delay:1500}],
  [{e:'warden',n:6, gap:700}, {e:'crow', n:6, gap:600, delay:2000}],
  [{e:'splitter', n:4, gap:1200}, {e:'scout', n:8, gap:420, delay:2500}],
  [{e:'tank',  n:3, gap:1000}, {e:'warden', n:4, gap:700, delay:1800}, {e:'crow', n:4, gap:600, delay:4000}],
  [{e:'boss',  n:1, gap:1, delay:500}, {e:'swarm', n:20, gap:220, delay:2500}],
];

export const TARGET_MODES = ['first','last','strongest','weakest','closest'];

export function damageMul(dmgType: string | null, armor: string): number {
  if (!dmgType) return 0;
  return (DMG_TABLE[armor] || DMG_TABLE.NONE)[dmgType] || 1;
}
