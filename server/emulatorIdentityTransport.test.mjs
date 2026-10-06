import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { assertIdentityEmulators } from './emulatorIdentitySafety.mjs';
import { installDemoNetworkGuard, demoNetworkDiagnostics } from './emulatorIdentityNetwork.test-support.mjs';
import { createDemoIdentityRuntime } from './emulatorIdentityRuntime.test-support.mjs';
import { createIdentityService, encodeBase58 } from './identity.mjs';
import { createIdentityTransport } from './identityTransport.mjs';
import { createFirebaseAdapters } from './firebaseAdapters.mjs';

test('test-only SDK token HTTP identity roundtrip with durable cross-instance reads', { timeout: 120000 }, async t => {
  const target = assertIdentityEmulators();
  installDemoNetworkGuard({ allowIdentityHttp: true });
  const [{ initializeApp, deleteApp }, client] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
  const runId = randomBytes(16).toString('hex');
  const runtimes = [], apps = [], users = new Set(), wallets = new Set(), documents = new Set();
  const collections = { challenges: 'identityChallenges', rates: 'identityRates', uids: 'identityUids', wallets: 'identityWallets' };
  const key = (kind, value) => `${kind}/${Buffer.from(value).toString('hex')}`;
  const path = encoded => { const [kind, id] = encoded.split('/'); return `${collections[kind]}/${id}`; };
  const guarded = async action => {
    assertIdentityEmulators();
    try { return await action(); } finally { assertIdentityEmulators(); }
  };
  const pair = () => {
    const keys = generateKeyPairSync('ed25519');
    const wallet = encodeBase58(keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
    wallets.add(wallet); return { wallet, privateKey: keys.privateKey };
  };
  const signed = (challenge, keys) => ({ challengeId: challenge.challengeId,
    signature: sign(null, Buffer.from(challenge.message), keys.privateKey).toString('base64') });
  const read = (runtime, encoded) => guarded(() => runtime.store.transaction(tx => tx.get(encoded)));
  let clock = Date.now(), server;
  const transports = [];
  function service(runtime) {
    const store = { transaction: callback => runtime.store.transaction(tx => callback({
      get: encoded => tx.get(encoded),
      async set(encoded, value) {
        const [kind, hex] = encoded.split('/'), id = Buffer.from(hex, 'hex').toString('utf8');
        assert.ok(kind === 'challenges' ? users.has(value.uid) && wallets.has(value.wallet)
          : kind === 'wallets' ? wallets.has(id) && users.has(value.uid) : users.has(id), 'run-owned writes only');
        documents.add(path(encoded)); await tx.set(encoded, value);
      },
    })) };
    return createIdentityService({ authenticateToken: runtime.authenticateToken, store,
      config: { audience: target.projectId, origin: 'https://identity.example.invalid', cluster: 'testnet' }, now: () => clock });
  }
  async function account(index) {
    const app = initializeApp({ projectId: target.projectId, apiKey: 'demo-emulator-only' }, `http-client-${runId}-${index}`);
    apps.push(app);
    const auth = client.getAuth(app);
    client.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    await guarded(() => client.setPersistence(auth, client.inMemoryPersistence));
    const credential = await guarded(() => client.createUserWithEmailAndPassword(auth,
      `${runId}-${index}@example.invalid`, randomBytes(24).toString('hex')));
    users.add(credential.user.uid);
    return { uid: credential.user.uid, token: await guarded(() => client.getIdToken(credential.user)) };
  }
  function request(token, route, body, instance = 0) {
    return guarded(() => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: 18089, method: 'POST', path: route, agent: false,
        headers: { Host: '127.0.0.1:18089', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
          'X-Test-Instance': String(instance) } }, res => {
        const chunks = []; let bytes = 0;
        res.on('data', chunk => { bytes += chunk.length; if (bytes > 8192) res.destroy(new Error('response too large')); else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch (error) { reject(error); }
        });
      });
      req.setTimeout(15000, () => req.destroy(new Error('HTTP fixture timeout')));
      req.on('error', reject); req.end(JSON.stringify(body));
    }));
  }
  const issue = (user, keys, instance = 0) => request(user.token, '/identity/challenge', { wallet: keys.wallet }, instance);
  const complete = (user, body, instance = 0) => request(user.token, '/identity/complete', body, instance);
  try {
    runtimes.push(await createDemoIdentityRuntime(`http-admin-${runId}-a`));
    runtimes.push(await createDemoIdentityRuntime(`http-admin-${runId}-b`));
    const [a, b] = runtimes;
    assert.throws(() => createFirebaseAdapters({ projectId: target.projectId, firebaseAuth: a.firebaseAuth, firestore: a.firestore }),
      /IDENTITY_ADAPTER_DENIED/, 'production factory rejects emulator SDK');
    for (const runtime of runtimes) transports.push(createIdentityTransport({ service: service(runtime),
      expectedHost: '127.0.0.1:18089', limits: { maxActive: 8, bodyBytes: 4096, headerBytes: 24576, bodyMs: 5000, operationMs: 10000 } }));
    server = http.createServer({ maxHeaderSize: 24576, headersTimeout: 5000, requestTimeout: 10000 }, (req, res) => {
      const index = req.headers['x-test-instance'] === '1' ? 1 : 0;
      transports[index].handler(req, res);
    });
    server.maxHeadersCount = 128;
    server.setTimeout(15000, socket => socket.destroy());
    server.listen(18089, '127.0.0.1'); await once(server, 'listening');
    assert.deepEqual(server.address(), { address: '127.0.0.1', family: 'IPv4', port: 18089 });
    const owner = await account(0), other = await account(1);
    await t.test('SDK token -> HTTP challenge -> Ed25519 complete -> other SDK read, negatives and replay', async () => {
      const keys = pair(), issued = await issue(owner, keys);
      assert.equal(issued.status, 200); assert.deepEqual(Object.keys(issued.body).sort(), ['challengeId', 'expiresAt', 'message']);
      assert.equal((await read(b, key('challenges', issued.body.challengeId))).consumed, false);
      const body = signed(issued.body, keys);
      assert.equal((await complete(other, body, 1)).status, 403);
      assert.equal((await complete(owner, signed(issued.body, pair()))).status, 403);
      const invalid = await request('invalid-token', '/identity/challenge', { wallet: keys.wallet });
      assert.ok([403, 503].includes(invalid.status)); assert.ok(!JSON.stringify(invalid.body).includes('invalid-token'));
      assert.equal(await read(b, key('uids', owner.uid)), undefined);
      assert.equal((await read(b, key('challenges', issued.body.challengeId))).consumed, false);
      const result = await complete(owner, body, 1);
      assert.equal(result.status, 200); assert.deepEqual(result.body, { uid: owner.uid, wallet: keys.wallet, cluster: 'testnet' });
      assert.deepEqual(await read(a, key('uids', owner.uid)), { wallet: keys.wallet });
      assert.deepEqual(await read(a, key('wallets', keys.wallet)), { uid: owner.uid });
      assert.equal((await read(a, key('challenges', issued.body.challengeId))).consumed, true);
      assert.equal((await complete(owner, body)).status, 403);
    });
    await t.test('concurrent HTTP consume across SDK instances commits exactly once', async () => {
      const user = await account(2), keys = pair(), issued = await issue(user, keys);
      assert.equal(issued.status, 200);
      const body = signed(issued.body, keys);
      const results = await Promise.all([complete(user, body), complete(user, body, 1)]);
      assert.deepEqual(results.map(result => result.status).sort(), [200, 403]);
      assert.deepEqual(await read(b, key('uids', user.uid)), { wallet: keys.wallet });
      assert.deepEqual(await read(b, key('wallets', keys.wallet)), { uid: user.uid });
    });
    await t.test('HTTP TTL and rate failures leave bindings absent and rate unchanged', async () => {
      const user = await account(3), keys = pair(), issued = await issue(user, keys);
      assert.equal(issued.status, 200); clock = issued.body.expiresAt;
      assert.equal((await complete(user, signed(issued.body, keys), 1)).status, 403);
      assert.equal((await read(b, key('challenges', issued.body.challengeId))).consumed, false);
      assert.equal(await read(b, key('uids', user.uid)), undefined);
      assert.equal(await read(b, key('wallets', keys.wallet)), undefined);
      const rateUser = await account(4), rateKeys = pair();
      for (let i = 0; i < 5; i++) assert.equal((await issue(rateUser, rateKeys, i % 2)).status, 200);
      const before = await read(b, key('rates', rateUser.uid));
      assert.equal((await issue(rateUser, rateKeys, 1)).status, 403);
      assert.deepEqual(await read(a, key('rates', rateUser.uid)), before); assert.equal(before.times.length, 5);
    });
  } finally {
    for (const transport of transports) transport.close();
    const cleanupErrors = [];
    const attempt = async action => { try { await guarded(action); } catch (error) { cleanupErrors.push(error); } };
    if (server) {
      server.closeAllConnections();
      if (server.listening) await attempt(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    }
    if (runtimes[0]) {
      for (const document of documents) await attempt(() => runtimes[0].firestore.doc(document).delete());
      for (const uid of users) await attempt(() => runtimes[0].firebaseAuth.deleteUser(uid));
    }
    for (const app of apps) await attempt(() => deleteApp(app));
    for (const runtime of runtimes) await attempt(() => runtime.close());
    assert.deepEqual(demoNetworkDiagnostics(), { blocked: 0, metadataWarnings: 0 });
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'run-owned HTTP identity fixture cleanup failed');
  }
});
