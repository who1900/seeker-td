import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { DEFAULT_STATE, LS_KEY, LS_BACKUP_KEY, STARTER_STD, loadState, saveState, sanitizeState,
  StorageRecoveryError, todayStr, nextUTCReset, applyDailyReset, claimDailyBonus, claimChallengeReward,
  getDailyBonusDisplay, DAILY_BONUS_SCHEDULE, ensureReferralCode, genReferralCode,
  persistBattleCheckpoint, getRecoverableCheckpoint, CONTINUE_LIVES, restoreStateBackup,
  discardLostRun, LS_RECOVERY_KEY, getPersistenceRecoveryError, retryStatePersistence } from './store';
import type { GameState } from './store';
import { admitRun, settleRun, continueRun, continuePrice, continuedCount, abandonRun, LOCAL_RANKED_RULES_VERSION } from './runs';
import type { RunConfig } from './runs';
import { createRunCheckpoint, validateRunCheckpoint, restoreRunCheckpoint, CheckpointRecoveryError } from './checkpoints';
import { tick, startWave, placeTower } from '../game/engine';
import { gameplayRandom } from '../game/gameplayRandom';
import { applyPaymentReceipt } from '../services/payments';

const now = Date.UTC(2026, 9, 7, 23, 59);
const day = 86400000;
const config: RunConfig = { access: 'standard', mode: 'endless', durationMinutes: 10, waveLimit: 10 };
const summary = { completedWaves: 3, victory: false, uniqueTowerTypes: 4, noLeakWave: true };
const fresh = (extra: Partial<GameState> = {}): GameState => ({ ...structuredClone(DEFAULT_STATE),
  lastRunReset: todayStr(now), challengesResetDate: todayStr(now), ...extra });
const disk = new Map<string, string>();
let readFails = false;
let writeFails = false;
let failKey = '';
let dropWrite = false;
let postWriteFault: 'throw' | 'wrong' | null = null;
let primaryJustWritten = false;
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem(key: string) {
    if (readFails) throw new Error('blocked read');
    if (key === LS_KEY && primaryJustWritten && postWriteFault) {
      primaryJustWritten = false;
      if (postWriteFault === 'throw') throw new Error('read-back blocked');
      return 'wrong read-back';
    }
    return disk.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    if (writeFails || failKey === key) throw new Error('quota');
    if (!dropWrite) disk.set(key, value);
    if (key === LS_KEY) primaryJustWritten = true;
  },
} });

const first = loadState();
assert.equal(first.tokens, STARTER_STD);
assert.equal(first.streak, 0);
assert.equal(first.lives, 0);
for (const key of ['sol', 'prizePool', 'monthlyRank'] as const) assert.equal(first[key], 0);
assert.equal(first.walletAddr, '');
assert.notEqual(loadState().referralCode, first.referralCode);
assert.equal(saveState(first), true);
assert.equal(loadState().referralCode, first.referralCode);
const valuable = fresh({ tokens: 999, paidRuns: 7, lives: 15, unlockedSkins: ['legacy-skin'] });
assert.equal(saveState(valuable), true);
const original = disk.get(LS_KEY)!;
const backupBefore = disk.get(LS_BACKUP_KEY)!;
readFails = true;
assert.throws(loadState, e => e instanceof StorageRecoveryError && e.code === 'STORAGE_UNREADABLE');
assert.equal(saveState(fresh()), false);
readFails = false;
assert.equal(saveState(fresh()), false, 'read failure blocks defaults-overwrite until successful retry');
assert.equal(disk.get(LS_KEY), original);
assert.equal(loadState().paidRuns, 7);
writeFails = true;
assert.equal(saveState({ ...valuable, tokens: 1099 }), false);
assert.equal(disk.get(LS_KEY), original);
writeFails = false;
failKey = LS_KEY;
assert.equal(saveState({ ...valuable, tokens: 1099 }), false);
assert.equal(loadState().tokens, 999);
assert.equal(loadState().paidRuns, 7);
assert.equal(disk.get(LS_BACKUP_KEY), original, 'backup never contains speculative new grants');
failKey = '';
dropWrite = true;
assert.equal(saveState({ ...valuable, tokens: 1099 }), false, 'read-back verifies acknowledged writes');
dropWrite = false;
disk.set(LS_KEY, '{unrecoverable');
assert.throws(loadState, e => e instanceof StorageRecoveryError && e.raw === '{unrecoverable');
assert.equal(saveState(fresh()), false);
assert.equal(disk.get(LS_KEY), '{unrecoverable');
assert.equal(disk.get(LS_BACKUP_KEY), original);
disk.delete(LS_KEY);
assert.throws(loadState, StorageRecoveryError, 'missing primary with prior backup is not a fresh profile');
disk.set(LS_KEY, original);
assert.equal(loadState().tokens, 999);
assert.notEqual(backupBefore, original);

const legacy = { ...fresh({ tokens: 420, lives: 5, streak: 5, localScores: [] }), localScores: null };
delete legacy.schemaVersion;
disk.set(LS_KEY, JSON.stringify(legacy));
const repaired = loadState();
assert.deepEqual(repaired.localScores, []);
assert.equal(repaired.tokens, 420);
assert.equal(repaired.lives, 5);
assert.equal(repaired.streak, 5);
assert.equal(disk.get(LS_KEY), JSON.stringify(legacy), 'load never rewrites raw');
for (const bad of [null, [], {}, { ...valuable, tokens: -1 }, { ...valuable, paidRuns: '7' },
  { ...valuable, lives: null }, { ...valuable, unlockedSkins: null }, { ...valuable, equippedSkins: null },
  { ...valuable, lastBonusClaim: Infinity }, { ...valuable, runLedger: null }, { ...valuable, schemaVersion: 999 }]) {
  assert.throws(() => sanitizeState(bad), StorageRecoveryError);
}
assert.deepEqual(sanitizeState({ ...valuable, localScores: [null, { wave: -1, ts: now }, { wave: 4, ts: now }] })
  .localScores, [{ wave: 4, ts: now, verified: false }]);
const badBackup = '{bad backup';
disk.delete(LS_KEY);
disk.set(LS_BACKUP_KEY, badBackup);
assert.throws(loadState, StorageRecoveryError);
assert.equal(disk.get(LS_BACKUP_KEY), badBackup);
disk.set(LS_KEY, original);
loadState();

const admission = admitRun(repaired, config, now);
assert.ok(admission.run);
const run = admission.run;
assert.equal(admission.state.dailyFreeLeft, repaired.dailyFreeLeft - 1);
assert.ok(validateRunCheckpoint(admission.state.battleCheckpoint, run));
assert.equal(admission.state.battleCheckpoint!.battle.paused, true);
assert.equal(admission.state.battleCheckpoint!.battle.combatRandom!.state, run.seed);
assert.equal(saveState(admission.state), true);
assert.equal(getRecoverableCheckpoint(loadState())!.runId, run.id);
const battle = structuredClone(admission.state.battleCheckpoint!.battle);
battle.paused = false;
assert.equal(placeTower(battle, 'canon', { x: 0, y: 10 }), true);
startWave(battle);
for (let i = 0; i < 35; i++) tick(battle, 0.05);
const snapshot = createRunCheckpoint({ runId: run.id, battle, activeSeconds: 1.75, planningSeconds: 2,
  clockStarted: true, backlogSeconds: 0.0123, speed: 1, placedTowerTypes: ['canon'], savedAt: now });
assert.equal(snapshot.battle.paused, true);
assert.equal(battle.paused, false, 'snapshot never mutates engine');
assert.ok(snapshot.battle.enemies.length > 0);
assert.deepEqual(snapshot.battle.spawnQueue, battle.spawnQueue);
assert.deepEqual(snapshot.battle.towers[0].cooldown, battle.towers[0].cooldown);
const resumed = restoreRunCheckpoint(snapshot, run);
const randomCopy = structuredClone(battle);
assert.equal(gameplayRandom(resumed.battle), gameplayRandom(randomCopy));
resumed.battle.gold++;
assert.notEqual(resumed.battle.gold, snapshot.battle.gold);
const checkpointState = persistBattleCheckpoint(admission.state, snapshot);
assert.equal(saveState(checkpointState), true);
assert.deepEqual(getRecoverableCheckpoint(loadState()), JSON.parse(JSON.stringify(snapshot)));
assert.equal(getRecoverableCheckpoint(loadState())!.backlogSeconds, 0.0123);
for (const mutate of [
  (v: typeof snapshot) => { v.version = 2 as 1; },
  (v: typeof snapshot) => { v.engineVersion = 'incompatible'; },
  (v: typeof snapshot) => { v.activeSeconds = NaN; },
  (v: typeof snapshot) => { v.backlogSeconds = Infinity; },
  (v: typeof snapshot) => { v.battle.combatRandom = undefined; },
  (v: typeof snapshot) => { v.battle.combatRandom!.cursor = 0xffffffff; },
  (v: typeof snapshot) => { v.battle.enemies[0].hp = Infinity; },
  (v: typeof snapshot) => { v.battle.towers[0].cooldown = 'oops' as unknown as number; },
  (v: typeof snapshot) => { v.battle.grid[0] = []; },
  (v: typeof snapshot) => { v.battle.shots = null as never; },
  (v: typeof snapshot) => { v.battle.enemies[0].speedEffects = [{ multiplier: 'oops' } as never]; },
  (v: typeof snapshot) => { v.battle.enemies[0].pathIdx = 0.5; },
]) {
  const bad = structuredClone(snapshot);
  mutate(bad);
  assert.equal(validateRunCheckpoint(bad, run), false);
  assert.throws(() => restoreRunCheckpoint(bad, run), CheckpointRecoveryError);
  const raw = JSON.stringify({ ...checkpointState, battleCheckpoint: bad });
  disk.set(LS_KEY, raw);
  assert.throws(loadState, StorageRecoveryError);
  assert.equal(saveState(fresh()), false);
  assert.equal(disk.get(LS_KEY), raw);
  disk.set(LS_KEY, JSON.stringify(checkpointState));
  loadState();
}
assert.throws(() => restoreRunCheckpoint(snapshot, 'local-999'), CheckpointRecoveryError);
const missingBattle = { ...checkpointState, battleCheckpoint: null };
assert.throws(() => getRecoverableCheckpoint(missingBattle), StorageRecoveryError);

let bonus = fresh();
for (let i = 0; i < 9; i++) {
  const date = now + i * day;
  assert.equal(getDailyBonusDisplay(bonus, date).day, (i % 7) + 1);
  const before = bonus.tokens;
  bonus = claimDailyBonus(bonus, date);
  assert.equal(bonus.tokens - before, DAILY_BONUS_SCHEDULE[i % 7]);
  assert.equal(bonus.streak, i + 1);
  assert.equal(claimDailyBonus(bonus, date), bonus);
  assert.equal(getDailyBonusDisplay(bonus, date).amount, DAILY_BONUS_SCHEDULE[i % 7]);
}
assert.equal(claimDailyBonus(bonus, now + 10 * day).streak, 1);
assert.equal(claimDailyBonus(bonus, now - day), bonus, 'clock rollback does not duplicate claims');
assert.equal(nextUTCReset(now), Date.UTC(2026, 9, 8));
assert.equal(nextUTCReset(nextUTCReset(now)), Date.UTC(2026, 9, 9));
assert.equal(claimDailyBonus(claimDailyBonus(fresh(), now), now + 60000).tokens, STARTER_STD + 110,
  'UTC midnight, not elapsed 24h, controls next claim');
const eligible = fresh({ tokens: 999, challengeProgress: { no_leak: 1 } });
const claimed = claimChallengeReward(eligible, 'no_leak', now);
assert.equal(claimed.tokens, 1079);
assert.equal(claimChallengeReward(claimed, 'no_leak', now), claimed);
assert.equal(claimChallengeReward(eligible, 'no_leak', now + 60000), eligible, 'stale midnight eligibility cannot claim');
assert.equal(claimChallengeReward(eligible, '__proto__', now), eligible);
assert.equal(claimChallengeReward({ ...eligible, challengeProgress: {} }, 'no_leak', now).tokens, 999);
const futureQuota = applyDailyReset(fresh({ dailyFreeLeft: 0 }), now + day);
assert.equal(applyDailyReset({ ...futureQuota, dailyFreeLeft: 1 }, now).dailyFreeLeft, 1);

const codes = new Set<string>();
for (let i = 0; i < 1000; i++) {
  const address = new PublicKey(createHash('sha256').update(`audit-public-address-${i}`).digest()).toBase58();
  const code = genReferralCode(address);
  assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  assert.equal(code, genReferralCode(address));
  codes.add(code);
}
assert.equal(codes.size, 1000);
assert.equal(ensureReferralCode({ ...fresh(), referralCode: 'LEGACY' }).referralCode, 'LEGACY');
assert.notEqual(ensureReferralCode(fresh()).referralCode, ensureReferralCode(fresh()).referralCode);

const defeated = settleRun(checkpointState, run, summary, now - day);
assert.equal(defeated.tokens, repaired.tokens + 15, 'calendar rollback does not block settlement');
assert.equal(settleRun(defeated, run, summary, now), defeated);
assert.equal(continuePrice(defeated, run), 25, 'five legacy lives are 25 STD credit');
const continued = continueRun(defeated, run, now - 2 * day);
assert.ok(continued.run);
assert.equal(continued.state.tokens, defeated.tokens - 25);
assert.equal(continued.state.lives, 0);
assert.equal(continued.state.battleCheckpoint!.battle.lives, 10);
assert.equal(continued.state.battleCheckpoint!.battle.gameOver, false);
assert.equal(continued.state.battleCheckpoint!.battle.paused, true);
assert.equal(saveState(continued.state), true);
assert.equal(loadState().runLedger[run.id].continuedCount, 1);
assert.equal(getRecoverableCheckpoint(loadState())!.battle.lives, 10, 'crash after authorization retains paid Continue');
assert.equal(getRecoverableCheckpoint(loadState())!.backlogSeconds, 0.0123);
assert.equal(continuedCount(continued.state, run), 1);
assert.equal(continuePrice(continued.state, run), 0, 'authorized retry never asks for another debit');
const staleDefeat = structuredClone(snapshot);
staleDefeat.battle.gameOver = true;
staleDefeat.battle.lives = 0;
assert.throws(() => persistBattleCheckpoint(continued.state, staleDefeat), StorageRecoveryError,
  'stale defeated UI cannot overwrite durable revived checkpoint after uncertain Continue ack');
assert.deepEqual(continueRun(continued.state, run, now), continued, 'authorized retry consumes neither tokens nor lives');
const defeatedAgain = settleRun(continued.state, run, { ...summary, completedWaves: 4 }, now);
assert.equal(continueRun(defeatedAgain, run, now).run, null);
assert.equal(continuePrice(defeatedAgain, run), Infinity);
const legacyCreditAdmission = admitRun(fresh({ lives: 15, tokens: 0 }), config, now);
assert.ok(legacyCreditAdmission.run);
const legacyCreditDefeat = settleRun(legacyCreditAdmission.state, legacyCreditAdmission.run, summary, now);
const creditedContinue = continueRun(legacyCreditDefeat, legacyCreditAdmission.run, now);
assert.equal(creditedContinue.state.lives, 5);
assert.equal(creditedContinue.state.tokens, legacyCreditDefeat.tokens);
assert.equal(CONTINUE_LIVES, 10);
const discarded = abandonRun(defeated, run);
assert.equal(discarded.battleCheckpoint, null);
assert.equal(discarded.runLedger[run.id].abandoned, true);
const rankedAdmission = admitRun(fresh({ lives: 99 }), { ...config, access: 'ranked' }, now);
assert.ok(rankedAdmission.run);
const rankedDefeat = settleRun(rankedAdmission.state, rankedAdmission.run, summary, now);
assert.equal(continueRun(rankedDefeat, rankedAdmission.run, now).run, null);
assert.equal(rankedDefeat.lives, 99);
assert.equal(rankedDefeat.localScores[0].config!.access, 'ranked');
assert.equal(rankedDefeat.localScores[0].verified, false);
assert.notEqual(rankedDefeat.localScores[0].partition, defeatedAgain.localScores[0].partition);
let practice = admitRun(fresh({ tokens: 0, lives: 15, dailyFreeLeft: 0 }), { ...config, access: 'practice' }, now);
assert.ok(practice.run);
for (let i = 0; i < 10; i++) {
  const settled = settleRun(practice.state, practice.run!, summary, now);
  practice = continueRun(settled, practice.run!, now - day);
  assert.ok(practice.run);
  assert.equal(practice.state.tokens, 0);
  assert.equal(practice.state.lives, 15);
}

const scopedAdmission = admitRun(fresh({ commerceAccount: 'uid:A' }), config, now);
assert.ok(scopedAdmission.run);
assert.equal(scopedAdmission.run.commerceAccount, 'uid:A');
const switched = { ...scopedAdmission.state, commerceAccount: 'uid:B' };
assert.equal(admitRun(switched, config, now).run, null);
assert.equal(settleRun(switched, scopedAdmission.run, summary, now), switched);
assert.throws(() => persistBattleCheckpoint(switched, switched.battleCheckpoint!), StorageRecoveryError);
assert.throws(() => getRecoverableCheckpoint(switched), StorageRecoveryError);
const scopedDefeat = settleRun(scopedAdmission.state, scopedAdmission.run, summary, now);
assert.equal(continueRun({ ...scopedDefeat, commerceAccount: 'uid:B' }, scopedAdmission.run, now).run, null);
const accounts = sanitizeState({ ...valuable, commerceAccounts: { 'uid:A': { tokens: 800, paidRuns: 8,
  lives: 7, unlockedSkins: ['legacy'], streak: 9, lastBonusClaim: now, challengeProgress: { no_leak: 1 },
  challengeClaimed: { no_leak: true }, challengesResetDate: todayStr(now) } } });
assert.equal(accounts.commerceAccounts!['uid:A'].lives, 7);
assert.equal(accounts.commerceAccounts!['uid:A'].streak, 9);

disk.set(LS_KEY, JSON.stringify(missingBattle));
assert.throws(loadState, e => e instanceof StorageRecoveryError && e.code === 'CHECKPOINT_RECOVERY_REQUIRED');
const lostRaw = disk.get(LS_KEY)!;
const discardedLost = discardLostRun();
assert.equal(discardedLost.activeRun, null);
assert.equal(discardedLost.tokens, missingBattle.tokens);
assert.equal(discardedLost.paidRuns, missingBattle.paidRuns);
assert.equal(discardedLost.dailyFreeLeft, missingBattle.dailyFreeLeft);
assert.equal(discardedLost.lives, missingBattle.lives);
assert.equal(discardedLost.runLedger[run.id].abandoned, true);
assert.equal(disk.get(LS_RECOVERY_KEY), lostRaw);
assert.equal(loadState().tokens, missingBattle.tokens);
disk.set(LS_KEY, '{bad-primary');
disk.set(LS_BACKUP_KEY, original);
readFails = true;
assert.throws(restoreStateBackup, StorageRecoveryError);
assert.equal(disk.get(LS_KEY), '{bad-primary');
readFails = false;
assert.equal(restoreStateBackup().tokens, 999);
assert.equal(loadState().paidRuns, 7);
assert.equal(disk.get(LS_RECOVERY_KEY), '{bad-primary');
assert.throws(restoreStateBackup, StorageRecoveryError, 'valid primary cannot silently roll back');
disk.delete(LS_KEY);
assert.equal(restoreStateBackup().tokens, 999, 'explicit validated restore handles missing primary');
disk.set(LS_KEY, '{bad-primary');
disk.set(LS_BACKUP_KEY, '{bad-backup');
assert.throws(restoreStateBackup, StorageRecoveryError);
assert.equal(disk.get(LS_KEY), '{bad-primary');
disk.set(LS_KEY, lostRaw);
writeFails = true;
assert.throws(discardLostRun, StorageRecoveryError);
writeFails = false;
assert.equal(disk.get(LS_KEY), lostRaw);
discardLostRun();
const guestAdmission = admitRun(fresh(), config, now);
assert.ok(guestAdmission.run);
assert.equal(guestAdmission.run.commerceAccount, 'guest');
assert.ok(getRecoverableCheckpoint({ ...guestAdmission.state, commerceAccount: undefined }));

let board = fresh({ paidRuns: 100, dailyFreeLeft: 0 });
for (let i = 0; i < 30; i++) {
  const a = admitRun(board, { ...config, access: i === 0 ? 'ranked' : 'standard' }, now);
  assert.ok(a.run);
  board = settleRun(a.state, a.run, { ...summary, completedWaves: i + 1 }, now);
}
assert.equal(board.localScores.filter(s => s.config?.access === 'standard').length, 20);
assert.equal(board.localScores.filter(s => s.config?.access === 'ranked').length, 1, 'Standard cannot evict Ranked partition');
assert.ok(board.localScores.every(s => s.seed !== undefined && s.engineVersion && s.verified === false));

const rankedA = admitRun(fresh(), { ...config, access: 'ranked', speed: 4 }, now);
const rankedB = admitRun(fresh(), { ...config, access: 'ranked' }, now - day);
const rankedNext = admitRun(fresh(), { ...config, access: 'ranked' }, Date.UTC(2026, 10, 1));
assert.ok(rankedA.run && rankedB.run && rankedNext.run);
assert.equal(rankedA.run.seed, rankedB.run.seed, 'same UTC month/rules share comparable seed');
assert.notEqual(rankedA.run.seed, rankedNext.run.seed, 'UTC month rollover rotates local seed');
assert.equal(rankedA.run.speed, 1);
assert.equal(rankedA.run.config.speed, 1);
assert.equal(rankedA.state.battleCheckpoint!.speed, 1);
assert.equal(rankedA.run.rulesVersion, LOCAL_RANKED_RULES_VERSION);
const rankedScoreA = settleRun(rankedA.state, rankedA.run, summary, now).localScores[0];
const rankedScoreB = settleRun(rankedB.state, rankedB.run, summary, now).localScores[0];
assert.equal(rankedScoreA.partition, rankedScoreB.partition);
assert.equal(rankedScoreA.seed, rankedScoreB.seed);
assert.equal(rankedScoreA.speed, 1);
assert.equal(rankedScoreA.period, '2026-10');
assert.equal(rankedScoreA.verified, false);
assert.equal(settleRun(rankedA.state, rankedA.run, { ...summary, speed: 4 }, now), rankedA.state);

for (const fault of ['throw', 'wrong'] as const) {
  disk.set(LS_KEY, JSON.stringify(valuable));
  loadState();
  const a = admitRun(valuable, config, now);
  assert.ok(a.run);
  primaryJustWritten = false;
  postWriteFault = fault;
  assert.equal(saveState(a.state), false);
  assert.equal(getPersistenceRecoveryError()!.code, 'STORAGE_WRITE_UNCERTAIN');
  assert.equal(JSON.parse(disk.get(LS_KEY)!).dailyFreeLeft, a.state.dailyFreeLeft, 'failed ack may already have debited');
  const committedRaw = disk.get(LS_KEY);
  assert.equal(saveState(valuable), false, 'uncertain write forbids overwriting with stale UI state');
  assert.equal(disk.get(LS_KEY), committedRaw);
  postWriteFault = null;
  assert.equal(retryStatePersistence({ ...a.state, paidRuns: 0 }), false, 'retry must use exact original pending snapshot');
  assert.equal(retryStatePersistence(a.state), true);
  assert.equal(loadState().dailyFreeLeft, a.state.dailyFreeLeft);
  assert.equal(getRecoverableCheckpoint(loadState())!.runId, a.run.id);
  assert.equal(loadState().paidRuns, valuable.paidRuns);
}
disk.set(LS_KEY, JSON.stringify(valuable));
loadState();
const uncertain = admitRun(valuable, config, now);
primaryJustWritten = false;
postWriteFault = 'throw';
assert.equal(saveState(uncertain.state), false);
postWriteFault = null;
const external = JSON.stringify({ ...valuable, tokens: 777 });
disk.set(LS_KEY, external);
assert.equal(retryStatePersistence(uncertain.state), false, 'cannot overwrite a different durable economic snapshot');
assert.equal(disk.get(LS_KEY), external);
assert.equal(loadState().tokens, 777);
const paymentReceipt = { id: 'legacy-receipt-1', quoteId: 'legacy-quote', signature: 'legacy-signature-1', payer: 'payer',
  recipient: 'recipient', lamports: 1000, runs: 3, cluster: 'devnet' as const };
const legacyPayment = applyPaymentReceipt(valuable, paymentReceipt);
assert.equal(saveState(legacyPayment), true);
const legacyPaymentReload = loadState();
assert.deepEqual(legacyPaymentReload.paymentReceiptIds, [paymentReceipt.id]);
assert.deepEqual(legacyPaymentReload.paymentSignatures, [paymentReceipt.signature]);
assert.equal(applyPaymentReceipt(legacyPaymentReload, paymentReceipt), legacyPaymentReload, 'legacy paid-run receipt remains deduplicated after reload');
assert.equal(applyPaymentReceipt(legacyPaymentReload, { ...paymentReceipt, id: 'other-id' }), legacyPaymentReload, 'legacy signature remains deduplicated after reload');
assert.equal(saveState(switched), false, 'foreign-owner candidate is rejected before any write');
assert.equal(saveState(legacyPaymentReload), true, 'invalid candidate must not lock valid persisted profile');
console.log('domain regression: persistence fault injection, schema, checkpoints, UTC claims, 1k referrals, ownership, Continue and score partitions passed');
