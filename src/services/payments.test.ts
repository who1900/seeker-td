import assert from 'node:assert/strict';
import {
  applyPaymentReceipt, configurePaymentVerifier, executePayment, mwaSignatureToBase58,
  paymentAvailability, purchasedRunPoolLamports, resolvePaymentLamports,
  validateParsedPayment, validatePaymentQuote, validatePaymentReceipt,
} from './payments';
import type { PaymentQuote, PaymentReceipt, PaymentRequest, PaymentTransport, SubmittedPayment } from './payments';

// Only this test file installs mocks. No RPC, MWA, wallet or Firebase imports.
const request: PaymentRequest = { lamports: 10000000, recipient: 'recipient', payer: 'payer', runs: 3, cluster: 'devnet' };
const quote: PaymentQuote = { ...request, payer: 'payer', runs: 3, id: 'quote-1', genesisHash: 'devnet-genesis', expiresAt: Date.now() + 60000 };
const submitted: SubmittedPayment = { signature: 'signature-1', blockhash: 'blockhash-1', lastValidBlockHeight: 100 };
const receipt: PaymentReceipt = { ...request, payer: 'payer', runs: 3, id: 'receipt-1', quoteId: quote.id, signature: submitted.signature };
function transaction() {
  return { meta: { err: null as unknown, innerInstructions: [] as unknown[] }, transaction: {
    signatures: [submitted.signature], message: { recentBlockhash: submitted.blockhash,
      accountKeys: [{ pubkey: 'payer', signer: true }], instructions: [{ program: 'system',
        programId: '11111111111111111111111111111111', parsed: { type: 'transfer',
          info: { source: 'payer', destination: 'recipient', lamports: request.lamports } } }] } } };
}

async function run() {
  let checks = 0;
  function rejectsSync(action: () => unknown) { assert.throws(action); checks++; }
  for (const value of [0, -1, NaN, Infinity, -Infinity]) {
    rejectsSync(() => resolvePaymentLamports({ priceUsd: value, solPrice: 1 }));
    rejectsSync(() => resolvePaymentLamports({ priceUsd: 1, solPrice: value }));
    rejectsSync(() => resolvePaymentLamports({ lamports: value }));
  }
  for (const value of [0.5, Number.MAX_SAFE_INTEGER + 1]) rejectsSync(() => resolvePaymentLamports({ lamports: value }));
  rejectsSync(() => resolvePaymentLamports({}));
  rejectsSync(() => resolvePaymentLamports({ priceUsd: 1e-20, solPrice: 1 }));
  rejectsSync(() => resolvePaymentLamports({ priceUsd: Number.MAX_VALUE, solPrice: 1 }));
  rejectsSync(() => resolvePaymentLamports({ lamports: 10, solPrice: 0 }));
  assert.equal(resolvePaymentLamports({ priceUsd: 2, solPrice: 200 }), 10000000);
  assert.equal(resolvePaymentLamports({ lamports: 17, priceUsd: 2, solPrice: 200 }), 17); checks += 2;
  assert.equal(mwaSignatureToBase58(btoa('\0'.repeat(64))), '1'.repeat(64)); checks++;
  for (const input of ['', 'base58-signature', btoa('\0'.repeat(63)), btoa('\0'.repeat(65)), '!'.repeat(88)]) {
    rejectsSync(() => mwaSignatureToBase58(input));
  }
  const bytes = Uint8Array.from({ length: 64 }, (_, i) => i);
  const encoded = mwaSignatureToBase58(btoa(String.fromCharCode(...bytes)));
  let number = 0n;
  for (const char of encoded) number = number * 58n + BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(char));
  let expected = 0n;
  for (const byte of bytes) expected = expected * 256n + BigInt(byte);
  assert.equal(number, expected); assert.ok(encoded.startsWith('1')); checks += 2;

  validateParsedPayment(transaction(), quote, submitted); checks++;
  for (const mutate of [
    (tx: ReturnType<typeof transaction>) => { tx.meta.err = { InstructionError: [0, 'error'] }; },
    (tx: ReturnType<typeof transaction>) => { tx.transaction.message.instructions[0].parsed.info.lamports++; },
    (tx: ReturnType<typeof transaction>) => { tx.transaction.message.instructions[0].parsed.info.destination = 'wrong'; },
    (tx: ReturnType<typeof transaction>) => { tx.transaction.message.instructions[0].parsed.info.source = 'wrong'; },
    (tx: ReturnType<typeof transaction>) => { tx.transaction.message.accountKeys[0].pubkey = 'wrong'; },
    (tx: ReturnType<typeof transaction>) => { tx.transaction.message.accountKeys[0].signer = false; },
    (tx: ReturnType<typeof transaction>) => { tx.transaction.message.recentBlockhash = 'wrong'; },
    (tx: ReturnType<typeof transaction>) => { tx.transaction.signatures[0] = 'wrong'; },
    (tx: ReturnType<typeof transaction>) => { tx.transaction.message.instructions[0].programId = 'wrong'; },
    (tx: ReturnType<typeof transaction>) => { tx.transaction.message.instructions.push(tx.transaction.message.instructions[0]); },
    (tx: ReturnType<typeof transaction>) => { tx.meta.innerInstructions.push({}); },
  ]) { const tx = transaction(); mutate(tx); rejectsSync(() => validateParsedPayment(tx, quote, submitted)); }
  rejectsSync(() => validateParsedPayment(null, quote, submitted));
  rejectsSync(() => validateParsedPayment({ transaction: transaction().transaction }, quote, submitted));
  for (const patch of [{ lamports: 1 }, { recipient: 'wrong' }, { payer: 'wrong' }, { runs: 1 },
    { cluster: 'testnet' as const }, { expiresAt: 0 }, { expiresAt: NaN }]) {
    rejectsSync(() => validatePaymentQuote({ ...quote, ...patch }, request, Date.now()));
  }
  for (const patch of [{ lamports: 1 }, { recipient: 'wrong' }, { payer: 'wrong' }, { runs: 1 },
    { cluster: 'testnet' as const }, { signature: 'wrong' }, { quoteId: 'wrong' }, { id: '' }]) {
    rejectsSync(() => validatePaymentReceipt({ ...receipt, ...patch }, quote, submitted.signature));
  }

  const state = { paidRuns: 2, dailyFreeLeft: 3, prizePool: 123, tokens: 7, paymentReceiptIds: [] as string[], paymentSignatures: [] as string[] };
  const credited = applyPaymentReceipt(state, receipt);
  assert.equal(credited.paidRuns, 5);
  assert.equal(state.paidRuns, 2);
  assert.equal(credited.dailyFreeLeft, 3); assert.equal(credited.prizePool, 123); assert.equal(credited.tokens, 7);
  const persisted = JSON.parse(JSON.stringify(credited)) as typeof credited;
  assert.strictEqual(applyPaymentReceipt(persisted, receipt), persisted);
  assert.strictEqual(applyPaymentReceipt(persisted, { ...receipt, id: 'replayed-as-new-id' }), persisted);
  assert.strictEqual(applyPaymentReceipt(persisted, { ...receipt, signature: 'different', id: receipt.id }), persisted); checks += 8;
  rejectsSync(() => applyPaymentReceipt(state, { ...receipt, runs: -1 }));
  rejectsSync(() => applyPaymentReceipt({ paidRuns: Number.MAX_SAFE_INTEGER }, receipt));
  assert.equal(purchasedRunPoolLamports(101), 10);
  assert.equal(purchasedRunPoolLamports(Number.MAX_SAFE_INTEGER), Number(BigInt(Number.MAX_SAFE_INTEGER) / 10n)); checks += 2;

  let sent = 0, verified = 0, chainReads = 0;
  const transport: PaymentTransport = {
    genesisHash: async () => { chainReads++; return quote.genesisHash; },
    send: async () => { sent++; return submitted; },
    confirm: async (evidence) => { assert.deepEqual(evidence, submitted); return { err: null }; },
    transaction: async () => transaction(),
  };
  configurePaymentVerifier(null);
  assert.equal(paymentAvailability('devnet').enabled, false);
  await assert.rejects(executePayment(request, transport), /disabled/);
  assert.equal(sent, 0); assert.equal(chainReads, 0); checks += 4;
  configurePaymentVerifier({ kind: 'server', createQuote: async () => quote,
    verifyReceipt: async () => { verified++; return receipt; } });
  await assert.rejects(executePayment({ ...request, cluster: 'mainnet-beta' }, transport), /Mainnet/);
  assert.equal(sent, 0); checks += 2;
  await assert.rejects(executePayment(request, { ...transport, genesisHash: async () => 'wrong-cluster' }), /cluster/);
  assert.equal(sent, 0); checks += 2;
  await assert.rejects(executePayment(request, { ...transport, confirm: async () => ({ err: 'failed' }) }), /failed/);
  assert.equal(verified, 0); checks += 2;
  await assert.rejects(executePayment(request, { ...transport, confirm: async () => { throw new Error('blockheight expired'); } }), /expired/);
  await assert.rejects(executePayment(request, { ...transport, transaction: async () => null }), /match/);
  assert.equal(verified, 0); checks += 3;
  configurePaymentVerifier({ kind: 'server', createQuote: async () => ({ ...quote, expiresAt: 0 }), verifyReceipt: async () => receipt });
  const before = sent;
  await assert.rejects(executePayment(request, transport), /expired/);
  assert.equal(sent, before); checks += 2;
  configurePaymentVerifier({ kind: 'server', createQuote: async () => quote,
    verifyReceipt: async () => { throw new Error('server unavailable'); } });
  await assert.rejects(executePayment(request, transport), /server unavailable/); checks++;
  configurePaymentVerifier({ kind: 'server', createQuote: async () => quote, verifyReceipt: async () => ({ ...receipt, payer: 'spoof' }) });
  await assert.rejects(executePayment(request, transport), /receipt mismatch/); checks++;
  configurePaymentVerifier({ kind: 'server', createQuote: async () => quote, verifyReceipt: async () => receipt });
  assert.deepEqual(await executePayment(request, transport), receipt); checks++;
  console.log(`Payment safety: ${checks} assertions PASS (local mocks only)`);
}

void run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => configurePaymentVerifier(null));
