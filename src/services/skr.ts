/**
 * Resolves a Seeker .skr handle by Solana pubkey.
 * Currently a stub — returns null until a resolver is available.
 * TODO: resolve .skr via Seeker ID / SNS reverse-lookup when resolver available
 */
export async function resolveSkr(_pubkey: string): Promise<string | null> {
  return null;
}

/** Returns a display name: skrName if available, otherwise shortened pubkey. */
export function displayName(
  skrName: string | null | undefined,
  walletAddr: string,
): string {
  if (skrName) return skrName;
  if (!walletAddr || walletAddr.length < 8) return walletAddr || '—';
  return `${walletAddr.slice(0, 4)}…${walletAddr.slice(-4)}`;
}
