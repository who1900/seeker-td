import { clusterApiUrl, Connection, PublicKey } from '@solana/web3.js';

export type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';
type SolanaEnv = Readonly<Record<string, string | undefined>>;

const GENESIS_HASHES = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
} as const;

function httpsUrl(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || value.trim() !== value) {
    throw new Error(`Invalid ${label}: HTTPS URL required`);
  }
  return value;
}

export function getSolanaConfig(env: SolanaEnv = import.meta.env) {
  const cluster = env.VITE_SOLANA_CLUSTER ?? 'devnet';
  if (cluster !== 'devnet' && cluster !== 'testnet' && cluster !== 'mainnet-beta') {
    throw new Error('Invalid Solana cluster configuration');
  }
  const endpoint = env.VITE_SOLANA_RPC_URL === undefined
    ? clusterApiUrl(cluster) : httpsUrl(env.VITE_SOLANA_RPC_URL, 'Solana RPC');
  const timeout = env.VITE_WALLET_TIMEOUT_MS ?? '60000';
  if (!/^[1-9]\d*$/.test(timeout) || Number(timeout) < 1000 || Number(timeout) > 120000) {
    throw new Error('Invalid wallet timeout (1000..120000 ms required)');
  }
  const uri = env.VITE_SOLANA_IDENTITY_URI === undefined
    ? 'https://github.com/who1900/seeker-td'
    : httpsUrl(env.VITE_SOLANA_IDENTITY_URI, 'wallet identity');
  const name = env.VITE_SOLANA_IDENTITY_NAME ?? 'SEEKER: TD';
  if (!name.trim() || name.length > 128 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Invalid wallet identity name');
  const icon = env.VITE_SOLANA_IDENTITY_ICON;
  if (icon !== undefined && (!icon || !/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_./-]+$/.test(icon))) {
    throw new Error('Wallet identity icon must be a relative URI');
  }
  const hasSkr = [env.VITE_SKR_MINT, env.VITE_SKR_DECIMALS, env.VITE_SKR_CLUSTER].some(value => value !== undefined);
  if (hasSkr && (!env.VITE_SKR_MINT || env.VITE_SKR_CLUSTER !== cluster || env.VITE_SKR_DECIMALS === undefined
    || !/^(0|[1-9]\d{0,2})$/.test(env.VITE_SKR_DECIMALS) || Number(env.VITE_SKR_DECIMALS) > 255)) {
    throw new Error('Invalid SKR mint/decimals/cluster configuration');
  }
  return Object.freeze({
    cluster,
    chain: cluster === 'mainnet-beta' ? 'solana:mainnet' as const : `solana:${cluster}` as const,
    endpoint,
    rpcUrl: endpoint,
    genesisHash: GENESIS_HASHES[cluster],
    skrMint: env.VITE_SKR_MINT ? canonicalSolanaAddress(env.VITE_SKR_MINT) : null,
    skrDecimals: hasSkr ? Number(env.VITE_SKR_DECIMALS) : null,
    timeoutMs: Number(timeout),
    identity: Object.freeze({ name, uri, ...(icon === undefined ? {} : { icon }) }),
  });
}

export function canonicalSolanaAddress(address: string): string {
  if (typeof address !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    throw new Error('Invalid Solana address');
  }
  const canonical = new PublicKey(address).toBase58();
  if (canonical !== address) throw new Error('Noncanonical Solana address');
  return canonical;
}

export function getSkrConfig(env: SolanaEnv = import.meta.env) {
  const config = getSolanaConfig(env);
  if (!env.VITE_SKR_MINT || env.VITE_SKR_DECIMALS === undefined || env.VITE_SKR_CLUSTER !== config.cluster) {
    throw new Error('SKR unavailable: configure VITE_SKR_MINT, VITE_SKR_DECIMALS and matching VITE_SKR_CLUSTER from trusted server configuration');
  }
  if (!/^(0|[1-9]\d{0,2})$/.test(env.VITE_SKR_DECIMALS) || Number(env.VITE_SKR_DECIMALS) > 255) {
    throw new Error('Invalid SKR decimals');
  }
  return Object.freeze({ mint: canonicalSolanaAddress(env.VITE_SKR_MINT), decimals: Number(env.VITE_SKR_DECIMALS) });
}

export async function assertSolanaRpcCluster(connection: Connection): Promise<void> {
  const genesis = await connection.getGenesisHash();
  canonicalSolanaAddress(genesis);
  if (genesis !== getSolanaConfig().genesisHash) throw new Error('Solana RPC cluster/genesis mismatch');
}
