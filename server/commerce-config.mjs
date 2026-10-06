import { createHash } from 'node:crypto';
import { address, DEVNET_GENESIS, exact, fail, grantValid, positive, timeValid } from './commerce-common.mjs';

const freeze = v => {
  if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); }
  return v;
};
const parse = (v, fallback) => {
  try { return v === undefined ? fallback : JSON.parse(v); } catch { fail('COMMERCE_CONFIG'); }
};
export const PILOT_CATALOG = freeze([
  { id: 'runs-1', usdCents: 25, runs: 1, std: 0, enabled: false },
  { id: 'runs-3', usdCents: 65, runs: 3, std: 0, enabled: false },
  { id: 'runs-10', usdCents: 195, runs: 10, std: 0, enabled: false },
  { id: 'std-500', usdCents: 99, runs: 0, std: 500, enabled: false },
  { id: 'std-1500', usdCents: 249, runs: 0, std: 1500, enabled: false },
  { id: 'std-4000', usdCents: 599, runs: 0, std: 4000, enabled: false },
]);
export function readCommerceConfig(env = process.env) {
  const cluster = env.COMMERCE_CLUSTER ?? 'devnet';
  if (cluster !== 'devnet') fail('COMMERCE_MAINNET_LOCKED');
  const products = parse(env.COMMERCE_CATALOG_JSON, PILOT_CATALOG);
  if (!Array.isArray(products) || products.length > 32 || products.some(p =>
    !exact(p, ['id', 'usdCents', 'runs', 'std', 'enabled']) || typeof p.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(p.id)
    || !Number.isSafeInteger(p.usdCents) || p.usdCents < 1 || p.usdCents > 1000000
    || !grantValid(p) || p.runs > 10000 || p.std > 10000000 || typeof p.enabled !== 'boolean')
    || new Set(products.map(p => p.id)).size !== products.length) fail('COMMERCE_CONFIG');
  const rates = parse(env.COMMERCE_RATES_JSON, {});
  if (!rates || Object.getPrototypeOf(rates) !== Object.prototype
    || Object.keys(rates).some(k => !['SOL', 'SKR'].includes(k))) fail('COMMERCE_CONFIG');
  for (const r of Object.values(rates)) {
    if (!exact(r, ['numerator', 'denominator', 'timestamp', 'ttlMilliseconds'])
      || !positive(r.numerator) || !positive(r.denominator) || !timeValid(r.timestamp)
      || !Number.isSafeInteger(r.ttlMilliseconds) || r.ttlMilliseconds < 1000 || r.ttlMilliseconds > 3600000
      || !timeValid(r.timestamp + r.ttlMilliseconds)) fail('COMMERCE_CONFIG');
  }
  const genesisHash = env.COMMERCE_GENESIS_HASH ?? null;
  if (genesisHash !== null && genesisHash !== DEVNET_GENESIS) fail('COMMERCE_CONFIG');
  const recipient = env.COMMERCE_RECIPIENT ?? null, mint = env.COMMERCE_SKR_MINT ?? null;
  if ((recipient !== null && !address(recipient)) || (mint !== null && !address(mint))) fail('COMMERCE_CONFIG');
  const decimals = env.COMMERCE_SKR_DECIMALS === undefined ? null : Number(env.COMMERCE_SKR_DECIMALS);
  if (decimals !== null && (!/^(0|[1-9]|1[0-8])$/.test(env.COMMERCE_SKR_DECIMALS)
    || !Number.isInteger(decimals))) fail('COMMERCE_CONFIG');
  const rpcUrl = env.COMMERCE_RPC_URL ?? null;
  if (rpcUrl !== null) {
    let url; try { url = new URL(rpcUrl); } catch { fail('COMMERCE_CONFIG'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || !url.hostname || /[\s\u0000-\u001f]/.test(rpcUrl)) fail('COMMERCE_CONFIG');
  }
  const ttlMilliseconds = env.COMMERCE_QUOTE_TTL_MS === undefined ? 300000 : Number(env.COMMERCE_QUOTE_TTL_MS);
  if (!Number.isSafeInteger(ttlMilliseconds) || ttlMilliseconds < 1000 || ttlMilliseconds > 600000) fail('COMMERCE_CONFIG');
  const config = { cluster, genesisHash, recipient, mint, decimals, rpcUrl, ttlMilliseconds, products, rates };
  return freeze({ ...config, catalogHash: createHash('sha256').update(JSON.stringify(config)).digest('hex') });
}
export function currencyAvailable(config, currency, time) {
  const r = config.rates[currency];
  return Boolean(config.cluster === 'devnet' && config.rpcUrl && config.genesisHash && config.recipient
    && (currency === 'SOL' || (currency === 'SKR' && config.mint && config.decimals !== null))
    && r && time >= r.timestamp && time < r.timestamp + r.ttlMilliseconds);
}
export function amountFor(cents, rate) {
  const numerator = BigInt(cents) * BigInt(rate.numerator), denominator = BigInt(rate.denominator);
  const amount = ((numerator + denominator - 1n) / denominator).toString();
  if (!positive(amount)) fail('COMMERCE_PRICE_RANGE');
  return amount;
}
