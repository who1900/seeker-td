import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createIdentityService, decodeWallet, encodeBase58 } from './identity.mjs';

// Test-only serialized adapter: isolated drafts, commit only after callback success.
function memoryStore() {
  let data = new Map();
  let queue = Promise.resolve();
  return {
    failWrite: 0, failCommit: false, retryAdvance: null, onRead: null,
    snapshot: () => structuredClone(data),
    corrupt(key, value) { data.set(key, structuredClone(value)); },
    transaction(callback) {
      const operation = queue.then(async () => {
        const attempt = async () => {
          const draft = structuredClone(data);
          let wrote = false;
          let writes = 0;
          const result = await callback({
            async get(key) {
              assert.equal(wrote, false, 'All reads precede writes');
              if (thisStore.onRead) await thisStore.onRead(key);
              return structuredClone(draft.get(key));
            },
            async set(key, value) {
              wrote = true;
              if (++writes === thisStore.failWrite) throw new Error('store write failure');
              draft.set(key, structuredClone(value));
            },
          });
          return { draft, result };
        };
        const thisStore = this;
        let done = await attempt();
        if (this.retryAdvance) { const advance = this.retryAdvance; this.retryAdvance = null; advance(); done = await attempt(); }
        if (this.failCommit) throw new Error('store commit failure');
        data = done.draft;
        return done.result;
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
}
function wallet() {
  const pair = generateKeyPairSync('ed25519');
  const bytes = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { address: encodeBase58(bytes), bytes, signature: message => sign(null, Buffer.from(message), pair.privateKey).toString('base64') };
}
const config = { audience: 'seeker-identity-test', origin: 'https://identity.example', cluster: 'devnet' };
function fixture() {
  let time = 1_000_000;
  const store = memoryStore();
  const authenticateToken = async token => {
    if (token === 'token-a') return { uid: 'user/a' };
    if (token === 'token-b') return { uid: 'user/b' };
    throw new Error('unverified token');
  };
  const service = createIdentityService({ store, config, authenticateToken, now: () => time });
  return { store, service, authenticateToken, time: value => { time = value; }, getTime: () => time };
}
const finish = (service, token, challenge, key) => service.complete(token, {
  challengeId: challenge.challengeId, signature: key.signature(challenge.message),
});
const bindings = store => [...store.snapshot()].filter(([key]) => /^(uids|wallets)\//.test(key));

test('actual Ed25519, canonical server message, nonce, ownership and one-shot consume', async () => {
  const f = fixture(); const key = wallet();
  assert.deepEqual(decodeWallet(key.address), key.bytes);
  const c = await f.service.issueChallenge('token-a', { wallet: key.address });
  const fields = JSON.parse(c.message);
  assert.deepEqual(fields, { ...config, purpose: 'SEEKER:TD/wallet-identity/v1', uid: 'user/a', wallet: key.address,
    nonce: c.challengeId, issuedAt: 1_000_000, expiresAt: 1_300_000 });
  assert.match(c.challengeId, /^[a-f0-9]{64}$/);
  const second = await f.service.issueChallenge('token-a', { wallet: key.address });
  assert.notEqual(second.challengeId, c.challengeId);
  assert.deepEqual(await finish(f.service, 'token-a', c, key), { uid: 'user/a', wallet: key.address, cluster: 'devnet' });
  assert.equal(bindings(f.store).length, 2);
  assert.ok([...f.store.snapshot().keys()].every(k => k.split('/').length === 2), 'UID slash encoded');
  await assert.rejects(finish(f.service, 'token-a', c, key));
  await assert.rejects(finish(f.service, 'token-b', second, key));
  await finish(f.service, 'token-a', second, key);
});

test('strict config, dependencies and auth fail closed', async () => {
  const f = fixture(); const key = wallet();
  for (const extra of [{ cluster: 'mainnet-beta' }, { origin: 'http://identity.example' },
    { origin: 'https://user@identity.example' }, { origin: 'https://identity.example?x=1' },
    { origin: 'https://identity.example/' }, { origin: 'https://identity.example#fragment' },
    { origin: 'https://identity.example\n' }, { audience: 'bad\npurpose' }]) {
    assert.throws(() => createIdentityService({ ...f, config: { ...config, ...extra }, authenticateToken: f.authenticateToken }));
  }
  assert.throws(() => createIdentityService());
  for (const dependency of [{ store: {} }, { authenticateToken: null }, { now: 7 }]) {
    assert.throws(() => createIdentityService({ store: f.store, authenticateToken: f.authenticateToken, config, ...dependency }));
  }
  for (const token of ['', null, 'x'.repeat(16385), 'forged']) await assert.rejects(f.service.issueChallenge(token, { wallet: key.address }));
  for (const identity of [null, {}, { uid: '' }, { uid: 'x'.repeat(129) }, { uid: 'bad\nuid' }]) {
    const service = createIdentityService({ store: f.store, config, authenticateToken: async () => identity });
    await assert.rejects(service.issueChallenge('token', { wallet: key.address }));
  }
  assert.equal(f.store.snapshot().size, 0);
});

test('exact plain request schema and bounded canonical base58/base64', async () => {
  const f = fixture(); const key = wallet();
  const symbolBody = { wallet: key.address, [Symbol('uid')]: 'override' };
  for (const body of [null, [], { wallet: key.address, uid: 'override' }, { wallet: key.address, purpose: 'pay' },
    Object.assign(Object.create(null), { wallet: key.address }), symbolBody]) await assert.rejects(f.service.issueChallenge('token-a', body));
  for (const address of ['', '0'.repeat(32), '1'.repeat(31), '1'.repeat(33), '2'.repeat(45), key.address + ' ',
    encodeBase58(Buffer.alloc(31, 2)), encodeBase58(Buffer.alloc(33, 2)), 42]) {
    await assert.rejects(f.service.issueChallenge('token-a', { wallet: address }));
  }
  assert.deepEqual(decodeWallet('1'.repeat(32)), Buffer.alloc(32));
  const c = await f.service.issueChallenge('token-a', { wallet: key.address });
  const signature = key.signature(c.message);
  for (const sig of ['', signature.trimEnd() + '\n', signature.slice(0, -2), signature.replace(/=/g, ''),
    Buffer.alloc(63).toString('base64'), Buffer.alloc(65).toString('base64'), 'a'.repeat(1000), 42,
    signature.slice(0, 85) + 'B==']) await assert.rejects(f.service.complete('token-a', { challengeId: c.challengeId, signature: sig }));
  for (const id of ['', c.challengeId.toUpperCase(), 'a'.repeat(65), '../challenge', 42]) {
    await assert.rejects(f.service.complete('token-a', { challengeId: id, signature }));
  }
  await assert.rejects(f.service.complete('token-a', { challengeId: c.challengeId, signature, uid: 'user/b' }));
  assert.equal(bindings(f.store).length, 0);
});

test('altered message, wrong key, purpose/config tampering and missing records fail closed', async () => {
  const f = fixture(); const key = wallet(); const other = wallet();
  const c = await f.service.issueChallenge('token-a', { wallet: key.address });
  await assert.rejects(f.service.complete('token-a', { challengeId: c.challengeId, signature: key.signature(c.message + '!') }));
  await assert.rejects(finish(f.service, 'token-a', c, other));
  const otherService = createIdentityService({ store: f.store, authenticateToken: f.authenticateToken, config: { ...config, cluster: 'testnet' }, now: f.getTime });
  await assert.rejects(finish(otherService, 'token-a', c, key));
  await assert.rejects(f.service.complete('token-a', { challengeId: 'a'.repeat(64), signature: key.signature(c.message) }));
  const [id, record] = [...f.store.snapshot()].find(([id]) => id.startsWith('challenges/'));
  f.store.corrupt(id, { ...record, message: record.message.replace('wallet-identity', 'payment') });
  await assert.rejects(finish(f.service, 'token-a', c, key));
  assert.equal(bindings(f.store).length, 0);
});

test('expiry boundary, future clock and transaction retry recheck', async () => {
  for (const offset of [-1, 0, 1]) {
    const f = fixture(); const key = wallet(); const c = await f.service.issueChallenge('token-a', { wallet: key.address });
    f.time(c.expiresAt + offset);
    if (offset < 0) await finish(f.service, 'token-a', c, key);
    else { await assert.rejects(finish(f.service, 'token-a', c, key)); assert.equal(bindings(f.store).length, 0); }
  }
  const f = fixture(); const key = wallet(); const c = await f.service.issueChallenge('token-a', { wallet: key.address });
  f.time(999_999); await assert.rejects(finish(f.service, 'token-a', c, key));
  f.time(c.expiresAt - 1);
  f.store.retryAdvance = () => f.time(c.expiresAt);
  await assert.rejects(finish(f.service, 'token-a', c, key));
  assert.equal(bindings(f.store).length, 0);
  f.time(NaN); await assert.rejects(f.service.issueChallenge('token-a', { wallet: key.address }));
});

test('atomic sliding rate limit 5/min per UID, boundary and callback retry nonce', async () => {
  const f = fixture(); const key = wallet();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => f.service.issueChallenge('token-a', { wallet: key.address })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 5);
  f.time(1_059_999); await assert.rejects(f.service.issueChallenge('token-a', { wallet: key.address }));
  f.time(1_060_000); f.store.retryAdvance = () => {};
  const c = await f.service.issueChallenge('token-a', { wallet: key.address });
  assert.equal(JSON.parse(c.message).nonce, c.challengeId);
  const records = [...f.store.snapshot()].filter(([id]) => id.startsWith('challenges/'));
  assert.equal(records.length, 6, 'Retried callback creates one record');
  await f.service.issueChallenge('token-b', { wallet: key.address });
});

test('binding reads delayed across TTL or backwards clock cannot consume or bind', async () => {
  for (const future of [false, true]) {
    const f = fixture(); const key = wallet();
    const c = await f.service.issueChallenge('token-a', { wallet: key.address });
    f.time(c.expiresAt - 1);
    const before = f.store.snapshot();
    f.store.onRead = async id => {
      if (id.startsWith('wallets/')) {
        await Promise.resolve();
        f.time(future ? 999_999 : c.expiresAt);
      }
    };
    await assert.rejects(finish(f.service, 'token-a', c, key));
    assert.deepEqual(f.store.snapshot(), before);
  }
});

test('corrupt binding records fail closed on issue and complete', async () => {
  for (const prefix of ['uids', 'wallets']) {
    for (const corrupt of [false, {}, { uid: 'user/a', extra: 1 }, { wallet: 'invalid', extra: 1 }]) {
      const f = fixture(); const key = wallet();
      const c = await f.service.issueChallenge('token-a', { wallet: key.address });
      const value = prefix === 'uids' ? 'user/a' : key.address;
      f.store.corrupt(`${prefix}/${Buffer.from(value).toString('hex')}`, corrupt);
      const before = f.store.snapshot();
      await assert.rejects(f.service.issueChallenge('token-a', { wallet: key.address }));
      await assert.rejects(finish(f.service, 'token-a', c, key));
      assert.deepEqual(f.store.snapshot(), before);
    }
  }
});

test('concurrent consume, different wallets same UID, same wallet other UID, swaps', async () => {
  for (const mode of ['consume', 'same-uid', 'same-wallet', 'swap']) {
    const f = fixture(); const a = wallet(); const b = wallet();
    const first = await f.service.issueChallenge('token-a', { wallet: a.address });
    const token = mode === 'same-wallet' || mode === 'swap' ? 'token-b' : 'token-a';
    const secondKey = mode === 'same-uid' || mode === 'swap' ? b : a;
    const second = mode === 'consume' ? first : await f.service.issueChallenge(token, { wallet: secondKey.address });
    const results = await Promise.allSettled([finish(f.service, 'token-a', first, a), finish(f.service, token, second, secondKey)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, mode === 'swap' ? 2 : 1);
    const before = f.store.snapshot();
    await assert.rejects(f.service.issueChallenge('token-a', { wallet: b.address }));
    await assert.rejects(f.service.issueChallenge('token-b', { wallet: a.address }));
    assert.deepEqual(f.store.snapshot(), before);
  }
});

test('store read/write/commit failures roll back nonce and both bindings', async () => {
  for (const failWrite of [1, 2, 3]) {
    const f = fixture(); const key = wallet(); const c = await f.service.issueChallenge('token-a', { wallet: key.address });
    const before = f.store.snapshot(); f.store.failWrite = failWrite;
    await assert.rejects(finish(f.service, 'token-a', c, key));
    assert.deepEqual(f.store.snapshot(), before);
    f.store.failWrite = 0; await finish(f.service, 'token-a', c, key);
  }
  const f = fixture(); const key = wallet(); const c = await f.service.issueChallenge('token-a', { wallet: key.address });
  const before = f.store.snapshot();
  await assert.rejects(finish(f.service, 'forged', c, key));
  assert.deepEqual(f.store.snapshot(), before);
  f.store.onRead = async () => { throw new Error('store read failure'); };
  await assert.rejects(finish(f.service, 'token-a', c, key));
  await assert.rejects(f.service.issueChallenge('token-a', { wallet: key.address }));
  assert.deepEqual(f.store.snapshot(), before);
  f.store.onRead = null;
  f.store.failCommit = true;
  await assert.rejects(finish(f.service, 'token-a', c, key)); assert.deepEqual(f.store.snapshot(), before);
  const broken = createIdentityService({ config, authenticateToken: f.authenticateToken,
    store: { transaction: async () => { throw new Error('store unavailable'); } } });
  await assert.rejects(broken.issueChallenge('token-a', { wallet: key.address }));
  await assert.rejects(finish(broken, 'token-a', c, key));
  for (const failWrite of [1, 2]) {
    const fresh = fixture(); fresh.store.failWrite = failWrite;
    await assert.rejects(fresh.service.issueChallenge('token-a', { wallet: key.address }));
    assert.equal(fresh.store.snapshot().size, 0);
  }
});
