import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, generateKeyPairSync, sign } from 'node:crypto';
import { createDemoRunAdmissionRuntime } from './emulatorRunAdmissionRuntime.test-support.mjs';
import { assertIdentityEmulators } from './emulatorIdentitySafety.mjs';
import { installDemoNetworkGuard, demoNetworkDiagnostics } from './emulatorIdentityNetwork.test-support.mjs';
import { createIdentityService, encodeBase58 } from './identity.mjs';
import { createRunAdmissionService } from './runAdmission.mjs';
import { createReplayRuntime } from './replayRuntime.mjs';
import { fileURLToPath } from 'node:url';
import { createFirebaseRunAdmissionStore } from './firebaseRunAdmissionStore.mjs';

test('LOCAL real SDK shadow admission; no payment/replay/production proof', { timeout: 120000 }, async t => {
  const target = assertIdentityEmulators(); installDemoNetworkGuard();
  const [{ initializeApp, deleteApp }, client] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
  assertIdentityEmulators();
  const prefix = randomBytes(16).toString('hex'), runtimes = [], apps = [], users = new Set(), wallets = new Set(), documents = new Set();
  const hex = value => Buffer.from(value).toString('hex');
  const guarded = async action => { assertIdentityEmulators(); try { return await action(); } finally { assertIdentityEmulators(); } };
  const track = store => ({ transaction: callback => store.transaction(tx => callback({ get: key => tx.get(key),
    async set(key, value) {
      const [kind, id] = key.split('/');
      assert.ok(kind === 'shadowRuns' ? users.has(value.uid) : ['shadowEntitlements', 'shadowRunActive', 'shadowRunRequests'].includes(kind)
        && users.has(Buffer.from(id.split('-')[0], 'hex').toString('utf8')), 'run-owned shadow writes only');
      documents.add(key); await tx.set(key, value);
    } })) });
  const identityCollections = { challenges: 'identityChallenges', rates: 'identityRates', uids: 'identityUids', wallets: 'identityWallets' };
  const identityTrack = store => ({ transaction: callback => store.transaction(tx => callback({ get: key => tx.get(key),
    async set(key, value) {
      const [kind, id] = key.split('/'), decoded = Buffer.from(id, 'hex').toString('utf8');
      assert.ok(kind === 'challenges' ? users.has(value.uid) && wallets.has(value.wallet)
        : kind === 'wallets' ? wallets.has(decoded) && users.has(value.uid)
          : ['uids', 'rates'].includes(kind) && users.has(decoded), 'run-owned identity writes only');
      documents.add(`${identityCollections[kind]}/${id}`); await tx.set(key, value);
    } })) });
  let clock = Date.now();
  const runtimeFingerprint = createReplayRuntime({ projectRoot: fileURLToPath(new URL('../', import.meta.url)), version: 1 }).fingerprint;
  const config = { engineVersion: 'engine-shadow-v1', dataVersion: 'data-shadow-v1', protocolVersion: 'replay-placeholder-v1',
    replayRuntimeVersion: runtimeFingerprint.version, replayRuntimeHash: runtimeFingerprint.hash,
    ttlMilliseconds: 1000, allowedConfigs: [{ mode: 'waves', waveLimit: 10, durationMinutes: 5 }] };
  const body = () => ({ requestId: randomBytes(16).toString('hex'), config: { ...config.allowedConfigs[0] } });
  const service = (runtime, store = track(runtime.store), now = () => clock) => createRunAdmissionService({
    authenticateToken: runtime.authenticateToken, store, config, runtimeFingerprint, now });
  const read = (runtime, path) => runtime.store.transaction(tx => tx.get(path));
  async function account(index) {
    const app = initializeApp({ projectId: target.projectId, apiKey: 'demo-emulator-only' }, `run-client-${prefix}-${index}`); apps.push(app);
    const auth = client.getAuth(app); client.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    await guarded(() => client.setPersistence(auth, client.inMemoryPersistence));
    const credential = await guarded(() => client.createUserWithEmailAndPassword(auth, `${prefix}-${index}@example.invalid`, randomBytes(24).toString('hex')));
    const uid = credential.user.uid; users.add(uid);
    const token = await guarded(() => client.getIdToken(credential.user));
    const pair = generateKeyPairSync('ed25519');
    const wallet = encodeBase58(pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
    wallets.add(wallet);
    const identity = createIdentityService({ authenticateToken: runtimes[0].authenticateToken, store: identityTrack(runtimes[0].identityStore),
      config: { audience: target.projectId, origin: 'https://identity.example.invalid', cluster: 'testnet' }, now: () => clock });
    const challenge = await identity.issueChallenge(token, { wallet });
    await identity.complete(token, { challengeId: challenge.challengeId, signature: sign(null, Buffer.from(challenge.message), pair.privateKey).toString('base64') });
    return { uid, token, wallet };
  }
  async function credits(runtime, user, count) {
    assert.ok(users.has(user.uid));
    await track(runtime.store).transaction(tx => tx.set(`shadowEntitlements/${hex(user.uid)}`, { credits: count }));
  }
  async function consistent(runtime, user, request, record, remaining) {
    assert.deepEqual(await read(runtime, `shadowRuns/${record.runId}`), record);
    assert.deepEqual(await read(runtime, `shadowRunRequests/${hex(user.uid)}-${request.requestId}`), { runId: record.runId, config: request.config });
    assert.deepEqual(await read(runtime, `shadowRunActive/${hex(user.uid)}`), { runId: record.runId });
    assert.deepEqual(await read(runtime, `shadowEntitlements/${hex(user.uid)}`), { credits: remaining });
    assert.deepEqual(await read(runtime, `identityUids/${hex(user.uid)}`), { wallet: user.wallet });
    assert.deepEqual(await read(runtime, `identityWallets/${hex(user.wallet)}`), { uid: user.uid });
  }
  try {
    runtimes.push(await createDemoRunAdmissionRuntime(`run-admin-${prefix}-a`));
    runtimes.push(await createDemoRunAdmissionRuntime(`run-admin-${prefix}-b`));
    const [a, b] = runtimes, sa = service(a), sb = service(b);
    assert.throws(() => createFirebaseRunAdmissionStore({ projectId: target.projectId, firestore: a.firestore, checkPrivilege: () => {} }), /RUN_STORE_DENIED/);
    const owner = await account(0), other = await account(1), empty = await account(2), rollback = await account(3);
    for (const user of [owner, other, rollback]) await credits(a, user, 2);
    const request = body(); let admitted;
    await t.test('real Auth + cross-instance same-key concurrency debits once', async () => {
      const records = await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? sa : sb).admit(owner.token, request)));
      admitted = records[0]; records.forEach(record => assert.deepEqual(record, admitted));
      await consistent(b, owner, request, admitted, 1);
    });
    await t.test('different request concurrency admits one; UID isolated; missing entitlement denied', async () => {
      const requests = [body(), body()];
      const outcomes = await Promise.allSettled([sa.admit(other.token, requests[0]), sb.admit(other.token, requests[1])]);
      assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
      const index = outcomes.findIndex(item => item.status === 'fulfilled');
      await consistent(a, other, requests[index], outcomes[index].value, 1);
      await assert.rejects(sa.admit(empty.token, body()));
      assert.equal(await read(b, `shadowRunActive/${hex(empty.uid)}`), undefined);
      await assert.rejects(sa.admit('invalid-token', body()));
    });
    await t.test('expired active blocked; clock rollback and corrupt record fail closed', async () => {
      clock = admitted.expiresAt;
      assert.deepEqual(await sb.admit(owner.token, request), admitted);
      await assert.rejects(sa.admit(owner.token, body()));
      await consistent(b, owner, request, admitted, 1);
      let time = clock;
      await assert.rejects(service(a, track(a.store), () => time--).admit(rollback.token, body()));
      await track(a.store).transaction(tx => tx.set(`shadowRuns/${admitted.runId}`, { ...admitted, combatSeed: -1 }));
      await assert.rejects(sb.admit(owner.token, request));
      await track(a.store).transaction(tx => tx.set(`shadowRuns/${admitted.runId}`, admitted));
    });
    await t.test('wrong canonical reverse binding rejected; identity restored exactly', async () => {
      const path = `identityWallets/${hex(rollback.wallet)}`;
      await guarded(() => a.firestore.doc(path).set({ uid: owner.uid }));
      try { await assert.rejects(sa.admit(rollback.token, body())); }
      finally { await guarded(() => a.firestore.doc(path).set({ uid: rollback.uid })); }
      assert.equal(await read(b, `shadowRunActive/${hex(rollback.uid)}`), undefined);
    });
    await t.test('injected callback failure rolls back actual SDK transaction; mock commit failures remain unit-only', async () => {
      const failed = [];
      const failing = { transaction: callback => a.store.transaction(tx => {
        let writes = 0;
        return callback({ get: key => tx.get(key), async set(key, value) {
          assert.ok(key.startsWith(`shadowEntitlements/${hex(rollback.uid)}`)
            || key.startsWith(`shadowRunRequests/${hex(rollback.uid)}-`)
            || key === `shadowRunActive/${hex(rollback.uid)}`
            || /^shadowRuns\/[a-f0-9]{32}$/.test(key) && value.uid === rollback.uid);
          documents.add(key); failed.push(key); await tx.set(key, value);
          if (++writes === 4) throw new Error('injected precommit callback failure');
        } });
      }) };
      await assert.rejects(service(a, failing).admit(rollback.token, body()), /injected precommit/);
      assert.deepEqual(await read(b, `shadowEntitlements/${hex(rollback.uid)}`), { credits: 2 });
      for (const path of failed.filter(path => !path.startsWith('shadowEntitlements/'))) assert.equal(await read(b, path), undefined);
      const next = body(), record = await sb.admit(rollback.token, next); await consistent(a, rollback, next, record, 1);
    });
    for (const user of [owner, other, empty, rollback]) {
      assert.deepEqual(await read(b, `identityUids/${hex(user.uid)}`), { wallet: user.wallet });
      assert.deepEqual(await read(b, `identityWallets/${hex(user.wallet)}`), { uid: user.uid });
    }
  } finally {
    const errors = [], attempt = async action => { try { await guarded(action); } catch (error) { errors.push(error); } };
    if (runtimes[0]) {
      for (const path of documents) await attempt(() => runtimes[0].firestore.doc(path).delete());
      for (const uid of users) await attempt(() => runtimes[0].firebaseAuth.deleteUser(uid));
    }
    for (const app of apps) await attempt(() => deleteApp(app));
    for (const runtime of runtimes) await attempt(() => runtime.close());
    if (errors.length) throw new AggregateError(errors, 'scoped shadow fixture cleanup failed');
    assert.deepEqual(demoNetworkDiagnostics(), { blocked: 0, metadataWarnings: 0 });
  }
});
