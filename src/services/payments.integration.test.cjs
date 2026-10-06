const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// Compile scoped TS modules in memory. All wallet/RPC boundaries are test-only stubs.
function sandbox(env = {}) {
  const cache = new Map();
  const calls = { connections: 0, wallet: 0, sends: 0, confirmations: 0, reads: 0, quotes: 0 };
  const payer = '1'.repeat(32);
  const recipient = 'recipient';
  const base64Signature = btoa('\0'.repeat(64));
  const signature = '1'.repeat(64);
  let confirmedEvidence;
  const storage = new Map();
  class PublicKey {
    constructor(value) { this.value = value; }
    toBase58() { return this.value; }
  }
  class Connection {
    constructor() { calls.connections++; }
    async getGenesisHash() { calls.reads++; return 'devnet-genesis'; }
    async getLatestBlockhash() { calls.reads++; return { blockhash: 'blockhash', lastValidBlockHeight: 123 }; }
    async confirmTransaction(evidence, commitment) {
      confirmedEvidence = evidence; calls.confirmations++; assert.equal(commitment, 'confirmed');
      return { value: { err: null } };
    }
    async getParsedTransaction(receivedSignature, options) {
      assert.equal(receivedSignature, signature); assert.equal(options.maxSupportedTransactionVersion, 0);
      return { meta: { err: null }, transaction: { signatures: [signature], message: {
        recentBlockhash: 'blockhash', accountKeys: [{ pubkey: payer, signer: true }],
        instructions: [{ program: 'system', programId: '11111111111111111111111111111111',
          parsed: { type: 'transfer', info: { source: payer, destination: recipient, lamports: 100 } } }],
      } } };
    }
  }
  const sdk = { Connection, PublicKey, LAMPORTS_PER_SOL: 1e9, clusterApiUrl: cluster => `mock:${cluster}`,
    SystemProgram: { transfer: values => values },
    TransactionMessage: class { constructor(values) { this.values = values; } compileToV0Message() { return this.values; } },
    VersionedTransaction: class { constructor(message) { this.message = message; } serialize() { return Uint8Array.from([1, 2, 3]); } },
  };
  const mwa = { transact: async callback => {
    calls.wallet++;
    return callback({ authorize: async () => ({ accounts: [{ address: btoa('\0'.repeat(32)) }] }),
      signAndSendTransactions: async values => {
        calls.sends++; assert.deepEqual(Array.from(values.payloads), [btoa('\x01\x02\x03')]);
        return { signatures: [base64Signature] };
      } });
  } };
  function load(file) {
    file = path.resolve(__dirname, file);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8').replaceAll('import.meta.env', '__testEnv'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
        jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const localRequire = spec => {
      if (spec === '@solana/web3.js') return sdk;
      if (spec === '@solana-mobile/mobile-wallet-adapter-protocol') return mwa;
      if (spec.startsWith('.')) {
        const base = path.resolve(path.dirname(file), spec);
        const target = [base, `${base}.ts`, `${base}.tsx`].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        if (target) return load(target);
      }
      return require(spec);
    };
    vm.runInNewContext(code, { require: localRequire, module, exports: module.exports,
      __testEnv: env, console, Uint8Array, Date, atob, btoa, setTimeout,
      localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    }, { filename: file });
    return module.exports;
  }
  return { load, calls, payer, recipient, signature, evidence: () => confirmedEvidence };
}

async function run() {
  const test = sandbox();
  const wallet = test.load('../wallet.ts');
  const payments = test.load('./payments.ts');
  await assert.rejects(wallet.payWithSol({ priceUsd: 1, solPrice: 1, toAddress: test.recipient }), /disabled/);
  assert.equal(test.calls.connections, 0); assert.equal(test.calls.wallet, 0); assert.equal(test.calls.sends, 0);
  assert.equal(test.calls.reads, 0);
  const state = { walletConnected: true, walletAddr: test.payer, tokens: 0, dailyFreeLeft: 2, dailyFreeMax: 3, paidRuns: 7 };
  for (const [file, name] of [['../screens/Paywall.tsx', 'Paywall'], ['../screens/WalletScreen.tsx', 'WalletScreen']]) {
    const Component = test.load(file)[name];
    const html = renderToStaticMarkup(React.createElement(Component, { state, setState() { throw new Error('unexpected state write'); }, nav() {} }));
    assert.equal((html.match(/class="btn small primary" disabled=""/g) || []).length, 3);
    assert.ok(html.includes('Purchases disabled'));
    assert.ok(!html.includes('70%')); assert.ok(!html.includes('liquidity for STD'));
    if (name === 'Paywall') {
      assert.ok(html.includes('Run credits'));
      assert.ok(html.includes('Free runs: 2 / 3'));
      assert.ok(html.includes('Paid runs: 7'));
      assert.ok(html.includes('Free runs reset at 00:00 UTC.'));
      assert.ok(html.includes('Practice is unlimited'));
      assert.ok(html.includes('Choose mode'));
      assert.ok(!html.includes('Out of free runs'));
      assert.ok(!html.includes('used today'));
    }
  }
  assert.equal(test.calls.wallet, 0); assert.equal(test.calls.reads, 0);
  payments.configurePaymentVerifier({ kind: 'server',
    createQuote: async request => { test.calls.quotes++; return { ...request, payer: test.payer, runs: 1,
      id: 'quote', expiresAt: Date.now() + 60000, genesisHash: 'devnet-genesis' }; },
    verifyReceipt: async (quote, signature) => ({ ...quote, quoteId: quote.id, id: 'receipt', signature }),
  });
  for (const options of [{ priceUsd: 1, solPrice: 0 }, { priceUsd: NaN, solPrice: 1 }, { lamports: Infinity }, { lamports: 0.5 }]) {
    await assert.rejects(wallet.payWithSol({ ...options, toAddress: test.recipient }));
  }
  assert.equal(test.calls.quotes, 0); assert.equal(test.calls.connections, 0);
  const paid = await wallet.payWithSol({ lamports: 100, toAddress: test.recipient, payer: test.payer, runs: 1 });
  assert.equal(paid.signature, test.signature); assert.equal(paid.receipt.id, 'receipt');
  assert.equal(test.calls.sends, 1); assert.equal(test.calls.confirmations, 1);
  assert.equal(test.evidence().blockhash, 'blockhash'); assert.equal(test.evidence().lastValidBlockHeight, 123);
  assert.equal(test.evidence().signature, test.signature);
  const store = test.load('../state/store.ts');
  const ledger = payments.applyPaymentReceipt(store.DEFAULT_STATE, paid.receipt);
  store.saveState(ledger);
  const reloaded = store.loadState();
  assert.equal(reloaded.paidRuns, store.DEFAULT_STATE.paidRuns + 1);
  assert.ok(reloaded.paymentReceiptIds.includes('receipt'));
  assert.ok(reloaded.paymentSignatures.includes(test.signature));
  assert.equal(reloaded.dailyFreeLeft, store.DEFAULT_STATE.dailyFreeLeft);
  assert.equal(reloaded.tokens, store.DEFAULT_STATE.tokens);
  assert.equal(reloaded.prizePool, store.DEFAULT_STATE.prizePool);
  assert.strictEqual(payments.applyPaymentReceipt(reloaded, paid.receipt), reloaded);
  for (const cluster of ['mainnet-beta', 'invalid-cluster']) {
    const locked = sandbox({ VITE_SOLANA_CLUSTER: cluster });
    const lockedWallet = locked.load('../wallet.ts');
    locked.load('./payments.ts').configurePaymentVerifier({ kind: 'server', createQuote: async () => { throw new Error('should not request quote'); }, verifyReceipt: async () => { throw new Error('should not verify'); } });
    await assert.rejects(lockedWallet.payWithSol({ lamports: 100, toAddress: 'recipient' }));
    assert.equal(locked.calls.connections, 0); assert.equal(locked.calls.wallet, 0);
  }
  payments.configurePaymentVerifier(null);
  console.log('Wallet/API + disabled purchase UI integration: PASS (mock-only; zero real network/wallet calls)');
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
