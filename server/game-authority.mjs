import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { address, encoded, exact, hex, timeValid, uidValid, uint } from './commerce-common.mjs';

const fail = (code = 'AUTHORITY_DENIED') => { throw new Error(code); };
const balanceValid = b => exact(b, ['runs', 'std']) && uint(b.runs) && uint(b.std);
const snapshotKeys = ['version', 'uid', 'payer', 'balances', 'free', 'settlementEnabled', 'payoutEnabled'];
const receiptKeys = ['version', 'requestId', 'uid', 'payer', 'policyVersion', 'action', 'amount', 'committedAt', 'balances', 'free', 'settlementEnabled', 'payoutEnabled'];
const policyId = v => typeof v === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(v);
const epochDay = time => Math.floor(time / 86400000);
const requestKey = requestId => `authorityRequests/${requestId}`;
const fingerprint = policy => createHash('sha256').update(JSON.stringify(policy)).digest('hex');

// This is a debit ledger, not gameplay admission or evidence of a verified run.
export function createGameAuthorityService({ authenticateToken, store, policy, enabled = false, now = Date.now } = {}) {
  if (typeof authenticateToken !== 'function' || typeof store?.transaction !== 'function' || typeof now !== 'function'
    || typeof enabled !== 'boolean' || !exact(policy, ['version', 'freeRunsPerUtcDay', 'stdCosts'])
    || !policyId(policy.version) || !Number.isSafeInteger(policy.freeRunsPerUtcDay)
    || policy.freeRunsPerUtcDay < 0 || policy.freeRunsPerUtcDay > 100 || Object.is(policy.freeRunsPerUtcDay, -0)
    || !policy.stdCosts || Object.getPrototypeOf(policy.stdCosts) !== Object.prototype
    || Reflect.ownKeys(policy.stdCosts).length > 32) fail('AUTHORITY_CONFIG');
  const costs = {};
  for (const key of Reflect.ownKeys(policy.stdCosts)) {
    const d = Object.getOwnPropertyDescriptor(policy.stdCosts, key);
    if (!policyId(key) || ['paid-run', 'free-run', '__proto__', 'constructor', 'prototype'].includes(key)
      || !d.enumerable || !Object.hasOwn(d, 'value') || !uint(d.value) || d.value === '0') fail('AUTHORITY_CONFIG');
    costs[key] = d.value;
  }
  const trusted = Object.freeze({ version: policy.version, freeRunsPerUtcDay: policy.freeRunsPerUtcDay,
    stdCosts: Object.freeze(Object.fromEntries(Object.entries(costs).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))) });
  const policyHash = fingerprint(trusted);
  const clock = () => { const time = now(); if (!timeValid(time) || Object.is(time, -0)) fail(); return time; };
  const request = (body, debit) => {
    if (!enabled) fail('AUTHORITY_DISABLED');
    if (!exact(body, debit ? ['version', 'uid', 'payer', 'requestId', 'policyVersion', 'action', 'amount']
      : ['version', 'uid', 'payer']) || body.version !== 1 || !uidValid(body.uid) || !address(body.payer)) fail();
    if (debit && (!hex(body.requestId) || body.policyVersion !== trusted.version
      || typeof body.action !== 'string' || !(body.action === 'paid-run' || body.action === 'free-run' || Object.hasOwn(costs, body.action))
      || !uint(body.amount) || body.amount !== (body.action === 'free-run' ? '0'
        : body.action === 'paid-run' ? '1' : costs[body.action]))) fail();
    return Object.freeze({ ...body });
  };
  const auth = async (token, body) => {
    if (typeof token !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(token)) fail();
    const result = await authenticateToken(token);
    if (!uidValid(result?.uid) || result.uid !== body.uid) fail();
  };
  const read = async (tx, body, time, debit) => {
    if (typeof tx?.get !== 'function' || typeof tx?.set !== 'function') fail('AUTHORITY_STORE');
    const uidKey = encoded(body.uid), walletKey = encoded(body.payer);
    const keys = { balance: `commerceBalances/${uidKey}`, uidQuota: `authorityUidQuota/${uidKey}`,
      walletQuota: `authorityWalletQuota/${walletKey}` };
    const [bound, owner, storedBalance, uq, wq, prior] = await Promise.all([
      tx.get(`identityUids/${uidKey}`), tx.get(`identityWallets/${walletKey}`), tx.get(keys.balance),
      tx.get(keys.uidQuota), tx.get(keys.walletQuota), debit ? tx.get(requestKey(body.requestId)) : undefined,
    ]);
    if (!exact(bound, ['wallet']) || bound.wallet !== body.payer || !exact(owner, ['uid']) || owner.uid !== body.uid) fail();
    const balances = storedBalance === undefined ? { runs: '0', std: '0' } : storedBalance;
    if (!balanceValid(balances)) fail('AUTHORITY_BALANCE');
    const day = epochDay(time);
    const used = q => {
      if (q === undefined) return 0;
      if (!exact(q, ['day', 'used']) || !Number.isSafeInteger(q.day) || q.day < 0 || q.day > day
        || !Number.isSafeInteger(q.used) || q.used < 0 || q.used > 100) fail('AUTHORITY_QUOTA');
      return q.day === day ? q.used : 0;
    };
    const uidUsed = used(uq), walletUsed = used(wq);
    const free = { day, remaining: Math.max(0, trusted.freeRunsPerUtcDay - Math.max(uidUsed, walletUsed)) };
    return { keys, balances, free, uidUsed, walletUsed, prior };
  };
  const receiptValid = (r, body) => exact(r, receiptKeys) && r.version === 1 && r.requestId === body.requestId
    && r.uid === body.uid && r.payer === body.payer && r.policyVersion === trusted.version
    && r.action === body.action && r.amount === body.amount && timeValid(r.committedAt)
    && balanceValid(r.balances) && exact(r.free, ['day', 'remaining'])
    && r.free.day === epochDay(r.committedAt) && Number.isSafeInteger(r.free.remaining)
    && r.free.remaining >= 0 && r.free.remaining <= trusted.freeRunsPerUtcDay
    && r.settlementEnabled === false && r.payoutEnabled === false;
  return Object.freeze({
    async balance(token, body) {
      const b = request(body, false); await auth(token, b);
      return store.transaction(async tx => {
        const state = await read(tx, b, clock(), false);
        const result = { version: 1, uid: b.uid, payer: b.payer, balances: { ...state.balances }, free: state.free,
          settlementEnabled: false, payoutEnabled: false };
        if (!exact(result, snapshotKeys)) fail();
        return result;
      });
    },
    async debit(token, body) {
      const b = request(body, true); await auth(token, b);
      return store.transaction(async tx => {
        const time = clock(), state = await read(tx, b, time, true);
        if (state.prior !== undefined) {
          if (!exact(state.prior, ['request', 'policyHash', 'receipt']) || state.prior.policyHash !== policyHash
            || !isDeepStrictEqual(state.prior.request, b) || !receiptValid(state.prior.receipt, b)
            || state.prior.receipt.committedAt > time) fail('AUTHORITY_REPLAY');
          return structuredClone(state.prior.receipt);
        }
        const next = { ...state.balances }, free = { ...state.free };
        if (b.action === 'free-run') {
          if (free.remaining < 1) fail('AUTHORITY_QUOTA');
          free.remaining--;
        } else {
          const field = b.action === 'paid-run' ? 'runs' : 'std';
          if (BigInt(next[field]) < BigInt(b.amount)) fail('AUTHORITY_FUNDS');
          next[field] = (BigInt(next[field]) - BigInt(b.amount)).toString();
        }
        const receipt = { version: 1, requestId: b.requestId, uid: b.uid, payer: b.payer,
          policyVersion: trusted.version, action: b.action, amount: b.amount, committedAt: time,
          balances: next, free, settlementEnabled: false, payoutEnabled: false };
        if (!receiptValid(receipt, b)) fail();
        if (b.action === 'free-run') {
          await tx.set(state.keys.uidQuota, { day: free.day, used: state.uidUsed + 1 });
          await tx.set(state.keys.walletQuota, { day: free.day, used: state.walletUsed + 1 });
        } else await tx.set(state.keys.balance, next);
        await tx.set(requestKey(b.requestId), { request: { ...b }, policyHash, receipt });
        return structuredClone(receipt);
      });
    },
    async settle() { fail('AUTHORITY_SETTLEMENT_DISABLED'); },
    async payout() { fail('AUTHORITY_PAYOUT_DISABLED'); },
  });
}
