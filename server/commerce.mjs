import { randomBytes, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { amountFor, currencyAvailable } from './commerce-config.mjs';
import { address, encoded, exact, fail, hex, quoteValid, timeValid, uidValid, uint } from './commerce-common.mjs';
import { signatureValid } from './commerce-verifier.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const binding = (bound, owner, uid, payer) => {
  if (!exact(bound, ['wallet']) || bound.wallet !== payer || !exact(owner, ['uid']) || owner.uid !== uid) fail();
};
const balanceValid = b => exact(b, ['runs', 'std']) && uint(b.runs) && uint(b.std);
const publicReceipt = (record, uid, quoteId, signature) => {
  if (!record || record.uid !== uid || record.quoteId !== quoteId || record.signature !== signature
    || !quoteValid(record.quote) || record.quote.id !== quoteId) fail('COMMERCE_REPLAY');
  return { ...record.quote, quoteId, signature, status: 'confirmed' };
};
export function createCommerceService({ authenticateToken, store, config, verifier, now = Date.now }) {
  if (typeof authenticateToken !== 'function' || typeof store?.transaction !== 'function'
    || typeof verifier?.verify !== 'function' || typeof verifier?.checkCurrency !== 'function'
    || typeof now !== 'function' || !Object.isFrozen(config) || config.cluster !== 'devnet') fail();
  const clock = () => { const t = now(); if (!timeValid(t) || t > Number.MAX_SAFE_INTEGER - 600000) fail(); return t; };
  const auth = async token => {
    if (typeof token !== 'string' || !token || token.length > 16384) fail();
    const result = await authenticateToken(token); if (!uidValid(result?.uid)) fail(); return result.uid;
  };
  return Object.freeze({
    async catalog() {
      const candidates = ['SOL', 'SKR'].filter(c => currencyAvailable(config, c, clock()));
      const checked = await Promise.all(candidates.map(async currency => {
        try { await verifier.checkCurrency(currency); return currency; } catch { return null; }
      }));
      const currencies = checked.filter(c => c !== null && currencyAvailable(config, c, clock()));
      const products = config.products.map(p => ({ id: p.id,
        title: p.runs > 0 ? `${p.runs} extra run${p.runs === 1 ? '' : 's'}` : `${p.std} STD`,
        runs: p.runs, std: p.std, usdCents: p.usdCents,
        prices: p.enabled ? currencies.map(currency => ({ currency, amount: amountFor(p.usdCents, config.rates[currency]),
          decimals: currency === 'SOL' ? 9 : config.decimals, mint: currency === 'SOL' ? null : config.mint })) : [] }));
      const enabled = products.some(p => p.prices.length > 0);
      return { enabled, reason: enabled ? null : 'COMMERCE_NOT_CONFIGURED_OR_RATE_STALE',
        cluster: config.cluster, genesisHash: config.genesisHash, recipient: config.recipient, products };
    },
    async quote(token, body) {
      if (!exact(body, ['productId', 'currency', 'payer']) || !address(body.payer)
        || !['SOL', 'SKR'].includes(body.currency) || body.payer === config.recipient) fail();
      const { productId, currency, payer } = body;
      const p = config.products.find(v => v.id === productId);
      if (!p?.enabled || !currencyAvailable(config, currency, clock())) fail('COMMERCE_LOCKED');
      const uid = await auth(token);
      await verifier.checkCurrency(currency);
      const id = randomBytes(16).toString('hex');
      return store.transaction(async tx => {
        const [bound, owner, collision] = await Promise.all([
          tx.get(`identityUids/${encoded(uid)}`), tx.get(`identityWallets/${encoded(payer)}`), tx.get(`commerceQuotes/${id}`),
        ]);
        binding(bound, owner, uid, payer);
        const issuedAt = clock();
        if (collision !== undefined || !currencyAvailable(config, currency, issuedAt)) fail('COMMERCE_LOCKED');
        const quote = { id, productId, currency, amount: amountFor(p.usdCents, config.rates[currency]),
          decimals: currency === 'SOL' ? 9 : config.decimals, mint: currency === 'SOL' ? null : config.mint,
          recipient: config.recipient, payer, cluster: config.cluster, genesisHash: config.genesisHash,
          expiresAt: Math.min(issuedAt + config.ttlMilliseconds,
            config.rates[currency].timestamp + config.rates[currency].ttlMilliseconds),
          runs: p.runs, std: p.std, memo: `SEEKER:TD/commerce/v1/${id}` };
        if (!quoteValid(quote)) fail();
        await tx.set(`commerceQuotes/${id}`, { uid, quote, issuedAt, catalogHash: config.catalogHash });
        return structuredClone(quote);
      });
    },
    async receipt(token, body) {
      if (!exact(body, ['quoteId', 'signature']) || !hex(body.quoteId) || !signatureValid(body.signature)) fail();
      const { quoteId, signature } = body, uid = await auth(token);
      const quoteKey = `commerceQuotes/${quoteId}`, receiptKey = `commerceReceipts/${quoteId}`;
      const signatureKey = `commerceSignatures/${digest(signature)}`, balanceKey = `commerceBalances/${encoded(uid)}`;
      const preflight = await store.transaction(async tx => {
        const [record, receipt] = await Promise.all([tx.get(quoteKey), tx.get(receiptKey)]);
        if (!exact(record, ['uid', 'quote', 'issuedAt', 'catalogHash']) || record.uid !== uid
          || !quoteValid(record.quote) || record.quote.id !== quoteId || !timeValid(record.issuedAt)
          || record.issuedAt >= record.quote.expiresAt) fail();
        const q = record.quote;
        const [bound, owner, claim] = await Promise.all([tx.get(`identityUids/${encoded(uid)}`),
          tx.get(`identityWallets/${encoded(q.payer)}`), tx.get(signatureKey)]);
        binding(bound, owner, uid, q.payer);
        if (receipt !== undefined) {
          if (!exact(claim, ['uid', 'quoteId', 'signature']) || claim.uid !== uid
            || claim.quoteId !== quoteId || claim.signature !== signature) fail('COMMERCE_REPLAY');
          return { receipt: publicReceipt(receipt, uid, quoteId, signature) };
        }
        if (claim !== undefined) fail('COMMERCE_REPLAY');
        return { record: structuredClone(record) };
      });
      if (preflight.receipt) return preflight.receipt;
      // Delayed submission is valid: verifier checks blockTime against persisted quote window, not now().
      const record = preflight.record, q = Object.freeze(record.quote);
      const evidence = await verifier.verify(q, signature, record.issuedAt);
      if (!Number.isSafeInteger(evidence?.slot) || evidence.slot < 0 || !Number.isSafeInteger(evidence.blockTime)
        || evidence.blockTime < Math.floor(record.issuedAt / 1000) || evidence.blockTime * 1000 >= q.expiresAt) fail();
      return store.transaction(async tx => {
        const poolKey = `commercePools/${q.currency}`;
        const [current, receipt, claim, balance, bound, owner, ledger, pool] = await Promise.all([
          tx.get(quoteKey), tx.get(receiptKey), tx.get(signatureKey), tx.get(balanceKey),
          tx.get(`identityUids/${encoded(uid)}`), tx.get(`identityWallets/${encoded(q.payer)}`),
          tx.get(`commerceLedger/${quoteId}`), tx.get(poolKey),
        ]);
        binding(bound, owner, uid, q.payer);
        if (!isDeepStrictEqual(current, record)) fail('COMMERCE_QUOTE_CHANGED');
        if (receipt !== undefined) {
          if (!exact(claim, ['uid', 'quoteId', 'signature']) || claim.uid !== uid
            || claim.quoteId !== quoteId || claim.signature !== signature) fail('COMMERCE_REPLAY');
          return publicReceipt(receipt, uid, quoteId, signature);
        }
        if (claim !== undefined || ledger !== undefined) fail('COMMERCE_REPLAY');
        const previous = balance ?? { runs: '0', std: '0' };
        if (!balanceValid(previous)) fail('COMMERCE_BALANCE');
        const next = { runs: (BigInt(previous.runs) + BigInt(q.runs)).toString(),
          std: (BigInt(previous.std) + BigInt(q.std)).toString() };
        if (!balanceValid(next)) fail('COMMERCE_BALANCE');
        let updatedPool;
        if (q.runs > 0) {
          const status = q.currency === 'SOL' ? 'pending_SOL_conversion' : 'SKR_reward_pool';
          const old = pool ?? { currency: q.currency, eligiblePurchaseBaseUnits: '0', poolBaseUnits: '0', remainderTenths: 0, status };
          if (!exact(old, ['currency', 'eligiblePurchaseBaseUnits', 'poolBaseUnits', 'remainderTenths', 'status'])
            || old.currency !== q.currency || old.status !== status || !uint(old.eligiblePurchaseBaseUnits)
            || !uint(old.poolBaseUnits) || old.poolBaseUnits !== (BigInt(old.eligiblePurchaseBaseUnits) / 10n).toString()
            || old.remainderTenths !== Number(BigInt(old.eligiblePurchaseBaseUnits) % 10n)) fail('COMMERCE_POOL');
          const eligible = (BigInt(old.eligiblePurchaseBaseUnits) + BigInt(q.amount)).toString();
          if (!uint(eligible)) fail('COMMERCE_POOL');
          updatedPool = { currency: q.currency, eligiblePurchaseBaseUnits: eligible,
            poolBaseUnits: (BigInt(eligible) / 10n).toString(), remainderTenths: Number(BigInt(eligible) % 10n), status };
        }
        const confirmedAt = clock();
        await tx.set(receiptKey, { uid, quoteId, signature, quote: { ...q }, evidence: { ...evidence }, confirmedAt });
        await tx.set(signatureKey, { uid, quoteId, signature });
        await tx.set(balanceKey, next);
        await tx.set(`commerceLedger/${quoteId}`, { uid, quoteId, signature, currency: q.currency, amount: q.amount,
          poolContributionNumerator: q.runs > 0 ? q.amount : '0', poolContributionDenominator: 10,
          runs: q.runs, std: q.std, confirmedAt });
        if (updatedPool) await tx.set(poolKey, updatedPool);
        return { ...q, quoteId, signature, status: 'confirmed' };
      });
    },
  });
}
