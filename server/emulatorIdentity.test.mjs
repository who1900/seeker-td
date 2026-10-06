import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { assertIdentityEmulators } from './emulatorIdentitySafety.mjs';
import { createDemoIdentityRuntime } from './emulatorIdentityRuntime.test-support.mjs';
import { createIdentityService, encodeBase58 } from './identity.mjs';
import { createFirebaseAdapters } from './firebaseAdapters.mjs';
import { installDemoNetworkGuard, demoNetworkDiagnostics } from './emulatorIdentityNetwork.test-support.mjs';

test('real demo Auth/Admin SDK + Firestore identity transactions (not production proof)', { timeout: 120000 }, async t => {
  const target = assertIdentityEmulators();
  installDemoNetworkGuard();
  const [{ initializeApp, deleteApp }, client] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
  assertIdentityEmulators();
  const runId = randomBytes(16).toString('hex');
  const runtimes = [], apps = [], users = new Set(), wallets = new Set(), documents = new Set();
  const guarded = async action => {
    assertIdentityEmulators();
    try { return await action(); } finally { assertIdentityEmulators(); }
  };
  const collections = { challenges: 'identityChallenges', rates: 'identityRates', uids: 'identityUids', wallets: 'identityWallets' };
  const key = (kind, value) => `${kind}/${Buffer.from(value).toString('hex')}`;
  const path = encoded => { const [kind, id] = encoded.split('/'); return `${collections[kind]}/${id}`; };
  const pair = () => {
    const keys = generateKeyPairSync('ed25519');
    const wallet = encodeBase58(keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
    wallets.add(wallet);
    return { wallet, privateKey: keys.privateKey };
  };
  const body = (challenge, keys) => ({ challengeId: challenge.challengeId,
    signature: sign(null, Buffer.from(challenge.message), keys.privateKey).toString('base64') });
  let clock = Date.now();
  const config = { audience: target.projectId, origin: 'https://identity.example.invalid', cluster: 'testnet' };
  function trackedStore(runtime) {
    return { transaction: callback => runtime.store.transaction(tx => callback({
      get: encoded => tx.get(encoded),
      async set(encoded, value) {
        const [kind, hex] = encoded.split('/'), id = Buffer.from(hex, 'hex').toString('utf8');
        assert.ok(kind === 'challenges' ? users.has(value.uid) && wallets.has(value.wallet)
          : kind === 'wallets' ? wallets.has(id) && users.has(value.uid) : users.has(id), 'only run-owned fixture writes');
        documents.add(path(encoded));
        await tx.set(encoded, value);
      },
    })) };
  }
  const service = runtime => createIdentityService({ authenticateToken: runtime.authenticateToken,
    store: trackedStore(runtime), config, now: () => clock });
  async function account(index) {
    const app = initializeApp({ projectId: target.projectId, apiKey: 'demo-emulator-only' }, `identity-client-${runId}-${index}`);
    apps.push(app);
    const auth = client.getAuth(app);
    client.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    await guarded(() => client.setPersistence(auth, client.inMemoryPersistence));
    const credential = await guarded(() => client.createUserWithEmailAndPassword(auth,
      `${runId}-${index}@example.invalid`, randomBytes(24).toString('hex')));
    users.add(credential.user.uid);
    const token = await guarded(() => client.getIdToken(credential.user));
    return { uid: credential.user.uid, token };
  }
  async function read(runtime, encoded) {
    return runtime.store.transaction(tx => tx.get(encoded));
  }
  try {
    runtimes.push(await createDemoIdentityRuntime(`identity-admin-${runId}-a`));
    runtimes.push(await createDemoIdentityRuntime(`identity-admin-${runId}-b`));
    const [a, b] = runtimes, sa = service(a), sb = service(b);
    assert.throws(() => createFirebaseAdapters({ projectId: target.projectId, firebaseAuth: a.firebaseAuth, firestore: a.firestore }),
      /IDENTITY_ADAPTER_DENIED/, 'production factory still refuses actual emulator SDKs');
    const owner = await account(0), other = await account(1);
    await t.test('SDK token UID + cross-instance persistence + replay', async () => {
      assert.deepEqual(await a.authenticateToken(owner.token), { uid: owner.uid });
      await assert.rejects(a.authenticateToken('invalid-token'));
      const keys = pair(), challenge = await sa.issueChallenge(owner.token, { wallet: keys.wallet });
      assert.equal((await read(b, key('challenges', challenge.challengeId))).consumed, false);
      const signed = body(challenge, keys);
      await assert.rejects(sb.complete(other.token, signed));
      await assert.rejects(sa.complete(owner.token, body(challenge, pair())));
      assert.equal((await read(b, key('challenges', challenge.challengeId))).consumed, false);
      assert.equal(await read(b, key('uids', owner.uid)), undefined);
      assert.deepEqual(await sb.complete(owner.token, signed), { uid: owner.uid, wallet: keys.wallet, cluster: 'testnet' });
      assert.equal((await read(a, key('challenges', challenge.challengeId))).consumed, true);
      assert.deepEqual(await read(a, key('uids', owner.uid)), { wallet: keys.wallet });
      assert.deepEqual(await read(a, key('wallets', keys.wallet)), { uid: owner.uid });
      await assert.rejects(sa.complete(owner.token, signed));
      await assert.rejects(sb.issueChallenge(other.token, { wallet: keys.wallet }));
    });
    await t.test('concurrent consume commits once across SDK instances', async () => {
      const user = await account(2), keys = pair();
      const challenge = await sa.issueChallenge(user.token, { wallet: keys.wallet }), signed = body(challenge, keys);
      const results = await Promise.allSettled([sa.complete(user.token, signed), sb.complete(user.token, signed)]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(results.filter(r => r.status === 'rejected').length, 1);
      assert.deepEqual(await read(b, key('uids', user.uid)), { wallet: keys.wallet });
      assert.deepEqual(await read(b, key('wallets', keys.wallet)), { uid: user.uid });
    });
    await t.test('concurrent wallet ownership never writes loser binding', async () => {
      const left = await account(3), right = await account(4), keys = pair();
      const lc = await sa.issueChallenge(left.token, { wallet: keys.wallet });
      const rc = await sb.issueChallenge(right.token, { wallet: keys.wallet });
      const results = await Promise.allSettled([sa.complete(left.token, body(lc, keys)), sb.complete(right.token, body(rc, keys))]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      const winner = results[0].status === 'fulfilled' ? left : right;
      const loser = winner === left ? right : left;
      assert.deepEqual(await read(b, key('wallets', keys.wallet)), { uid: winner.uid });
      assert.deepEqual(await read(b, key('uids', winner.uid)), { wallet: keys.wallet });
      assert.equal(await read(b, key('uids', loser.uid)), undefined);
      assert.equal((await read(b, key('challenges', winner === left ? rc.challengeId : lc.challengeId))).consumed, false);
    });
    await t.test('TTL and rate persist, refused transactions leave no bindings', async () => {
      const user = await account(5), keys = pair();
      const challenge = await sa.issueChallenge(user.token, { wallet: keys.wallet });
      clock = challenge.expiresAt;
      await assert.rejects(sb.complete(user.token, body(challenge, keys)));
      assert.equal((await read(a, key('challenges', challenge.challengeId))).consumed, false);
      assert.equal(await read(a, key('uids', user.uid)), undefined);
      assert.equal(await read(a, key('wallets', keys.wallet)), undefined);
      const rateUser = await account(6), rateKeys = pair();
      for (let i = 0; i < 5; i++) await (i % 2 ? sb : sa).issueChallenge(rateUser.token, { wallet: rateKeys.wallet });
      const before = await read(b, key('rates', rateUser.uid));
      await assert.rejects(sb.issueChallenge(rateUser.token, { wallet: rateKeys.wallet }));
      assert.deepEqual(await read(a, key('rates', rateUser.uid)), before);
      assert.equal(before.times.length, 5);
    });
    await t.test('actual SDK transaction callback rejection rolls back every write', async () => {
      const freshUid = `rollback-${runId}`;
      users.add(freshUid);
      await assert.rejects(trackedStore(a).transaction(async tx => {
        await tx.get(key('uids', freshUid));
        await tx.get(key('rates', freshUid));
        await tx.set(key('uids', freshUid), { wallet: pair().wallet });
        await tx.set(key('rates', freshUid), { times: [clock] });
        throw new Error('intentional rollback');
      }), /intentional rollback/);
      assert.equal(await read(b, key('uids', freshUid)), undefined);
      assert.equal(await read(b, key('rates', freshUid)), undefined);
    });
  } finally {
    const cleanupErrors = [];
    const attempt = async action => { try { await guarded(action); } catch (error) { cleanupErrors.push(error); } };
    if (runtimes[0]) {
      for (const document of documents) await attempt(() => runtimes[0].firestore.doc(document).delete());
      for (const uid of users) {
        if (uid.startsWith('rollback-')) continue;
        await attempt(() => runtimes[0].firebaseAuth.deleteUser(uid));
      }
    }
    for (const app of apps) await attempt(() => deleteApp(app));
    for (const runtime of runtimes) await attempt(() => runtime.close());
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'run-owned identity fixture cleanup failed');
    assert.deepEqual(demoNetworkDiagnostics(), { blocked: 0, metadataWarnings: 0 });
  }
});
