import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createDemoCommerceRuntime } from './commerce-emulator.test-support.mjs';
import { assertIdentityEmulators } from './emulatorIdentitySafety.mjs';
import { demoNetworkDiagnostics, installDemoNetworkGuard } from './emulatorIdentityNetwork.test-support.mjs';
import { encodeBase58 } from './identity.mjs';
import { encoded } from './commerce-common.mjs';
import { fixture, signature } from './commerce.test-support.mjs';
import { rejectCommerceEmulators } from './commerce-functions.mjs';

test('real demo Auth proof + durable cross-instance Firestore receipts and concurrent retry (not chain proof)',
  { skip: process.env.COMMERCE_EMULATOR_TEST !== '1', timeout: 60000 }, async () => {
    const target = assertIdentityEmulators(); installDemoNetworkGuard();
    const [{ initializeApp, deleteApp }, client] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
    const runId = randomBytes(16).toString('hex'), f = fixture(), documents = new Set(), runtimes = [];
    let clock = f.time, account, app;
    const guarded = async action => { assertIdentityEmulators(); try { return await action(); } finally { assertIdentityEmulators(); } };
    try {
      const options = { config: f.config, verifier: f.verifier, now: () => clock, onWrite: key => documents.add(key) };
      runtimes.push(await createDemoCommerceRuntime({ ...options, name: `commerce-${runId}-a` }));
      runtimes.push(await createDemoCommerceRuntime({ ...options, name: `commerce-${runId}-b` }));
      const [a, b] = runtimes;
      assert.throws(rejectCommerceEmulators, /PRODUCTION_ONLY/);
      app = initializeApp({ projectId: target.projectId, apiKey: 'demo-emulator-only' }, `commerce-client-${runId}`);
      const auth = client.getAuth(app); client.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      await guarded(() => client.setPersistence(auth, client.inMemoryPersistence));
      account = (await guarded(() => client.createUserWithEmailAndPassword(auth,
        `${runId}@example.invalid`, randomBytes(24).toString('hex')))).user;
      const token = await guarded(() => client.getIdToken(account));
      const keys = generateKeyPairSync('ed25519'), payer = encodeBase58(keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
      const challenge = await a.identity.issueChallenge(token, { wallet: payer });
      assert.equal(JSON.parse(challenge.message).origin, 'https://localhost');
      await b.identity.complete(token, { challengeId: challenge.challengeId,
        signature: sign(null, Buffer.from(challenge.message), keys.privateKey).toString('base64') });
      const q = await a.commerce.quote(token, { productId: 'std-500', currency: 'SKR', payer }), payment = f.pay(q);
      clock = q.expiresAt + 100000;
      const results = await Promise.all(Array.from({ length: 4 }, (_, i) => (i % 2 ? a : b).commerce.receipt(token,
        { quoteId: q.id, signature: payment.sig })));
      for (const r of results) assert.deepEqual(r, results[0]);
      const balanceKey = `commerceBalances/${encoded(account.uid)}`;
      assert.deepEqual(await b.store.transaction(tx => tx.get(balanceKey)), { runs: '0', std: '500' });
      await assert.rejects(b.commerce.receipt(token, { quoteId: q.id, signature: signature() }), /REPLAY/);
      clock = f.time;
      const q2 = await b.commerce.quote(token, { productId: 'std-1500', currency: 'SOL', payer });
      await assert.rejects(b.commerce.receipt(token, { quoteId: q2.id, signature: payment.sig }), /REPLAY/);
      const payment2 = f.pay(q2);
      await a.commerce.receipt(token, { quoteId: q2.id, signature: payment2.sig });
      assert.deepEqual(await b.store.transaction(tx => tx.get(balanceKey)), { runs: '0', std: '2000' });
      const rollbackKey = `commerceQuotes/${randomBytes(16).toString('hex')}`;
      await assert.rejects(a.store.transaction(async tx => {
        await tx.get(rollbackKey); await tx.set(rollbackKey, { test: 'rollback' }); throw new Error('intentional rollback');
      }), /intentional rollback/);
      assert.equal(await b.store.transaction(tx => tx.get(rollbackKey)), undefined);
      assert.deepEqual(await b.commerce.receipt(token, { quoteId: q.id, signature: payment.sig }), results[0]);
    } finally {
      const errors = [], cleanup = async action => { try { await guarded(action); } catch (e) { errors.push(e); } };
      if (runtimes[0]) {
        for (const document of documents) await cleanup(() => runtimes[0].firestore.doc(document).delete());
        if (account) await cleanup(() => runtimes[0].firebaseAuth.deleteUser(account.uid));
      }
      if (app) await cleanup(() => deleteApp(app));
      for (const runtime of runtimes) await cleanup(() => runtime.close());
      if (errors.length) throw new AggregateError(errors, 'run-owned commerce fixture cleanup failed');
      assert.deepEqual(demoNetworkDiagnostics(), { blocked: 0, metadataWarnings: 0 });
    }
  });
