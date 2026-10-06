export type PaymentCluster = 'devnet' | 'testnet' | 'mainnet-beta';

export interface PaymentRequest {
  lamports: number;
  recipient: string;
  cluster: PaymentCluster;
  payer?: string;
  runs?: number;
}

export interface PaymentQuote extends PaymentRequest {
  id: string;
  payer: string;
  runs: number;
  genesisHash: string;
  expiresAt: number;
}

export interface PaymentReceipt {
  id: string;
  quoteId: string;
  signature: string;
  payer: string;
  recipient: string;
  lamports: number;
  runs: number;
  cluster: PaymentCluster;
}

// Implementations must call an authenticated server, never a local/mock verifier.
export interface ServerPaymentVerifier {
  kind: 'server';
  createQuote(request: PaymentRequest): Promise<PaymentQuote>;
  verifyReceipt(quote: PaymentQuote, signature: string): Promise<PaymentReceipt>;
}

let serverVerifier: ServerPaymentVerifier | null = null;

export function configurePaymentVerifier(verifier: ServerPaymentVerifier | null): void {
  if (verifier && (verifier.kind !== 'server' || typeof verifier.createQuote !== 'function'
    || typeof verifier.verifyReceipt !== 'function')) throw new Error('Invalid server payment verifier');
  serverVerifier = verifier;
}

export function paymentAvailability(cluster: PaymentCluster): { enabled: boolean; reason: string } {
  if (!['devnet', 'testnet', 'mainnet-beta'].includes(cluster)) return { enabled: false, reason: 'Unknown payment cluster.' };
  if (cluster === 'mainnet-beta') return { enabled: false, reason: 'Mainnet purchases are locked pending security audit.' };
  return serverVerifier
    ? { enabled: true, reason: '' }
    : { enabled: false, reason: 'Purchases disabled: authenticated server verifier is not implemented/configured. No funds will be sent.' };
}

export function resolvePaymentLamports(opts: { lamports?: number; priceUsd?: number; solPrice?: number }): number {
  for (const value of [opts.priceUsd, opts.solPrice]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error('Price and SOL denominator must be finite and positive');
  }
  if (opts.lamports !== undefined) {
    if (!Number.isSafeInteger(opts.lamports) || opts.lamports <= 0) throw new Error('Lamports must be a positive safe integer');
    return opts.lamports;
  }
  if (opts.priceUsd === undefined || opts.solPrice === undefined) throw new Error('Explicit lamports or a valid price quote is required');
  const lamports = Math.round(opts.priceUsd / opts.solPrice * 1_000_000_000);
  if (!Number.isSafeInteger(lamports) || lamports <= 0) throw new Error('Converted lamports out of range');
  return lamports;
}

export function bytesToBase58(bytes: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = 0n;
  for (const byte of bytes) num = num * 256n + BigInt(byte);
  let encoded = '';
  while (num > 0n) { encoded = alphabet[Number(num % 58n)] + encoded; num /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; encoded = '1' + encoded; }
  return encoded;
}

export function mwaSignatureToBase58(signature: string): string {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new Error('Invalid MWA base64 signature');
  const raw = atob(signature);
  if (raw.length !== 64 || btoa(raw) !== signature) throw new Error('MWA signature must encode exactly 64 bytes');
  return bytesToBase58(Uint8Array.from(raw, char => char.charCodeAt(0)));
}

function requireInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${label}`);
}

export function validatePaymentQuote(quote: PaymentQuote, request: PaymentRequest, now: number): void {
  requireInteger(quote.lamports, 'quote lamports');
  requireInteger(quote.runs, 'quote runs');
  if (typeof quote.id !== 'string' || !quote.id || !quote.payer || !quote.recipient || !quote.genesisHash
    || !Number.isFinite(quote.expiresAt) || quote.expiresAt <= now
    || quote.cluster !== request.cluster || quote.lamports !== request.lamports
    || quote.recipient !== request.recipient || (request.payer !== undefined && quote.payer !== request.payer)
    || (request.runs !== undefined && quote.runs !== request.runs)) throw new Error('Payment quote mismatch or expired');
}

export interface SubmittedPayment {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface PaymentTransport {
  genesisHash(): Promise<string>;
  send(quote: PaymentQuote): Promise<SubmittedPayment>;
  confirm(submitted: SubmittedPayment): Promise<{ err: unknown }>;
  transaction(signature: string): Promise<unknown>;
}

export function validateParsedPayment(transaction: unknown, quote: PaymentQuote, submitted: SubmittedPayment): void {
  const tx = transaction as {
    meta?: { err?: unknown; innerInstructions?: unknown[] };
    transaction?: { signatures?: string[]; message?: {
      recentBlockhash?: string;
      accountKeys?: { pubkey: { toString(): string } | string; signer: boolean }[];
      instructions?: { program?: string; programId?: { toString(): string } | string;
        parsed?: { type?: string; info?: { source?: string; destination?: string; lamports?: number } } }[];
    } };
  } | null;
  const message = tx?.transaction?.message;
  const payer = message?.accountKeys?.[0];
  const instructions = message?.instructions;
  const instruction = instructions?.[0];
  const info = instruction?.parsed?.info;
  if (!tx?.meta || tx.meta.err !== null || tx.meta.innerInstructions?.length
    || tx.transaction?.signatures?.[0] !== submitted.signature
    || message?.recentBlockhash !== submitted.blockhash || !payer?.signer
    || payer.pubkey.toString() !== quote.payer || instructions?.length !== 1
    || instruction?.program !== 'system' || instruction.programId?.toString() !== '11111111111111111111111111111111'
    || instruction.parsed?.type !== 'transfer' || info?.source !== quote.payer
    || info.destination !== quote.recipient || info.lamports !== quote.lamports) {
    throw new Error('Confirmed transaction does not match payment');
  }
}

export function validatePaymentReceipt(receipt: PaymentReceipt, quote: PaymentQuote, signature: string): void {
  if (typeof receipt.id !== 'string' || !receipt.id || receipt.quoteId !== quote.id || receipt.signature !== signature
    || receipt.payer !== quote.payer || receipt.recipient !== quote.recipient
    || receipt.lamports !== quote.lamports || receipt.runs !== quote.runs
    || receipt.cluster !== quote.cluster) throw new Error('Server receipt mismatch');
}

export async function executePayment(request: PaymentRequest, transport: PaymentTransport): Promise<PaymentReceipt> {
  const availability = paymentAvailability(request.cluster);
  if (!availability.enabled) throw new Error(availability.reason);
  const verifier = serverVerifier!;
  requireInteger(request.lamports, 'payment lamports');
  if (request.runs !== undefined) requireInteger(request.runs, 'payment runs');
  const quote = await verifier.createQuote(request);
  validatePaymentQuote(quote, request, Date.now());
  if (await transport.genesisHash() !== quote.genesisHash) throw new Error('Payment cluster/genesis mismatch');
  validatePaymentQuote(quote, request, Date.now());
  const submitted = await transport.send(quote);
  if (!submitted.signature || !submitted.blockhash || !Number.isSafeInteger(submitted.lastValidBlockHeight)
    || submitted.lastValidBlockHeight <= 0) throw new Error('Invalid submitted transaction');
  const result = await transport.confirm(submitted);
  if (result.err !== null) throw new Error('Payment transaction failed');
  validateParsedPayment(await transport.transaction(submitted.signature), quote, submitted);
  const receipt = await verifier.verifyReceipt(quote, submitted.signature);
  validatePaymentReceipt(receipt, quote, submitted.signature);
  return receipt;
}

export interface PaidRunLedger {
  paidRuns?: number;
  paymentReceiptIds?: string[];
  paymentSignatures?: string[];
}

// Pure cache adapter; caller persists the returned state through existing saveState.
// Local deduplication is not the authoritative server's entitlement ledger.
export function applyPaymentReceipt<T extends PaidRunLedger>(state: T, receipt: PaymentReceipt): T & PaidRunLedger {
  requireInteger(receipt.runs, 'receipt runs');
  requireInteger(receipt.lamports, 'receipt lamports');
  if (typeof receipt.id !== 'string' || !receipt.id || typeof receipt.signature !== 'string' || !receipt.signature) throw new Error('Invalid receipt identity');
  const ids = state.paymentReceiptIds ?? [];
  const signatures = state.paymentSignatures ?? [];
  if (!Array.isArray(ids) || !Array.isArray(signatures)
    || ids.some(id => typeof id !== 'string' || !id)
    || signatures.some(signature => typeof signature !== 'string' || !signature)) throw new Error('Invalid payment cache');
  if (ids.includes(receipt.id) || signatures.includes(receipt.signature)) return state;
  const balance = state.paidRuns ?? 0;
  if (!Number.isSafeInteger(balance) || balance < 0 || !Number.isSafeInteger(balance + receipt.runs)) throw new Error('Invalid paid run balance');
  return { ...state, paidRuns: balance + receipt.runs,
    paymentReceiptIds: [...ids, receipt.id], paymentSignatures: [...signatures, receipt.signature] };
}

export function purchasedRunPoolLamports(lamports: number): number {
  requireInteger(lamports, 'purchase lamports');
  return Number(BigInt(lamports) / 10n);
}
