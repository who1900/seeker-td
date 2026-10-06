import { strict as assert } from 'node:assert';
import { DEFAULT_STATE, applyDailyReset, migrateRunState, todayStr, loadState, saveState } from './store';
import type { GameState } from './store';
import { admitRun, abandonRun, settleRun as settleAt, continueRun as continueAt } from './runs';
import type { RunSession } from './runs';
import type { RunConfig, RunSummary } from './runs';

const now = Date.UTC(2026, 9, 4, 23, 59);
const config: RunConfig = { mode: 'endless', access: 'standard', waveLimit: 10, durationMinutes: 10 };
const summary: RunSummary = { completedWaves: 3, victory: false, uniqueTowerTypes: 4, noLeakWave: true };
const settleRun = (s: GameState, r: RunSession, result: RunSummary) => settleAt(s, r, result, now);
const continueRun = (s: GameState, r: RunSession) => continueAt(s, r, now);
const fresh = (extra: Partial<GameState> = {}): GameState => ({
  ...structuredClone(DEFAULT_STATE), lastRunReset: todayStr(now), challengesResetDate: todayStr(now), ...extra,
});
const restart = (s: GameState): GameState => JSON.parse(JSON.stringify(s));

const zero = fresh({ dailyFreeLeft: 0 });
assert.equal(admitRun(zero, config, now).run, null);
assert.deepEqual(zero, fresh({ dailyFreeLeft: 0 }));
const free = admitRun(fresh({ paidRuns: 2 }), config, now);
assert.ok(free.run);
assert.equal(free.state.dailyFreeLeft, 2);
assert.equal(free.state.paidRuns, 2);
assert.equal(free.state.totalRuns, 1);
assert.deepEqual(admitRun(restart(free.state), config, now + 1), { state: restart(free.state), run: free.run });
assert.equal(admitRun(free.state, { ...config, access: 'ranked' }, now).run, null);
const paid = admitRun(fresh({ dailyFreeLeft: 0, paidRuns: 1 }), config, now);
assert.ok(paid.run);
assert.equal(paid.run.debit, 'paid');
assert.equal(paid.state.paidRuns, 0);
assert.equal(paid.state.dailyFreeLeft, 0);
const finishedPaid = settleRun(paid.state, paid.run, summary);
assert.equal(admitRun(restart(finishedPaid), config, now).run, null);

const practice = admitRun(zero, { ...config, access: 'practice' }, now);
assert.ok(practice.run);
const practiced = settleRun(practice.state, practice.run, { ...summary, victory: true });
for (const key of ['tokens', 'paidRuns', 'dailyFreeLeft', 'totalRuns', 'lastPlayed', 'bestWave', 'localScores', 'challengeProgress', 'challengesResetDate'] as const) {
  assert.deepEqual(practiced[key], zero[key], key);
}
assert.deepEqual(settleRun(restart(practiced), practice.run, summary), practiced);

const settled = settleRun(free.state, free.run, summary);
assert.equal(settled.tokens, DEFAULT_STATE.tokens + 15);
assert.equal(settled.challengeProgress.win_3, undefined);
assert.equal(settled.challengeProgress.no_leak, 1);
assert.equal(settled.challengeProgress.use_4, 4);
assert.equal(settled.localScores.length, 1);
assert.deepEqual(settleRun(restart(settled), free.run, summary), settled);
assert.deepEqual(settleRun(settled, free.run, { ...summary, completedWaves: 5 }), settled);
const reopened = continueRun(restart(settled), free.run);
assert.ok(reopened.run);
assert.deepEqual(continueRun(reopened.state, free.run), reopened);
assert.deepEqual(admitRun(reopened.state, config, now), reopened);
const continued = settleRun(reopened.state, free.run, { ...summary, completedWaves: 5, victory: true });
assert.equal(continued.tokens, DEFAULT_STATE.tokens + 25 - 50);
assert.equal(continued.challengeProgress.win_3, 1);
assert.equal(continued.localScores.length, 1);
assert.equal(continueRun(continued, free.run).run, null);
const twice = settleRun(continued, free.run, { ...summary, completedWaves: 6, victory: true });
assert.equal(twice.challengeProgress.win_3, 1);
assert.equal(twice.tokens, DEFAULT_STATE.tokens + 25 - 50);
assert.deepEqual(settleRun(twice, free.run, summary), twice);
const newAdmission = admitRun(restart(twice), config, now);
assert.ok(newAdmission.run);
assert.notEqual(newAdmission.run.id, free.run.id);
assert.equal(newAdmission.state.dailyFreeLeft, 1);

const ranked = admitRun(fresh(), { ...config, access: 'ranked' }, now);
assert.ok(ranked.run);
const rankedSettled = settleRun(ranked.state, ranked.run, summary);
assert.equal(continueRun(rankedSettled, ranked.run).run, null);
assert.deepEqual(settleRun(rankedSettled, ranked.run, { ...summary, completedWaves: 10 }), rankedSettled);
const empty = settleRun(free.state, free.run, { ...summary, completedWaves: 0, victory: true });
assert.equal(empty.tokens, DEFAULT_STATE.tokens);
assert.equal(empty.challengeProgress.no_leak, undefined);
assert.equal(empty.challengeProgress.win_3, undefined);
assert.equal(empty.localScores.length, 0);

const tomorrow = Date.UTC(2026, 9, 5);
const longRun = settleAt({ ...free.state, challengesResetDate: todayStr(tomorrow), challengeProgress: { win_3: 2 } }, free.run, summary, tomorrow);
assert.equal(longRun.challengesResetDate, todayStr(tomorrow));
assert.equal(longRun.challengeProgress.win_3, 2);
assert.deepEqual(settleRun(newAdmission.state, free.run, { ...summary, completedWaves: 20 }), newAdmission.state);
assert.equal(continueRun({ ...settled, tokens: 49 }, free.run).run, null);
const practiceDefeat = settleRun(practice.state, practice.run, summary);
assert.equal(continueRun(practiceDefeat, practice.run).state.tokens, zero.tokens);
assert.equal(todayStr(tomorrow - 1), '2026-10-04');
assert.equal(todayStr(tomorrow), '2026-10-05');
const reset = applyDailyReset(fresh({ dailyFreeLeft: 0, paidRuns: 7 }), tomorrow);
assert.equal(reset.dailyFreeLeft, 3);
assert.equal(reset.paidRuns, 7);
assert.deepEqual(applyDailyReset(reset, tomorrow), reset);
assert.equal(admitRun(reset, config, tomorrow).state.dailyFreeLeft, 2);
const old = { ...fresh(), dailyFreeLeft: 8 } as Partial<GameState>;
delete old.paidRuns;
const migrated = migrateRunState(old as GameState);
assert.equal(migrated.dailyFreeLeft, 3);
assert.equal(migrated.paidRuns, 5);
assert.deepEqual(migrateRunState(migrated), migrated);
assert.equal(applyDailyReset(old as GameState, tomorrow).paidRuns, 5);
assert.equal(migrateRunState(fresh({ dailyFreeLeft: 8, paidRuns: 2 })).paidRuns, 2);
assert.equal(migrateRunState({ ...old, dailyFreeLeft: 2 } as GameState).paidRuns, 0);

for (const bad of [null, {}, { ...config, mode: 'bad' }, { ...config, access: 'bad' },
  { ...config, waveLimit: 0 }, { ...config, waveLimit: -1 }, { ...config, waveLimit: 1.5 },
  { ...config, waveLimit: Infinity }, { ...config, durationMinutes: 15 }, { ...config, durationMinutes: '10' }]) {
  assert.equal(admitRun(fresh(), bad as RunConfig, now).run, null);
}
assert.equal(admitRun(fresh(), config, NaN).run, null);
assert.deepEqual(settleRun(free.state, { ...free.run, id: 'forged' }, summary), free.state);
assert.deepEqual(settleRun(free.state, { ...free.run, config: { ...config, access: 'practice' } }, summary), free.state);
assert.deepEqual(settleRun(free.state, free.run, { ...summary, completedWaves: NaN }), free.state);
const waves = admitRun(fresh(), { ...config, mode: 'waves', waveLimit: 3 }, now);
assert.ok(waves.run);
assert.deepEqual(settleRun(waves.state, waves.run, { ...summary, completedWaves: 4 }), waves.state);
assert.equal(settleRun(waves.state, waves.run, { ...summary, victory: true }).challengeProgress.win_3, 1);

let stored: string | null = null;
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; },
} });
saveState(settled);
const loaded = loadState();
assert.deepEqual(settleRun(loaded, free.run, summary), loaded);
stored = JSON.stringify(old);
assert.equal(loadState().paidRuns, 5);
saveState(free.state);
const reload = loadState();
assert.ok(reload.activeRun);
const abandoned = abandonRun(reload, reload.activeRun);
assert.equal(abandoned.activeRun, null);
assert.deepEqual(abandonRun(abandoned, free.run), abandoned);
assert.equal(continueRun(abandoned, free.run).run, null);
assert.deepEqual(settleRun(abandoned, free.run, summary), abandoned);
const afterAbandon = admitRun(restart(abandoned), { ...config, mode: 'timed' }, now);
assert.ok(afterAbandon.run);
assert.notEqual(afterAbandon.run.id, free.run.id);
assert.equal(afterAbandon.state.dailyFreeLeft, free.state.dailyFreeLeft - 1);
assert.equal(afterAbandon.run.config.mode, 'timed');
assert.deepEqual(abandonRun(free.state, { ...free.run, config: { ...config, mode: 'timed' } }), free.state);
const corrupted = migrateRunState({ ...free.state, activeRun: { ...free.run, config: { ...config, durationMinutes: 15 } } } as unknown as GameState);
assert.equal(corrupted.activeRun, null);
assert.equal(corrupted.runLedger[free.run.id].abandoned, true);
assert.equal(continueRun(corrupted, free.run).run, null);
assert.deepEqual(settleRun(corrupted, free.run, summary), corrupted);
assert.equal(migrateRunState({ ...free.state, runSequence: 0 }).runSequence, 1);
for (const timestamp of [NaN, Infinity, -1, 8.64e15 + 1, null, 'invalid']) {
  const damagedRun = { ...free.run, startedAt: timestamp };
  const damaged = migrateRunState({ ...free.state, activeRun: damagedRun,
    runLedger: { [free.run.id]: { ...free.state.runLedger[free.run.id], run: damagedRun } },
  } as unknown as GameState);
  assert.equal(damaged.activeRun, null);
  assert.equal(continueRun(damaged, free.run).run, null);
  assert.deepEqual(settleRun(damaged, free.run, summary), damaged);
}
assert.deepEqual(settleRun(settled, { ...free.run, startedAt: now + 1 }, { ...summary, completedWaves: 100 }), settled);
assert.deepEqual(settleRun(settled, free.run, { ...summary, completedWaves: 100 }), settled);
const canonicalFreeRun = free.run;
const fullLedger = Object.fromEntries(Array.from({ length: 4096 }, (_, i) => {
  const id = `local-${i + 1}`;
  return [id, { ...settled.runLedger[canonicalFreeRun.id], run: { ...canonicalFreeRun, id } }];
}));
const full = fresh({ runLedger: fullLedger, runSequence: 4096 });
const compacted = admitRun(full, config, now);
assert.ok(compacted.run);
assert.equal(compacted.run.id, 'local-4097');
assert.equal(Object.keys(compacted.state.runLedger).length, 1);
assert.equal(continueRun(compacted.state, canonicalFreeRun).run, null);
assert.deepEqual(settleRun(compacted.state, canonicalFreeRun, summary), compacted.state);
assert.equal(continueRun(restart(settled), canonicalFreeRun).run?.id, canonicalFreeRun.id);
let practiceLoopState = fresh({ dailyFreeLeft: 0, paidRuns: 0 });
let oldestPractice: RunSession | null = null;
for (let i = 0; i < 4200; i++) {
  const admission = admitRun(restart(practiceLoopState), { ...config, access: 'practice' }, now);
  assert.ok(admission.run);
  if (!oldestPractice) oldestPractice = admission.run;
  assert.equal(admission.state.runSequence, i + 1);
  assert.equal(Object.keys(admission.state.runLedger).length, 1);
  assert.deepEqual(admitRun(admission.state, admission.run.config, now), admission);
  practiceLoopState = i % 2 === 0 ? settleRun(admission.state, admission.run, summary)
    : abandonRun(admission.state, admission.run);
}
assert.ok(oldestPractice);
assert.equal(practiceLoopState.runSequence, 4200);
assert.equal(Object.keys(practiceLoopState.runLedger).length, 1);
assert.equal(practiceLoopState.tokens, DEFAULT_STATE.tokens);
assert.equal(practiceLoopState.dailyFreeLeft, 0);
assert.equal(practiceLoopState.paidRuns, 0);
assert.equal(practiceLoopState.totalRuns, 0);
assert.equal(continueRun(practiceLoopState, oldestPractice).run, null);
assert.deepEqual(settleRun(practiceLoopState, oldestPractice, summary), practiceLoopState);
assert.deepEqual(abandonRun(practiceLoopState, oldestPractice), practiceLoopState);
console.log('runs regression: all assertions passed');
