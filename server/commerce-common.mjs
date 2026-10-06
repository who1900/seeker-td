import { decodeWallet } from './identity.mjs';

export const fail = (code = 'COMMERCE_DENIED') => { throw new Error(code); };
export const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype
  && Reflect.ownKeys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(v, k), 'value'));
export const uint = v => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v)
  && BigInt(v) <= 18446744073709551615n;
export const positive = v => uint(v) && v !== '0';
export const hex = v => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
export const encoded = v => Buffer.from(v, 'utf8').toString('hex');
export const uidValid = v => typeof v === 'string' && v.length > 0 && v.length <= 128
  && !/[\u0000-\u001f\u007f]/.test(v) && Buffer.from(v).toString('utf8') === v;
export const address = v => { try { decodeWallet(v); return true; } catch { return false; } };
export const timeValid = v => Number.isSafeInteger(v) && v >= 0;
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const QUOTE_KEYS = Object.freeze(['id', 'productId', 'currency', 'amount', 'decimals', 'mint',
  'recipient', 'payer', 'cluster', 'genesisHash', 'expiresAt', 'runs', 'std', 'memo']);
export const grantValid = v => Number.isSafeInteger(v.runs) && v.runs >= 0
  && Number.isSafeInteger(v.std) && v.std >= 0 && (v.runs > 0) !== (v.std > 0);
export const quoteValid = q => exact(q, QUOTE_KEYS) && hex(q.id)
  && typeof q.productId === 'string' && /^[a-z0-9-]{1,64}$/.test(q.productId)
  && ['SOL', 'SKR'].includes(q.currency) && positive(q.amount) && grantValid(q)
  && Number.isInteger(q.decimals) && q.decimals >= 0 && q.decimals <= 18
  && (q.currency === 'SOL' ? q.mint === null && q.decimals === 9 : address(q.mint))
  && address(q.recipient) && address(q.payer) && q.payer !== q.recipient
  && q.cluster === 'devnet' && q.genesisHash === DEVNET_GENESIS && timeValid(q.expiresAt)
  && q.memo === `SEEKER:TD/commerce/v1/${q.id}`;
