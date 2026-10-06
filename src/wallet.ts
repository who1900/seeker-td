import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol';
import type { AuthorizationResult, MobileWallet } from '@solana-mobile/mobile-wallet-adapter-protocol';
import type { AuthorizationResultCache } from '@solana-mobile/wallet-adapter-mobile';
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { bytesToBase58, executePayment, mwaSignatureToBase58, paymentAvailability, resolvePaymentLamports } from './services/payments';
import type { PaymentReceipt } from './services/payments';
import { assertSolanaRpcCluster, canonicalSolanaAddress, getSkrConfig, getSolanaConfig } from './services/solanaConfig';
import type { SolanaCluster } from './services/solanaConfig';
import { createSolanaConnection } from './services/solanaRpc';
export { getSolanaConfig } from './services/solanaConfig';

export function getReceivingWallet(): string {
  const w = import.meta.env.VITE_RECEIVING_WALLET as string | undefined;
  if (!w) throw new Error('Receiving wallet not configured. Set VITE_RECEIVING_WALLET in .env');
  return w;
}

export async function getSolBalance(address: string): Promise<number> {
  const owner = new PublicKey(canonicalSolanaAddress(address));
  return readWithTimeout(async () => {
    const connection = createSolanaConnection();
    await assertSolanaRpcCluster(connection);
    const lamports = await connection.getBalance(owner);
    if (!Number.isSafeInteger(lamports) || lamports < 0) throw new Error('Invalid SOL balance');
    return lamports / LAMPORTS_PER_SOL;
  });
}

function toBase58(bytes: Uint8Array): string {
  return bytesToBase58(bytes);
}

function rawAddressToBase58(raw: string): string {
  const bytes = decodeBase64(raw);
  if (bytes.length !== 32) throw new Error('MWA account must contain exactly 32 bytes');
  return toBase58(bytes);
}

function isMobile(): boolean {
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    throw new Error('Mobile Wallet Adapter is not supported on iOS. Please use an Android Solana wallet.');
  }
  return /Android/i.test(navigator.userAgent);
}

// Desktop wallet provider type
interface SolanaProvider {
  connect(): Promise<{ publicKey: { toString(): string } }>;
  publicKey?: { toString(): string } | null;
  signMessage?(message: Uint8Array, display?: 'utf8'): Promise<{ signature: Uint8Array; publicKey?: { toString(): string } }>;
  disconnect?(): Promise<void>;
}

declare global {
  interface Window {
    solana?: SolanaProvider;
    solflare?: SolanaProvider;
  }
}

export interface WalletOperationOptions { signal?: AbortSignal }
export interface WalletCapabilities {
  supportsV0: boolean;
  supportsSignTransactions: boolean;
  supportedTransactionVersions: readonly ('legacy' | number)[];
  maxMessagesPerRequest?: number;
  maxTransactionsPerRequest?: number;
}
type WalletSession = { address: string; authToken: string; cluster: SolanaCluster;
  baseUri?: string; capabilities: WalletCapabilities };
type Operation = { check(): void; cancel(reason: string): void; signal: AbortSignal; nextSession?: WalletSession; settled?: Promise<unknown> };
let session: WalletSession | undefined;
let activeOperation: Operation | undefined;
let authorizationEpoch = 0;
const authorizationCaches = new Map<AuthorizationResultCache, () => Awaited<ReturnType<AuthorizationResultCache['get']>>>();

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  if (typeof value !== 'string' || value.length > 5552 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid canonical MWA base64');
  }
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  if (encodeBase64(bytes) !== value) throw new Error('Noncanonical MWA base64');
  return bytes;
}

async function readWithTimeout<T>(task: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([task(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Solana RPC request timed out')), getSolanaConfig().timeoutMs);
    })]);
  } finally { if (timer !== undefined) globalThis.clearTimeout?.(timer); }
}

async function walletOperation<T>(task: (operation: Operation) => Promise<T>, options: WalletOperationOptions = {}): Promise<T> {
  if (options.signal?.aborted) throw new Error('Wallet operation cancelled');
  if (activeOperation) throw new Error('Wallet operation already in progress');
  const epoch = authorizationEpoch;
  const deadline = Date.now() + getSolanaConfig().timeoutMs;
  const rpcCancellation = new AbortController();
  let cancelled: string | undefined;
  let rejectCancellation: (error: Error) => void = () => {};
  const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject; });
  const operation: Operation = {
    signal: rpcCancellation.signal,
    check() {
      if (!cancelled && Date.now() >= deadline) operation.cancel('Wallet operation timed out');
      if (cancelled || epoch !== authorizationEpoch) throw new Error(cancelled ?? 'Wallet operation cancelled');
    },
    cancel(reason) {
      if (cancelled) return;
      cancelled = reason;
      rpcCancellation.abort();
      session = undefined;
      rejectCancellation(new Error(reason));
    },
  };
  activeOperation = operation;
  const abort = () => operation.cancel('Wallet operation cancelled');
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => operation.cancel('Wallet operation timed out'), Math.max(0, deadline - Date.now()));
  (timer as unknown as { unref?(): void }).unref?.();
  const pending = Promise.resolve().then(async () => {
    try {
      operation.check();
      const result = await task(operation);
      operation.check();
      if (operation.nextSession) session = operation.nextSession;
      return result;
    } catch (error) { session = undefined; throw error; }
    finally { rpcCancellation.abort(); if (activeOperation === operation) activeOperation = undefined; }
  });
  operation.settled = pending;
  try { return await Promise.race([pending, cancellation]); }
  finally {
    globalThis.clearTimeout?.(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

export function cancelWalletOperation(): void {
  activeOperation?.cancel('Wallet operation cancelled');
}

function validateAuthorization(auth: AuthorizationResult, expectedPayer?: string): { address: string; encodedAddress: string; features?: readonly string[] } {
  const config = getSolanaConfig();
  if (!auth || typeof auth.auth_token !== 'string' || !auth.auth_token || !Array.isArray(auth.accounts) || !auth.accounts.length) {
    throw new Error('Invalid wallet authorization');
  }
  const accounts = auth.accounts.map(account => {
    // Low-level MWA addresses are base64, never display/base58 addresses.
    const encodedAddress = account.address;
    const address = rawAddressToBase58(encodedAddress);
    if (account.chains !== undefined && (!Array.isArray(account.chains) || !account.chains.includes(config.chain))) {
      throw new Error('Wallet account cluster mismatch');
    }
    if (account.features !== undefined && (!Array.isArray(account.features) || account.features.some(feature => typeof feature !== 'string'))) {
      throw new Error('Invalid wallet account features');
    }
    return { address, encodedAddress, features: account.features };
  });
  const selected = expectedPayer === undefined ? accounts[0] : accounts.find(account => account.address === expectedPayer);
  if (!selected) throw new Error('Authorized wallet account does not match expected payer');
  return selected;
}

function parseCapabilities(raw: Awaited<ReturnType<MobileWallet['getCapabilities']>>): WalletCapabilities {
  const versions: unknown = raw?.supported_transaction_versions;
  if (!Array.isArray(versions) || !versions.length
    || Array.from(versions).some(version => version !== 'legacy'
      && (typeof version !== 'number' || !Number.isInteger(version) || version < 0 || version > 127))) {
    throw new Error('Invalid wallet capabilities: supported_transaction_versions must contain legacy or integers 0..127');
  }
  for (const limit of [raw.max_messages_per_request, raw.max_transactions_per_request]) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error('Invalid wallet capability limit');
  }
  if (!Array.isArray(raw.features) || Array.from(raw.features).some(feature => typeof feature !== 'string' || !feature)) {
    throw new Error('Invalid wallet capability features');
  }
  return Object.freeze({ supportsV0: versions.includes(0),
    supportsSignTransactions: raw.features.includes('solana:signTransactions'),
    supportedTransactionVersions: Object.freeze([...versions]),
    maxMessagesPerRequest: raw.max_messages_per_request, maxTransactionsPerRequest: raw.max_transactions_per_request });
}

function associationOptions(baseUri?: string): { baseUri: string } | undefined {
  const capacitor = (window as Window & { Capacitor?: { isNativePlatform?(): boolean; getPlatform?(): string } }).Capacitor;
  // Capacitor ACTION_VIEW can open a cached HTTPS endpoint in a browser. Keep the wallet scheme on native Android.
  return baseUri && !(capacitor?.isNativePlatform?.() && capacitor.getPlatform?.() === 'android') ? { baseUri } : undefined;
}

async function authorizedSession<T>(operation: Operation, expectedPayer: string | undefined,
  action: (wallet: MobileWallet, account: { address: string; encodedAddress: string; features?: readonly string[] }, capabilities: WalletCapabilities) => Promise<T>): Promise<T> {
  if (!isMobile()) throw new Error('Mobile Wallet Adapter signing requires an Android Solana wallet');
  const config = getSolanaConfig();
  const previous = session;
  if (previous && (previous.cluster !== config.cluster || (expectedPayer !== undefined && previous.address !== expectedPayer))) {
    throw new Error('Connected wallet account/cluster mismatch; disconnect first');
  }
  const connection = createSolanaConnection(config.endpoint, operation.signal);
  await assertSolanaRpcCluster(connection);
  operation.check();
  return transact(async wallet => {
    operation.check();
    let auth: AuthorizationResult | undefined;
    try {
      if (previous) {
        try { auth = await wallet.reauthorize({ auth_token: previous.authToken, identity: config.identity }); }
        catch (error) {
          operation.check();
          if ((error as { code?: unknown })?.code !== -1) throw error;
          session = undefined;
        }
      }
      operation.check();
      if (!auth) auth = await wallet.authorize({ chain: config.chain, identity: config.identity });
      operation.check();
      const account = validateAuthorization(auth, expectedPayer ?? previous?.address);
      const capabilities = parseCapabilities(await wallet.getCapabilities());
      operation.check();
      let baseUri: string | undefined;
      if (auth.wallet_uri_base) {
        const url = new URL(auth.wallet_uri_base);
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Invalid wallet association URI');
        baseUri = url.toString();
      }
      operation.nextSession = { address: account.address, authToken: auth.auth_token, cluster: config.cluster, baseUri, capabilities };
      const result = await action(wallet, account, capabilities);
      operation.check();
      return result;
    } catch (error) {
      const token = auth?.auth_token ?? previous?.authToken;
      if (token) { try { await wallet.deauthorize({ auth_token: token }); } catch { /* Local authorization stays cleared. */ } }
      throw error;
    }
  }, associationOptions(previous?.baseUri));
}

async function verifyDetachedSignature(message: Uint8Array, signature: Uint8Array, address: string): Promise<void> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(new PublicKey(address).toBytes()).buffer,
    { name: 'Ed25519' }, false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', key, new Uint8Array(signature).buffer, new Uint8Array(message).buffer)) {
    throw new Error('Invalid wallet signature for expected payer');
  }
}

export function signWalletTransaction(serialized: Uint8Array, expectedPayer: string, signal?: AbortSignal): Promise<Uint8Array> {
  canonicalSolanaAddress(expectedPayer);
  if (getSolanaConfig().cluster === 'mainnet-beta') throw new Error('Mainnet transaction signing is locked pending security audit');
  if (!(serialized instanceof Uint8Array) || !serialized.length || serialized.length > 1232) throw new Error('Invalid serialized wallet transaction');
  const unsigned = new Uint8Array(serialized);
  const transaction = VersionedTransaction.deserialize(unsigned);
  if (transaction.message.staticAccountKeys[0]?.toBase58() !== expectedPayer
    || transaction.message.header.numRequiredSignatures < 1 || transaction.signatures[0].some(byte => byte !== 0)
    || !equalBytes(transaction.serialize(), unsigned)) throw new Error('Wallet transaction payer/signature/serialization mismatch');
  const originalMessage = transaction.message.serialize();
  return walletOperation(operation => authorizedSession(operation, expectedPayer, async (wallet, account, capabilities) => {
    if (!capabilities.supportsSignTransactions || capabilities.maxTransactionsPerRequest === 0
      || (account.features !== undefined && !account.features.includes('solana:signTransactions'))
      || !capabilities.supportedTransactionVersions.includes(transaction.version)) throw new Error('Wallet cannot sign this transaction version');
    operation.check();
    const result = await wallet.signTransactions({ payloads: [encodeBase64(unsigned)] });
    operation.check();
    if (!Array.isArray(result.signed_payloads) || result.signed_payloads.length !== 1) throw new Error('Unexpected signed transaction count');
    const signedBytes = decodeBase64(result.signed_payloads[0]);
    if (signedBytes.length > 1232) throw new Error('Invalid signed wallet transaction size');
    const signed = VersionedTransaction.deserialize(signedBytes);
    if (signed.version !== transaction.version || !equalBytes(signed.message.serialize(), originalMessage)
      || signed.signatures.length !== transaction.signatures.length || !equalBytes(signed.serialize(), signedBytes)
      || signed.signatures.some((signature, index) => index > 0 && !equalBytes(signature, transaction.signatures[index]))) {
      throw new Error('Wallet changed the transaction message/signers');
    }
    await verifyDetachedSignature(originalMessage, signed.signatures[0], expectedPayer);
    operation.check();
    return signedBytes;
  }), { signal });
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export function connectWallet(options: WalletOperationOptions = {}): Promise<{ address: string; authToken: string }> {
  return walletOperation(async operation => {
    if (isMobile()) {
      return authorizedSession(operation, undefined, async (_wallet, account) => ({
        address: account.address, authToken: operation.nextSession!.authToken,
      }));
    }
    const provider = window.solana ?? window.solflare;
    if (!provider) throw new Error('No Solana wallet found. Install a browser extension.');
    const connection = createSolanaConnection(getSolanaConfig().endpoint, operation.signal);
    await assertSolanaRpcCluster(connection);
    operation.check();
    const response = await provider.connect();
    operation.check();
    return { address: canonicalSolanaAddress(response.publicKey.toString()), authToken: '' };
  }, options);
}

export function reauthorizeWallet(expectedPayer?: string, options: WalletOperationOptions = {}): Promise<{ address: string; authToken: string }> {
  if (expectedPayer !== undefined) canonicalSolanaAddress(expectedPayer);
  return walletOperation(operation => authorizedSession(operation, expectedPayer, async (_wallet, account) => ({
    address: account.address, authToken: operation.nextSession!.authToken,
  })), options);
}

export async function getWalletCapabilities(options: WalletOperationOptions & { requireV0?: boolean } = {}): Promise<WalletCapabilities> {
  if (options.signal?.aborted) throw new Error('Wallet operation cancelled');
  if (activeOperation) throw new Error('Wallet operation already in progress');
  const config = getSolanaConfig();
  if (session) {
    if (session.cluster !== config.cluster) throw new Error('Connected wallet cluster mismatch; disconnect first');
    if (options.requireV0 && !session.capabilities.supportsV0) throw new Error('Wallet does not support v0 transactions');
    return session.capabilities;
  }
  return walletOperation(operation => authorizedSession(operation, undefined, async (_wallet, _account, capabilities) => {
    if (options.requireV0 && !capabilities.supportsV0) throw new Error('Wallet does not support v0 transactions');
    return capabilities;
  }), options);
}

export function signWalletMessage(message: string | Uint8Array, expectedPayer: string,
  options: WalletOperationOptions = {}): Promise<string> {
  canonicalSolanaAddress(expectedPayer);
  if (typeof message !== 'string' && !(message instanceof Uint8Array)) throw new Error('Invalid wallet proof message');
  const payload = typeof message === 'string' ? new TextEncoder().encode(message) : new Uint8Array(message);
  if (!payload.length || payload.length > 4096) throw new Error('Wallet proof message must contain 1..4096 bytes');
  return walletOperation(async operation => {
    if (isMobile()) {
      return authorizedSession(operation, expectedPayer, async (wallet, account, capabilities) => {
        if (capabilities.maxMessagesPerRequest === 0 || (account.features !== undefined && !account.features.includes('solana:signMessages'))) {
          throw new Error('Wallet cannot sign messages');
        }
        operation.check();
        const result = await wallet.signMessages({ addresses: [account.encodedAddress], payloads: [encodeBase64(payload)] });
        operation.check();
        if (!Array.isArray(result.signed_payloads) || result.signed_payloads.length !== 1) throw new Error('Unexpected MWA signed message count');
        const signed = decodeBase64(result.signed_payloads[0]);
        if (signed.length !== payload.length + 64 || !payload.every((byte, index) => byte === signed[index])) {
          throw new Error('MWA signed message does not match exact wallet proof payload');
        }
        const signature = signed.slice(payload.length);
        await verifyDetachedSignature(payload, signature, expectedPayer);
        operation.check();
        return encodeBase64(signature);
      });
    }
    const provider = window.solana ?? window.solflare;
    if (!provider?.signMessage || provider.publicKey?.toString() !== expectedPayer) throw new Error('Connected wallet does not match expected payer');
    const result = await provider.signMessage(new Uint8Array(payload), 'utf8');
    operation.check();
    if (provider.publicKey?.toString() !== expectedPayer || (result.publicKey && result.publicKey.toString() !== expectedPayer)
      || !(result.signature instanceof Uint8Array) || result.signature.length !== 64) throw new Error('Invalid wallet proof signer/signature');
    await verifyDetachedSignature(payload, result.signature, expectedPayer);
    operation.check();
    return encodeBase64(result.signature);
  }, options);
}

export async function disconnectWallet(): Promise<void> {
  const previous = session;
  const running = activeOperation;
  const tokens = new Map<string, string | undefined>();
  if (previous?.authToken) tokens.set(previous.authToken, previous.baseUri);
  for (const snapshot of authorizationCaches.values()) {
    const auth = snapshot();
    if (auth?.auth_token) tokens.set(auth.auth_token, auth.wallet_uri_base);
  }
  authorizationEpoch++;
  session = undefined;
  cancelWalletOperation();
  await Promise.all([...authorizationCaches.keys()].map(cache => cache.clear()));
  if (running?.settled) {
    await readWithTimeout(async () => { try { await running.settled; } catch { /* Cancellation is expected. */ } });
  }
  if (tokens.size) {
    await walletOperation(async operation => {
      for (const [token, baseUri] of tokens) {
        operation.check();
        await transact(async wallet => { operation.check(); await wallet.deauthorize({ auth_token: token }); }, associationOptions(baseUri));
      }
    });
  } else if (!isMobile()) {
    await walletOperation(async () => { await (window.solana ?? window.solflare)?.disconnect?.(); });
  }
}

export const logoutWallet = disconnectWallet;

export function createInMemoryWalletAuthorizationCache(): AuthorizationResultCache {
  let value: Awaited<ReturnType<AuthorizationResultCache['get']>>;
  let epoch = authorizationEpoch;
  const cache: AuthorizationResultCache = {
    async clear() { value = undefined; },
    async get() {
      if (epoch !== authorizationEpoch) { value = undefined; epoch = authorizationEpoch; }
      return value;
    },
    async set(auth) {
      if (epoch !== authorizationEpoch) throw new Error('Wallet authorization cache cancelled');
      if ('chain' in auth && auth.chain !== getSolanaConfig().chain) throw new Error('Wallet authorization cache cluster mismatch');
      if (auth.wallet_uri_base) {
        const url = new URL(auth.wallet_uri_base);
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Invalid wallet association URI');
      }
      // The React adapter caches Wallet Standard accounts (base58 + publicKey), not wire MWA accounts.
      const accounts = auth.accounts.map(account => {
        if (!('publicKey' in account)) return account;
        if (!(account.publicKey instanceof Uint8Array) || account.publicKey.length !== 32
          || canonicalSolanaAddress(account.address) !== toBase58(account.publicKey)) throw new Error('Invalid cached wallet account');
        return { ...account, address: encodeBase64(account.publicKey) };
      });
      validateAuthorization({ ...auth, accounts });
      value = auth;
    },
  };
  authorizationCaches.set(cache, () => value);
  return cache;
}

export interface SkrBalance { mint: string; address: string; cluster: SolanaCluster; decimals: number; raw: string; decimal: string }

export async function getSkrBalance(address: string): Promise<SkrBalance> {
  canonicalSolanaAddress(address);
  const config = getSolanaConfig();
  const skr = getSkrConfig();
  const program = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  return readWithTimeout(async () => {
    const connection = createSolanaConnection(config.endpoint);
    await assertSolanaRpcCluster(connection);
    const mint = (await connection.getParsedAccountInfo(new PublicKey(skr.mint), 'confirmed')).value;
    if (!mint || mint.executable || mint.owner.toBase58() !== program || !('parsed' in mint.data)
      || mint.data.program !== 'spl-token' || mint.data.space !== 82
      || mint.data.parsed?.type !== 'mint' || mint.data.parsed.info?.isInitialized !== true
      || mint.data.parsed.info.decimals !== skr.decimals) throw new Error('Invalid SKR mint owner/decimals');
    const accounts = await connection.getParsedTokenAccountsByOwner(new PublicKey(address), { mint: new PublicKey(skr.mint) }, 'confirmed');
    const seen = new Set<string>();
    let amount = 0n;
    for (const entry of accounts.value) {
      const key = canonicalSolanaAddress(entry.pubkey.toBase58());
      const data = entry.account.data.parsed;
      const info = data?.info;
      const raw = info?.tokenAmount?.amount;
      if (seen.has(key) || entry.account.executable || entry.account.owner.toBase58() !== program
        || entry.account.data.program !== 'spl-token' || entry.account.data.space !== 165
        || data?.type !== 'account' || info?.owner !== address || info.mint !== skr.mint
        || !['initialized', 'frozen'].includes(info.state) || info.tokenAmount?.decimals !== skr.decimals
        || typeof raw !== 'string' || raw.length > 20 || !/^(0|[1-9]\d*)$/.test(raw) || BigInt(raw) > 18446744073709551615n) {
        throw new Error('Invalid SKR token account owner/mint/amount/decimals');
      }
      seen.add(key);
      amount += BigInt(raw);
    }
    const raw = amount.toString();
    const padded = raw.padStart(skr.decimals + 1, '0');
    const decimal = skr.decimals === 0 ? raw : `${padded.slice(0, -skr.decimals)}.${padded.slice(-skr.decimals)}`;
    return { mint: skr.mint, address, cluster: config.cluster, decimals: skr.decimals, raw, decimal };
  });
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
  if (activeOperation) throw new Error('Wallet operation already in progress');
  const { cluster: CLUSTER, endpoint: RPC, identity: APP_IDENTITY } = getSolanaConfig();
  const lamports = resolvePaymentLamports(opts);
  const recipient = new PublicKey(opts.toAddress).toBase58();
  return walletOperation(async operation => {
  const connection = createSolanaConnection(RPC, operation.signal);
  const receipt = await executePayment({ lamports, recipient, cluster: CLUSTER, payer: opts.payer, runs: opts.runs }, {
    genesisHash: () => connection.getGenesisHash(),
    send: async (quote) => {
      operation.check();
      new PublicKey(quote.payer);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const signature = await transact(async (wallet) => {
        operation.check();
        const auth = await wallet.authorize({ cluster: CLUSTER, identity: APP_IDENTITY });
        operation.check();
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
        operation.check();
        // Low-level protocol uses base64 payloads AND base64 signatures, not web3js wrapper types.
        const results = await wallet.signAndSendTransactions({
          payloads: [btoa(String.fromCharCode(...serialized))],
        });
        operation.check();
        if (results.signatures.length !== 1) throw new Error('Unexpected MWA signature count');
        return mwaSignatureToBase58(results.signatures[0]);
      });
      return { signature, blockhash, lastValidBlockHeight };
    },
    confirm: async (submitted) => (await connection.confirmTransaction(submitted, 'confirmed')).value,
    transaction: (signature) => connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }),
  });
  operation.check();
  return { signature: receipt.signature, receipt };
  });
}

export function getPurchaseAvailability(): { enabled: boolean; reason: string } {
  try { return paymentAvailability(getSolanaConfig().cluster); }
  catch {
    return { enabled: false, reason: 'Purchases disabled: invalid cluster configuration.' };
  }
}

export function getWalletCluster(): SolanaCluster {
  return getSolanaConfig().cluster;
}
