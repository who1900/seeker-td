const isProd = import.meta.env.PROD;

function requireEnv(key: string): string {
  const val = import.meta.env[key] as string | undefined;
  if (!val && isProd) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return val ?? '';
}

export const PAYMENT_WALLET_ADDRESS = requireEnv('VITE_PAYMENT_WALLET_ADDRESS');
export const PRIZE_POOL_WALLET_ADDRESS = requireEnv('VITE_PRIZE_POOL_WALLET_ADDRESS');
export const EXTRA_RUN_PRICE_USD: number = parseFloat(
  (import.meta.env.VITE_EXTRA_RUN_PRICE_USD as string | undefined) ?? '0.5'
);
