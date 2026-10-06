import { Buffer } from 'buffer';
import {
  PublicKey, SystemProgram, TransactionInstruction, TransactionMessage,
  Transaction, VersionedTransaction,
} from '@solana/web3.js';
import type { AccountInfo, Connection } from '@solana/web3.js';
import { bytesToBase58 } from './payments';
import { commerceDeadline, throwIfCancelled, validateCommerceQuote } from './commerce';
import type { CommerceWalletTransport } from './commerce';
import { getWalletCapabilities, signWalletTransaction } from '../wallet';
import { createSolanaConnection } from './solanaRpc';

// Classic SPL only. Token-2022 extensions require a separate reviewed protocol.
// Layouts: https://github.com/solana-program/token/tree/main/interface/src
export const COMMERCE_TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const COMMERCE_ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const COMMERCE_MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export interface CommerceSolanaConfig {
  rpcUrl: string;
  cluster: string;
  genesisHash: string;
  skrMint: string | null;
  skrDecimals: number | null;
  identity: { name?: string; uri?: string; icon?: string };
}
export function commerceAta(owner: PublicKey, mint: PublicKey): PublicKey {
  if (!PublicKey.isOnCurve(owner.toBytes())) throw new Error('Off-curve recipient wallets are not supported.');
  return PublicKey.findProgramAddressSync([owner.toBuffer(), COMMERCE_TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], COMMERCE_ATA_PROGRAM)[0];
}
export function commerceTransferChecked(source: PublicKey, mint: PublicKey, destination: PublicKey,
  payer: PublicKey, amount: bigint, decimals: number): TransactionInstruction {
  if (amount <= 0n || amount > 18446744073709551615n || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error('Invalid checked transfer amount.');
  }
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(amount, 1);
  data[9] = decimals;
  return new TransactionInstruction({ programId: COMMERCE_TOKEN_PROGRAM, data, keys: [
    { pubkey: source, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: destination, isSigner: false, isWritable: true },
    { pubkey: payer, isSigner: true, isWritable: false },
  ] });
}
export function validateCommerceMint(info: AccountInfo<Buffer> | null, decimals: number): void {
  if (!info || info.executable || !info.owner.equals(COMMERCE_TOKEN_PROGRAM) || info.data.length !== 82
    || info.data[44] !== decimals || info.data[45] !== 1) throw new Error('SKR mint owner, layout or decimals mismatch.');
}
export function validateCommerceTokenAccount(info: AccountInfo<Buffer> | null, owner: PublicKey, mint: PublicKey): bigint {
  if (!info || info.executable || !info.owner.equals(COMMERCE_TOKEN_PROGRAM) || info.data.length !== 165
    || !new PublicKey(info.data.subarray(0, 32)).equals(mint)
    || !new PublicKey(info.data.subarray(32, 64)).equals(owner) || info.data[108] !== 1) {
    throw new Error('Token account owner, mint or state mismatch.');
  }
  return info.data.readBigUInt64LE(64);
}
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
export function validateCommerceSignedTransaction(raw: Uint8Array, message: Uint8Array, version: 'legacy' | 0): string {
  if (version === 'legacy') {
    const tx = Transaction.from(raw);
    if (!equalBytes(tx.serializeMessage(), message) || tx.signatures.length !== 1 || !tx.verifySignatures()) {
      throw new Error('Wallet changed the transaction or returned an invalid signature.');
    }
    return bytesToBase58(tx.signatures[0].signature!);
  }
  const tx = VersionedTransaction.deserialize(raw);
  if (!equalBytes(tx.message.serialize(), message) || tx.signatures.length !== 1) throw new Error('Wallet changed the transaction.');
  // Both versions sign the identical serialized Message. Use web3's verifier for v0 too.
  const key = tx.message.staticAccountKeys[0];
  const verify = new Transaction();
  verify.signatures = [{ publicKey: key, signature: Buffer.from(tx.signatures[0]) }];
  verify.serializeMessage = () => Buffer.from(message);
  if (!verify.verifySignatures()) throw new Error('Invalid wallet transaction signature.');
  return bytesToBase58(tx.signatures[0]);
}
export function createCommerceWalletTransport(config: CommerceSolanaConfig, dependencies: {
  connection?: Connection;
  capabilities?: typeof getWalletCapabilities;
  sign?: typeof signWalletTransaction;
  now?: () => number;
  walletTimeoutMs?: number;
} = {}): CommerceWalletTransport {
  if (config.cluster !== 'devnet') throw new Error('Mainnet commerce is locked pending security signoff. DEVNET only.');
  const rpc = new URL(config.rpcUrl);
  if (rpc.protocol !== 'https:' || rpc.username || rpc.password || !config.genesisHash) throw new Error('Invalid trusted DEVNET RPC configuration.');
  const capabilitiesForWallet = dependencies.capabilities ?? getWalletCapabilities;
  const sign = dependencies.sign ?? signWalletTransaction, clock = dependencies.now ?? Date.now;
  return {
    async prepare(q, signal) {
      throwIfCancelled(signal);
      validateCommerceQuote(q, clock());
      if (q.cluster !== config.cluster || q.genesisHash !== config.genesisHash) throw new Error('Quote network does not match wallet configuration.');
      const connection = dependencies.connection ?? createSolanaConnection(config.rpcUrl, signal);
      const read = <T,>(work: Promise<T>) => commerceDeadline(work, signal);
      if (await read(connection.getGenesisHash()) !== q.genesisHash) throw new Error('RPC genesis mismatch. Nothing will be signed.');
      const payer = new PublicKey(q.payer), recipient = new PublicKey(q.recipient), amount = BigInt(q.amount);
      if (!PublicKey.isOnCurve(payer.toBytes()) || !PublicKey.isOnCurve(recipient.toBytes())) throw new Error('Invalid payer or recipient wallet.');
      const payerInfo = await read(connection.getAccountInfo(payer, 'confirmed'));
      if (!payerInfo || payerInfo.executable || !payerInfo.owner.equals(SystemProgram.programId) || payerInfo.data.length !== 0
        || !Number.isSafeInteger(payerInfo.lamports)) throw new Error('Payer must be a funded system wallet.');
      const instructions: TransactionInstruction[] = [];
      const rent = 0;
      if (q.currency === 'SOL') {
        instructions.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports: amount }));
      } else {
        if (!config.skrMint || q.mint !== config.skrMint || q.decimals !== config.skrDecimals) throw new Error('Unapproved DEVNET test SKR mint or decimals.');
        const mint = new PublicKey(q.mint);
        validateCommerceMint(await read(connection.getAccountInfo(mint, 'confirmed')), q.decimals);
        const source = commerceAta(payer, mint), destination = commerceAta(recipient, mint);
        const accounts = await read(connection.getMultipleAccountsInfo([source, destination], 'confirmed'));
        if (validateCommerceTokenAccount(accounts[0], payer, mint) < amount) throw new Error('Not enough test SKR.');
        if (!accounts[1]) throw new Error('Merchant test SKR account is not provisioned. Contact support; nothing will be signed.');
        validateCommerceTokenAccount(accounts[1], recipient, mint);
        instructions.push(commerceTransferChecked(source, mint, destination, payer, amount, q.decimals));
      }
      instructions.push(new TransactionInstruction({ programId: COMMERCE_MEMO_PROGRAM, data: Buffer.from(q.memo, 'utf8'),
        keys: [{ pubkey: payer, isSigner: true, isWritable: false }] }));
      const block = await read(connection.getLatestBlockhash('confirmed'));
      const builder = new TransactionMessage({ payerKey: payer, recentBlockhash: block.blockhash, instructions });
      const fee = (await read(connection.getFeeForMessage(builder.compileToLegacyMessage(), 'confirmed'))).value;
      if (fee === null || !Number.isSafeInteger(fee) || fee < 0 || !Number.isSafeInteger(rent) || rent < 0) throw new Error('Network fee unavailable.');
      const required = BigInt(fee) + BigInt(rent) + (q.currency === 'SOL' ? amount : 0n);
      if (BigInt(payerInfo.lamports) < required) throw new Error('Not enough test SOL for payment, network fee and account rent.');
      const simulation = await read(connection.simulateTransaction(new VersionedTransaction(builder.compileToV0Message()),
        { sigVerify: false, commitment: 'confirmed' }));
      if (simulation.value.err) throw new Error('Payment simulation failed. Nothing will be signed.');
      validateCommerceQuote(q, clock());
      let consumed = false;
      return { feeLamports: String(fee), rentLamports: String(rent), async send(beforeBroadcast, externalSignal) {
        if (consumed) throw new Error('This checkout was already used. Never resend; check its receipt.');
        consumed = true;
        const operation = new AbortController();
        const abort = () => operation.abort();
        externalSignal.addEventListener('abort', abort, { once: true });
        if (externalSignal.aborted) operation.abort();
        const operationSignal = operation.signal;
        const timer = setTimeout(abort, dependencies.walletTimeoutMs ?? 60_000);
        try {
          throwIfCancelled(operationSignal);
          const sendingConnection = dependencies.connection ?? createSolanaConnection(config.rpcUrl, operationSignal);
          validateCommerceQuote(q, clock());
          if (await commerceDeadline(sendingConnection.getGenesisHash(), operationSignal) !== q.genesisHash) throw new Error('RPC genesis changed.');
          const capabilities = await commerceDeadline(capabilitiesForWallet({ signal: operationSignal }), operationSignal);
          throwIfCancelled(operationSignal);
          const version = capabilities.supportsV0 ? 0 : capabilities.supportedTransactionVersions.includes('legacy') ? 'legacy' : null;
          if (version === null) throw new Error('Wallet supports neither legacy nor v0 transactions.');
          validateCommerceQuote(q, clock());
          if (await commerceDeadline(sendingConnection.getBlockHeight('confirmed'), operationSignal) > block.lastValidBlockHeight) throw new Error('Transaction blockhash expired. Request a new quote.');
          const message = version === 0 ? builder.compileToV0Message() : builder.compileToLegacyMessage();
          const unsigned = new VersionedTransaction(message);
          const raw = await commerceDeadline(sign(unsigned.serialize(), q.payer, operationSignal), operationSignal, dependencies.walletTimeoutMs ?? 60_000);
          throwIfCancelled(operationSignal);
          const signed = { raw, signature: validateCommerceSignedTransaction(raw, message.serialize(), version) };
          throwIfCancelled(operationSignal);
          validateCommerceQuote(q, clock());
          // Durable signature precedes broadcast. A timeout can therefore only trigger receipt reconciliation.
          beforeBroadcast(signed.signature);
          throwIfCancelled(operationSignal);
          const returned = await commerceDeadline(sendingConnection.sendRawTransaction(signed.raw,
            { skipPreflight: false, maxRetries: 0, preflightCommitment: 'confirmed' }), operationSignal);
          if (returned !== signed.signature) throw new Error('RPC returned a different transaction signature.');
          return signed.signature;
        } finally {
          clearTimeout(timer);
          operation.abort();
          externalSignal.removeEventListener('abort', abort);
        }
      } };
    },
  };
}
