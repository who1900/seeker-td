import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { applyCommerceReceipt, applyScopedCommerceReceipt, commerceAccountKey, createCommerceClient,
  formatAtomic, readCommercePending, recordCommercePending, switchCommerceAccount,
  trustedCommerceUrl, validateCommerceCatalog, validateCommerceQuote, validateCommerceReceipt } from './commerce';
import type { CommerceCatalog, CommerceQuote, CommerceReceipt, CommerceStorage } from './commerce';

const payer = Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey.toBase58();
const recipient = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey.toBase58();
const genesisHash = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const id = 'a'.repeat(32), signature = '2'.repeat(88), now = 1_000_000;
const quote: CommerceQuote = { id, productId: 'runs-1', currency: 'SOL', amount: '123456789', decimals: 9,
  mint: null, payer, recipient, cluster: 'devnet', genesisHash, expiresAt: now + 60_000, runs: 1, std: 0,
  memo: `SEEKER:TD/commerce/v1/${id}` };
const catalog: CommerceCatalog = { enabled: true, reason: null, cluster: 'devnet', genesisHash, recipient,
  products: [{ id: 'runs-1', title: '1 extra run', runs: 1, std: 0, usdCents: 25,
    prices: [{ currency: 'SOL', amount: quote.amount, decimals: 9, mint: null }] }] };
const receipt: CommerceReceipt = { id, quoteId: id, signature, payer, runs: 1, std: 0, status: 'confirmed' };
function storage(): CommerceStorage {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}
function fixture(overrides: { token?: string | null; uid?: string | null; result?: unknown; timeoutMs?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [], disk = storage();
  const client = createCommerceClient({ url: 'https://trusted.example', getToken: async () => overrides.token === undefined ? 'firebase-token' : overrides.token,
    getUid: async () => overrides.uid === undefined ? 'uid-a' : overrides.uid, storage: disk, now: () => now,
    timeoutMs: overrides.timeoutMs, identityAudience: 'firebase-project', identityOrigin: 'https://localhost',
    fetch: (async (url, init) => {
      calls.push({ url: String(url), init: init! });
      const result = String(url).endsWith('/catalog') ? catalog : String(url).endsWith('/quote') ? quote : receipt;
      return { ok: true, status: 200, json: async () => overrides.result ?? result } as Response;
    }) as typeof fetch });
  return { client, calls, disk };
}
const signal = () => new AbortController().signal;
test('HTTPS environment is required, with no redirects, credentials or query tricks', () => {
  for (const value of ['', '   ', 'http://trusted.example', 'https://u:p@trusted.example', 'https://trusted.example?redirect=bad', 'https://trusted.example#bad']) {
    assert.throws(() => trustedCommerceUrl(value));
  }
  assert.equal(trustedCommerceUrl('https://trusted.example/'), 'https://trusted.example');
});
test('exact atomic amount parsing, closed catalogue and no fake locked addresses', () => {
  assert.equal(formatAtomic('18446744073709551615', 9), '18446744073.709551615');
  assert.equal(formatAtomic('1', 9), '0.000000001');
  assert.equal(formatAtomic('1200000000', 9), '1.2');
  for (const amount of ['1.2', '01', '-1', '1e9', '18446744073709551616']) assert.throws(() => validateCommerceQuote({ ...quote, amount }, now));
  validateCommerceCatalog({ ...catalog, enabled: false, reason: 'Locked', recipient: null, genesisHash: null, products: [] });
  assert.throws(() => validateCommerceCatalog({ ...catalog, recipient: null }));
  assert.throws(() => validateCommerceCatalog({ ...catalog, products: [catalog.products[0], catalog.products[0]] }));
});
test('quote rejects wrong chain, precision, expiry, payer, grants and nonce', () => {
  for (const mutation of [{ cluster: 'mainnet-beta' }, { amount: '0' }, { decimals: 6 }, { mint: recipient },
    { payer: recipient }, { recipient: 'recipient' }, { genesisHash: 'bad' }, { expiresAt: now },
    { expiresAt: now + 600001 }, { runs: -1 }, { std: 500 }, { memo: 'just a note' }, { id: 'not-hex' }]) {
    assert.throws(() => validateCommerceQuote({ ...quote, ...mutation }, now));
  }
});
test('catalog and quote requests use only product, currency and payer with Firebase bearer', async () => {
  const f = fixture();
  assert.deepEqual(await f.client.quote('runs-1', 'SOL', payer, signal()), quote);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(JSON.parse(f.calls[1].init.body as string), { productId: 'runs-1', currency: 'SOL', payer });
  assert.equal((f.calls[1].init.headers as Record<string, string>).Authorization, 'Bearer firebase-token');
  assert.equal(f.calls[1].init.redirect, 'error'); assert.equal(f.calls[1].init.credentials, 'omit');
  assert.equal(f.calls[1].init.cache, 'no-store');
  await assert.rejects(f.client.quote('runs-1', 'SKR', payer, signal()), /unavailable/);
});
test('Firebase auth unavailable and cancelled request never call HTTP', async () => {
  const f = fixture({ token: null });
  await assert.rejects(f.client.catalog(signal()), /Firebase/); assert.equal(f.calls.length, 0);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(fixture().client.catalog(cancelled.signal), /Cancelled/);
});
test('pending signature persists BEFORE one send; reconciliation does not send again', async () => {
  const f = fixture(); let sends = 0;
  const prepared = { feeLamports: '5000', rentLamports: '0', async send(beforeBroadcast: (sig: string) => void) {
    beforeBroadcast(signature); assert.equal(readCommercePending(f.disk)[0].signature, signature); sends++; return signature;
  } };
  const result = await f.client.purchase(quote, prepared, signal()); assert.deepEqual(result, receipt);
  await assert.rejects(f.client.purchase(quote, prepared, signal()), /already signed/);
  assert.equal(sends, 1);
  assert.deepEqual(await f.client.reconcile(f.client.pending()[0], signal()), receipt); assert.equal(sends, 1);
});
test('unknown broadcast remains recoverable, never credits or resends automatically', async () => {
  const f = fixture(); let sends = 0;
  await assert.rejects(f.client.purchase(quote, { feeLamports: '5000', rentLamports: '0', async send(save) {
    save(signature); sends++; throw new Error('RPC timeout');
  } }, signal()), /timeout/);
  assert.equal(sends, 1); assert.equal(f.client.pending().length, 1);
  const result = await f.client.reconcile(f.client.pending()[0], signal()); assert.deepEqual(result, receipt); assert.equal(sends, 1);
});
test('pending receipt and account mismatch do not fabricate credits', async () => {
  const f = fixture({ result: { status: 'pending' } }), pending = { uid: 'uid-a', quote, signature };
  assert.equal(await f.client.reconcile(pending, signal()), null);
  await assert.rejects(f.client.reconcile({ ...pending, uid: 'uid-b' }, signal()), /original/);
  for (const mutation of [{ signature: '3'.repeat(88) }, { quoteId: 'b'.repeat(32) }, { runs: 10 }, { std: 500 }, { payer: recipient }, { status: 'pending' }]) {
    assert.throws(() => validateCommerceReceipt({ ...receipt, ...mutation }, pending));
  }
});
test('storage denial and corrupt journal prevent broadcasting; original entries stay intact', async () => {
  const denied = { getItem: () => null, setItem: () => { throw new Error('disk full'); } };
  assert.throws(() => recordCommercePending(denied, { uid: 'uid-a', quote, signature }), /disk full/);
  assert.throws(() => readCommercePending({ getItem: () => '{bad', setItem() {} }), /unreadable/);
  const disk = storage(); recordCommercePending(disk, { uid: 'uid-a', quote, signature });
  assert.throws(() => recordCommercePending(disk, { uid: 'uid-b', quote, signature }), /Conflicting/);
  assert.equal(readCommercePending(disk)[0].uid, 'uid-a');
});
test('cache credits each receipt, quote and signature once, while preserving free runs and prize pool', () => {
  const state = { tokens: 10, paidRuns: 0, dailyFreeLeft: 2, prizePool: 123 };
  const once = applyCommerceReceipt(state, receipt);
  assert.equal(once.paidRuns, 1); assert.equal(once.tokens, 10); assert.equal(once.dailyFreeLeft, 2); assert.equal(once.prizePool, 123);
  assert.strictEqual(applyCommerceReceipt(once, receipt), once);
  assert.strictEqual(applyCommerceReceipt(once, { ...receipt, id: 'receipt-2' }), once);
  assert.throws(() => applyCommerceReceipt(state, { ...receipt, runs: 0 }), /confirmed/);
});
test('UID + payer isolation: switching accounts never inherits purchased runs or STD', () => {
  let state = switchCommerceAccount({ tokens: 420, paidRuns: 0 }, 'uid-a', payer);
  state = applyScopedCommerceReceipt(state, receipt, 'uid-a');
  assert.equal(state.paidRuns, 1); assert.equal(state.tokens, 0);
  const otherWallet = switchCommerceAccount(state, 'uid-a', recipient);
  assert.equal(otherWallet.paidRuns, 0); assert.equal(otherWallet.tokens, 0);
  assert.strictEqual(applyScopedCommerceReceipt(otherWallet, receipt, 'uid-a'), otherWallet);
  const otherUser = switchCommerceAccount(state, 'uid-b', payer);
  assert.equal(otherUser.paidRuns, 0);
  const restored = switchCommerceAccount(otherWallet, 'uid-a', payer);
  assert.equal(restored.paidRuns, 1); assert.strictEqual(applyScopedCommerceReceipt(restored, receipt, 'uid-a'), restored);
  assert.equal((restored as typeof restored & { commerceAccount: string }).commerceAccount, commerceAccountKey('uid-a', payer));
});
test('signing a wallet challenge requires exact bound project, origin, purpose, nonce and canonical message', async () => {
  let signed = 0;
  const challengeId = 'b'.repeat(64);
  const proof = { audience: 'firebase-project', origin: 'https://localhost', purpose: 'SEEKER:TD/wallet-identity/v1',
    uid: 'uid-a', wallet: payer, cluster: 'devnet', nonce: challengeId, issuedAt: now, expiresAt: now + 300000 };
  function bindingClient(mutation = {}, messageTransform = (value: string) => value) {
    return createCommerceClient({ url: 'https://trusted.example', getToken: async () => 'firebase-token', getUid: async () => 'uid-a',
      storage: storage(), now: () => now, identityAudience: 'firebase-project', identityOrigin: 'https://localhost',
      fetch: (async (url) => ({ ok: true, json: async () => String(url).endsWith('challenge')
        ? { challengeId, message: messageTransform(JSON.stringify({ ...proof, ...mutation })), expiresAt: proof.expiresAt }
        : { uid: 'uid-a', wallet: payer, cluster: 'devnet' } })) as typeof fetch });
  }
  const sign = async (message: string, expected: string) => { signed++; assert.equal(expected, payer); assert.equal(message, JSON.stringify(proof)); return btoa('\0'.repeat(64)); };
  await bindingClient().bindWallet(payer, sign, signal()); assert.equal(signed, 1);
  for (const mutation of [{ purpose: 'Transfer assets' }, { audience: 'evil' }, { origin: 'https://evil' }, { uid: 'uid-b' },
    { wallet: recipient }, { cluster: 'mainnet-beta' }, { issuedAt: now + 1 }, { extra: 'arbitrary payload' }]) {
    await assert.rejects(bindingClient(mutation).bindWallet(payer, sign, signal()));
  }
  await assert.rejects(bindingClient({}, value => ` ${value}`).bindWallet(payer, sign, signal()), /canonical/);
  assert.equal(signed, 1);
});

test('HTTP JSON body timeout cannot turn an unresolved response into a catalog or receipt', async () => {
  const client = createCommerceClient({ url: 'https://trusted.example', getToken: async () => 'fixture-token',
    getUid: async () => 'uid-a', storage: storage(), timeoutMs: 15,
    fetch: async () => {
      const response = new Response(null, { status: 200 });
      response.json = () => new Promise<never>(() => {});
      return response;
    } });
  await assert.rejects(client.catalog(signal()), /Cancelled|Timed out/);
  await assert.rejects(client.reconcile({ uid: 'uid-a', quote, signature }, signal()), /Cancelled|Timed out/);
  assert.equal(client.pending().length, 0);
});

test('optional durable receipt acknowledgement validates every receipt identity/grant field and closed shape', () => {
  const disk = storage(), pending = { uid: 'uid-a', quote, signature, confirmedReceipt: receipt };
  recordCommercePending(disk, pending);
  assert.deepEqual(readCommercePending(disk)[0].confirmedReceipt, receipt);
  const key = 'seekdef_commerce_pending_v1';
  for (const mutation of [{ id: '' }, { id: 'a'.repeat(129) }, { quoteId: 'b'.repeat(32) }, { signature: '3'.repeat(88) },
    { payer: recipient }, { runs: 3 }, { std: 500 }, { status: 'pending' }, { extra: true }]) {
    disk.setItem(key, JSON.stringify([{ ...pending, confirmedReceipt: { ...receipt, ...mutation } }]));
    assert.throws(() => readCommercePending(disk), /receipt mismatch|acknowledgement/);
  }
  disk.setItem(key, JSON.stringify([{ ...pending, confirmedReceipt: null }]));
  assert.throws(() => readCommercePending(disk), /Invalid commerce response/);
  disk.setItem(key, JSON.stringify([{ uid: 'uid-a', quote, signature }]));
  assert.equal(readCommercePending(disk)[0].confirmedReceipt, undefined);
});

test('unvalidated server receipt never acknowledges or releases the unknown outcome guard', async () => {
  const f = fixture({ result: { ...receipt, std: 500 } });
  recordCommercePending(f.disk, { uid: 'uid-a', quote, signature });
  await assert.rejects(f.client.reconcile(f.client.pending()[0], signal()), /receipt mismatch/);
  assert.equal(f.client.pending()[0].confirmedReceipt, undefined);
  let signs = 0;
  const id = 'b'.repeat(32), next = { ...quote, id, memo: `SEEKER:TD/commerce/v1/${id}` };
  await assert.rejects(f.client.purchase(next, { feeLamports: '5000', rentLamports: '0',
    async send() { signs++; return signature; } }, signal()), /outcome is unknown/);
  assert.equal(signs, 0);
});
