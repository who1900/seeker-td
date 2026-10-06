import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createGameAuthorityService } from './game-authority.mjs';
import { createGameAuthorityFirebaseAdapters } from './game-authority-firebase.mjs';
import { createCommerceFirestoreStore } from './commerce-firestore.mjs';
import { createFirebaseSdkBridge } from './firebaseSdkBridge.mjs';
import { createIdentityService, encodeBase58 } from './identity.mjs';
import { encoded } from './commerce-common.mjs';
import { fixture, fakeFirestore, wallet } from './commerce.test-support.mjs';

const policy = { version: 'alpha-ledger-1', freeRunsPerUtcDay: 3, stdCosts: { 'bounded-upgrade': '25' } };
function authorityFixture() {
  const commerce = fixture(), { sdk, uid, payer } = commerce;
  const store = createCommerceFirestoreStore({ projectId: sdk.projectId, firestore: sdk, checkPrivilege() {}, authority: true });
  const authenticateToken = async token => {
    if (token !== 'owner-token') throw new Error('IDENTITY_DENIED'); return { uid };
  };
  const make = (extra = {}) => createGameAuthorityService({ authenticateToken, store, policy, enabled: true,
    now: () => commerce.time, ...extra });
  const body = (action = 'paid-run', amount = '1', requestId = 'a'.repeat(32)) => ({
    version: 1, uid, payer, policyVersion: policy.version, requestId, action, amount,
  });
  const snapshot = () => ({ version: 1, uid, payer });
  const buy = async (product = 'runs-1') => { const q = await commerce.quote(product), p = commerce.pay(q); await commerce.receipt(q, p.sig); };
  return { commerce, sdk, uid, payer, make, body, snapshot, buy, service: make(),
    balances: () => sdk.docs.get(`commerceBalances/${encoded(uid)}`) };
}

test('disabled by default, no arbitrary credit, empty account cannot spend', async () => {
  const f = authorityFixture(), before = structuredClone(f.sdk.docs);
  await assert.rejects(f.make({ enabled: false }).debit('owner-token', f.body()), /DISABLED/);
  await assert.rejects(f.make({ enabled: undefined }).balance('owner-token', f.snapshot()), /DISABLED/);
  const b = await f.service.balance('owner-token', f.snapshot());
  assert.deepEqual(b.balances, { runs: '0', std: '0' }); assert.equal(b.free.remaining, 3);
  await assert.rejects(f.service.debit('owner-token', f.body()), /FUNDS/);
  assert.deepEqual(f.sdk.docs, before);
});

test('real Ed25519 challenge binds identity; same privileged project/revocation-checked bearer authorizes debit', async () => {
  const sdk = fakeFirestore(), uid = 'signed-owner', key = generateKeyPairSync('ed25519');
  const payer = encodeBase58(key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  const auth = { app: { options: { projectId: sdk.projectId } }, async verifyIdToken(token, revoked) {
    assert.equal(token, 'firebase-token'); assert.equal(revoked, true);
    return { uid, sub: uid, aud: sdk.projectId, iss: `https://securetoken.google.com/${sdk.projectId}` };
  } };
  const bridge = createFirebaseSdkBridge({ projectId: sdk.projectId, firebaseAuth: auth, firestore: sdk, checkPrivilege() {} });
  const identity = createIdentityService({ ...bridge, config: { audience: sdk.projectId, origin: 'https://game.invalid', cluster: 'devnet' } });
  const adapters = createGameAuthorityFirebaseAdapters({ projectId: sdk.projectId, firebaseAuth: auth, firestore: sdk });
  const service = createGameAuthorityService({ ...adapters, policy, enabled: true });
  const body = { version: 1, uid, payer, policyVersion: policy.version, action: 'free-run', amount: '0', requestId: 'b'.repeat(32) };
  await assert.rejects(service.debit('firebase-token', body), /DENIED/);
  const challenge = await identity.issueChallenge('firebase-token', { wallet: payer });
  await identity.complete('firebase-token', { challengeId: challenge.challengeId,
    signature: sign(null, Buffer.from(challenge.message), key.privateKey).toString('base64') });
  const receipt = await service.debit('firebase-token', body);
  assert.equal(receipt.uid, uid); assert.equal(receipt.free.remaining, 2);
  assert.deepEqual(receipt.balances, { runs: '0', std: '0' });
  assert.throws(() => createGameAuthorityFirebaseAdapters({ projectId: 'wrong-project', firebaseAuth: auth, firestore: sdk }));
  auth.app.options.projectId = 'wrong-project';
  await assert.rejects(service.debit('firebase-token', body));
});

test('commerce-granted paid run debit once, concurrent same-ID retry, response loss and process restart', async () => {
  const f = authorityFixture(); await f.buy();
  const body = f.body(), first = await f.service.debit('owner-token', body);
  const retries = await Promise.all(Array.from({ length: 8 }, () => f.make().debit('owner-token', body)));
  retries.forEach(r => assert.deepEqual(r, first));
  assert.deepEqual(f.balances(), { runs: '0', std: '0' });
  assert.equal([...f.sdk.docs.keys()].filter(k => k.startsWith('authorityRequests/')).length, 1);
  assert.equal(first.settlementEnabled, false); assert.equal(first.payoutEnabled, false);
  await f.buy('runs-3');
  assert.deepEqual(await f.make().debit('owner-token', body), first, 'retry is historical, not a fresh snapshot');
  assert.deepEqual((await f.service.balance('owner-token', f.snapshot())).balances, { runs: '3', std: '0' });
});

test('distinct concurrent spends cannot double-spend one purchased run; commerce credit races preserve totals', async () => {
  const f = authorityFixture(); await f.buy();
  const results = await Promise.allSettled(['a', 'b'].map(id => f.service.debit('owner-token', f.body('paid-run', '1', id.repeat(32)))));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected').length, 1);
  assert.deepEqual(f.balances(), { runs: '0', std: '0' }); assert.ok(f.sdk.retries > 0);
  await f.buy();
  await Promise.all([f.buy('runs-3'), f.service.debit('owner-token', f.body('paid-run', '1', 'c'.repeat(32)))]);
  assert.deepEqual(f.balances(), { runs: '3', std: '0' });
});

test('STD spends use server allowlisted exact cost, uint64 without floating point and no new grants', async () => {
  const f = authorityFixture(); await f.buy('std-500');
  await f.service.debit('owner-token', f.body('bounded-upgrade', '25'));
  assert.deepEqual(f.balances(), { runs: '0', std: '475' });
  for (const amount of ['0', '-1', '01', '1e2', '25.0', '18446744073709551616', 25, 1.5, null]) {
    await assert.rejects(f.service.debit('owner-token', f.body('bounded-upgrade', amount, 'b'.repeat(32))));
  }
  await assert.rejects(f.service.debit('owner-token', f.body('mint-std', '25')));
  f.sdk.docs.set(`commerceBalances/${encoded(f.uid)}`, { runs: '0', std: '18446744073709551615' });
  await f.service.debit('owner-token', f.body('bounded-upgrade', '25', 'c'.repeat(32)));
  assert.equal(f.balances().std, '18446744073709551590');
});

test('uid/payer/session switch, reverse ownership change and request replay mismatch never debit', async () => {
  const f = authorityFixture(); await f.buy('runs-3'); const original = f.body();
  for (const mutation of [{ uid: 'other' }, { payer: wallet() }, { version: 2 }, { policyVersion: 'future' },
    { extra: 1 }, { requestId: '../bad' }, { amount: '2' }]) {
    await assert.rejects(f.service.debit('owner-token', { ...original, ...mutation }));
  }
  await assert.rejects(f.service.debit('other-token', original));
  await f.service.debit('owner-token', original);
  await assert.rejects(f.service.debit('owner-token', { ...original, action: 'free-run', amount: '0' }), /REPLAY/);
  f.sdk.docs.set(`identityWallets/${encoded(f.payer)}`, { uid: 'other' });
  await assert.rejects(f.service.debit('owner-token', original));
  f.sdk.docs.set(`identityWallets/${encoded(f.payer)}`, { uid: f.uid });
  f.sdk.docs.set(`identityUids/${encoded(f.uid)}`, { wallet: wallet() });
  await assert.rejects(f.service.debit('owner-token', original));
  assert.deepEqual(f.balances(), { runs: '2', std: '0' });
});

test('global request IDs reject another bound account; policy changes cannot reinterpret old receipt', async () => {
  const f = authorityFixture(); await f.service.debit('owner-token', f.body('free-run', '0'));
  const otherUid = 'other-uid', otherPayer = wallet();
  f.sdk.docs.set(`identityUids/${encoded(otherUid)}`, { wallet: otherPayer });
  f.sdk.docs.set(`identityWallets/${encoded(otherPayer)}`, { uid: otherUid });
  const other = f.make({ authenticateToken: async () => ({ uid: otherUid }) });
  await assert.rejects(other.debit('token', { ...f.body('free-run', '0'), uid: otherUid, payer: otherPayer }), /REPLAY/);
  await assert.rejects(f.make({ policy: { ...policy, freeRunsPerUtcDay: 4 } }).debit('owner-token', f.body('free-run', '0')), /REPLAY/);
});

test('free UTC quota global across instances, checked against BOTH uid and wallet, no commerce credits', async () => {
  const f = authorityFixture(); f.commerce.setTime(86400000 * 100 + 86399999);
  const results = await Promise.allSettled(['a', 'b', 'c', 'd'].map(id => f.make().debit('owner-token', f.body('free-run', '0', id.repeat(32)))));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 3); assert.equal(f.balances(), undefined);
  const exhausted = await f.service.balance('owner-token', f.snapshot()); assert.equal(exhausted.free.remaining, 0);
  f.sdk.docs.delete(`authorityUidQuota/${encoded(f.uid)}`);
  await assert.rejects(f.service.debit('owner-token', f.body('free-run', '0', 'e'.repeat(32))), /QUOTA/);
  f.sdk.docs.set(`authorityUidQuota/${encoded(f.uid)}`, { day: 100, used: 3 });
  f.sdk.docs.delete(`authorityWalletQuota/${encoded(f.payer)}`);
  await assert.rejects(f.service.debit('owner-token', f.body('free-run', '0', 'e'.repeat(32))), /QUOTA/);
  f.commerce.setTime(86400000 * 101);
  assert.equal((await f.service.debit('owner-token', f.body('free-run', '0', 'e'.repeat(32)))).free.remaining, 2);
  const old = await f.service.debit('owner-token', f.body('free-run', '0'));
  assert.equal(old.free.day, 100, 'retry across UTC boundary cannot mint another quota');
});

test('invalid balances/quotas, commit failure and swallowed adapter errors cannot partially commit', async () => {
  const f = authorityFixture(); await f.buy(); const before = structuredClone(f.sdk.docs);
  f.sdk.failCommit = true; await assert.rejects(f.service.debit('owner-token', f.body()), /COMMIT_FAILED/);
  assert.deepEqual(f.sdk.docs, before); f.sdk.failCommit = false;
  for (const balance of [{ runs: 1, std: '0' }, { runs: '-1', std: '0' }, { runs: '18446744073709551616', std: '0' }]) {
    f.sdk.docs.set(`commerceBalances/${encoded(f.uid)}`, balance);
    await assert.rejects(f.service.debit('owner-token', f.body()), /BALANCE/);
  }
  f.sdk.docs.set(`commerceBalances/${encoded(f.uid)}`, { runs: '1', std: '0' });
  f.sdk.docs.set(`authorityWalletQuota/${encoded(f.payer)}`, { day: 9999999999, used: 0 });
  await assert.rejects(f.service.debit('owner-token', f.body()), /QUOTA/);
  const legacy = createCommerceFirestoreStore({ projectId: f.sdk.projectId, firestore: f.sdk, checkPrivilege() {} });
  await assert.rejects(legacy.transaction(tx => tx.set(`authorityRequests/${'a'.repeat(32)}`, {})), /STORE/);
});

test('unverified settlement, shadow records, client score and payout are never money authority', async () => {
  const f = authorityFixture(); f.sdk.docs.set(`shadowEntitlements/${encoded(f.uid)}`, { credits: 999 });
  const before = structuredClone(f.sdk.docs);
  await assert.rejects(f.service.debit('owner-token', f.body()), /FUNDS/);
  for (const input of [{ score: 999999, won: true }, { replayVerified: true, runtimeFingerprint: 'a'.repeat(64) }, {}]) {
    await assert.rejects(f.service.settle('owner-token', input), /SETTLEMENT_DISABLED/);
    await assert.rejects(f.service.payout('owner-token', input), /PAYOUT_DISABLED/);
  }
  assert.deepEqual(f.sdk.docs, before);
});
