const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const web3 = require('@solana/web3.js');
const payer = web3.Keypair.fromSeed(new Uint8Array(32).fill(1));
const merchant = web3.Keypair.fromSeed(new Uint8Array(32).fill(2));
const mint = web3.Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey;
const genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const config = { cluster: 'devnet', rpcUrl: 'https://rpc.example', genesisHash: genesis,
  skrMint: mint.toBase58(), skrDecimals: 6, identity: { name: 'Test', uri: 'https://localhost' } };
const q = { id: 'a'.repeat(32), productId: 'std-500', currency: 'SKR', amount: '123456789012345', decimals: 6,
  mint: mint.toBase58(), recipient: merchant.publicKey.toBase58(), payer: payer.publicKey.toBase58(), cluster: 'devnet',
  genesisHash: genesis, expiresAt: 1060000, runs: 0, std: 500, memo: `SEEKER:TD/commerce/v1/${'a'.repeat(32)}` };
function load() {
  const cache = new Map();
  function moduleAt(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8').replaceAll('import.meta.env', '__testEnv'), {
      fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    vm.runInNewContext(code, { module, exports: module.exports, console, Buffer, URL, AbortController, setTimeout, clearTimeout, __testEnv: {},
      require: id => id === '../wallet' ? { getWalletCapabilities() { throw new Error('REAL_WALLET_DENIED'); },
        signWalletTransaction() { throw new Error('REAL_WALLET_DENIED'); } }
        : id.startsWith('.') ? moduleAt(path.resolve(path.dirname(filename), `${id}.ts`)) : require(id),
    }, { filename }); return module.exports;
  }
  return moduleAt(path.join(__dirname, 'commerceWallet.ts'));
}
const lib = load();
function account(owner, tokenMint = mint, amount = 999999999999999n) {
  const data = Buffer.alloc(165); tokenMint.toBuffer().copy(data); owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64); data[108] = 1;
  return { data, owner: lib.COMMERCE_TOKEN_PROGRAM, executable: false, lamports: 2039280 };
}
function fixture(options = {}) {
  const calls = { signing: 0, sends: 0, capabilities: 0 }, events = [];
  const mintData = Buffer.alloc(82); mintData[44] = 6; mintData[45] = 1;
  const source = account(payer.publicKey), destination = account(merchant.publicKey);
  const mintInfo = { data: mintData, owner: lib.COMMERCE_TOKEN_PROGRAM, executable: false, lamports: 1 };
  const payerInfo = { data: Buffer.alloc(0), owner: web3.SystemProgram.programId, executable: false, lamports: 1000000000 };
  const connection = {
    getGenesisHash: async () => options.genesis ?? genesis,
    getAccountInfo: async key => key.equals(mint) ? options.mintInfo ?? mintInfo : options.payerInfo ?? payerInfo,
    getMultipleAccountsInfo: async () => [options.source ?? source, options.missingAta ? null : options.destination ?? destination],
    getLatestBlockhash: async () => ({ blockhash: merchant.publicKey.toBase58(), lastValidBlockHeight: 99 }),
    getFeeForMessage: async () => ({ value: options.fee === undefined ? 5000 : options.fee }),
    simulateTransaction: async tx => { assert.equal(tx.message.compiledInstructions.length, 2); return { value: { err: options.simError ?? null } }; },
    getBlockHeight: async () => options.blockHeight ?? 1,
    sendRawTransaction: async (raw, sendOptions) => {
      calls.sends++; events.push('send'); assert.equal(sendOptions.maxRetries, 0); assert.equal(sendOptions.skipPreflight, false);
      const signed = web3.VersionedTransaction.deserialize(raw);
      return lib.validateCommerceSignedTransaction(raw, signed.message.serialize(), signed.version);
    },
  };
  const transport = lib.createCommerceWalletTransport(config, { connection, now: () => 1000000,
    walletTimeoutMs: options.walletTimeoutMs ?? 1000,
    capabilities: async () => { calls.capabilities++; return { supportsV0: options.legacy ? false : true,
      supportedTransactionVersions: options.unsupported ? [] : options.legacy ? ['legacy'] : [0] }; },
    sign: options.sign ?? (async (raw, expected, signal) => {
      calls.signing++; events.push('sign'); assert.equal(expected, payer.publicKey.toBase58()); assert.equal(signal.aborted, false);
      const tx = web3.VersionedTransaction.deserialize(raw);
      assert.equal(tx.message.compiledInstructions.length, 2);
      const keys = tx.version === 0 ? tx.message.staticAccountKeys : tx.message.accountKeys;
      const transfer = tx.message.compiledInstructions[0], memo = tx.message.compiledInstructions[1];
      if (q.currency === 'SKR') assert.ok(keys[transfer.programIdIndex].equals(lib.COMMERCE_TOKEN_PROGRAM));
      assert.ok(keys[memo.programIdIndex].equals(lib.COMMERCE_MEMO_PROGRAM));
      assert.equal(Buffer.from(memo.data).toString(), q.memo);
      tx.sign([payer]); return tx.serialize();
    }),
  });
  return { transport, calls, events, source, destination, mintInfo, payerInfo };
}
test('TransferChecked exact U64 bytes, ATA derivation and account/mint owner validation', () => {
  const source = lib.commerceAta(payer.publicKey, mint), destination = lib.commerceAta(merchant.publicKey, mint);
  const ix = lib.commerceTransferChecked(source, mint, destination, payer.publicKey, 18446744073709551615n, 6);
  assert.equal(ix.data.toString('hex'), '0cffffffffffffffff06'); assert.equal(ix.keys[3].isSigner, true);
  assert.equal(ix.keys[0].isWritable, true); assert.equal(ix.keys[1].isWritable, false);
  assert.throws(() => lib.commerceTransferChecked(source, mint, destination, payer.publicKey, 18446744073709551616n, 6));
  const valid = account(payer.publicKey); assert.equal(lib.validateCommerceTokenAccount(valid, payer.publicKey, mint), 999999999999999n);
  assert.throws(() => lib.validateCommerceTokenAccount(valid, merchant.publicKey, mint), /owner/);
  assert.throws(() => lib.validateCommerceTokenAccount({ ...valid, owner: web3.SystemProgram.programId }, payer.publicKey, mint), /owner/);
  const frozen = { ...valid, data: Buffer.from(valid.data) }; frozen.data[108] = 2;
  assert.throws(() => lib.validateCommerceTokenAccount(frozen, payer.publicKey, mint), /state/);
});
test('v0 and legacy shared sign-only paths journal before exactly one broadcast', async () => {
  for (const legacy of [false, true]) {
    const f = fixture({ legacy }); const signal = new AbortController().signal;
    const prepared = await f.transport.prepare(q, signal);
    assert.equal(f.calls.signing, 0); assert.equal(prepared.rentLamports, '0');
    await prepared.send(signature => { assert.equal(f.calls.sends, 0); assert.ok(signature); f.events.push('journal'); }, signal);
    assert.deepEqual(f.events, ['sign', 'journal', 'send']); assert.equal(f.calls.sends, 1);
    await assert.rejects(prepared.send(() => {}, signal), /already used/); assert.equal(f.calls.sends, 1);
  }
});
test('wrong genesis, unprovisioned ATA, decimals, owners, funds and simulation fail before wallet', async () => {
  const base = fixture();
  const wrongDecimals = { ...base.mintInfo, data: Buffer.from(base.mintInfo.data) }; wrongDecimals.data[44] = 9;
  for (const options of [{ genesis: merchant.publicKey.toBase58() }, { missingAta: true }, { mintInfo: wrongDecimals },
    { mintInfo: { ...base.mintInfo, owner: web3.SystemProgram.programId } },
    { source: account(merchant.publicKey) }, { destination: account(payer.publicKey) }, { source: account(payer.publicKey, mint, 1n) },
    { payerInfo: { ...base.payerInfo, lamports: 1 } }, { payerInfo: { ...base.payerInfo, owner: lib.COMMERCE_TOKEN_PROGRAM } },
    { fee: null }, { simError: 'InstructionError' }]) {
    const f = fixture(options); await assert.rejects(f.transport.prepare(q, new AbortController().signal));
    assert.equal(f.calls.signing, 0); assert.equal(f.calls.sends, 0); assert.equal(f.calls.capabilities, 0);
  }
  assert.throws(() => lib.createCommerceWalletTransport({ ...config, cluster: 'mainnet-beta' }), /locked/);
});
test('cancellation or timeout during signing suppresses late broadcast', async () => {
  for (const cancel of [true, false]) {
    let release;
    const f = fixture({ walletTimeoutMs: 15, sign: raw => new Promise(resolve => { release = () => {
      const tx = web3.VersionedTransaction.deserialize(raw); tx.sign([payer]); resolve(tx.serialize());
    }; }) });
    const controller = new AbortController(), prepared = await f.transport.prepare(q, controller.signal);
    const sent = prepared.send(() => { throw new Error('must not journal'); }, controller.signal);
    while (!release) await new Promise(resolve => setTimeout(resolve, 1));
    if (cancel) controller.abort();
    await assert.rejects(sent, /Cancelled|Timed out/);
    release(); await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(f.calls.sends, 0);
  }
});
test('no broadcast after storage failure, altered message, wrong signer or expired blockhash', async () => {
  const signal = new AbortController().signal;
  const disk = fixture(), prepared = await disk.transport.prepare(q, signal);
  await assert.rejects(prepared.send(() => { throw new Error('disk full'); }, signal), /disk full/); assert.equal(disk.calls.sends, 0);
  const expired = fixture({ blockHeight: 100 }), blocked = await expired.transport.prepare(q, signal);
  await assert.rejects(blocked.send(() => {}, signal), /expired/); assert.equal(expired.calls.sends, 0);
  const altered = fixture({ sign: async raw => {
    const tx = web3.VersionedTransaction.deserialize(raw); tx.message.recentBlockhash = payer.publicKey.toBase58(); tx.sign([payer]); return tx.serialize();
  } });
  await assert.rejects((await altered.transport.prepare(q, signal)).send(() => {}, signal), /changed/); assert.equal(altered.calls.sends, 0);
  const invalid = fixture({ sign: async raw => raw });
  await assert.rejects((await invalid.transport.prepare(q, signal)).send(() => {}, signal), /signature/); assert.equal(invalid.calls.sends, 0);
});
