import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import { PublicKey } from '@solana/web3.js';
import type { ComponentProps } from 'react';
import type { CommercePurchases } from '../components/CommercePurchases';
import { DEFAULT_STATE, LS_KEY, CONTINUE_LIVES, STD_PER_LIFE, StorageRecoveryError,
  loadState, saveState, todayStr, persistBattleCheckpoint, getRecoverableCheckpoint, getPersistenceRecoveryError } from '../state/store';
import type { GameState } from '../state/store';
import { admitRun, settleRun, continueRun, canContinueRun, continuePrice, runOwnedByState } from '../state/runs';
import type { RunConfig } from '../state/runs';
import * as commerce from './commerce';
import type { CommerceCatalog, CommerceQuote, CommerceReceipt, CommerceStorage } from './commerce';

const now = Date.UTC(2026, 9, 7, 12);
const uid = 'offline-audit-owner';
const payer = new PublicKey(new Uint8Array(32).fill(11)).toBase58();
const other = new PublicKey(new Uint8Array(32).fill(12)).toBase58();
const config: RunConfig = { access: 'standard', mode: 'endless', waveLimit: 10, durationMinutes: 10 };
const loss = { completedWaves: 0, victory: false, uniqueTowerTypes: 0, noLeakWave: false };
const fresh = (extra: Partial<GameState> = {}): GameState => ({ ...structuredClone(DEFAULT_STATE),
  lastRunReset: todayStr(now), challengesResetDate: todayStr(now), ...extra });

type Fault = '' | 'throw-primary' | 'drop-primary' | 'uncertain-primary';
async function withDisk(task: (disk: CommerceStorage & { values: Map<string, string>; fault: Fault }) => unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let unreadable = false;
  const disk = { values: new Map<string, string>(), fault: '' as Fault,
    getItem(key: string) {
      if (key === LS_KEY && unreadable) { unreadable = false; throw new Error('offline readback failure'); }
      return this.values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (key === LS_KEY && this.fault === 'throw-primary') throw new Error('offline quota');
      if (key === LS_KEY && this.fault === 'drop-primary') return;
      this.values.set(key, value);
      if (key === LS_KEY && this.fault === 'uncertain-primary') unreadable = true;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: disk });
  try { loadState(); await task(disk); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

test('guest checkpoint/claims/inventory remain owned across real account switches and durable reload', () => withDisk(disk => {
  const guest = fresh({ commerceAccount: 'guest', tokens: 140, lives: 13, paidRuns: 2, dailyFreeLeft: 1,
    unlockedSkins: ['canon-legacy'], equippedSkins: { ...DEFAULT_STATE.equippedSkins, canon: 'canon-legacy' },
    challengeProgress: { no_leak: 1 }, challengeClaimed: { no_leak: true }, lastBonusClaim: now,
    streak: 6, loginClaimedToday: true });
  const admission = admitRun(guest, config, now);
  assert.ok(admission.run);
  assert.equal(saveState(admission.state), true);
  const checkpoint = getRecoverableCheckpoint(loadState());
  for (const [accountUid, wallet] of [[uid, payer], [uid, other], ['offline-other-uid', payer]]) {
    const foreign = commerce.switchCommerceAccount(admission.state, accountUid, wallet);
    assert.equal(runOwnedByState(foreign, admission.run), false);
    assert.equal(foreign.lives, 0); assert.equal(foreign.tokens, 0);
    assert.deepEqual(foreign.unlockedSkins, []); assert.deepEqual(foreign.challengeClaimed, {});
    assert.strictEqual(settleRun(foreign, admission.run, { ...loss, completedWaves: 2 }, now), foreign);
    assert.equal(admitRun(foreign, config, now).run, null);
    assert.equal(continueRun(foreign, admission.run, now).run, null);
    assert.throws(() => persistBattleCheckpoint(foreign, checkpoint!), StorageRecoveryError);
    assert.throws(() => getRecoverableCheckpoint(foreign), StorageRecoveryError);
    const raw = disk.values.get(LS_KEY);
    assert.equal(saveState(foreign), false);
    assert.equal(disk.values.get(LS_KEY), raw, 'foreign ownership never replaces the durable guest run');
    assert.deepEqual(loadState().activeRun, admission.run, 'B recovery gate requires a successful reload before another write');
    const restored = commerce.switchCommerceAccount(foreign, null, null);
    for (const key of ['tokens', 'lives', 'paidRuns', 'unlockedSkins', 'equippedSkins', 'challengeProgress',
      'challengeClaimed', 'streak', 'lastBonusClaim', 'loginClaimedToday'] as const) assert.deepEqual(restored[key], guest[key], key);
    assert.equal(saveState(restored), true);
    const reloaded = loadState();
    assert.deepEqual(reloaded.activeRun, admission.run);
    assert.deepEqual(getRecoverableCheckpoint(reloaded), checkpoint);
    assert.equal(reloaded.dailyFreeLeft, 0, 'shared free quota is not refunded by a scope round-trip');
    assert.equal(admitRun(reloaded, config, now).state.paidRuns, 2);
  }
}));

test('legacy life credits conserve inventory/value through failed Continue, scope return, reload and authorized retry', () => withDisk(disk => {
  for (const lives of [3, 10, 17]) {
    disk.values.clear(); loadState();
    const legacy: Partial<GameState> = fresh({ tokens: 150, lives, paidRuns: 2, dailyFreeLeft: 0 });
    delete legacy.schemaVersion; delete legacy.commerceAccount;
    disk.values.set(LS_KEY, JSON.stringify(legacy));
    const admission = admitRun(loadState(), config, now);
    assert.ok(admission.run); assert.equal(admission.run.debit, 'paid');
    const checkpoint = structuredClone(admission.state.battleCheckpoint!);
    checkpoint.battle.lives = 0; checkpoint.battle.gameOver = true;
    const defeated = settleRun(persistBattleCheckpoint(admission.state, checkpoint), admission.run, loss, now);
    assert.equal(saveState(defeated), true);
    const foreign = { ...commerce.switchCommerceAccount(defeated, uid, payer), tokens: 500, lives: 50 };
    assert.equal(continueRun(foreign, admission.run, now).run, null);
    assert.equal(foreign.tokens, 500); assert.equal(foreign.lives, 50);
    const owner = commerce.switchCommerceAccount(foreign, null, null);
    assert.equal(owner.lives, lives); assert.equal(owner.tokens, 150);
    assert.equal(canContinueRun(owner, admission.run), true);
    const cost = continuePrice(owner, admission.run);
    const continued = continueRun(owner, admission.run, now);
    assert.ok(continued.run);
    assert.equal(owner.lives - continued.state.lives + cost / STD_PER_LIFE, CONTINUE_LIVES);
    disk.fault = 'throw-primary';
    assert.equal(saveState(continued.state), false);
    disk.fault = '';
    const beforeRetry = loadState();
    assert.equal(beforeRetry.tokens, 150); assert.equal(beforeRetry.lives, lives);
    assert.equal(beforeRetry.runLedger[admission.run.id].continuedCount, 0);
    const retry = continueRun(beforeRetry, admission.run, now);
    assert.equal(saveState(retry.state), true);
    const durable = loadState();
    assert.equal(durable.tokens, 150 - cost);
    assert.equal(durable.lives, Math.max(0, lives - CONTINUE_LIVES));
    assert.equal(durable.paidRuns, 1, 'Continue never consumes another admission');
    assert.equal(getRecoverableCheckpoint(durable)!.battle.lives, CONTINUE_LIVES);
    const repeated = continueRun(durable, admission.run, now);
    assert.strictEqual(repeated.state, durable);
    assert.equal(repeated.state.runLedger[admission.run.id].continuedCount, 1);
  }
}));

test('guest-defeat STD top-up cannot migrate owner or credits: actual save rejects foreign checkpoint without locking owner', () => withDisk(disk => {
  const guest = fresh({ commerceAccount: 'guest', tokens: 15, lives: 2, unlockedSkins: ['guest-legacy'] });
  const admission = admitRun(guest, config, now);
  assert.ok(admission.run);
  const checkpoint = structuredClone(admission.state.battleCheckpoint!);
  checkpoint.battle.lives = 0; checkpoint.battle.gameOver = true;
  const defeated = settleRun(persistBattleCheckpoint(admission.state, checkpoint), admission.run, loss, now);
  assert.equal(defeated.activeRun, null);
  assert.equal(saveState(defeated), true);
  const original = disk.values.get(LS_KEY);
  const connected = { ...commerce.switchCommerceAccount(defeated, uid, payer), walletConnected: true, walletAddr: payer };
  const receipt: CommerceReceipt = { id: 'offline-std-receipt', quoteId: 'f'.repeat(32), signature: '4'.repeat(88),
    payer, runs: 0, std: 500, status: 'confirmed' };
  const credited = commerce.applyScopedCommerceReceipt(connected, receipt, uid);
  assert.equal(credited.tokens, 500, 'speculative credit belongs to wallet account, never guest');
  assert.equal(credited.commerceAccounts?.guest.tokens, 15);
  assert.equal(continueRun(credited, admission.run, now).run, null);
  assert.equal(saveState(credited), false);
  assert.equal(getPersistenceRecoveryError()?.code, 'CHECKPOINT_RECOVERY_REQUIRED');
  assert.equal(disk.values.get(LS_KEY), original);
  const back = commerce.switchCommerceAccount(connected, null, null);
  assert.equal(back.tokens, 15); assert.equal(back.lives, 2);
  assert.equal(saveState(defeated), true, 'rejected pre-write candidate must not poison the valid owner save');
  const recovered = loadState();
  assert.equal(recovered.commerceAccount, 'guest');
  assert.equal(recovered.tokens, 15); assert.deepEqual(recovered.unlockedSkins, ['guest-legacy']);
  assert.deepEqual(getRecoverableCheckpoint(recovered), checkpoint);
  assert.equal(canContinueRun(recovered, admission.run), false, 'foreign top-up never funds guest Continue');
  assert.equal(saveState(recovered), true);
}));

type PurchaseProps = ComponentProps<typeof CommercePurchases>;
type Element = { type?: unknown; props?: { children?: unknown; onClick?: () => void; disabled?: boolean } };
function mountPurchases(props: PurchaseProps) {
  const slots: unknown[] = []; let cursor = 0, effects: (() => void)[] = [], tree: unknown;
  const hooks = {
    useState(initial: unknown) {
      const i = cursor++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], (value: unknown) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
    },
    useRef(initial: unknown) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(action: () => (() => void) | void, deps: unknown[]) {
      const i = cursor++, previous = slots[i] as { deps: unknown[]; cleanup?: () => void } | undefined;
      if (!previous || deps.some((value, index) => value !== previous.deps[index])) {
        previous?.cleanup?.(); const slot = { deps, cleanup: undefined as (() => void) | undefined }; slots[i] = slot;
        effects.push(() => { slot.cleanup = action() || undefined; });
      }
    },
  };
  const filename = join(__dirname, '../components/CommercePurchases.tsx');
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} as { CommercePurchases?: (props: PurchaseProps) => unknown } };
  runInNewContext(compiled, { module, exports: module.exports, AbortController, console, Date, setTimeout, clearTimeout,
    require: (id: string) => {
      if (id === 'react') return hooks;
      if (id === 'react/jsx-runtime') return require(id);
      if (id === '../services/commerce') return commerce;
      if (id === '../services/commerceRuntime') return {};
      if (id.endsWith('.css')) return {};
      throw new Error('OFFLINE_COMPONENT_DEPENDENCY_DENIED');
    },
  }, { filename });
  const render = () => { cursor = 0; tree = module.exports.CommercePurchases!(props); };
  function text(value: unknown): string {
    if (value == null || typeof value === 'boolean') return '';
    if (typeof value !== 'object') return String(value);
    return [(value as Element).props?.children].flat(Infinity).map(text).join('');
  }
  function find(value: unknown, label: string): Element | undefined {
    if (!value || typeof value !== 'object') return;
    const node = value as Element;
    if (node.type === 'button' && text(node).includes(label)) return node;
    for (const child of [node.props?.children].flat(Infinity)) { const found = find(child, label); if (found) return found; }
  }
  return {
    async flush() {
      for (let i = 0; i < 8; i++) { render(); const jobs = effects; effects = []; jobs.forEach(job => job());
        await new Promise<void>(resolve => setImmediate(resolve)); }
      render();
    },
    click(label: string) { render(); const button = find(tree, label); assert.ok(button, `Missing ${label}`);
      assert.equal(button.props?.disabled, false); button.props?.onClick?.(); },
    content: () => text(tree),
    unmount() { for (const slot of slots) (slot as { cleanup?: () => void } | null)?.cleanup?.(); },
  };
}

for (const fault of ['throw-primary', 'drop-primary', 'uncertain-primary'] as const) {
  test(`actual checkout/journal/store: ${fault} cannot trigger onComplete admission; acknowledged receipt survives reload`, () => withDisk(async disk => {
    const id = 'e'.repeat(32), signature = '3'.repeat(88);
    const quote: CommerceQuote = { id, productId: 'runs-3', currency: 'SOL', amount: '1000', decimals: 9, mint: null,
      payer, recipient: other, cluster: 'devnet', genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
      expiresAt: now + 60000, runs: 3, std: 0, memo: `SEEKER:TD/commerce/v1/${id}` };
    const receipt: CommerceReceipt = { id, quoteId: id, signature, payer, runs: 3, std: 0, status: 'confirmed' };
    const catalog: CommerceCatalog = { enabled: true, reason: null, cluster: 'devnet', genesisHash: quote.genesisHash,
      recipient: other, products: [] };
    let current = { ...commerce.switchCommerceAccount(fresh({ dailyFreeLeft: 0 }), uid, payer), walletConnected: true, walletAddr: payer };
    assert.equal(saveState(current), true);
    commerce.recordCommercePending(disk, { uid, quote, signature });
    let calls = 0, callbacks = 0;
    const client = commerce.createCommerceClient({ url: 'https://offline.invalid', getUid: async () => uid,
      getToken: async () => 'offline-token', getSession: async () => ({ uid, token: 'offline-token' }), getCurrentUid: () => uid,
      storage: disk, now: () => now, fetch: async url => {
        const route = new URL(String(url)).pathname;
        assert.ok(['/commerce/catalog', '/commerce/receipt'].includes(route), 'no quote, wallet, signing or broadcast');
        calls++; return new Response(JSON.stringify(route === '/commerce/catalog' ? catalog : receipt));
      } });
    const props: PurchaseProps = { state: current, kind: 'runs', client, getUid: async () => uid,
      setState(update) {
        const next = update(current);
        if (!saveState(next)) return false;
        current = next; props.state = next; return true;
      },
      onComplete(confirmed) {
        assert.equal(confirmed.quoteId, id); callbacks++;
        const admission = admitRun(current, config, now);
        assert.ok(admission.run);
        assert.equal(saveState(admission.state), true);
        current = admission.state; props.state = current;
      },
    };
    let mounted = mountPurchases(props);
    try {
      await mounted.flush(); disk.fault = fault;
      mounted.click('Check status'); await mounted.flush();
      assert.equal(callbacks, 0); assert.equal(current.paidRuns, 0); assert.equal(current.activeRun, null);
      assert.doesNotMatch(mounted.content(), /Purchase complete/);
      assert.equal(client.pending().length, 1);
      assert.deepEqual(client.pending()[0].confirmedReceipt, receipt, 'journal acknowledgement is independent of failed profile save');
      mounted.unmount(); disk.fault = '';
      current = loadState(); props.state = current;
      assert.equal(current.activeRun, null);
      assert.equal(current.paidRuns, fault === 'uncertain-primary' ? 3 : 0,
        'false return does not prove rollback when the primary write succeeded but readback failed');
      mounted = mountPurchases(props); await mounted.flush();
      if (fault !== 'uncertain-primary') {
        mounted.click('Check status'); await mounted.flush();
        assert.equal(callbacks, 1); assert.equal(current.paidRuns, 2);
        const durable = loadState(); assert.equal(durable.paidRuns, 2); assert.ok(durable.activeRun);
        assert.deepEqual(durable.commerceQuoteIds, [id]);
        assert.strictEqual(commerce.applyScopedCommerceReceipt(durable, receipt, uid), durable);
        const repeated = admitRun(durable, config, now);
        assert.equal(repeated.run?.id, durable.activeRun.id); assert.equal(repeated.state.paidRuns, 2);
      } else assert.equal(callbacks, 0, 'reload is not permission to auto-admit from a previously uncertain write');
      assert.equal(client.pending().length, 1); assert.ok(calls >= 3);
    } finally { mounted.unmount(); }
  }));
}
