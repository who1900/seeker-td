import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, TransactionInstruction, TransactionMessage, VersionedTransaction, PublicKey, SystemProgram } from '@solana/web3.js';
import { verifyCommerceTransaction, associatedAddress, TOKEN, MEMO, COMPUTE } from './commerce-verifier.mjs';
import { encodeBase58 } from './identity.mjs';
import { fixture, transactionFixture, wallet } from './commerce.test-support.mjs';

test('native SOL and classic SPL TransferChecked verify exact quote', async () => {
  for (const currency of ['SOL', 'SKR']) {
    const f = fixture(), q = await f.quote('runs-1', currency), p = f.pay(q);
    assert.deepEqual(verifyCommerceTransaction(p.f), { slot: 42, blockTime: Math.floor(f.time / 1000) + 1 });
  }
});
test('adversarial transaction matrix rejects ambiguity, outgoing spends and mismatched proof', async t => {
  for (const currency of ['SOL', 'SKR']) {
    const f = fixture(), q = await f.quote('runs-1', currency), payment = f.pay(q);
    const mutations = {
      failed: x => { x.transaction.meta.err = {}; },
      unfinalized: x => { x.status.confirmationStatus = 'confirmed'; },
      statusSlot: x => { x.status.slot++; },
      missingBlockTime: x => { x.transaction.blockTime = null; },
      beforeWindow: x => { x.transaction.blockTime = Math.floor(x.issuedAt / 1000) - 1; },
      expiry: x => { x.transaction.blockTime = Math.ceil(x.quote.expiresAt / 1000); },
      signature: x => { x.transaction.transaction.signatures[0] = 'forged'; },
      feePayer: x => { x.transaction.transaction.message.accountKeys[0].pubkey = wallet(); },
      signer: x => { x.transaction.transaction.message.accountKeys[0].signer = false; },
      extraSigner: x => { x.transaction.transaction.message.accountKeys[1].signer = true; },
      readonlySource: x => { x.transaction.transaction.message.accountKeys[0].writable = false; },
      loaded: x => { x.transaction.meta.loadedAddresses = { writable: [wallet()], readonly: [] }; },
      unusedLookup: x => { x.transaction.transaction.message.addressTableLookups = [{ accountKey: wallet(), writableIndexes: [], readonlyIndexes: [] }]; },
      lookupSource: x => { x.transaction.transaction.message.accountKeys[1].source = 'lookupTable'; },
      duplicateTransfer: x => { x.transaction.transaction.message.instructions.push(x.transaction.transaction.message.instructions[0]); },
      duplicateMemo: x => { x.transaction.transaction.message.instructions.push(x.transaction.transaction.message.instructions[1]); },
      memo: x => { x.transaction.transaction.message.instructions[1].parsed += '/other'; },
      inner: x => { x.transaction.meta.innerInstructions = [{ index: 0, instructions: [] }]; },
      unknown: x => { x.transaction.transaction.message.instructions.push({ programId: wallet(), data: '1' }); },
      outgoingDelta: x => { x.transaction.meta.postBalances[0] = (BigInt(x.transaction.meta.postBalances[0]) - 1n).toString(); },
      ambiguousWritable: x => { x.transaction.transaction.message.accountKeys.at(-1).writable = true; },
      floatBalance: x => { x.transaction.meta.preBalances[0] = 1.5; },
      destination: x => { x.transaction.transaction.message.instructions[0].parsed.info.destination = wallet(); },
    };
    if (currency === 'SOL') Object.assign(mutations, {
      amount: x => { x.transaction.transaction.message.instructions[0].parsed.info.lamports = '62'; },
      wrappedSOL: x => { x.transaction.transaction.message.instructions[0].programId = TOKEN; },
    });
    else Object.assign(mutations, {
      mint: x => { x.transaction.transaction.message.instructions[0].parsed.info.mint = wallet(); },
      decimals: x => { x.transaction.transaction.message.instructions[0].parsed.info.tokenAmount.decimals = 9; },
      unchecked: x => { x.transaction.transaction.message.instructions[0].parsed.type = 'transfer'; },
      authority: x => { x.transaction.transaction.message.instructions[0].parsed.info.authority = wallet(); },
      sourceATA: x => { x.transaction.transaction.message.instructions[0].parsed.info.source = wallet(); },
      owner: x => { x.transaction.meta.preTokenBalances[0].owner = wallet(); },
      tokenProgram: x => { x.transaction.meta.postTokenBalances[0].programId = wallet(); },
      tokenDelta: x => { x.transaction.meta.postTokenBalances[1].uiTokenAmount.amount = '100'; },
      extraTokens: x => { x.transaction.meta.preTokenBalances.push(x.transaction.meta.preTokenBalances[0]); },
      delegatedMultisig: x => { x.transaction.transaction.message.instructions[0].parsed.info.signers = [wallet()]; },
    });
    for (const [name, mutate] of Object.entries(mutations)) await t.test(`${currency}/${name}`, () => {
      const x = structuredClone(payment.f); mutate(x); assert.throws(() => verifyCommerceTransaction(x), /COMMERCE/);
    });
  }
});
test('merchant destination ATA unavailable/invalid disables SKR catalog and quote', async t => {
  for (const mutate of [a => { a.data.parsed.info.state = 'frozen'; }, a => { a.owner = wallet(); },
    a => { a.data.parsed.info.owner = wallet(); }, a => { a.data.parsed.info.mint = wallet(); },
    a => { a.space = 0; }, a => { a.data.parsed.info.tokenAmount.decimals = 9; }]) {
    await t.test('invalid ATA', async () => {
      const f = fixture(); mutate(f.recipientAccount);
      const dto = await f.service.catalog(); assert.equal(dto.enabled, true);
      assert.ok(dto.products.every(p => p.prices.every(price => price.currency === 'SOL')));
      await assert.rejects(f.quote('runs-1', 'SKR'));
    });
  }
  const f = fixture(), original = f.rpc.call;
  f.rpc.call = async (method, params) => method === 'getMultipleAccounts' ? { context: { slot: 42 }, value: [null, null] } : original(method, params);
  assert.ok((await f.service.catalog()).products.every(p => p.prices.every(price => price.currency !== 'SKR')));
  await assert.rejects(f.quote('runs-1', 'SKR'));
});
test('late SKR receipt/retry does not read currently closed source or destination ATA', async () => {
  const f = fixture(), q = await f.quote('runs-1', 'SKR'), { sig } = f.pay(q);
  f.setTime(q.expiresAt + 86400000);
  const original = f.rpc.call;
  f.rpc.call = async (method, params) => {
    assert.notEqual(method, 'getMultipleAccounts', 'receipt must use historical metadata, not mutable ATA state');
    return original(method, params);
  };
  const r = await f.receipt(q, sig); assert.deepEqual(await f.make().receipt('owner-token', { quoteId: q.id, signature: sig }), r);
});
test('genesis mismatch never quotes or credits', async () => {
  const f = fixture(), q = await f.quote(), { sig } = f.pay(q), original = f.rpc.call;
  f.rpc.call = async (method, params) => method === 'getGenesisHash' ? wallet() : original(method, params);
  assert.equal((await f.service.catalog()).enabled, false);
  await assert.rejects(f.quote(), /NETWORK/); await assert.rejects(f.receipt(q, sig), /NETWORK/);
});
test('actual signed web3 v0 transactions without ALT verify for SOL and SKR', async () => {
  for (const currency of ['SOL', 'SKR']) {
    const f = fixture(), q0 = await f.quote('runs-1', currency), payer = Keypair.generate();
    const q = { ...q0, payer: payer.publicKey.toBase58() }, issuedAt = f.time;
    const source = currency === 'SKR' ? associatedAddress(q.payer, q.mint) : q.payer;
    const destination = currency === 'SKR' ? associatedAddress(q.recipient, q.mint) : q.recipient;
    const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(BigInt(q.amount), 1); data[9] = q.decimals;
    const transfer = currency === 'SOL' ? SystemProgram.transfer({ fromPubkey: payer.publicKey,
      toPubkey: new PublicKey(q.recipient), lamports: BigInt(q.amount) })
      : new TransactionInstruction({ programId: new PublicKey(TOKEN), data, keys: [
        { pubkey: new PublicKey(source), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(q.mint), isSigner: false, isWritable: false },
        { pubkey: new PublicKey(destination), isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      ] });
    const memo = new TransactionInstruction({ programId: new PublicKey(MEMO), data: Buffer.from(q.memo),
      keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }] });
    const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: wallet(), instructions: [transfer, memo] }).compileToV0Message();
    const tx = new VersionedTransaction(message); tx.sign([payer]);
    const decoded = VersionedTransaction.deserialize(tx.serialize()); assert.equal(decoded.version, 0);
    assert.equal(decoded.message.addressTableLookups.length, 0);
    const sig = encodeBase58(decoded.signatures[0]), x = transactionFixture(q, sig, issuedAt);
    const oldKeys = x.transaction.transaction.message.accountKeys;
    const keys = decoded.message.staticAccountKeys.map((pubkey, i) => ({ pubkey: pubkey.toBase58(),
      signer: decoded.message.isAccountSigner(i), writable: decoded.message.isAccountWritable(i), source: 'transaction' }));
    for (const field of ['preBalances', 'postBalances']) {
      const old = x.transaction.meta[field]; x.transaction.meta[field] = keys.map(k => old[oldKeys.findIndex(v => v.pubkey === k.pubkey)]);
    }
    for (const field of ['preTokenBalances', 'postTokenBalances']) for (const b of x.transaction.meta[field]) {
      b.accountIndex = keys.findIndex(k => k.pubkey === oldKeys[b.accountIndex].pubkey);
    }
    x.transaction.transaction.message.accountKeys = keys;
    assert.equal(BigInt(q.amount), currency === 'SOL' ? Buffer.from(decoded.message.compiledInstructions[0].data).readBigUInt64LE(4)
      : Buffer.from(decoded.message.compiledInstructions[0].data).readBigUInt64LE(1));
    assert.equal(Buffer.from(decoded.message.compiledInstructions[1].data).toString(), q.memo);
    x.transaction.version = 0; x.transaction.meta.loadedAddresses = { readonly: [], writable: [] };
    assert.deepEqual(verifyCommerceTransaction(x), { slot: 42, blockTime: Math.floor(issuedAt / 1000) + 1 });
  }
});
test('allow bounded canonical compute budget instructions but reject duplicates', async () => {
  const f = fixture(), q = await f.quote(), x = f.pay(q).f;
  const d = Buffer.alloc(5); d[0] = 2; d.writeUInt32LE(200000, 1);
  x.transaction.transaction.message.instructions.unshift({ programId: COMPUTE, accounts: [], data: encodeBase58(d) });
  assert.doesNotThrow(() => verifyCommerceTransaction(x));
  x.transaction.transaction.message.instructions.unshift(x.transaction.transaction.message.instructions[0]);
  assert.throws(() => verifyCommerceTransaction(x));
});
