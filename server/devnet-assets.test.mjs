import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Keypair, PublicKey, SystemProgram, SystemInstruction, Transaction } from '@solana/web3.js';
import { ATA_PROGRAM, TOKEN_PROGRAM, DEVNET_GENESIS, MINT_SIZE, TOKEN_SIZE, canonicalAta,
  createAta, initializeMint, mintToChecked, parsePrivateEnv, readConfig, httpsRpc,
  loadSigners, verifyMint, verifyTokenAccount, runSetup, createRpc, parseArgs, main,
  readPrivateEnv } from './devnet-assets.mjs';

// Public, deterministic OFFLINE fixtures only. These are not provisioned operator identities.
const fixture = n => Keypair.fromSeed(new Uint8Array(32).fill(n));
const operator = fixture(1), mint = fixture(2), merchant = fixture(3), payer = fixture(4);
const env = (overrides = {}) => ({
  DEVNET_ASSETS_ACK: 'CUSTOM_DEVNET_TEST_TOKEN_ONLY',
  DEVNET_ASSETS_RPC_URL: 'https://rpc.invalid/devnet?credential=PRIVATE_RPC_SENTINEL',
  DEVNET_ASSETS_OPERATOR: operator.publicKey.toBase58(), DEVNET_ASSETS_MINT: mint.publicKey.toBase58(),
  DEVNET_ASSETS_MERCHANT: merchant.publicKey.toBase58(), DEVNET_ASSETS_TEST_PAYER: payer.publicKey.toBase58(),
  DEVNET_ASSETS_DECIMALS: '6', DEVNET_ASSETS_SUPPLY_BASE_UNITS: '1000000000', ...overrides,
});
const config = readConfig(env());
const secretEnv = () => ({ ...env(),
  DEVNET_ASSETS_OPERATOR_SECRET_JSON: JSON.stringify([...operator.secretKey]),
  DEVNET_ASSETS_MINT_SECRET_JSON: JSON.stringify([...mint.secretKey]),
});
const wallet = (balance = 100000000) => ({ owner: SystemProgram.programId.toBase58(),
  executable: false, data: ['', 'base64'], lamports: balance });
const account = (data, balance) => ({ owner: TOKEN_PROGRAM.toBase58(), executable: false,
  data: [data.toString('base64'), 'base64'], lamports: balance });
function mintAccount(change = () => {}) {
  const data = Buffer.alloc(MINT_SIZE);
  data.writeUInt32LE(1, 0); config.operator.toBuffer().copy(data, 4);
  data.writeBigUInt64LE(config.supply, 36); data[44] = config.decimals; data[45] = 1;
  change(data);
  return account(data, 1461600);
}
function tokenAccount(owner, amount = 0n, change = () => {}) {
  const data = Buffer.alloc(TOKEN_SIZE);
  config.mint.toBuffer().copy(data, 0); owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64); data[108] = 1; change(data);
  return account(data, 2039280);
}
const prepared = () => [mintAccount(), tokenAccount(config.merchant), tokenAccount(config.payer, config.supply),
  wallet(), wallet(), wallet(1000000)];
const fresh = () => [null, null, null, wallet(), wallet(), null];

function harness({ accounts = fresh(), genesis = [DEVNET_GENESIS], sendError, finalize = true,
  claimError, height = 101, fee = 10000, rents = [1461600, 2039280, 890880] } = {}) {
  const calls = [], reports = [], transactions = [], receipts = [];
  let signLoads = 0, genesisReads = 0, current = accounts;
  const receiptStore = {
    async read() { return receipts[0] ?? null; },
    async claim(receipt) {
      if (claimError) throw new Error(claimError);
      assert.equal(receipts.length, 0, 'exclusive submission claim');
      receipts.push(receipt);
    },
  };
  const rpc = { async call(method, params = []) {
    calls.push({ method, params });
    if (method === 'getGenesisHash') return genesis[Math.min(genesisReads++, genesis.length - 1)];
    if (method === 'getMultipleAccounts') {
      assert.deepEqual(params[0], [config.mint, canonicalAta(config.merchant, config.mint),
        canonicalAta(config.payer, config.mint), config.operator, config.payer, config.merchant].map(k => k.toBase58()));
      assert.equal(params[1].commitment, 'finalized');
      return { context: { slot: 50 }, value: current };
    }
    if (method === 'getMinimumBalanceForRentExemption') return rents[[MINT_SIZE, TOKEN_SIZE, 0].indexOf(params[0])];
    if (method === 'getLatestBlockhash') return { value: { blockhash: fixture(8).publicKey.toBase58(), lastValidBlockHeight: 500 } };
    if (method === 'getFeeForMessage') return { value: fee };
    if (method === 'sendTransaction') {
      assert.equal(receipts.length, 1, 'receipt persisted before send');
      assert.deepEqual(params[1], { encoding: 'base64', skipPreflight: false,
        preflightCommitment: 'finalized', maxRetries: 0, minContextSlot: 50 });
      const transaction = Transaction.from(Buffer.from(params[0], 'base64'));
      assert.equal(transaction.verifySignatures(), true, 'actual SDK signatures, not fixture stubs');
      transactions.push(transaction);
      if (sendError) throw new Error(sendError);
      if (finalize) current = prepared();
      return receipts[0].signature;
    }
    if (method === 'getSignatureStatuses') return { value: finalize ? [{ err: null, confirmationStatus: 'finalized' }] : [null] };
    if (method === 'getBlockHeight') return height;
    assert.fail(`unexpected offline method ${method}`);
  } };
  const options = { rpc, receiptStore, report: item => reports.push(item), pause: async () => {},
    signerLoader: needsMint => { signLoads++; return loadSigners(secretEnv(), config, needsMint); } };
  return { calls, reports, transactions, receipts, options, signLoads: () => signLoads };
}
const sends = h => h.calls.filter(c => c.method === 'sendTransaction');
const tags = transaction => transaction.instructions.filter(i => i.programId.equals(TOKEN_PROGRAM)).map(i => i.data[0]);

test('official InitializeMint2 wire format and metas: 35 bytes, ONE-byte None', () => {
  const instruction = initializeMint(config.mint, config.operator, 6);
  assert.equal(instruction.programId.toBase58(), TOKEN_PROGRAM.toBase58());
  assert.deepEqual(instruction.data, Buffer.concat([Buffer.from([20, 6]), config.operator.toBuffer(), Buffer.from([0])]));
  assert.deepEqual(instruction.keys, [{ pubkey: config.mint, isSigner: false, isWritable: true }]);
});

test('official MintToChecked wire format: tag 14, u64 LE, decimals, authority signer', () => {
  const destination = canonicalAta(config.payer, config.mint);
  const instruction = mintToChecked(config.mint, destination, config.operator, 0x0102030405060708n, 6);
  assert.equal(instruction.data.toString('hex'), '0e080706050403020106');
  assert.equal(instruction.programId.toBase58(), TOKEN_PROGRAM.toBase58());
  assert.deepEqual(instruction.keys, [
    { pubkey: config.mint, isSigner: false, isWritable: true },
    { pubkey: destination, isSigner: false, isWritable: true },
    { pubkey: config.operator, isSigner: true, isWritable: false },
  ]);
  assert.throws(() => mintToChecked(config.mint, destination, config.operator, 1n << 64n, 6), /INVALID_TEST_SUPPLY/);
});

test('official ATA wire format and canonical PDA (classic program seed, 6 metas)', () => {
  const expected = PublicKey.findProgramAddressSync([config.merchant.toBuffer(), TOKEN_PROGRAM.toBuffer(),
    config.mint.toBuffer()], ATA_PROGRAM)[0];
  const instruction = createAta(config.operator, config.merchant, config.mint);
  assert.equal(canonicalAta(config.merchant, config.mint).toBase58(), expected.toBase58());
  assert.deepEqual(instruction.data, Buffer.from([1]));
  assert.deepEqual(instruction.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [
    [config.operator.toBase58(), true, true], [expected.toBase58(), false, true],
    [config.merchant.toBase58(), false, false], [config.mint.toBase58(), false, false],
    [SystemProgram.programId.toBase58(), false, false], [TOKEN_PROGRAM.toBase58(), false, false],
  ]);
});

test('real JSON loadSigners -> Transaction.sign -> verifySignatures regression', () => {
  const signers = loadSigners(secretEnv(), config, true);
  const transaction = new Transaction({ feePayer: config.operator, recentBlockhash: fixture(8).publicKey.toBase58() });
  transaction.add(SystemProgram.createAccount({ fromPubkey: config.operator, newAccountPubkey: config.mint,
    lamports: 1461600, space: 82, programId: TOKEN_PROGRAM }));
  transaction.add(initializeMint(config.mint, config.operator, config.decimals));
  transaction.sign(...signers);
  assert.equal(transaction.verifySignatures(), true);
  assert.equal(Transaction.from(transaction.serialize()).verifySignatures(), true);
});

test('private parser and config reject env bypasses, duplicate fields and excessive supply/spend', () => {
  const parsed = parsePrivateEnv('# comment\r\nDEVNET_ASSETS_ACK="CUSTOM_DEVNET_TEST_TOKEN_ONLY"\r\n');
  assert.equal(parsed.DEVNET_ASSETS_ACK, 'CUSTOM_DEVNET_TEST_TOKEN_ONLY');
  for (const value of ['MAINNET=1', 'DEVNET_ASSETS_GENESIS_HASH=override', 'export DEVNET_ASSETS_ACK=x',
    'DEVNET_ASSETS_ACK=x\nDEVNET_ASSETS_ACK=x', 'DEVNET_ASSETS_OPERATOR_SECRET_JSON="unterminated']) {
    assert.throws(() => parsePrivateEnv(value), /PRIVATE_ENV_FORMAT/);
  }
  for (const override of [{ DEVNET_ASSETS_DECIMALS: '10' }, { DEVNET_ASSETS_DECIMALS: '06' },
    { DEVNET_ASSETS_SUPPLY_BASE_UNITS: '1000000000001' }, { DEVNET_ASSETS_SUPPLY_BASE_UNITS: '0' },
    { DEVNET_ASSETS_MAX_SETUP_LAMPORTS: '100000001' }, { DEVNET_ASSETS_MERCHANT_MIN_LAMPORTS: '10000001' },
    { DEVNET_ASSETS_ACK: 'REAL_SKR' }, { DEVNET_ASSETS_MINT: env().DEVNET_ASSETS_OPERATOR },
    { DEVNET_ASSETS_EXECUTE: '1' }]) assert.throws(() => readConfig(env(override)));
});

test('HTTPS-only operator RPC: no credentials, redirects, malformed URL or whitespace', () => {
  for (const url of ['http://rpc.invalid', 'https://user:secret@rpc.invalid', 'https://rpc.invalid/#secret',
    'https://rpc.invalid\n', 'file:///private.env', 'not-a-url']) assert.throws(() => httpsRpc(url), /HTTPS_RPC_REQUIRED/);
  assert.equal(httpsRpc('https://rpc.invalid/'), 'https://rpc.invalid/');
});

test('CLI only accepts private-env path plus explicit execute; no secret CLI args', async () => {
  const absolute = new URL('./private.env', import.meta.url);
  const filename = process.platform === 'win32' ? 'C:\\private\\private.env' : '/private/private.env';
  assert.equal(parseArgs(['--private-env', filename]).execute, false);
  assert.equal(parseArgs(['--execute', '--private-env', filename]).execute, true);
  const output = [];
  const result = await main(['--secret', 'PRIVATE_SECRET_SENTINEL'], { stdout: x => output.push(x), stderr: x => output.push(x) });
  assert.equal(result, 1); assert.deepEqual(output, ['CLI_ARGUMENTS_FORBIDDEN']);
  assert.throws(() => parseArgs(['--private-env', filename, '--execute', '--execute']), /CLI_ARGUMENTS_FORBIDDEN/);
  await assert.rejects(readPrivateEnv(absolute.href), /PRIVATE_ENV_PATH/);
  await assert.rejects(readPrivateEnv('relative/private.env'), /PRIVATE_ENV_PATH/);
});

test('default dry-run: no signer loading/send/receipt; absent merchant bounded rent-safe funding', async () => {
  const h = harness();
  const result = await runSetup(config, h.options);
  assert.equal(result.mode, 'dry-run'); assert.equal(h.signLoads(), 0);
  assert.equal(sends(h).length, 0); assert.equal(h.receipts.length, 0);
  assert.equal(h.reports[0].merchantFundingLamports, '1000000');
  assert.equal(h.reports[0].totalLamports, '6550160');
  assert.equal(h.reports[0].COMMERCE_RECIPIENT, config.merchant.toBase58());
  assert.equal(h.reports[0].COMMERCE_SKR_MINT, config.mint.toBase58());
  assert.equal(h.reports[0].COMMERCE_SKR_DECIMALS, '6');
});

for (const genesis of ['5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY', undefined]) {
  test(`non-devnet genesis refuses before state/sign/send (${genesis ?? 'missing'})`, async () => {
    const h = harness({ genesis: [genesis] });
    await assert.rejects(runSetup(config, { ...h.options, execute: true }), /DEVNET_GENESIS_REQUIRED/);
    assert.equal(h.calls.length, 1); assert.equal(h.signLoads(), 0); assert.equal(sends(h).length, 0);
  });
}

test('rechecks exact genesis immediately before signer loading; changing RPC fails closed', async () => {
  const h = harness({ genesis: [DEVNET_GENESIS, 'mainnet'] });
  await assert.rejects(runSetup(config, { ...h.options, execute: true }), /DEVNET_GENESIS_REQUIRED/);
  assert.equal(h.signLoads(), 0); assert.equal(sends(h).length, 0); assert.equal(h.receipts.length, 0);
});

test('classic mint rejects program owner, size, decimals, authority, initialization, freeze and supply', () => {
  verifyMint(mintAccount(), config);
  for (const change of [d => { d[44] = 9; }, d => { d[45] = 0; }, d => { d[45] = 2; },
    d => { d[4] ^= 1; }, d => { d.writeUInt32LE(0, 0); }, d => { d.writeUInt32LE(1, 46); },
    d => { d.writeBigUInt64LE(config.supply + 1n, 36); }]) assert.throws(() => verifyMint(mintAccount(change), config));
  assert.throws(() => verifyMint({ ...mintAccount(), owner: SystemProgram.programId.toBase58() }, config), /INVALID_CLASSIC_MINT/);
  assert.throws(() => verifyMint(account(Buffer.alloc(83), 1461600), config), /INVALID_CLASSIC_MINT/);
});

test('canonical token account rejects owner/mint/program/status/delegate/native/close authority', () => {
  verifyTokenAccount(tokenAccount(config.merchant), config.merchant, config);
  for (const change of [d => { d[0] ^= 1; }, d => { d[32] ^= 1; }, d => { d[108] = 2; }, d => { d[108] = 0; },
    d => { d.writeUInt32LE(1, 72); }, d => { d.writeUInt32LE(1, 109); }, d => { d.writeUInt32LE(1, 129); },
    d => { d.writeBigUInt64LE(1n, 121); }]) {
    assert.throws(() => verifyTokenAccount(tokenAccount(config.merchant, 0n, change), config.merchant, config), /TOKEN_MINT_OWNER_STATUS/);
  }
  assert.throws(() => verifyTokenAccount({ ...tokenAccount(config.merchant), owner: SystemProgram.programId.toBase58() },
    config.merchant, config), /INVALID_CLASSIC_TOKEN_ACCOUNT/);
});

test('invalid existing mint/ATA prevents execution; target supply mismatch refuses remint', async () => {
  for (const accounts of [[mintAccount(d => d.writeBigUInt64LE(config.supply + 1n, 36)), ...prepared().slice(1)],
    [mintAccount(), tokenAccount(config.payer), ...prepared().slice(2)]]) {
    const h = harness({ accounts });
    await assert.rejects(runSetup(config, { ...h.options, execute: true }));
    assert.equal(h.signLoads(), 0); assert.equal(sends(h).length, 0);
  }
});

for (const [index, error] of [[3, 'INSUFFICIENT_OPERATOR_TEST_SOL'], [4, 'INSUFFICIENT_TEST_PAYER_SOL']]) {
  test(`insufficient pre-funded test SOL fails closed: ${error}`, async () => {
    const accounts = fresh(); accounts[index] = wallet(0);
    const h = harness({ accounts });
    await assert.rejects(runSetup(config, { ...h.options, execute: true }), new RegExp(error));
    assert.equal(h.signLoads(), 0); assert.equal(sends(h).length, 0);
    assert.equal(h.calls.some(c => c.method === 'requestAirdrop'), false);
  });
}

test('existing fully prepared mint is no-op: no mint/sign/send even with execute', async () => {
  const h = harness({ accounts: prepared() });
  await runSetup(config, { ...h.options, execute: true });
  assert.equal(h.signLoads(), 0); assert.equal(sends(h).length, 0);
  assert.equal(h.reports[0].status, 'already-prepared-no-mint-no-send');
});

test('existing mint missing merchant ATA creates only ATA, never remints supply or refills funded merchant', async () => {
  const accounts = prepared(); accounts[1] = null;
  const h = harness({ accounts });
  await runSetup(config, { ...h.options, execute: true });
  assert.deepEqual(tags(h.transactions[0]), []);
  assert.equal(h.transactions[0].instructions.length, 1);
  assert.equal(h.transactions[0].instructions[0].programId.toBase58(), ATA_PROGRAM.toBase58());
  assert.equal(h.transactions[0].signatures.length, 1);
});

test('execute signs actual loaded JSON keys once; supply, ATAs and bounded merchant SOL are atomic', async () => {
  const h = harness();
  await runSetup(config, { ...h.options, execute: true });
  assert.equal(sends(h).length, 1); assert.equal(h.signLoads(), 1);
  assert.deepEqual(tags(h.transactions[0]), [20, 14]);
  assert.equal(h.transactions[0].instructions.filter(i => i.programId.equals(ATA_PROGRAM)).length, 2);
  const transfer = h.transactions[0].instructions.find(i => i.programId.equals(SystemProgram.programId) && i.data.readUInt32LE(0) === 2);
  assert.equal(SystemInstruction.decodeTransfer(transfer).lamports, 1000000n);
  assert.equal(SystemInstruction.decodeTransfer(transfer).toPubkey.toBase58(), config.merchant.toBase58());
  assert.equal(h.reports.at(-1).status, 'finalized-and-verified');
  assert.match(h.receipts[0].signature, /^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
  const logs = JSON.stringify([...h.reports, ...h.receipts]);
  assert.equal(logs.includes('PRIVATE_RPC_SENTINEL'), false);
  assert.equal(logs.includes(secretEnv().DEVNET_ASSETS_OPERATOR_SECRET_JSON), false);
  assert.equal(logs.includes(secretEnv().DEVNET_ASSETS_MINT_SECRET_JSON), false);
  assert.equal(logs.includes(sends(h)[0].params[0]), false);
});

test('unknown send records intent first and blocks reexecute even with stale absent-mint state', async () => {
  const h = harness({ sendError: 'UNKNOWN' });
  await assert.rejects(runSetup(config, { ...h.options, execute: true }), /UNKNOWN/);
  assert.equal(sends(h).length, 1); assert.equal(h.receipts.length, 1);
  await assert.rejects(runSetup(config, { ...h.options, execute: true }), /PRIOR_SUBMISSION_INSPECT_NO_RESEND/);
  assert.equal(sends(h).length, 1); assert.equal(h.signLoads(), 1);
});

test('unwritable/exclusive receipt prevents broadcast; execute requires durable guard', async () => {
  const h = harness({ claimError: 'receipt unavailable' });
  await assert.rejects(runSetup(config, { ...h.options, execute: true }), /receipt unavailable/);
  assert.equal(sends(h).length, 0);
  await assert.rejects(runSetup(config, { ...h.options, receiptStore: undefined, execute: true }), /DURABLE_SUBMISSION_RECEIPT_REQUIRED/);
});

test('finalization timeout and expiration are bounded, never resubmit', async () => {
  const h = harness({ finalize: false });
  await assert.rejects(runSetup(config, { ...h.options, execute: true }), /SUBMISSION_UNKNOWN_NO_RETRY/);
  assert.equal(sends(h).length, 1); assert.equal(h.calls.filter(c => c.method === 'getSignatureStatuses').length, 20);
  const expired = harness({ finalize: false, height: 501 });
  await assert.rejects(runSetup(config, { ...expired.options, execute: true }), /SUBMISSION_EXPIRED_INSPECT_SIGNATURE/);
  assert.equal(sends(expired).length, 1);
});

test('no fee, excessive total spend and merchant rent above cap fail closed', async () => {
  for (const [opts, expected] of [[{ fee: null }, 'FEE_UNAVAILABLE'], [{ fee: 100000000 }, 'SETUP_SPEND_CAP'],
    [{ rents: [1461600, 2039280, 10000001] }, 'MERCHANT_TEST_SOL_CAP']]) {
    const h = harness(opts);
    await assert.rejects(runSetup(config, { ...h.options, execute: true }), new RegExp(expected));
    assert.equal(h.signLoads(), 0); assert.equal(sends(h).length, 0);
  }
});

test('malformed/mismatching secrets fail with static safe codes, not JSON bytes or SDK errors', () => {
  assert.throws(() => loadSigners({ ...secretEnv(), DEVNET_ASSETS_OPERATOR_SECRET_JSON: 'PRIVATE_SECRET_SENTINEL' }, config, true),
    { message: 'INVALID_DEDICATED_SECRET' });
  assert.throws(() => loadSigners({ ...secretEnv(), DEVNET_ASSETS_OPERATOR_SECRET_JSON: JSON.stringify([...mint.secretKey]) }, config, true),
    { message: 'SECRET_PUBLIC_KEY_MISMATCH' });
});

test('bounded RPC read retries redact errors; send never retries; redirect forbidden', async () => {
  let attempts = 0;
  const rpc = createRpc({ url: config.rpcUrl, fetchImpl: async (_url, options) => {
    attempts++; assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    throw new Error('PRIVATE_SECRET_SENTINEL PRIVATE_RPC_SENTINEL');
  } });
  await assert.rejects(rpc.call('getGenesisHash'), { message: 'RPC_UNAVAILABLE' });
  assert.equal(attempts, 2);
  await assert.rejects(rpc.call('sendTransaction'), { message: 'SUBMISSION_UNKNOWN_NO_RETRY' });
  assert.equal(attempts, 3);
  await assert.rejects(rpc.call('requestAirdrop'), /RPC_METHOD_FORBIDDEN/); assert.equal(attempts, 3);
});

test('RPC validates envelope and enforces response size cap', async () => {
  for (const body of ['{"jsonrpc":"2.0","id":999,"result":"bad"}', Buffer.alloc(1048577)]) {
    const rpc = createRpc({ url: config.rpcUrl, fetchImpl: async () => new Response(body) });
    await assert.rejects(rpc.call('getGenesisHash'), /RPC_UNAVAILABLE/);
  }
  const good = createRpc({ url: config.rpcUrl, fetchImpl: async (_url, options) => {
    const { id } = JSON.parse(options.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: DEVNET_GENESIS }));
  } });
  assert.equal(await good.call('getGenesisHash'), DEVNET_GENESIS);
});

test('module import and help have no network/filesystem mutation side effects', () => {
  const url = new URL('./devnet-assets.mjs', import.meta.url).href;
  const source = `import http from 'node:http'; import https from 'node:https'; import net from 'node:net';
    const forbidden=()=>{throw new Error('NETWORK_ON_IMPORT')}; globalThis.fetch=forbidden;
    http.request=forbidden; https.request=forbidden; net.connect=forbidden; net.createConnection=forbidden;
    const m=await import(${JSON.stringify(url)}); await m.main(['--help']); console.log('IMPORT_SAFE');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /IMPORT_SAFE/);
  assert.equal(result.stdout.includes('PRIVATE_SECRET_SENTINEL'), false);
});
