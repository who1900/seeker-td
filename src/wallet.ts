import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol';
import {
  clusterApiUrl,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { bytesToBase58, executePayment, mwaSignatureToBase58, paymentAvailability, resolvePaymentLamports } from './services/payments';
import type { PaymentReceipt } from './services/payments';

const APP_IDENTITY = {
  name: 'SEEKER: TD',
  uri: 'https://seekdef.app',
  icon: 'favicon.ico',
} as const;

// devnet | testnet | mainnet-beta — MWA authorize cluster type
type MwaCluster = 'devnet' | 'testnet' | 'mainnet-beta';

const CLUSTER: MwaCluster = (() => {
  const v = import.meta.env.VITE_SOLANA_CLUSTER ?? 'devnet';
  if (v === 'testnet' || v === 'mainnet-beta') return v;
  return 'devnet';
})();

const RPC = clusterApiUrl(CLUSTER);

export function getReceivingWallet(): string {
  const w = import.meta.env.VITE_RECEIVING_WALLET as string | undefined;
  if (!w) throw new Error('Receiving wallet not configured. Set VITE_RECEIVING_WALLET in .env');
  return w;
}

export async function getSolBalance(address: string): Promise<number> {
  const connection = new Connection(RPC, 'confirmed');
  const lamports = await connection.getBalance(new PublicKey(address));
  return lamports / LAMPORTS_PER_SOL;
}

function toBase58(bytes: Uint8Array): string {
  return bytesToBase58(bytes);
}

function rawAddressToBase58(raw: Uint8Array | string): string {
  if (raw instanceof Uint8Array) return toBase58(raw);
  const binaryStr = atob(raw);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  return toBase58(bytes);
}

function isMobile(): boolean {
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

// Desktop wallet provider type
interface SolanaProvider {
  connect(): Promise<{ publicKey: { toString(): string } }>;
}

declare global {
  interface Window {
    solana?: SolanaProvider;
    solflare?: SolanaProvider;
  }
}

export async function connectWallet(): Promise<{ address: string; authToken: string }> {
  if (isMobile()) {
    const auth = await transact(async (wallet) => {
      return wallet.authorize({ cluster: CLUSTER, identity: APP_IDENTITY });
    });

    if (!auth?.accounts?.length) throw new Error('No accounts returned from wallet');

    const address = rawAddressToBase58(auth.accounts[0].address as Uint8Array | string);
    return { address, authToken: auth.auth_token ?? '' };
  }

  // Desktop fallback
  const provider = window.solana ?? window.solflare;

  if (!provider) throw new Error('No Solana wallet found. Install a browser extension.');

  const resp = await provider.connect();
  return { address: resp.publicKey.toString(), authToken: '' };
}

export async function payWithSol(opts: {
  priceUsd?: number;
  toAddress: string;
  solPrice?: number;
  lamports?: number;
  payer?: string;
  runs?: number;
}): Promise<{ signature: string; receipt: PaymentReceipt }> {
  const availability = getPurchaseAvailability();
  if (!availability.enabled) throw new Error(availability.reason);
  const lamports = resolvePaymentLamports(opts);
  const recipient = new PublicKey(opts.toAddress).toBase58();
  const connection = new Connection(RPC, 'confirmed');
  const receipt = await executePayment({ lamports, recipient, cluster: CLUSTER, payer: opts.payer, runs: opts.runs }, {
    genesisHash: () => connection.getGenesisHash(),
    send: async (quote) => {
      new PublicKey(quote.payer);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const signature = await transact(async (wallet) => {
        const auth = await wallet.authorize({ cluster: CLUSTER, identity: APP_IDENTITY });
        if (!auth?.accounts?.length) throw new Error('No accounts returned from wallet');
        const payerKey = new PublicKey(rawAddressToBase58(auth.accounts[0].address));
        if (payerKey.toBase58() !== quote.payer) throw new Error('Authorized payer does not match server quote');
        if (Date.now() >= quote.expiresAt) throw new Error('Payment quote expired before signing');
        const message = new TransactionMessage({
          payerKey,
          recentBlockhash: blockhash,
          instructions: [SystemProgram.transfer({ fromPubkey: payerKey,
            toPubkey: new PublicKey(quote.recipient), lamports: quote.lamports })],
        }).compileToV0Message();
        const serialized = new VersionedTransaction(message).serialize();
        // Low-level protocol uses base64 payloads AND base64 signatures, not web3js wrapper types.
        const results = await wallet.signAndSendTransactions({
          payloads: [btoa(String.fromCharCode(...serialized))],
        });
        if (results.signatures.length !== 1) throw new Error('Unexpected MWA signature count');
        return mwaSignatureToBase58(results.signatures[0]);
      });
      return { signature, blockhash, lastValidBlockHeight };
    },
    confirm: async (submitted) => (await connection.confirmTransaction(submitted, 'confirmed')).value,
    transaction: (signature) => connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }),
  });
  return { signature: receipt.signature, receipt };
}

export function getPurchaseAvailability(): { enabled: boolean; reason: string } {
  const configuredCluster = import.meta.env.VITE_SOLANA_CLUSTER;
  if (configuredCluster && !['devnet', 'testnet', 'mainnet-beta'].includes(configuredCluster)) {
    return { enabled: false, reason: 'Purchases disabled: invalid cluster configuration.' };
  }
  return paymentAvailability(CLUSTER);
}

export function getWalletCluster(): MwaCluster {
  return CLUSTER;
}
