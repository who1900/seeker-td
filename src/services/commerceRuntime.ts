import { currentFirebaseUid, getFirebaseAuthSnapshot, getFirebaseIdToken, subscribeFirebaseIdentity } from '../firebase';
import { FIREBASE_CONFIG } from '../firebase.config';
import { getSkrConfig, getSolanaConfig } from './solanaConfig';
import { createCommerceClient, trustedCommerceUrl } from './commerce';
import { createCommerceWalletTransport } from './commerceWallet';

export async function commerceFirebaseUid(): Promise<string | null> {
  return (await getFirebaseAuthSnapshot())?.uid ?? null;
}
export const subscribeCommerceIdentity = subscribeFirebaseIdentity;
export function commerceRuntimeAvailability(): { enabled: boolean; reason: string } {
  try {
    trustedCommerceUrl(import.meta.env.VITE_COMMERCE_URL);
    if (getSolanaConfig().cluster !== 'devnet') throw new Error('Mainnet purchases are locked pending security signoff. DEVNET only.');
    return { enabled: true, reason: '' };
  } catch (error) {
    return { enabled: false, reason: error instanceof Error ? error.message : 'Purchases disabled.' };
  }
}
let commerceClient: ReturnType<typeof createCommerceClient> | undefined;
export function getCommerceClient() {
  const availability = commerceRuntimeAvailability();
  if (!availability.enabled) throw new Error(availability.reason);
  return commerceClient ??= createCommerceClient({ url: import.meta.env.VITE_COMMERCE_URL, getToken: getFirebaseIdToken,
    getSession: getFirebaseAuthSnapshot, getCurrentUid: currentFirebaseUid,
    getUid: commerceFirebaseUid, storage: localStorage, identityAudience: FIREBASE_CONFIG.projectId,
    identityOrigin: window.location.origin });
}
export function getCommerceWalletTransport() {
  const config = getSolanaConfig();
  let skr: ReturnType<typeof getSkrConfig> | undefined;
  try { skr = getSkrConfig(); } catch { /* SOL checkout remains available without a test SKR mint. */ }
  return createCommerceWalletTransport({ ...config, rpcUrl: config.endpoint, genesisHash: config.genesisHash,
    skrMint: skr?.mint ?? null, skrDecimals: skr?.decimals ?? null }, { walletTimeoutMs: config.timeoutMs });
}
