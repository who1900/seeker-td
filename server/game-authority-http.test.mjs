import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGameAuthorityService } from './game-authority.mjs';
import { createGameAuthorityHttpHandler } from './game-authority-http.mjs';
import { createCommerceFirestoreStore } from './commerce-firestore.mjs';
import { encoded } from './commerce-common.mjs';
import { fixture } from './commerce.test-support.mjs';

const response = () => ({ headers: {}, statusCode: 0, writableEnded: false, headersSent: false,
  setHeader(k, v) { this.headers[k] = v; }, end(text) { this.text = text; this.writableEnded = true; this.headersSent = true; } });
const request = (action, body, overrides = {}) => ({ method: 'POST', url: `/api/game-authority/v1/${action}`, protocol: 'https',
  headers: { authorization: 'Bearer owner-token', origin: 'https://game.invalid', 'content-type': 'application/json' },
  rawHeaders: ['authorization', 'Bearer owner-token'], rawBody: Buffer.from(JSON.stringify(body)), ...overrides });
async function setup() {
  const f = fixture(), q = await f.quote(), p = f.pay(q); await f.receipt(q, p.sig);
  const store = createCommerceFirestoreStore({ projectId: f.sdk.projectId, firestore: f.sdk, checkPrivilege() {}, authority: true });
  const authority = createGameAuthorityService({ store, authenticateToken: async token => {
    if (token !== 'owner-token') throw new Error('IDENTITY_DENIED'); return { uid: f.uid };
  }, policy: { version: 'alpha-1', freeRunsPerUtcDay: 3, stdCosts: {} }, enabled: true, now: () => f.time });
  const handler = createGameAuthorityHttpHandler({ authority, origin: 'https://game.invalid', enabled: true });
  const body = { version: 1, uid: f.uid, payer: f.payer, requestId: 'a'.repeat(32), policyVersion: 'alpha-1', action: 'paid-run', amount: '1' };
  return { f, authority, handler, body };
}

test('HTTP contract balance and immutable debit response loss retry without second debit', async () => {
  const { f, handler, body } = await setup();
  const balance = response(); await handler(request('balance', { version: 1, uid: body.uid, payer: body.payer }), balance);
  assert.equal(balance.statusCode, 200); assert.deepEqual(JSON.parse(balance.text).balances, { runs: '1', std: '0' });
  const first = response(); first.destroyed = true;
  await handler(request('debit', body), first);
  assert.deepEqual(f.sdk.docs.get(`commerceBalances/${encoded(f.uid)}`), { runs: '0', std: '0' });
  const retry = response(); await handler(request('debit', body), retry);
  assert.equal(retry.statusCode, 200); assert.equal(JSON.parse(retry.text).requestId, body.requestId);
  const again = response(); await handler(request('debit', body), again); assert.equal(again.text, retry.text);
  assert.equal(retry.headers['cache-control'], 'no-store');
});

test('HTTPS, bearer, shapes, origin, amount and routes fail closed without writes', async () => {
  const { f, handler, body } = await setup(), before = structuredClone(f.sdk.docs);
  const cases = [
    [request('debit', body, { protocol: 'http' }), 403],
    [request('debit', body, { headers: { authorization: 'Bearer owner-token', origin: 'https://other.invalid' } }), 403],
    [request('debit', body, { headers: { 'content-type': 'application/json' } }), 401],
    [request('debit', body, { rawHeaders: ['authorization', 'Bearer owner-token', 'Authorization', 'Bearer other'] }), 401],
    [request('debit', body, { rawBody: Buffer.alloc(4097) }), 400],
    [request('debit', body, { rawBody: Buffer.from('{invalid') }), 400],
    [request('debit', body, { headers: { authorization: 'Bearer owner-token', 'content-type': 'text/plain' } }), 415],
    [request('debit', { ...body, amount: '01' }), 403],
    [request('debit', { ...body, uid: 'other' }), 403],
    [request('debit', { ...body, score: 99999 }), 403],
    [request('debit?extra=true', body), 404],
    [request('debit', body, { method: 'GET' }), 404],
  ];
  for (const [req, status] of cases) { const res = response(); await handler(req, res); assert.equal(res.statusCode, status); }
  assert.deepEqual(f.sdk.docs, before);
});

test('HTTP default disabled and settlement/payout always disabled even with spoofed evidence', async () => {
  const { f, authority, body } = await setup(), before = structuredClone(f.sdk.docs);
  const disabled = createGameAuthorityHttpHandler({ authority, origin: 'https://game.invalid' });
  const off = response(); await disabled(request('debit', body), off); assert.equal(off.statusCode, 503);
  const handler = createGameAuthorityHttpHandler({ authority, origin: 'https://game.invalid', enabled: true });
  for (const action of ['settle', 'payout']) {
    const res = response(); await handler(request(action, { replayVerified: true, score: 99999 }), res);
    assert.equal(res.statusCode, 503); assert.match(JSON.parse(res.text).error, /DISABLED/);
  }
  assert.deepEqual(f.sdk.docs, before);
});

test('HTTP timed out in-flight debit may commit; retry same request returns its receipt', async () => {
  const { f, authority, body } = await setup(); let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const delayed = { ...authority, async debit(...args) { await barrier; return authority.debit(...args); } };
  const handler = createGameAuthorityHttpHandler({ authority: delayed, origin: 'https://game.invalid', enabled: true, timeoutMilliseconds: 5 });
  const res = response(), pending = handler(request('debit', body), res);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(res.statusCode, 503); assert.match(JSON.parse(res.text).error, /RETRY_SAME_REQUEST/);
  release(); await pending;
  const retry = response(); await handler(request('debit', body), retry); assert.equal(retry.statusCode, 200);
  assert.deepEqual(f.sdk.docs.get(`commerceBalances/${encoded(f.uid)}`), { runs: '0', std: '0' });
});
