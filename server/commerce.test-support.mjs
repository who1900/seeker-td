import { randomBytes } from 'node:crypto';
import { encodeBase58 } from './identity.mjs';
import { readCommerceConfig } from './commerce-config.mjs';
import { createCommerceFirestoreStore } from './commerce-firestore.mjs';
import { createCommerceService } from './commerce.mjs';
import { createCommerceVerifier, associatedAddress, SYSTEM, TOKEN, MEMO } from './commerce-verifier.mjs';
import { DEVNET_GENESIS, encoded } from './commerce-common.mjs';

// Test-only SDK/RPC fixtures. Production never imports this module.
export const wallet = () => encodeBase58(randomBytes(32));
export const signature = () => encodeBase58(randomBytes(64));
export const products = [
  { id: 'runs-1', usdCents: 25, runs: 1, std: 0, enabled: true },
  { id: 'runs-3', usdCents: 65, runs: 3, std: 0, enabled: true },
  { id: 'runs-10', usdCents: 195, runs: 10, std: 0, enabled: true },
  { id: 'std-500', usdCents: 99, runs: 0, std: 500, enabled: true },
  { id: 'std-1500', usdCents: 249, runs: 0, std: 1500, enabled: true },
  { id: 'std-4000', usdCents: 599, runs: 0, std: 4000, enabled: true },
];
export function environment(time, overrides = {}) {
  return { COMMERCE_CLUSTER: 'devnet', COMMERCE_GENESIS_HASH: DEVNET_GENESIS,
    COMMERCE_RPC_URL: 'https://rpc.example.invalid', COMMERCE_RECIPIENT: wallet(), COMMERCE_SKR_MINT: wallet(),
    COMMERCE_SKR_DECIMALS: '6', COMMERCE_QUOTE_TTL_MS: '300000', COMMERCE_CATALOG_JSON: JSON.stringify(products),
    COMMERCE_RATES_JSON: JSON.stringify(Object.fromEntries(['SOL', 'SKR'].map(c => [c,
      { numerator: '5', denominator: '2', timestamp: time, ttlMilliseconds: 900000 }]))), ...overrides };
}
export function fakeFirestore(projectId = 'demo-commerce-test') {
  const docs = new Map(); let revision = 0;
  const sdk = { projectId, docs, retries: 0, failCommit: false, doc: key => ({ key }),
    async runTransaction(callback) {
      for (let attempt = 0; attempt < 50; attempt++) {
        const start = revision, snapshot = structuredClone(docs), writes = new Map(); let wrote = false;
        const result = await callback({
          async get(ref) {
            if (wrote) throw new Error('SDK_READ_AFTER_WRITE');
            const value = snapshot.get(ref.key); await Promise.resolve();
            return { exists: value !== undefined, data: () => structuredClone(value) };
          },
          set(ref, value) { wrote = true; writes.set(ref.key, structuredClone(value)); },
        });
        if (writes.size && sdk.failCommit) throw new Error('SDK_COMMIT_FAILED');
        if (start !== revision) { sdk.retries++; continue; }
        for (const [key, value] of writes) docs.set(key, value);
        if (writes.size) revision++;
        return result;
      }
      throw new Error('SDK_RETRY_EXHAUSTED');
    },
  };
  return sdk;
}
export function transactionFixture(q, sig, issuedAt) {
  const source = q.currency === 'SOL' ? q.payer : associatedAddress(q.payer, q.mint);
  const dest = q.currency === 'SOL' ? q.recipient : associatedAddress(q.recipient, q.mint);
  const keys = [...new Set([q.payer, source, dest, ...(q.mint ? [q.mint] : []), q.currency === 'SOL' ? SYSTEM : TOKEN, MEMO])]
    .map((pubkey, i) => ({ pubkey, signer: i === 0, writable: [q.payer, source, dest].includes(pubkey), source: 'transaction' }));
  const pre = keys.map(() => '1000000000000000000'), post = [...pre], fee = '5000';
  post[0] = (BigInt(pre[0]) - BigInt(fee) - (q.currency === 'SOL' ? BigInt(q.amount) : 0n)).toString();
  if (q.currency === 'SOL') {
    const index = keys.findIndex(k => k.pubkey === dest); post[index] = (BigInt(pre[index]) + BigInt(q.amount)).toString();
  }
  const tokenBalance = (key, owner, amount) => ({ accountIndex: keys.findIndex(k => k.pubkey === key),
    programId: TOKEN, mint: q.mint, owner, uiTokenAmount: { amount, decimals: q.decimals, uiAmount: null } });
  const tokenAccount = owner => ({ owner: TOKEN, executable: false, space: 165,
    data: { program: 'spl-token', parsed: { type: 'account', info: { owner, mint: q.mint, state: 'initialized',
      isNative: false, tokenAmount: { amount: '1000000', decimals: q.decimals } } } } });
  const mint = { owner: TOKEN, executable: false, space: 82, data: { program: 'spl-token', parsed: { type: 'mint',
    info: { decimals: q.decimals, isInitialized: true, freezeAuthority: null } } } };
  const transfer = q.currency === 'SOL' ? { programId: SYSTEM, program: 'system', parsed: { type: 'transfer',
    info: { source, destination: dest, lamports: q.amount } } } : { programId: TOKEN, program: 'spl-token',
    parsed: { type: 'transferChecked', info: { source, destination: dest, mint: q.mint, authority: q.payer,
      tokenAmount: { amount: q.amount, decimals: q.decimals } } } };
  return { quote: q, signature: sig, issuedAt, status: { slot: 42, err: null, confirmations: null, confirmationStatus: 'finalized' },
    transaction: { slot: 42, blockTime: Math.floor(issuedAt / 1000) + 1, version: 'legacy',
      transaction: { signatures: [sig], message: { accountKeys: keys, instructions: [transfer, { programId: MEMO, program: 'spl-memo', parsed: q.memo }] } },
      meta: { err: null, fee, innerInstructions: [], rewards: [], preBalances: pre, postBalances: post,
        preTokenBalances: q.currency === 'SOL' ? [] : [tokenBalance(source, q.payer, '1000000'), tokenBalance(dest, q.recipient, '0')],
        postTokenBalances: q.currency === 'SOL' ? [] : [tokenBalance(source, q.payer, (1000000n - BigInt(q.amount)).toString()),
          tokenBalance(dest, q.recipient, q.amount)] } },
    accounts: { payer: { owner: SYSTEM, executable: false }, recipient: { owner: SYSTEM, executable: false },
      mint, source: tokenAccount(q.payer), destination: tokenAccount(q.recipient) } };
}
export function fixture(overrides = {}) {
  let time = Math.floor(Date.now() / 1000) * 1000;
  const env = environment(time, overrides), config = readCommerceConfig(env), payer = wallet(), uid = 'commerce-owner';
  const sdk = fakeFirestore(), store = createCommerceFirestoreStore({ projectId: sdk.projectId, firestore: sdk, checkPrivilege() {} });
  sdk.docs.set(`identityUids/${encoded(uid)}`, { wallet: payer });
  sdk.docs.set(`identityWallets/${encoded(payer)}`, { uid });
  const calls = [], payments = new Map();
  const recipientAccount = { owner: TOKEN, executable: false, space: 165, data: { program: 'spl-token', parsed: {
    type: 'account', info: { owner: config.recipient, mint: config.mint, state: 'initialized', isNative: false,
      tokenAmount: { amount: '0', decimals: config.decimals } } } } };
  const rpc = { async call(method, params = []) {
    calls.push({ method, params });
    if (method === 'getGenesisHash') return config.genesisHash;
    const f = payments.get(params[0]?.[0]) ?? payments.get(params[0]);
    if (method === 'getTransaction') return f?.transaction ?? null;
    if (method === 'getSignatureStatuses') return { value: [f?.status ?? null] };
    if (method === 'getMultipleAccounts') {
      const a = f?.accounts ?? { mint: { owner: TOKEN, executable: false, space: 82,
        data: { program: 'spl-token', parsed: { type: 'mint', info: { isInitialized: true, decimals: config.decimals, freezeAuthority: null } } } } };
      const addresses = params[0];
      const payment = [...payments.values()].find(v => addresses.includes(v.quote.payer));
      if (payment) return { context: { slot: 42 }, value: addresses.map(addr => addr === payment.quote.payer ? payment.accounts.payer
        : addr === payment.quote.recipient ? payment.accounts.recipient : addr === payment.quote.mint ? payment.accounts.mint
          : addr === associatedAddress(payment.quote.payer, payment.quote.mint) ? payment.accounts.source : payment.accounts.destination) };
      return { context: { slot: 42 }, value: [a.mint, recipientAccount] };
    }
    throw new Error('TEST_RPC_METHOD');
  } };
  const verifier = createCommerceVerifier({ rpc, config });
  const authenticateToken = async token => { if (token !== 'owner-token') throw new Error('IDENTITY_DENIED'); return { uid }; };
  const make = () => createCommerceService({ authenticateToken, store, config, verifier, now: () => time });
  const service = make();
  return { config, env, sdk, store, payer, uid, verifier, rpc, calls, service, make, recipientAccount,
    setTime(t) { time = t; }, get time() { return time; },
    quote: (productId = 'runs-1', currency = 'SOL') => service.quote('owner-token', { productId, currency, payer }),
    pay(q, sig = signature()) {
      const record = sdk.docs.get(`commerceQuotes/${q.id}`), f = transactionFixture(q, sig, record?.issuedAt ?? time);
      payments.set(sig, f); return { sig, f };
    },
    receipt: (q, sig) => service.receipt('owner-token', { quoteId: q.id, signature: sig }),
  };
}
