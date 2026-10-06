import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCommerceHttpHandler } from './commerce-http.mjs';
import { fixture, signature } from './commerce.test-support.mjs';
import { encoded } from './commerce-common.mjs';

test('unknown, missing, not-indexed, historical RPC failures and ambiguous evidence stay pending with no credits', async t => {
  const mutations = {
    unknown: (f, p) => { p.sig = signature(); },
    missingTransaction: (f, p) => { p.f.transaction = null; },
    missingStatus: (f, p) => { p.f.status = null; },
    unfinalized: (f, p) => { p.f.status.confirmationStatus = 'confirmed'; },
    malformedStatus: f => { const call = f.rpc.call; f.rpc.call = (m, p) => m === 'getSignatureStatuses' ? {} : call(m, p); },
    historyUnavailable: f => { const call = f.rpc.call; f.rpc.call = (m, p) => {
      if (m === 'getTransaction') throw new Error('HISTORY_UNAVAILABLE'); return call(m, p);
    }; },
    slotDisagreement: (f, p) => { p.f.status.slot++; },
    missingBlockTime: (f, p) => { p.f.transaction.blockTime = null; },
    failed: (f, p) => { p.f.status.err = { InstructionError: [0, 'failure'] }; p.f.transaction.meta.err = p.f.status.err; },
    wrongMessage: (f, p) => { p.f.transaction.transaction.message.instructions[1].parsed = 'unrelated memo'; },
    wrongSignature: (f, p) => { p.f.transaction.transaction.signatures = [signature()]; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const f = fixture(), q = await f.quote(), p = f.pay(q); mutate(f, p);
    await assert.rejects(f.receipt(q, p.sig), /COMMERCE_PENDING/);
    assert.equal(f.sdk.docs.has(`commerceBalances/${encoded(f.uid)}`), false);
    assert.equal(f.sdk.docs.has(`commerceReceipts/${q.id}`), false);
    assert.equal(f.sdk.docs.has(`commerceLedger/${q.id}`), false);
  });
});

test('HTTP 202 pending shape preserves hold; later finalized transaction credits exactly once', async () => {
  const f = fixture(), q = await f.quote(), sig = signature();
  const identity = { async issueChallenge() {}, async complete() {} };
  const handler = createCommerceHttpHandler({ commerce: f.service, identity, origin: 'https://game.invalid' });
  const req = { method: 'POST', url: '/commerce/receipt', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
    rawHeaders: ['authorization', 'Bearer owner-token'], body: { quoteId: q.id, signature: sig } };
  const send = async () => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { this.text = s; this.writableEnded = true; } };
    await handler(req, res); return res;
  };
  const pending = await send(); assert.equal(pending.statusCode, 202);
  assert.deepEqual(JSON.parse(pending.text), { status: 'pending', error: 'COMMERCE_PENDING' });
  assert.equal(pending.headers['cache-control'], 'no-store');
  assert.equal(f.sdk.docs.has(`commerceBalances/${encoded(f.uid)}`), false);
  f.pay(q, sig);
  const confirmed = await send(); assert.equal(confirmed.statusCode, 200);
  assert.equal(JSON.parse(confirmed.text).status, 'confirmed');
  await send(); assert.deepEqual(f.sdk.docs.get(`commerceBalances/${encoded(f.uid)}`), { runs: '1', std: '0' });
});
