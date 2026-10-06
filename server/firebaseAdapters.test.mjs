import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createFirebaseAdapters } from './firebaseAdapters.mjs';
import { createIdentityService, encodeBase58 } from './identity.mjs';

const projectId = 'identity-test-project';
const claims = { uid: 'user/a', sub: 'user/a', aud: projectId, iss: `https://securetoken.google.com/${projectId}` };
const key = (kind, value) => `${kind}/${Buffer.from(value).toString('hex')}`;
function fixture() {
  let data = new Map();
  let queue = Promise.resolve();
  const calls = [];
  const firebaseAuth = {
    app: { options: { projectId } }, decoded: claims, error: null,
    async verifyIdToken(token, revoked) {
      assert.equal(this, firebaseAuth);
      calls.push(['verifyIdToken', token, revoked]);
      if (this.error) throw this.error;
      return this.decoded;
    },
  };
  // Privileged SDK mocks only: not an emulator, actual SDK or Firestore proof.
  const firestore = {
    projectId, retry: false, failCommit: false, failGet: false, failSet: false, commitGate: null,
    snapshot: () => structuredClone(data), calls,
    doc(path) { assert.equal(this, firestore); calls.push(['doc', path]); return { path }; },
    runTransaction(callback) {
      assert.equal(this, firestore);
      const pending = queue.then(async () => {
        async function attempt() {
          const draft = structuredClone(data);
          const sdk = {
            async get(ref) {
              assert.equal(this, sdk); calls.push(['get', ref.path]);
              if (firestore.failGet) throw new Error('read failed');
              return { exists: draft.has(ref.path), data: () => structuredClone(draft.get(ref.path)) };
            },
            set(ref, value) {
              assert.equal(this, sdk); calls.push(['set', ref.path]);
              if (firestore.failSet) throw new Error('write failed');
              draft.set(ref.path, structuredClone(value));
              return sdk;
            },
          };
          return { result: await callback(sdk), draft };
        }
        let output = await attempt();
        if (firestore.retry) { firestore.retry = false; output = await attempt(); }
        if (firestore.commitGate) await firestore.commitGate;
        if (firestore.failCommit) throw new Error('commit failed');
        data = output.draft;
        calls.push(['commit']);
        return output.result;
      });
      queue = pending.catch(() => {});
      return pending;
    },
  };
  const adapters = createFirebaseAdapters({ projectId, firebaseAuth, firestore });
  return { firebaseAuth, firestore, adapters, calls };
}

test('auth delegates verifyIdToken(token,true), validates project/aud/iss/sub and emits only UID', async () => {
  const f = fixture();
  assert.deepEqual(await f.adapters.authenticateToken('actual-token'), { uid: 'user/a' });
  assert.deepEqual(f.calls[0], ['verifyIdToken', 'actual-token', true]);
  for (const decoded of [null, {}, { ...claims, uid: '' }, { ...claims, uid: 'x'.repeat(129) },
    { ...claims, uid: 'bad\nuid' }, { ...claims, uid: '\ud800', sub: '\ud800' }, { ...claims, sub: 'other' }, { ...claims, aud: 'other-project' },
    { ...claims, aud: [projectId] }, { ...claims, iss: `https://securetoken.google.com/${projectId}/` },
    { ...claims, iss: 'http://securetoken.google.com/identity-test-project' }]) {
    f.firebaseAuth.decoded = decoded;
    await assert.rejects(f.adapters.authenticateToken('token'));
  }
  for (const name of ['auth/id-token-revoked', 'auth/user-disabled', 'auth/id-token-expired', 'SDK unavailable']) {
    f.firebaseAuth.error = new Error(name);
    await assert.rejects(f.adapters.authenticateToken('token'));
  }
  f.firebaseAuth.error = null; f.firebaseAuth.decoded = claims;
  const before = f.calls.length;
  for (const token of ['', null, 42, 'x'.repeat(16385)]) await assert.rejects(f.adapters.authenticateToken(token));
  assert.equal(f.calls.length, before, 'Malformed tokens never reach SDK');
});

test('factory rejects malformed projects, wrong SDK projects and absent privileged methods', async () => {
  const f = fixture();
  for (const project of ['', 'UPPERCASE', '../project', 'has space', 'abcde', 'a'.repeat(31), 'valid-project\n']) {
    assert.throws(() => createFirebaseAdapters({ projectId: project, firebaseAuth: f.firebaseAuth, firestore: f.firestore }));
  }
  assert.throws(() => createFirebaseAdapters());
  assert.throws(() => createFirebaseAdapters({ projectId, firebaseAuth: {}, firestore: f.firestore }));
  assert.throws(() => createFirebaseAdapters({ projectId, firebaseAuth: f.firebaseAuth, firestore: {} }));
  f.firebaseAuth.app.options.projectId = 'other-project';
  await assert.rejects(f.adapters.authenticateToken('token'));
  await assert.rejects(f.adapters.store.transaction(async () => 'no'));
  assert.throws(() => createFirebaseAdapters({ projectId, firebaseAuth: f.firebaseAuth, firestore: f.firestore }));
  f.firebaseAuth.app.options.projectId = projectId; f.firestore.projectId = 'other-project';
  assert.throws(() => createFirebaseAdapters({ projectId, firebaseAuth: f.firebaseAuth, firestore: f.firestore }));
});

test('emulator environment denied by default at factory and runtime; env restored', async () => {
  const f = fixture();
  for (const name of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST']) {
    const prior = process.env[name];
    try {
      for (const value of ['127.0.0.1:9099', '']) {
        process.env[name] = value;
        assert.throws(() => createFirebaseAdapters({ projectId, firebaseAuth: f.firebaseAuth, firestore: f.firestore }));
        await assert.rejects(f.adapters.authenticateToken('token'));
        await assert.rejects(f.adapters.store.transaction(async () => 'no'));
      }
    } finally {
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    }
  }
  assert.equal(f.calls.length, 0, 'Emulator mode never reaches privileged SDK mocks');
});

test('strict path allowlist maps canonical encoded identifiers to private collections', async () => {
  const f = fixture();
  const wallet = encodeBase58(Buffer.alloc(32, 3));
  const paths = [key('challenges', 'a'.repeat(64)), key('rates', 'user/a'), key('uids', 'user/a'), key('wallets', wallet)];
  await f.adapters.store.transaction(async tx => {
    for (const path of paths) assert.equal(await tx.get(path), undefined);
    for (const path of paths) await tx.set(path, { value: 1 });
  });
  assert.deepEqual([...f.firestore.snapshot().keys()].map(path => path.split('/')[0]),
    ['identityChallenges', 'identityRates', 'identityUids', 'identityWallets']);
  await f.adapters.store.transaction(async tx => {
    for (const path of paths) assert.deepEqual(await tx.get(path), { value: 1 });
  });
  for (const path of ['', 'uids/user/a', '../uids/61', 'identityUids/61', 'uids/ABCDEF', 'uids/6',
    'uids/ff', 'uids/00', 'uids/' + '61'.repeat(129), 'challenges/61', 'wallets/61',
    'uids/61/62', 'scores/61', 'uids/61\n', key('challenges', 'A'.repeat(64)), 42]) {
    const before = f.firestore.snapshot();
    const calls = f.calls.length;
    await assert.rejects(f.adapters.store.transaction(tx => tx.get(path)));
    await assert.rejects(f.adapters.store.transaction(tx => tx.set(path, {})));
    assert.deepEqual(f.firestore.snapshot(), before);
    assert.equal(f.calls.length, calls, 'Invalid paths do not reach db.doc');
  }
});

test('reads-before-writes, poison on swallowed errors, escaped wrapper and SDK failures', async () => {
  const f = fixture(); const path = key('uids', 'user/a'); let escaped;
  await assert.rejects(f.adapters.store.transaction(async tx => {
    await tx.set(path, { wallet: 'demo' });
    await tx.get(path);
  }));
  assert.equal(f.firestore.snapshot().size, 0);
  await assert.rejects(f.adapters.store.transaction(async tx => {
    try { await tx.get('invalid'); } catch {}
    return 'swallowed';
  }));
  await f.adapters.store.transaction(async tx => { escaped = tx; });
  await assert.rejects(escaped.set(path, {}));
  await assert.rejects(escaped.get(path));
  for (const failure of ['failGet', 'failSet', 'failCommit']) {
    f.firestore[failure] = true;
    await assert.rejects(f.adapters.store.transaction(async tx => {
      await tx.get(path);
      await tx.set(path, {});
      return 'not committed';
    }));
    assert.equal(f.firestore.snapshot().size, 0);
    f.firestore[failure] = false;
  }
});

test('SDK retries rerun callback; result observable only after commit, commit failure rejects', async () => {
  const f = fixture(); const path = key('rates', 'user/a'); let attempts = 0;
  f.firestore.retry = true;
  const result = await f.adapters.store.transaction(async tx => {
    attempts++;
    assert.equal(await tx.get(path), undefined, 'Retry sees committed data, not abandoned draft');
    await tx.set(path, { times: [attempts] });
    return attempts;
  });
  assert.equal(result, 2); assert.equal(attempts, 2);
  let release;
  f.firestore.commitGate = new Promise(resolve => { release = resolve; });
  let settled = false;
  const pending = f.adapters.store.transaction(async tx => {
    await tx.get(path); await tx.set(path, { times: [9] }); return 'committed';
  }).then(result => { settled = true; return result; });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(f.firestore.snapshot().get('identityRates/' + Buffer.from('user/a').toString('hex')), { times: [2] });
  release(); assert.equal(await pending, 'committed');
});

test('injected adapters with unchanged core: real signature, SDK-mock commit and replay', async () => {
  const f = fixture(); const pair = generateKeyPairSync('ed25519');
  const address = encodeBase58(pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  const service = createIdentityService({ ...f.adapters, config: {
    audience: projectId, origin: 'https://identity.example', cluster: 'testnet',
  } });
  const c = await service.issueChallenge('verified-token', { wallet: address });
  const body = { challengeId: c.challengeId, signature: sign(null, Buffer.from(c.message), pair.privateKey).toString('base64') };
  f.firestore.failCommit = true;
  const before = f.firestore.snapshot();
  await assert.rejects(service.complete('verified-token', body));
  assert.deepEqual(f.firestore.snapshot(), before);
  f.firestore.failCommit = false;
  assert.equal((await service.complete('verified-token', body)).wallet, address);
  await assert.rejects(service.complete('verified-token', body));
  assert.ok([...f.firestore.snapshot().keys()].every(path => /^identity(Challenges|Rates|Uids|Wallets)\/[a-f0-9]+$/.test(path)));
});
