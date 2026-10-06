import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCommerceConfig, amountFor } from './commerce-config.mjs';
import { encoded, QUOTE_KEYS } from './commerce-common.mjs';
import { fixture, environment, signature, wallet } from './commerce.test-support.mjs';

test('default catalog safely disabled with nullable configuration DTO', async () => {
  const f = fixture({ COMMERCE_CATALOG_JSON: undefined, COMMERCE_RATES_JSON: undefined,
    COMMERCE_RPC_URL: undefined, COMMERCE_RECIPIENT: undefined, COMMERCE_GENESIS_HASH: undefined,
    COMMERCE_SKR_MINT: undefined, COMMERCE_SKR_DECIMALS: undefined });
  const dto = await f.service.catalog();
  assert.deepEqual({ ...dto, products: [] }, { enabled: false, reason: 'COMMERCE_NOT_CONFIGURED_OR_RATE_STALE',
    cluster: 'devnet', genesisHash: null, recipient: null, products: [] });
  assert.equal(dto.products.length, 6); assert.ok(dto.products.every(p => p.prices.length === 0));
  assert.deepEqual(dto.products.map(p => [p.id, p.usdCents, p.runs, p.std]), [
    ['runs-1', 25, 1, 0], ['runs-3', 65, 3, 0], ['runs-10', 195, 10, 0],
    ['std-500', 99, 0, 500], ['std-1500', 249, 0, 1500], ['std-4000', 599, 0, 4000],
  ]);
  await assert.rejects(f.quote(), /COMMERCE_LOCKED/);
  assert.equal(f.calls.length, 0);
});
test('catalog is deeply immutable and mainnet has no env bypass', () => {
  const f = fixture();
  assert.ok(Object.isFrozen(f.config.products[0])); assert.ok(Object.isFrozen(f.config.rates.SOL));
  assert.throws(() => { f.config.products[0].runs = 99; });
  for (const cluster of ['mainnet', 'mainnet-beta', 'testnet', 'localnet']) {
    assert.throws(() => readCommerceConfig({ COMMERCE_CLUSTER: cluster, COMMERCE_AUDIT_APPROVED: 'true' }), /MAINNET_LOCKED/);
  }
  for (const override of [{ COMMERCE_QUOTE_TTL_MS: '600001' }, { COMMERCE_GENESIS_HASH: wallet() },
    { COMMERCE_RPC_URL: 'http://127.0.0.1:8899' }, { COMMERCE_RPC_URL: 'https://user:password@example.invalid' },
    { COMMERCE_CATALOG_JSON: '[{"id":"a","usdCents":25,"runs":1,"std":1,"enabled":true}]' },
    { COMMERCE_CATALOG_JSON: '[{"id":123,"usdCents":25,"runs":1,"std":0,"enabled":true}]' },
    { COMMERCE_CATALOG_JSON: '[{"id":"a","usdCents":0.25,"runs":1,"std":0,"enabled":true}]' }]) {
    assert.throws(() => readCommerceConfig(environment(f.time, override)), /COMMERCE_CONFIG/);
  }
});
test('exact integer cents ceil conversion never rounds through Number', () => {
  assert.equal(amountFor(25, { numerator: '5', denominator: '2' }), '63');
  assert.equal(amountFor(1, { numerator: '9007199254740993', denominator: '1' }), '9007199254740993');
  assert.throws(() => amountFor(2, { numerator: '18446744073709551615', denominator: '1' }), /PRICE_RANGE/);
});
test('pilot run packs have strictly decreasing per-run USD cents, without floats', () => {
  const p = readCommerceConfig({}).products.filter(v => v.runs > 0);
  assert.ok(BigInt(p[1].usdCents) * BigInt(p[0].runs) < BigInt(p[0].usdCents) * BigInt(p[1].runs));
  assert.ok(BigInt(p[2].usdCents) * BigInt(p[1].runs) < BigInt(p[1].usdCents) * BigInt(p[2].runs));
});
test('catalog/client shape and all six grants match immutable quote snapshots', async () => {
  const f = fixture(), dto = await f.service.catalog();
  assert.deepEqual(Object.keys(dto), ['enabled', 'reason', 'cluster', 'genesisHash', 'recipient', 'products']);
  assert.equal(dto.enabled, true); assert.equal(dto.products.length, 6);
  for (const p of dto.products) {
    assert.deepEqual(Object.keys(p), ['id', 'title', 'runs', 'std', 'usdCents', 'prices']);
    assert.equal(p.prices.length, 2);
    for (const price of p.prices) {
      const q = await f.quote(p.id, price.currency);
      assert.deepEqual(Object.keys(q), QUOTE_KEYS);
      assert.equal(q.amount, price.amount); assert.equal(q.decimals, price.decimals); assert.equal(q.mint, price.mint);
      assert.match(q.id, /^[a-f0-9]{32}$/); assert.equal(q.memo, `SEEKER:TD/commerce/v1/${q.id}`);
      assert.equal(q.runs, p.runs); assert.equal(q.std, p.std);
      assert.ok(q.expiresAt - f.time <= 600000);
    }
  }
  assert.equal(f.sdk.docs.has(`commerceBalances/${encoded(f.uid)}`), false, 'quotes never credit');
});
test('future/stale FX locks quotes, old paid quote settles after TTL/rate expiry and restart', async () => {
  const f = fixture(), q = await f.quote(), { sig } = f.pay(q);
  f.setTime(f.time + 900001);
  assert.equal((await f.service.catalog()).enabled, false);
  await assert.rejects(f.quote(), /LOCKED/);
  const receipt = await f.make().receipt('owner-token', { quoteId: q.id, signature: sig });
  assert.equal(receipt.status, 'confirmed'); assert.equal(receipt.quoteId, q.id);
  assert.deepEqual(await f.receipt(q, sig), receipt);
  f.setTime(f.time - 900002);
  await assert.rejects(f.quote(), /LOCKED/);
});
test('auth, forward/reverse owner binding and extra client fields cannot authorize credits', async () => {
  const f = fixture();
  await assert.rejects(f.service.quote('forged', { productId: 'runs-1', currency: 'SOL', payer: f.payer }), /IDENTITY_DENIED/);
  await assert.rejects(f.service.quote('owner-token', { productId: 'runs-1', currency: 'SOL', payer: f.payer, amount: '1' }));
  await assert.rejects(f.service.quote('owner-token', { productId: 'runs-1', currency: 'STD', payer: f.payer }));
  const q = await f.quote(), { sig } = f.pay(q);
  f.sdk.docs.set(`identityWallets/${encoded(f.payer)}`, { uid: 'attacker' });
  await assert.rejects(f.receipt(q, sig)); await assert.rejects(f.quote());
  assert.equal(f.sdk.docs.has(`commerceBalances/${encoded(f.uid)}`), false);
});
test('concurrent replay commits exactly once and distinct purchases preserve both counters', async () => {
  const f = fixture(), q = await f.quote(), { sig } = f.pay(q);
  const receipts = await Promise.all(Array.from({ length: 8 }, () => f.receipt(q, sig)));
  for (const r of receipts) assert.deepEqual(r, receipts[0]);
  assert.deepEqual(f.sdk.docs.get(`commerceBalances/${encoded(f.uid)}`), { runs: '1', std: '0' });
  const q2 = await f.quote('std-1500', 'SKR'), p2 = f.pay(q2), q3 = await f.quote('runs-3'), p3 = f.pay(q3);
  await Promise.all([f.receipt(q2, p2.sig), f.receipt(q3, p3.sig)]);
  assert.deepEqual(f.sdk.docs.get(`commerceBalances/${encoded(f.uid)}`), { runs: '4', std: '1500' });
  assert.ok(f.sdk.retries > 0);
  assert.equal([...f.sdk.docs.keys()].filter(k => k.startsWith('commerceReceipts/')).length, 3);
});
test('signature reuse, second signature for consumed quote and changed quote fail closed', async () => {
  const f = fixture(), q = await f.quote(), p = f.pay(q);
  await f.receipt(q, p.sig);
  await assert.rejects(f.receipt(q, signature()), /REPLAY/);
  const q2 = await f.quote(); await assert.rejects(f.receipt(q2, p.sig), /REPLAY/);
  assert.deepEqual(f.sdk.docs.get(`commerceBalances/${encoded(f.uid)}`), { runs: '1', std: '0' });
});
test('failed RPC, failed verification, commit failure and overflow leave no partial receipt/ledger', async () => {
  const f = fixture(), q = await f.quote(), { sig, f: tx } = f.pay(q);
  tx.transaction.meta.err = { InstructionError: [0, 'error'] };
  await assert.rejects(f.receipt(q, sig));
  tx.transaction.meta.err = null; f.sdk.failCommit = true;
  await assert.rejects(f.receipt(q, sig), /COMMIT_FAILED/);
  assert.equal(f.sdk.docs.has(`commerceReceipts/${q.id}`), false);
  assert.equal(f.sdk.docs.has(`commerceLedger/${q.id}`), false);
  f.sdk.failCommit = false;
  f.sdk.docs.set(`commerceBalances/${encoded(f.uid)}`, { runs: '18446744073709551615', std: '0' });
  await assert.rejects(f.receipt(q, sig), /BALANCE/);
  f.sdk.docs.delete(`commerceBalances/${encoded(f.uid)}`);
  await f.receipt(q, sig);
});
test('10% original currency pools carry exact remainder; STD packs never enter pool', async () => {
  const f = fixture();
  for (const [product, currency] of [['runs-1', 'SOL'], ['runs-1', 'SOL'], ['runs-3', 'SKR'], ['std-4000', 'SOL'], ['std-500', 'SKR']]) {
    const q = await f.quote(product, currency), { sig } = f.pay(q); await f.receipt(q, sig);
    const ledger = f.sdk.docs.get(`commerceLedger/${q.id}`);
    assert.equal(ledger.poolContributionNumerator, q.runs ? q.amount : '0');
  }
  assert.deepEqual(f.sdk.docs.get('commercePools/SOL'), { currency: 'SOL', eligiblePurchaseBaseUnits: '126',
    poolBaseUnits: '12', remainderTenths: 6, status: 'pending_SOL_conversion' });
  assert.deepEqual(f.sdk.docs.get('commercePools/SKR'), { currency: 'SKR', eligiblePurchaseBaseUnits: '163',
    poolBaseUnits: '16', remainderTenths: 3, status: 'SKR_reward_pool' });
});
