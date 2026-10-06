import { PublicKey } from '@solana/web3.js';

export interface AuthoritySession { uid: string; payer: string; token: string }
export interface AuthoritySnapshot {
  version: 1;
  uid: string;
  payer: string;
  balances: { runs: string; std: string };
  free: { day: number; remaining: number };
  settlementEnabled: false;
  payoutEnabled: false;
}
export interface AuthorityDebit {
  requestId: string;
  policyVersion: string;
  action: string;
  amount: string;
}
export interface AuthorityReceipt extends AuthoritySnapshot, AuthorityDebit { committedAt: number }

function denied(): never { throw new Error('GAME_AUTHORITY_DENIED'); }
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object'
  && Object.getPrototypeOf(v) === Object.prototype && Reflect.ownKeys(v).length === keys.length
  && keys.every(k => Object.prototype.hasOwnProperty.call(v, k)
    && Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(v, k), 'value'));
const uint = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v)
  && BigInt(v) <= 18446744073709551615n;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && !Object.is(v, -0);
const policyId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(v);
const uidValid = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128
  && !/[\u0000-\u001f\u007f]/.test(v) && new TextDecoder().decode(new TextEncoder().encode(v)) === v;
const wallet = (v: unknown): v is string => {
  try { return typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) && new PublicKey(v).toBase58() === v; }
  catch { return false; }
};
const snapshotKeys = ['version', 'uid', 'payer', 'balances', 'free', 'settlementEnabled', 'payoutEnabled'];
const debitKeys = ['requestId', 'policyVersion', 'action', 'amount'];
const debitValid = (v: unknown): v is Record<string, unknown> => exact(v, debitKeys)
  && typeof v.requestId === 'string' && /^[a-f0-9]{32}$/.test(v.requestId)
  && policyId(v.policyVersion) && policyId(v.action) && uint(v.amount)
  && (v.action === 'free-run' ? v.amount === '0' : v.action === 'paid-run' ? v.amount === '1' : v.amount !== '0');

function validate(value: unknown, session: AuthoritySession, debit?: AuthorityDebit): AuthoritySnapshot | AuthorityReceipt {
  if (!exact(value, debit ? [...snapshotKeys, ...debitKeys, 'committedAt'] : snapshotKeys)
    || value.version !== 1 || value.uid !== session.uid || value.payer !== session.payer
    || value.settlementEnabled !== false || value.payoutEnabled !== false
    || !exact(value.balances, ['runs', 'std']) || !uint(value.balances.runs) || !uint(value.balances.std)
    || !exact(value.free, ['day', 'remaining']) || !count(value.free.day) || value.free.day > Math.floor(Number.MAX_SAFE_INTEGER / 86400000)
    || !count(value.free.remaining) || value.free.remaining > 100) denied();
  if (debit && (debitKeys.some(k => value[k] !== debit[k as keyof AuthorityDebit]) || !count(value.committedAt)
    || value.free.day !== Math.floor(value.committedAt / 86400000))) denied();
  return value as unknown as AuthoritySnapshot | AuthorityReceipt;
}

// Transport only. Never updates local economy, grants rewards, admits a run, or retries a debit automatically.
export function createGameAuthorityClient(options: {
  origin: string;
  getSession: () => Promise<AuthoritySession | null>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}) {
  let origin: URL;
  try { origin = new URL(options.origin); } catch { return denied(); }
  const timeoutMs = options.timeoutMs ?? 10000;
  if (origin.protocol !== 'https:' || origin.origin !== options.origin || origin.username || origin.password
    || (typeof location !== 'undefined' && location.origin !== origin.origin)
    || typeof options.getSession !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) denied();
  const base = origin.origin, requestFetch = options.fetch ?? globalThis.fetch, getSession = options.getSession;
  if (typeof requestFetch !== 'function') denied();
  const session = async () => {
    const s = await getSession();
    if (!exact(s, ['uid', 'payer', 'token']) || !uidValid(s.uid) || !wallet(s.payer)
      || typeof s.token !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(s.token)) return denied();
    return Object.freeze({ uid: s.uid, payer: s.payer, token: s.token });
  };
  async function request(action: 'balance' | 'debit', debit?: AuthorityDebit, signal?: AbortSignal) {
    if (action === 'debit' && !debitValid(debit)) denied();
    const captured = debit ? Object.freeze({ ...debit }) : undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectDeadline: (reason: Error) => void = () => {};
    const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
    const stop = () => { controller.abort(); rejectDeadline(new Error('GAME_AUTHORITY_ABORTED_RETRY_SAME_REQUEST')); };
    signal?.addEventListener('abort', stop, { once: true });
    const guard = () => { if (controller.signal.aborted) denied(); };
    const operation = async () => {
      guard(); const bound = await session(); guard();
      const url = `${base}/api/game-authority/v1/${action}`;
      const response = await requestFetch(url, { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
        signal: controller.signal, headers: { Authorization: `Bearer ${bound.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, uid: bound.uid, payer: bound.payer, ...captured }) });
      guard();
      if (response.status !== 200 || !response.ok || response.redirected || (response.url && response.url !== url)
        || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '') || !response.body) denied();
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener('abort', cancel, { once: true });
      try {
        for (;;) {
          const { done, value } = await reader.read(); guard(); if (done) break;
          size += value.byteLength; if (size > 4096) denied(); chunks.push(value);
        }
      } finally { controller.signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => {}); reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const current = await session(); guard();
      if (current.uid !== bound.uid || current.payer !== bound.payer) denied();
      return validate(parsed, bound, captured);
    };
    try {
      timer = setTimeout(stop, timeoutMs);
      if (signal?.aborted) stop();
      return await Promise.race([operation(), deadline]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
  }
  return Object.freeze({
    balance: (signal?: AbortSignal) => request('balance', undefined, signal) as Promise<AuthoritySnapshot>,
    debit: (body: AuthorityDebit, signal?: AbortSignal) => request('debit', body, signal) as Promise<AuthorityReceipt>,
  });
}
