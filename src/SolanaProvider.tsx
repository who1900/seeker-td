import React, { useMemo } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import {
  SolanaMobileWalletAdapter,
  createDefaultAddressSelector,
  createDefaultWalletNotFoundHandler,
} from '@solana-mobile/wallet-adapter-mobile';
import { getSolanaConfig } from './services/solanaConfig';
import { createInMemoryWalletAuthorizationCache } from './wallet';
import { getSolanaConnectionConfig } from './services/solanaRpc';

export const SolanaProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const config = useMemo(() => getSolanaConfig(), []);
  const connectionConfig = useMemo(() => getSolanaConnectionConfig(config.endpoint), [config]);
  const authorizationResultCache = useMemo(() => createInMemoryWalletAuthorizationCache(), []);

  const wallets = useMemo(
    () => [
      new SolanaMobileWalletAdapter({
        addressSelector: createDefaultAddressSelector(),
        appIdentity: config.identity,
        authorizationResultCache,
        chain: config.chain,
        onWalletNotFound: createDefaultWalletNotFoundHandler(),
      }),
    ],
    [config, authorizationResultCache]
  );

  return (
    <ConnectionProvider endpoint={config.endpoint} config={connectionConfig}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
};
