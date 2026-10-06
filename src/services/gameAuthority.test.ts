import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { createGameAuthorityClient } from './gameAuthority';
import type { AuthorityReceipt, AuthoritySession, AuthoritySnapshot } from './gameAuthority';

const origin = 'https://game.invalid', payer = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58();
const bound: AuthoritySession = { uid: 'owner', payer, token: 'firebase-token' };
const debit = { requestId: 'a'.repeat(32), policyVersion: 'alpha-1', action: 'paid-run', amount: '1' };
const snapshot: AuthoritySnapshot = { version: 1, uid: bound.uid, payer, balances: { runs: '0', std: '9007199254740993' },
  free: { day: 100, remaining: 3 }, settlementEnabled: false, payoutEnabled: false };
const receipt: AuthorityReceipt = { ...snapshot, ...debit, committedAt: 8640000000 };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

test('same-origin HTTPS bearer strict shapes, exact uint64 and no local balance writes', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = createGameAuthorityClient({ origin, getSession: async () => bound, fetch: (async (url, init) => {
    calls.push({ url: String(url), init: init! }); return json(String(url).endsWith('/balance') ? snapshot : receipt);
  }) as typeof fetch });
  assert.deepEqual(await client.balance(), snapshot); assert.deepEqual(await client.debit(debit), receipt);
  assert.equal(calls[1].url, `${origin}/api/game-authority/v1/debit`);
  assert.deepEqual(JSON.parse(calls[1].init.body as string), { version: 1, uid: bound.uid, payer, ...debit });
  assert.equal((calls[1].init.headers as Record<string, string>).Authorization, `Bearer ${bound.token}`);
  assert.equal(calls[1].init.redirect, 'error'); assert.equal(calls[1].init.credentials, 'omit'); assert.equal(calls[1].init.cache, 'no-store');
  assert.equal(calls.length, 2);
});

test('invalid origin, identity, amount and request reject before transport', async () => {
  for (const bad of ['http://game.invalid', `${origin}/`, `${origin}/path`, `${origin}?x=1`, 'https://u:p@game.invalid', `${origin}#fragment`]) {
    assert.throws(() => createGameAuthorityClient({ origin: bad, getSession: async () => bound }));
  }
  let calls = 0;
  const fetcher = (async () => { calls++; return json(receipt); }) as typeof fetch;
  for (const session of [null, { ...bound, uid: '' }, { ...bound, token: 'bad token' }, { ...bound, payer: 'bad' }]) {
    await assert.rejects(createGameAuthorityClient({ origin, getSession: async () => session, fetch: fetcher }).debit(debit));
  }
  const client = createGameAuthorityClient({ origin, getSession: async () => bound, fetch: fetcher });
  for (const amount of ['2', '-1', '01', '1e0', '1.0', '18446744073709551616']) await assert.rejects(client.debit({ ...debit, amount }));
  await assert.rejects(client.debit({ ...debit, requestId: '../other' })); assert.equal(calls, 0);
});

test('browser application origin must equal HTTPS transport origin', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
  try {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://other.invalid' } });
    assert.throws(() => createGameAuthorityClient({ origin, getSession: async () => bound }));
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin } });
    assert.ok(createGameAuthorityClient({ origin, getSession: async () => bound }));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'location', descriptor);
    else delete (globalThis as unknown as { location?: unknown }).location;
  }
});

test('account switched during response is rejected, with no automatic debit retry', async () => {
  let current = bound, calls = 0;
  const client = createGameAuthorityClient({ origin, getSession: async () => current, fetch: (async () => {
    calls++; current = { ...bound, uid: 'other' }; return json(receipt);
  }) as typeof fetch });
  await assert.rejects(client.debit(debit)); assert.equal(calls, 1);
});

test('unverified, mismatched, extra and unsafe response fields fail closed', async () => {
  const mutations = [{ uid: 'other' }, { payer: Keypair.generate().publicKey.toBase58() }, { settlementEnabled: true }, { payoutEnabled: true },
    { score: 9999 }, { requestId: 'b'.repeat(32) }, { amount: '2' }, { committedAt: 1.5 }, { version: 2 },
    { free: { day: 101, remaining: 3 } }, { balances: { runs: '00', std: '0' } }, { balances: { runs: '0', std: 123 } }];
  for (const mutation of mutations) {
    const client = createGameAuthorityClient({ origin, getSession: async () => bound, fetch: (async () => json({ ...receipt, ...mutation })) as typeof fetch });
    await assert.rejects(client.debit(debit));
  }
  for (const status of [202, 403, 503]) {
    const client = createGameAuthorityClient({ origin, getSession: async () => bound, fetch: (async () => json(receipt, status)) as typeof fetch });
    await assert.rejects(client.debit(debit));
  }
});

test('whole-operation timeout includes token, fetch and response stream; cancellation never retries', async () => {
  const hanging = <T>(): Promise<T> => new Promise(() => {});
  const token = createGameAuthorityClient({ origin, timeoutMs: 5, getSession: () => hanging(), fetch: (async () => json(receipt)) as typeof fetch });
  await assert.rejects(token.debit(debit), /ABORTED_RETRY_SAME_REQUEST/);
  let calls = 0;
  const fetchHang = createGameAuthorityClient({ origin, timeoutMs: 5, getSession: async () => bound, fetch: (async () => { calls++; return hanging(); }) as typeof fetch });
  await assert.rejects(fetchHang.debit(debit), /ABORTED_RETRY_SAME_REQUEST/); assert.equal(calls, 1);
  const streamHang = createGameAuthorityClient({ origin, timeoutMs: 5, getSession: async () => bound,
    fetch: (async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } })) as typeof fetch });
  await assert.rejects(streamHang.debit(debit), /ABORTED_RETRY_SAME_REQUEST/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchHang.debit(debit, controller.signal)); assert.equal(calls, 1);
});

test('oversized, redirected, non-JSON and invalid UTF8 responses reject', async () => {
  for (const result of [new Response('x'.repeat(4097), { headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify(receipt), { headers: { 'content-type': 'text/plain' } }),
    new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
    Object.defineProperty(json(receipt), 'redirected', { value: true })]) {
    const client = createGameAuthorityClient({ origin, getSession: async () => bound, fetch: (async () => result) as typeof fetch });
    await assert.rejects(client.debit(debit));
  }
});
