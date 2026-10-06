import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCommerceFirestoreStore } from './commerce-firestore.mjs';
import { createCommerceHttpHandler } from './commerce-http.mjs';
import { parseRpcJson, createCommerceRpc } from './commerce-rpc.mjs';
import { createCommerceFirebaseRuntime, rejectCommerceEmulators } from './commerce-functions.mjs';
import { fixture, fakeFirestore } from './commerce.test-support.mjs';

test('Firestore bridge rejects writes to identity, traversal, post-write reads and poisoned callbacks', async () => {
  const sdk = fakeFirestore(), store = createCommerceFirestoreStore({ projectId: sdk.projectId, firestore: sdk, checkPrivilege() {} });
  for (const key of ['../players/admin', 'players/admin', 'commerceQuotes/not-a-quote', 'identityUids/6162']) {
    await assert.rejects(store.transaction(tx => tx.set(key, { runs: '1', std: '0' })), /COMMERCE_STORE/);
  }
  const key = `commerceQuotes/${'a'.repeat(32)}`;
  await assert.rejects(store.transaction(async tx => { await tx.set(key, {}); await tx.get(key); }), /COMMERCE_STORE/);
  await assert.rejects(store.transaction(async tx => {
    try { await tx.set('players/admin', {}); } catch {}
    return 'swallowed';
  }), /COMMERCE_STORE/);
  assert.equal(sdk.docs.size, 0);
  let leaked;
  await store.transaction(async tx => { leaked = tx; await tx.set(key, { value: 'persisted' }); });
  await assert.rejects(leaked.get(key), /COMMERCE_STORE/);
  assert.throws(() => createCommerceFirestoreStore({ projectId: 'wrong-project', firestore: sdk, checkPrivilege() {} }), /COMMERCE_STORE/);
});
test('commit privilege checks cannot be bypassed through swallowed validation errors', async () => {
  const sdk = fakeFirestore(); let privileged = true;
  const store = createCommerceFirestoreStore({ projectId: sdk.projectId, firestore: sdk,
    checkPrivilege() { if (!privileged) throw new Error('privilege revoked'); } });
  await assert.rejects(store.transaction(async tx => {
    await tx.get(`commerceQuotes/${'a'.repeat(32)}`); privileged = false;
    try { await tx.set(`commerceQuotes/${'a'.repeat(32)}`, {}); } catch {}
  }), /privilege revoked/);
  assert.equal(sdk.docs.size, 0);
});
test('raw RPC JSON retains uint64 integers, strings and nesting without floating conversion', () => {
  const x = parseRpcJson('{"n":9007199254740993,"b":18446744073709551615,"s":"quote \\" 9007199254740993","a":[42,null]}');
  assert.equal(x.n, '9007199254740993'); assert.equal(x.b, '18446744073709551615');
  assert.equal(x.s, 'quote " 9007199254740993'); assert.deepEqual(x.a, [42, null]);
  assert.throws(() => parseRpcJson('{not-json}'));
});
test('RPC POST target, method allowlist, response cap, timeout and redirects fail closed', async () => {
  const original = globalThis.fetch, calls = [];
  try {
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options }); const body = JSON.parse(options.body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: 'genesis' }));
    };
    const rpc = createCommerceRpc({ url: 'https://trusted-rpc.example.invalid/path?api-key=test-only' });
    assert.equal(await rpc.call('getGenesisHash'), 'genesis');
    assert.equal(calls[0].options.method, 'POST'); assert.equal(calls[0].options.redirect, 'error');
    assert.equal(calls[0].url, 'https://trusted-rpc.example.invalid/path?api-key=test-only');
    await assert.rejects(rpc.call('sendTransaction', ['never']), /RPC_METHOD/);
    assert.equal(calls.length, 1);
    globalThis.fetch = async () => new Response('x'.repeat(1048577));
    await assert.rejects(rpc.call('getGenesisHash'), /RPC_UNAVAILABLE/);
    globalThis.fetch = async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'wrong', result: null }));
    await assert.rejects(rpc.call('getGenesisHash'), /RPC_UNAVAILABLE/);
    globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    await assert.rejects(createCommerceRpc({ url: 'https://trusted-rpc.example.invalid', timeoutMilliseconds: 10 }).call('getGenesisHash'), /RPC_UNAVAILABLE/);
    for (const url of ['http://example.invalid', 'https://u:p@example.invalid', 'https://example.invalid/#fragment']) {
      assert.throws(() => createCommerceRpc({ url }), /RPC_CONFIG/);
    }
  } finally { globalThis.fetch = original; }
});
const response = () => ({ headers: {}, statusCode: 0, headersSent: false, writableEnded: false,
  setHeader(key, value) { this.headers[key] = value; },
  end(text) { this.text = text; this.writableEnded = true; this.headersSent = true; } });
const request = (url, body, overrides = {}) => ({ url, method: 'POST',
  headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json', origin: 'https://localhost' },
  rawHeaders: ['authorization', 'Bearer owner-token'], rawBody: Buffer.from(JSON.stringify(body)), ...overrides });
test('HTTP routes quote/receipt/catalog plus existing identity fields, Firebase bearer and Android CORS', async () => {
  const f = fixture(); const identity = {
    async issueChallenge(token, body) { assert.equal(token, 'owner-token'); return { challengeId: 'c'.repeat(64), message: body.wallet, expiresAt: f.time + 300000 }; },
    async complete(token, body) { assert.equal(token, 'owner-token'); return { uid: f.uid, wallet: f.payer, cluster: 'devnet' }; },
  };
  const handler = createCommerceHttpHandler({ commerce: f.service, identity, origin: 'https://localhost' });
  const issue = response(); await handler(request('/identity/challenge', { wallet: f.payer }), issue);
  assert.equal(issue.statusCode, 200); assert.ok(JSON.parse(issue.text).challengeId);
  const complete = response(); await handler(request('/identity/complete', { challengeId: 'c'.repeat(64), signature: 'signature' }), complete);
  assert.deepEqual(JSON.parse(complete.text), { uid: f.uid, wallet: f.payer, cluster: 'devnet' });
  const catalog = response(); await handler(request('/commerce/catalog', {}, { method: 'GET' }), catalog);
  assert.equal(catalog.statusCode, 200); assert.equal(JSON.parse(catalog.text).enabled, true);
  const quote = response(); await handler(request('/commerce/quote', { productId: 'runs-1', currency: 'SOL', payer: f.payer }), quote);
  const q = JSON.parse(quote.text), { sig } = f.pay(q);
  const receipt = response(); await handler(request('/commerce/receipt', { quoteId: q.id, signature: sig }), receipt);
  assert.equal(receipt.statusCode, 200); assert.equal(JSON.parse(receipt.text).status, 'confirmed');
  assert.equal(receipt.headers['access-control-allow-origin'], 'https://localhost');
  assert.equal(receipt.headers['cache-control'], 'no-store');
  for (const [req, status] of [
    [request('/commerce/quote', {}, { headers: { 'content-type': 'application/json' } }), 401],
    [request('/commerce/quote', {}, { rawHeaders: ['authorization', 'Bearer owner-token', 'Authorization', 'Bearer attacker'] }), 401],
    [request('/commerce/quote', {}, { headers: { origin: 'https://attacker.invalid' } }), 403],
    [request('/commerce/quote', {}, { rawBody: Buffer.alloc(4097) }), 400],
    [request('/commerce/quote', {}, { headers: { authorization: 'Bearer owner-token', 'content-type': 'text/plain' } }), 415],
    [request('/commerce/quote?amount=1', {}), 404],
  ]) { const res = response(); await handler(req, res); assert.equal(res.statusCode, status); }
  const preflight = response(); await handler(request('/commerce/quote', {}, { method: 'OPTIONS' }), preflight);
  assert.equal(preflight.statusCode, 204);
});
test('production rejects emulator routing and dry Firebase entry import performs no network', async () => {
  const saved = process.env.FIRESTORE_EMULATOR_HOST, fetch = globalThis.fetch;
  try {
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8089';
    assert.throws(rejectCommerceEmulators, /PRODUCTION_ONLY/);
    await assert.rejects(createCommerceFirebaseRuntime(), /PRODUCTION_ONLY/);
    globalThis.fetch = async () => { throw new Error('dry import attempted network'); };
    const entry = await import('./index.mjs');
    assert.equal(typeof entry.commerce, 'function');
    assert.ok(entry.commerce.__endpoint);
  } finally {
    if (saved === undefined) delete process.env.FIRESTORE_EMULATOR_HOST; else process.env.FIRESTORE_EMULATOR_HOST = saved;
    globalThis.fetch = fetch;
  }
});
