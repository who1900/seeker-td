import { PublicKey } from '@solana/web3.js';

export type CommerceCurrency = 'SOL' | 'SKR';
export interface CommercePrice {
  currency: CommerceCurrency;
  amount: string;
  decimals: number;
  mint: string | null;
}
export interface CommerceProduct {
  id: string;
  title: string;
  runs: number;
  std: number;
  usdCents: number;
  prices: CommercePrice[];
}
export interface CommerceCatalog {
  enabled: boolean;
  reason: string | null;
  cluster: 'devnet';
  genesisHash: string | null;
  recipient: string | null;
  products: CommerceProduct[];
}
export interface CommerceQuote extends CommercePrice {
  id: string;
  productId: string;
  recipient: string;
  payer: string;
  cluster: 'devnet';
  genesisHash: string;
  expiresAt: number;
  runs: number;
  std: number;
  memo: string;
}
export interface CommerceReceipt {
  id: string;
  quoteId: string;
  signature: string;
  payer: string;
  runs: number;
  std: number;
  status: 'confirmed';
}
export interface PreparedCommercePurchase {
  feeLamports: string;
  rentLamports: string;
  send(beforeBroadcast: (signature: string) => void, signal: AbortSignal): Promise<string>;
}
export interface CommerceWalletTransport {
  prepare(quote: CommerceQuote, signal: AbortSignal): Promise<PreparedCommercePurchase>;
}
export interface PendingCommercePurchase {
  uid: string;
  quote: CommerceQuote;
  signature: string;
  confirmedReceipt?: CommerceReceipt;
}
export interface CommerceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const JOURNAL_KEY = 'seekdef_commerce_pending_v1';
const U64_MAX = 18446744073709551615n;
const ID = /^[a-f0-9]{32}$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid commerce response.');
  return value as Record<string, unknown>;
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function address(value: unknown): value is string {
  try { return typeof value === 'string' && new PublicKey(value).toBase58() === value; } catch { return false; }
}
function grants(value: { runs: unknown; std: unknown }): boolean {
  return count(value.runs) && count(value.std) && (value.runs > 0) !== (value.std > 0);
}
export function validateCommercePrice(value: unknown): asserts value is CommercePrice {
  const p = object(value);
  if (!['SOL', 'SKR'].includes(String(p.currency)) || typeof p.amount !== 'string'
    || !/^[1-9][0-9]{0,19}$/.test(p.amount) || BigInt(p.amount) > U64_MAX
    || !count(p.decimals) || p.decimals > 18
    || (p.currency === 'SOL' ? p.mint !== null || p.decimals !== 9 : !address(p.mint))) {
    throw new Error('Invalid server price. Purchases are locked.');
  }
}
export function validateCommerceCatalog(value: unknown): asserts value is CommerceCatalog {
  const c = object(value);
  if (typeof c.enabled !== 'boolean' || (c.reason !== null && typeof c.reason !== 'string') || c.cluster !== 'devnet'
    || (c.enabled ? !address(c.genesisHash) || !address(c.recipient)
      : (c.genesisHash !== null && !address(c.genesisHash)) || (c.recipient !== null && !address(c.recipient)))
    || !Array.isArray(c.products) || c.products.length > 64) {
    throw new Error('Invalid DEVNET catalog. Purchases are locked.');
  }
  const ids = new Set();
  for (const item of c.products) {
    const p = object(item);
    if (typeof p.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(p.id) || ids.has(p.id)
      || typeof p.title !== 'string' || !p.title || p.title.length > 120 || !grants({ runs: p.runs, std: p.std })
      || !count(p.usdCents) || p.usdCents <= 0 || !Array.isArray(p.prices) || p.prices.length > 2) {
      throw new Error('Invalid server product.');
    }
    ids.add(p.id);
    const currencies = new Set();
    for (const price of p.prices) {
      validateCommercePrice(price);
      if (currencies.has(price.currency)) throw new Error('Duplicate server currency.');
      currencies.add(price.currency);
    }
  }
}
export function validateCommerceQuote(value: unknown, now?: number): asserts value is CommerceQuote {
  validateCommercePrice(value);
  const q = object(value);
  if (typeof q.id !== 'string' || !ID.test(q.id) || typeof q.productId !== 'string'
    || !/^[a-z0-9-]{1,64}$/.test(q.productId) || !address(q.payer) || !address(q.recipient)
    || q.payer === q.recipient || q.cluster !== 'devnet' || !address(q.genesisHash)
    || !count(q.expiresAt) || !grants({ runs: q.runs, std: q.std })
    || q.memo !== `SEEKER:TD/commerce/v1/${q.id}`) throw new Error('Invalid server quote.');
  if (now !== undefined && (q.expiresAt <= now || q.expiresAt > now + 10 * 60_000)) {
    throw new Error('Quote expired or outside the allowed signing window. Request a new quote.');
  }
}
export function validateCommerceReceipt(value: unknown, pending: PendingCommercePurchase): asserts value is CommerceReceipt {
  const r = object(value);
  if (typeof r.id !== 'string' || !r.id || r.id.length > 128 || r.status !== 'confirmed'
    || r.quoteId !== pending.quote.id || r.signature !== pending.signature || r.payer !== pending.quote.payer
    || r.runs !== pending.quote.runs || r.std !== pending.quote.std) throw new Error('Server receipt mismatch. No credits applied.');
}
export function formatAtomic(amount: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(amount) || !count(decimals) || decimals > 18) throw new Error('Invalid token amount.');
  const padded = amount.padStart(decimals + 1, '0');
  if (!decimals) return padded;
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return padded.slice(0, -decimals) + (fraction ? `.${fraction}` : '');
}
export function trustedCommerceUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Purchases disabled: VITE_COMMERCE_URL is not configured.');
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Commerce requires a trusted HTTPS URL without credentials or query parameters.');
  }
  return url.href.replace(/\/$/, '');
}
export function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Cancelled. Nothing else will be sent.');
}
export async function commerceDeadline<T>(work: Promise<T>, signal: AbortSignal, timeoutMs = 20_000): Promise<T> {
  throwIfCancelled(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled: () => void = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      cancelled = () => reject(new Error('Cancelled. Check pending purchases before trying again.'));
      signal.addEventListener('abort', cancelled, { once: true });
      timer = setTimeout(() => reject(new Error('Timed out. Check pending purchases; no automatic resend.')), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancelled);
  }
}
export function readCommercePending(storage: CommerceStorage): PendingCommercePurchase[] {
  const raw = storage.getItem(JOURNAL_KEY);
  if (!raw) return [];
  let entries: unknown;
  try { entries = JSON.parse(raw); } catch { throw new Error('Purchase journal is unreadable. Do not send another payment.'); }
  if (!Array.isArray(entries) || entries.length > 256) throw new Error('Invalid purchase journal.');
  for (const entry of entries) {
    const p = object(entry);
    validateCommerceQuote(p.quote);
    if (typeof p.uid !== 'string' || !p.uid || typeof p.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(p.signature)) {
      throw new Error('Invalid purchase journal identity.');
    }
    if (Object.prototype.hasOwnProperty.call(p, 'confirmedReceipt')) {
      validateCommerceReceipt(p.confirmedReceipt, p as unknown as PendingCommercePurchase);
      const keys = ['id', 'quoteId', 'signature', 'payer', 'runs', 'std', 'status'];
      const receipt = object(p.confirmedReceipt);
      if (Object.keys(receipt).length !== keys.length || !keys.every(key => Object.prototype.hasOwnProperty.call(receipt, key))) {
        throw new Error('Invalid confirmed purchase acknowledgement.');
      }
    }
  }
  return entries as PendingCommercePurchase[];
}
export function recordCommercePending(storage: CommerceStorage, pending: PendingCommercePurchase): void {
  const entries = readCommercePending(storage);
  const previous = entries.find(p => p.quote.id === pending.quote.id || p.signature === pending.signature);
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(pending)) throw new Error('Conflicting pending purchase.');
    return;
  }
  if (entries.length >= 256) throw new Error('Purchase journal is full. Contact support before purchasing.');
  storage.setItem(JOURNAL_KEY, JSON.stringify([...entries, pending]));
  if (!readCommercePending(storage).some(p => p.quote.id === pending.quote.id && p.signature === pending.signature)) {
    throw new Error('Could not persist purchase. Nothing will be sent.');
  }
}
function assertCommercePurchaseAllowed(entries: PendingCommercePurchase[], uid: string, q: CommerceQuote): void {
  if (entries.some(p => p.uid === uid && p.quote.id === q.id)) throw new Error('This quote was already signed. Check its receipt instead.');
  if (entries.some(p => p.uid === uid && p.quote.payer === q.payer && !p.confirmedReceipt)) {
    throw new Error('A purchase outcome is unknown for this account and wallet. Check pending purchases before signing again.');
  }
  if (entries.length >= 256) throw new Error('Purchase journal is full. Contact support before purchasing.');
}
function acknowledgeCommerceReceipt(storage: CommerceStorage, pending: PendingCommercePurchase, receipt: CommerceReceipt): void {
  validateCommerceReceipt(receipt, pending);
  const entries = readCommercePending(storage);
  const index = entries.findIndex(p => p.uid === pending.uid && p.signature === pending.signature && p.quote.id === pending.quote.id);
  if (index < 0 || JSON.stringify(entries[index].quote) !== JSON.stringify(pending.quote)) {
    throw new Error('Purchase journal identity mismatch. Check pending purchases.');
  }
  const acknowledgement: CommerceReceipt = { id: receipt.id, quoteId: receipt.quoteId, signature: receipt.signature,
    payer: receipt.payer, runs: receipt.runs, std: receipt.std, status: receipt.status };
  if (entries[index].confirmedReceipt) {
    if (JSON.stringify(entries[index].confirmedReceipt) !== JSON.stringify(acknowledgement)) throw new Error('Conflicting confirmed purchase acknowledgement.');
    return;
  }
  const updated = entries.map((entry, i) => i === index ? { ...entry, confirmedReceipt: acknowledgement } : entry);
  storage.setItem(JOURNAL_KEY, JSON.stringify(updated));
  if (JSON.stringify(readCommercePending(storage)) !== JSON.stringify(updated)) {
    throw new Error('Could not persist confirmed purchase acknowledgement. Check pending purchases.');
  }
}
export interface CommerceProfileFields {
  lives?: number;
  unlockedSkins?: string[];
  equippedSkins?: Record<'canon' | 'laser' | 'mortar' | 'glue', string>;
  streak?: number;
  lastBonusClaim?: number | null;
  loginClaimedToday?: boolean;
  challengeProgress?: Record<string, number>;
  challengeClaimed?: Record<string, boolean>;
  challengesResetDate?: string | null;
  challengesDone?: boolean[];
}
export interface CommerceCache extends CommerceProfileFields {
  tokens: number;
  paidRuns: number;
  commerceReceiptIds?: string[];
  commerceQuoteIds?: string[];
  commerceSignatures?: string[];
  commerceAccount?: string;
  commerceAccounts?: Record<string, Omit<CommerceCache, 'commerceAccount' | 'commerceAccounts'>>;
}
export function commerceAccountKey(uid: string, payer: string): string {
  if (!uid || uid.length > 128 || !address(payer)) throw new Error('Invalid commerce account.');
  return `${uid}:${payer}`;
}
export function switchCommerceAccount<T extends CommerceCache>(state: T, uid: string | null, payer: string | null): T {
  const key = uid && payer ? commerceAccountKey(uid, payer) : 'guest';
  if (state.commerceAccount === key) return state;
  const previous = state.commerceAccount ?? 'guest';
  const accounts = { ...state.commerceAccounts, [previous]: {
    tokens: state.tokens, paidRuns: state.paidRuns, commerceReceiptIds: state.commerceReceiptIds ?? [],
    commerceQuoteIds: state.commerceQuoteIds ?? [], commerceSignatures: state.commerceSignatures ?? [],
    ...commerceProfile(state),
  } };
  const next = accounts[key] ?? { tokens: 0, paidRuns: 0, commerceReceiptIds: [], commerceQuoteIds: [], commerceSignatures: [] };
  return { ...state, ...next, ...commerceProfile(next), commerceAccount: key, commerceAccounts: accounts };
}
function commerceProfile(profile: CommerceProfileFields): Required<CommerceProfileFields> {
  return {
    lives: profile.lives ?? 0,
    unlockedSkins: [...(profile.unlockedSkins ?? [])],
    equippedSkins: { canon: 'canon-default', laser: 'laser-default', mortar: 'mortar-default', glue: 'glue-default', ...profile.equippedSkins },
    streak: profile.streak ?? 0,
    lastBonusClaim: profile.lastBonusClaim ?? null,
    loginClaimedToday: profile.loginClaimedToday ?? false,
    challengeProgress: { ...profile.challengeProgress },
    challengeClaimed: { ...profile.challengeClaimed },
    challengesResetDate: profile.challengesResetDate ?? null,
    challengesDone: [...(profile.challengesDone ?? [false, false, false])],
  };
}
export function applyScopedCommerceReceipt<T extends CommerceCache>(state: T, receipt: CommerceReceipt, uid: string): T {
  if (state.commerceAccount !== commerceAccountKey(uid, receipt.payer)) return state;
  return applyCommerceReceipt(state, receipt);
}
export function applyCommerceReceipt<T extends CommerceCache>(state: T, receipt: CommerceReceipt): T {
  if (receipt.status !== 'confirmed' || !grants(receipt) || !receipt.id || !receipt.quoteId || !receipt.signature) {
    throw new Error('Only server-confirmed receipts can update the display cache.');
  }
  const ids = state.commerceReceiptIds ?? [], quotes = state.commerceQuoteIds ?? [], signatures = state.commerceSignatures ?? [];
  if (![ids, quotes, signatures].every(values => Array.isArray(values) && values.every(v => typeof v === 'string'))) {
    throw new Error('Invalid commerce display cache.');
  }
  if (ids.includes(receipt.id) || quotes.includes(receipt.quoteId) || signatures.includes(receipt.signature)) return state;
  if (!count(state.tokens) || !count(state.paidRuns) || !count(state.tokens + receipt.std) || !count(state.paidRuns + receipt.runs)) {
    throw new Error('Invalid cached balance.');
  }
  return { ...state, tokens: state.tokens + receipt.std, paidRuns: state.paidRuns + receipt.runs,
    commerceReceiptIds: [...ids, receipt.id], commerceQuoteIds: [...quotes, receipt.quoteId],
    commerceSignatures: [...signatures, receipt.signature] };
}
export function createCommerceClient(options: {
  url: string;
  getToken(): Promise<string | null>;
  getUid(): Promise<string | null>;
  getSession?(): Promise<{ uid: string; token: string } | null>;
  getCurrentUid?(): string | null;
  storage: CommerceStorage;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  identityAudience?: string;
  identityOrigin?: string;
}) {
  const base = trustedCommerceUrl(options.url), clock = options.now ?? Date.now;
  const fetcher = options.fetch ?? globalThis.fetch;
  const quoteOwners = new Map<string, string>();
  async function session(signal: AbortSignal) {
    if (options.getSession) return commerceDeadline(options.getSession(), signal, options.timeoutMs);
    const uid = await commerceDeadline(options.getUid(), signal, options.timeoutMs);
    const token = await commerceDeadline(options.getToken(), signal, options.timeoutMs);
    if (uid !== await commerceDeadline(options.getUid(), signal, options.timeoutMs)) throw new Error('Firebase account changed.');
    return uid && token ? { uid, token } : null;
  }
  function assertCurrent(uid: string) {
    if (options.getCurrentUid && options.getCurrentUid() !== uid) throw new Error('Firebase account changed.');
  }
  async function assertUid(uid: string, signal: AbortSignal) {
    if (await commerceDeadline(options.getUid(), signal, options.timeoutMs) !== uid) throw new Error('Sign in to the original purchase account.');
    throwIfCancelled(signal);
    assertCurrent(uid);
  }
  async function request(path: string, body: unknown, signal: AbortSignal, expectedUid?: string): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, options.timeoutMs ?? 20_000);
    try {
      throwIfCancelled(signal);
      const snapshot = await session(controller.signal);
      const token = snapshot?.token;
      if (!token || /[\r\n]/.test(token)) throw new Error('Sign in with Firebase before purchasing.');
      if (expectedUid && snapshot.uid !== expectedUid) throw new Error('Firebase account changed.');
      assertCurrent(snapshot.uid);
      throwIfCancelled(controller.signal);
      const response = await commerceDeadline(fetcher(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
        redirect: 'error', credentials: 'omit', cache: 'no-store',
      }), controller.signal, options.timeoutMs);
      if (!response.ok) throw new Error(response.status === 401 ? 'Firebase session expired. Sign in again.'
        : response.status === 403 ? 'Wallet ownership or commerce configuration is not approved.'
        : 'Commerce unavailable. Check pending purchases before trying again.');
      const result = await commerceDeadline(response.json(), controller.signal, options.timeoutMs);
      await assertUid(snapshot.uid, controller.signal);
      return result;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  async function catalog(signal: AbortSignal, expectedUid?: string): Promise<CommerceCatalog> {
    const result = await request('/commerce/catalog', undefined, signal, expectedUid);
    validateCommerceCatalog(result);
    for (const product of result.products) {
      product.prices.forEach(Object.freeze); Object.freeze(product.prices); Object.freeze(product);
    }
    Object.freeze(result.products);
    return Object.freeze(result);
  }
  async function quote(productId: string, currency: CommerceCurrency, payer: string, signal: AbortSignal): Promise<CommerceQuote> {
    if (!address(payer)) throw new Error('Select a wallet first.');
    const uid = await commerceDeadline(options.getUid(), signal, options.timeoutMs);
    if (!uid) throw new Error('Firebase sign-in required.');
    const c = await catalog(signal, uid);
    if (!c.enabled) throw new Error(c.reason || 'Purchases are locked until server rates are configured.');
    const product = c.products.find(p => p.id === productId), price = product?.prices.find(p => p.currency === currency);
    if (!product || !price) throw new Error('Product or currency is unavailable.');
    const result = await request('/commerce/quote', { productId, currency, payer }, signal, uid);
    validateCommerceQuote(result, clock());
    if (result.productId !== productId || result.currency !== currency || result.payer !== payer
      || result.recipient !== c.recipient || result.cluster !== c.cluster || result.genesisHash !== c.genesisHash
      || result.runs !== product.runs || result.std !== product.std || result.amount !== price.amount
      || result.decimals !== price.decimals || result.mint !== price.mint) throw new Error('Catalog and quote differ. Refresh before purchasing.');
    quoteOwners.set(result.id, uid);
    return Object.freeze(result);
  }
  async function reconcile(pending: PendingCommercePurchase, signal: AbortSignal): Promise<CommerceReceipt | null> {
    if (await commerceDeadline(options.getUid(), signal, options.timeoutMs) !== pending.uid) throw new Error('Sign in to the original purchase account.');
    const result = object(await request('/commerce/receipt', { quoteId: pending.quote.id, signature: pending.signature }, signal, pending.uid));
    if (result.status === 'pending') return null;
    validateCommerceReceipt(result, pending);
    throwIfCancelled(signal);
    acknowledgeCommerceReceipt(options.storage, pending, result);
    return result;
  }
  async function purchase(q: CommerceQuote, prepared: PreparedCommercePurchase, signal: AbortSignal): Promise<CommerceReceipt | null> {
    validateCommerceQuote(q, clock());
    const uid = await commerceDeadline(options.getUid(), signal, options.timeoutMs);
    if (!uid) throw new Error('Firebase sign-in required.');
    if (quoteOwners.has(q.id) && quoteOwners.get(q.id) !== uid) throw new Error('Firebase account changed. Request a new quote.');
    assertCurrent(uid);
    assertCommercePurchaseAllowed(readCommercePending(options.storage), uid, q);
    let pending: PendingCommercePurchase | undefined;
    const signature = await prepared.send(sig => {
      throwIfCancelled(signal);
      assertCurrent(uid);
      validateCommerceQuote(q, clock());
      assertCommercePurchaseAllowed(readCommercePending(options.storage), uid, q);
      pending = { uid, quote: q, signature: sig };
      recordCommercePending(options.storage, pending);
    }, signal);
    if (!pending || signature !== pending.signature) throw new Error('Transaction identity mismatch. Check pending purchases.');
    return reconcile(pending, signal);
  }
  async function bindWallet(payer: string, sign: (message: string, expectedPayer: string) => Promise<string>, signal: AbortSignal): Promise<void> {
    if (!address(payer)) throw new Error('Invalid wallet address.');
    const uid = await commerceDeadline(options.getUid(), signal, options.timeoutMs);
    if (!uid) throw new Error('Firebase sign-in required.');
    const challenge = object(await request('/identity/challenge', { wallet: payer }, signal, uid));
    if (typeof challenge.challengeId !== 'string' || !/^[a-f0-9]{64}$/.test(challenge.challengeId)
      || typeof challenge.message !== 'string' || challenge.message.length < 20 || challenge.message.length > 4096
      || !count(challenge.expiresAt) || challenge.expiresAt <= clock() || challenge.expiresAt > clock() + 10 * 60_000) {
      throw new Error('Invalid server wallet challenge.');
    }
    const proof = object(JSON.parse(challenge.message));
    const proofKeys = ['audience', 'origin', 'purpose', 'uid', 'wallet', 'cluster', 'nonce', 'issuedAt', 'expiresAt'];
    if (proof.uid !== uid || proof.wallet !== payer || proof.cluster !== 'devnet' || proof.expiresAt !== challenge.expiresAt
      || proof.nonce !== challenge.challengeId || !options.identityOrigin || proof.origin !== options.identityOrigin
      || !options.identityAudience || proof.audience !== options.identityAudience || proof.purpose !== 'SEEKER:TD/wallet-identity/v1'
      || Object.keys(proof).length !== proofKeys.length || !proofKeys.every(key => Object.prototype.hasOwnProperty.call(proof, key))
      || !count(proof.issuedAt) || proof.issuedAt > clock() || proof.expiresAt !== proof.issuedAt + 5 * 60_000) {
      throw new Error('Wallet challenge identity does not match.');
    }
    const canonicalMessage = JSON.stringify(Object.fromEntries(proofKeys.map(key => [key, proof[key]])));
    if (canonicalMessage !== challenge.message) throw new Error('Wallet challenge message is not canonical.');
    const signature = await commerceDeadline(sign(challenge.message, payer), signal, 60_000);
    await assertUid(uid, signal);
    throwIfCancelled(signal);
    if (challenge.expiresAt <= clock() || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new Error('Wallet challenge expired or signature invalid.');
    const complete = object(await request('/identity/complete', { challengeId: challenge.challengeId, signature }, signal, uid));
    if (complete.wallet !== payer || complete.uid !== uid || complete.cluster !== 'devnet') throw new Error('Server did not verify wallet ownership.');
  }
  return { catalog, quote, purchase, reconcile, bindWallet, pending: () => readCommercePending(options.storage) };
}
export type CommerceClient = ReturnType<typeof createCommerceClient>;
