import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';

// Operator CLI only. No environment, filesystem or network work at import time.
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const MINT_SIZE = 82;
export const TOKEN_SIZE = 165;
const ACK = 'CUSTOM_DEVNET_TEST_TOKEN_ONLY';
const PUBLIC_FIELDS = ['DEVNET_ASSETS_ACK', 'DEVNET_ASSETS_RPC_URL', 'DEVNET_ASSETS_OPERATOR',
  'DEVNET_ASSETS_MINT', 'DEVNET_ASSETS_MERCHANT', 'DEVNET_ASSETS_TEST_PAYER',
  'DEVNET_ASSETS_DECIMALS', 'DEVNET_ASSETS_SUPPLY_BASE_UNITS', 'DEVNET_ASSETS_RPC_TIMEOUT_MS',
  'DEVNET_ASSETS_MAX_SETUP_LAMPORTS', 'DEVNET_ASSETS_OPERATOR_RESERVE_LAMPORTS',
  'DEVNET_ASSETS_PAYER_MIN_LAMPORTS', 'DEVNET_ASSETS_MERCHANT_MIN_LAMPORTS'];
const SECRET_FIELDS = ['DEVNET_ASSETS_OPERATOR_SECRET_JSON', 'DEVNET_ASSETS_MINT_SECRET_JSON'];
const READ_METHODS = new Set(['getGenesisHash', 'getMultipleAccounts', 'getMinimumBalanceForRentExemption',
  'getLatestBlockhash', 'getFeeForMessage', 'getSignatureStatuses', 'getBlockHeight']);
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

class AssetError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new AssetError(code); };
const check = (condition, code) => { if (!condition) fail(code); };
const safeCode = error => error instanceof AssetError ? error.code : 'DEVNET_ASSETS_FAILED';
const lamports = value => {
  check(Number.isSafeInteger(value) && value >= 0, 'INVALID_LAMPORTS');
  return BigInt(value);
};

export function parsePrivateEnv(text) {
  check(typeof text === 'string' && Buffer.byteLength(text) <= 16384, 'PRIVATE_ENV_FORMAT');
  const env = Object.create(null);
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    check(match && [...PUBLIC_FIELDS, ...SECRET_FIELDS].includes(match[1])
      && !Object.hasOwn(env, match[1]), 'PRIVATE_ENV_FORMAT');
    let value = match[2].trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      check(value.length >= 2 && value.at(-1) === value[0], 'PRIVATE_ENV_FORMAT');
      value = value.slice(1, -1);
    }
    check(!/[\x00-\x1f\x7f]/.test(value), 'PRIVATE_ENV_FORMAT');
    env[match[1]] = value;
  }
  return env;
}

export function httpsRpc(value) {
  let url;
  try { url = new URL(value); } catch { fail('HTTPS_RPC_REQUIRED'); }
  check(typeof value === 'string' && !/[\s\x00-\x1f\x7f]/.test(value)
    && url.protocol === 'https:' && url.hostname && !url.username && !url.password && !url.hash,
  'HTTPS_RPC_REQUIRED');
  return url.href;
}

function publicKey(value) {
  try {
    const key = new PublicKey(value);
    check(typeof value === 'string' && key.toBase58() === value && PublicKey.isOnCurve(key.toBytes()),
      'INVALID_PUBLIC_KEY');
    return key;
  } catch { fail('INVALID_PUBLIC_KEY'); }
}

function integer(env, name, fallback, min, max) {
  const value = env[name] ?? String(fallback);
  check(/^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value))
    && Number(value) >= min && Number(value) <= max, 'INVALID_CONFIG');
  return Number(value);
}

export function readConfig(env) {
  check(env && Object.keys(env).every(k => [...PUBLIC_FIELDS, ...SECRET_FIELDS].includes(k)), 'INVALID_CONFIG');
  check(env.DEVNET_ASSETS_ACK === ACK, 'TEST_TOKEN_ACK_REQUIRED');
  const rpcUrl = httpsRpc(env.DEVNET_ASSETS_RPC_URL);
  const operator = publicKey(env.DEVNET_ASSETS_OPERATOR), mint = publicKey(env.DEVNET_ASSETS_MINT);
  const merchant = publicKey(env.DEVNET_ASSETS_MERCHANT), payer = publicKey(env.DEVNET_ASSETS_TEST_PAYER);
  check(new Set([operator, mint, merchant, payer].map(k => k.toBase58())).size === 4, 'DEDICATED_KEYS_REQUIRED');
  const decimals = integer(env, 'DEVNET_ASSETS_DECIMALS', 6, 0, 9);
  const supplyText = env.DEVNET_ASSETS_SUPPLY_BASE_UNITS;
  check(typeof supplyText === 'string' && /^[1-9]\d{0,18}$/.test(supplyText), 'INVALID_TEST_SUPPLY');
  const supply = BigInt(supplyText);
  check(supply <= 1000000n * 10n ** BigInt(decimals) && supply <= 0xffffffffffffffffn, 'INVALID_TEST_SUPPLY');
  return Object.freeze({ rpcUrl, operator, mint, merchant, payer, decimals, supply,
    timeoutMs: integer(env, 'DEVNET_ASSETS_RPC_TIMEOUT_MS', 8000, 1000, 15000),
    maxSetupLamports: BigInt(integer(env, 'DEVNET_ASSETS_MAX_SETUP_LAMPORTS', 50000000, 1, 100000000)),
    operatorReserve: BigInt(integer(env, 'DEVNET_ASSETS_OPERATOR_RESERVE_LAMPORTS', 1000000, 1000000, 100000000)),
    payerMinimum: BigInt(integer(env, 'DEVNET_ASSETS_PAYER_MIN_LAMPORTS', 10000000, 1000000, 100000000)),
    merchantMinimum: BigInt(integer(env, 'DEVNET_ASSETS_MERCHANT_MIN_LAMPORTS', 1000000, 1000000, 10000000)),
  });
}

function within(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function windowsPrivateAcl(filename) {
  // Only the current Windows SID and SYSTEM may have read/write access; inheritance must be off.
  const literal = filename.replaceAll("'", "''");
  const script = `$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath '${literal}'; `
    + '$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; '
    + '$owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; '
    + 'if ($owner -ne $sid -or -not $a.AreAccessRulesProtected) { exit 1 }; '
    + '$rules=$a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]); '
    + 'foreach($r in $rules) { if ($r.AccessControlType -eq "Allow" '
    + '-and $r.IdentityReference.Value -notin @($sid,"S-1-5-18") '
    + '-and ([int]$r.FileSystemRights -band 2032127) -ne 0) { exit 1 } }; exit 0';
  try {
    execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { stdio: 'ignore', timeout: 5000, windowsHide: true });
  } catch { fail('PRIVATE_ENV_PERMISSIONS'); }
}

export async function readPrivateEnv(filename) {
  try {
    check(typeof filename === 'string' && path.isAbsolute(filename)
      && path.basename(filename) === 'private.env', 'PRIVATE_ENV_PATH');
    check(!(await lstat(filename)).isSymbolicLink(), 'PRIVATE_ENV_PATH');
    const resolved = await realpath(filename);
    const project = await realpath(fileURLToPath(new URL('../', import.meta.url)));
    check(!within(resolved, project), 'PRIVATE_ENV_OUTSIDE_REPO_REQUIRED');
    // Also reject other Git repositories, including worktrees (.git may be a file).
    for (let folder = path.dirname(resolved);;) {
      let inRepo = false;
      try { await lstat(path.join(folder, '.git')); inRepo = true; }
      catch (error) { if (error.code !== 'ENOENT') fail('PRIVATE_ENV_PATH'); }
      check(!inRepo, 'PRIVATE_ENV_OUTSIDE_REPO_REQUIRED');
      const parent = path.dirname(folder);
      if (parent === folder) break;
      folder = parent;
    }
    const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat(), parentInfo = await stat(path.dirname(resolved));
      check(info.isFile() && info.size <= 16384, 'PRIVATE_ENV_FORMAT');
      if (process.platform === 'win32') {
        windowsPrivateAcl(resolved);
        windowsPrivateAcl(path.dirname(resolved));
      } else {
        check(info.uid === process.getuid() && (info.mode & 0o077) === 0
          && parentInfo.uid === process.getuid() && (parentInfo.mode & 0o077) === 0, 'PRIVATE_ENV_PERMISSIONS');
      }
      return parsePrivateEnv(await handle.readFile('utf8'));
    } finally { await handle.close(); }
  } catch (error) { fail(error instanceof AssetError ? error.code : 'PRIVATE_ENV_UNREADABLE'); }
}

export function loadSigners(env, config, needsMint) {
  function keypair(name, expected) {
    let bytes;
    try {
      const values = JSON.parse(env[name]);
      check(Array.isArray(values) && values.length === 64
        && values.every(n => Number.isInteger(n) && n >= 0 && n <= 255), 'INVALID_DEDICATED_SECRET');
      bytes = Uint8Array.from(values);
      // SDK retains its input: clear the parser buffer, not the SDK-owned independent copy.
      const key = Keypair.fromSecretKey(bytes.slice());
      check(key.publicKey.equals(expected), 'SECRET_PUBLIC_KEY_MISMATCH');
      return key;
    } catch (error) { fail(error instanceof AssetError ? error.code : 'INVALID_DEDICATED_SECRET'); }
    finally { bytes?.fill(0); }
  }
  const signers = [keypair('DEVNET_ASSETS_OPERATOR_SECRET_JSON', config.operator)];
  if (needsMint) signers.push(keypair('DEVNET_ASSETS_MINT_SECRET_JSON', config.mint));
  return signers;
}

function receiptBinding(config) {
  return JSON.stringify([DEVNET_GENESIS, config.operator.toBase58(), config.mint.toBase58(),
    config.merchant.toBase58(), config.payer.toBase58(), config.decimals, config.supply.toString(),
    config.merchantMinimum.toString()]);
}

// Durable intent, not a retry queue. Only public identifiers; never a raw transaction or key.
export function createReceiptStore(privateEnvPath) {
  const filename = `${privateEnvPath}.devnet-assets.receipt.json`;
  return Object.freeze({
    async read() {
      try {
        const info = await lstat(filename);
        check(info.isFile() && !info.isSymbolicLink() && info.size <= 4096, 'INVALID_SUBMISSION_RECEIPT');
        const receipt = JSON.parse(await readFile(filename, 'utf8'));
        check(receipt?.version === 1 && typeof receipt.binding === 'string'
          && typeof receipt.signature === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(receipt.signature),
        'INVALID_SUBMISSION_RECEIPT');
        return receipt;
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        fail('INVALID_SUBMISSION_RECEIPT');
      }
    },
    async claim(receipt) {
      let handle;
      try {
        handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
          | (constants.O_NOFOLLOW ?? 0), 0o600);
        await handle.writeFile(JSON.stringify(receipt), 'utf8');
        await handle.sync();
        if (process.platform !== 'win32') {
          const directory = await open(path.dirname(filename), constants.O_RDONLY);
          try { await directory.sync(); } finally { await directory.close(); }
        }
      } catch { fail('SUBMISSION_RECEIPT_EXISTS_OR_UNWRITABLE_NO_SEND'); }
      finally { await handle?.close(); }
    },
  });
}

export function canonicalAta(owner, mint) {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}

// Layouts verified against solana-program/token/interface and associated-token-account/interface.
export function initializeMint(mint, authority, decimals) {
  const data = Buffer.alloc(35);
  data[0] = 20; data[1] = decimals; authority.toBuffer().copy(data, 2);
  data[34] = 0; // Instruction COption<Pubkey>::None is ONE byte, unlike account-state COption.
  return new TransactionInstruction({ programId: TOKEN_PROGRAM,
    keys: [{ pubkey: mint, isSigner: false, isWritable: true }], data });
}

export function createAta(funder, owner, mint) {
  return new TransactionInstruction({ programId: ATA_PROGRAM, data: Buffer.from([1]), keys: [
    { pubkey: funder, isSigner: true, isWritable: true },
    { pubkey: canonicalAta(owner, mint), isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
  ] });
}

export function mintToChecked(mint, destination, authority, amount, decimals) {
  check(typeof amount === 'bigint' && amount > 0n && amount <= 0xffffffffffffffffn, 'INVALID_TEST_SUPPLY');
  const data = Buffer.alloc(10);
  data[0] = 14; data.writeBigUInt64LE(amount, 1); data[9] = decimals;
  return new TransactionInstruction({ programId: TOKEN_PROGRAM, data, keys: [
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: destination, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: false },
  ] });
}

function classicData(account, size, code) {
  check(account && account.owner === TOKEN_PROGRAM.toBase58() && account.executable === false
    && Array.isArray(account.data) && account.data.length === 2 && account.data[1] === 'base64'
    && typeof account.data[0] === 'string', code);
  const data = Buffer.from(account.data[0], 'base64');
  check(data.length === size && data.toString('base64') === account.data[0], code);
  lamports(account.lamports);
  return data;
}

export function verifyMint(account, config) {
  const data = classicData(account, MINT_SIZE, 'INVALID_CLASSIC_MINT');
  check(data.readUInt32LE(0) === 1 && data.subarray(4, 36).equals(config.operator.toBuffer())
    && data[44] === config.decimals && data[45] === 1 && data.readUInt32LE(46) === 0,
  'MINT_AUTHORITY_DECIMALS_STATUS');
  // Never top up an existing mint: exact fixed initial test supply is a rerun/recovery invariant.
  check(data.readBigUInt64LE(36) === config.supply, 'TEST_SUPPLY_MISMATCH');
}

export function verifyTokenAccount(account, owner, config) {
  const data = classicData(account, TOKEN_SIZE, 'INVALID_CLASSIC_TOKEN_ACCOUNT');
  check(data.subarray(0, 32).equals(config.mint.toBuffer()) && data.subarray(32, 64).equals(owner.toBuffer())
    && data[108] === 1 && data.readUInt32LE(72) === 0 && data.readUInt32LE(109) === 0
    && data.readBigUInt64LE(121) === 0n && data.readUInt32LE(129) === 0,
  'TOKEN_MINT_OWNER_STATUS');
  check(data.readBigUInt64LE(64) <= config.supply, 'TOKEN_AMOUNT_RANGE');
}

function walletBalance(account, required) {
  if (account === null && !required) return 0n;
  check(account && account.owner === SystemProgram.programId.toBase58() && account.executable === false
    && Array.isArray(account.data) && account.data[0] === '' && account.data[1] === 'base64', 'INVALID_SYSTEM_WALLET');
  return lamports(account.lamports);
}

export function createRpc({ url, timeoutMs = 8000, fetchImpl = globalThis.fetch } = {}) {
  const target = httpsRpc(url);
  check(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 15000, 'INVALID_RPC_TIMEOUT');
  let sequence = 0;
  return Object.freeze({ async call(method, params = []) {
    check(READ_METHODS.has(method) || method === 'sendTransaction', 'RPC_METHOD_FORBIDDEN');
    const attempts = READ_METHODS.has(method) ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const id = ++sequence;
        const response = await fetchImpl(target, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
        check(response.ok && response.body, 'RPC_UNAVAILABLE');
        const reader = response.body.getReader(), chunks = [];
        let size = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            check(size <= 1048576, 'RPC_UNAVAILABLE');
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        check(result?.jsonrpc === '2.0' && result.id === id && !Object.hasOwn(result, 'error')
          && Object.hasOwn(result, 'result'), 'RPC_UNAVAILABLE');
        return result.result;
      } catch {
        controller.abort();
        if (attempt + 1 === attempts) fail(method === 'sendTransaction' ? 'SUBMISSION_UNKNOWN_NO_RETRY' : 'RPC_UNAVAILABLE');
      } finally { clearTimeout(timer); }
    }
  } });
}

const assertDevnet = async rpc => check(await rpc.call('getGenesisHash') === DEVNET_GENESIS, 'DEVNET_GENESIS_REQUIRED');

async function snapshot(rpc, config) {
  const merchantAta = canonicalAta(config.merchant, config.mint), payerAta = canonicalAta(config.payer, config.mint);
  const keys = [config.mint, merchantAta, payerAta, config.operator, config.payer, config.merchant];
  const result = await rpc.call('getMultipleAccounts', [keys.map(k => k.toBase58()), { encoding: 'base64', commitment: 'finalized' }]);
  check(Number.isSafeInteger(result?.context?.slot) && result.context.slot >= 0
    && Array.isArray(result.value) && result.value.length === keys.length, 'INVALID_RPC_ACCOUNTS');
  const [mint, merchant, payer, operatorWallet, payerWallet, merchantWallet] = result.value;
  if (mint !== null) verifyMint(mint, config);
  if (merchant !== null) verifyTokenAccount(merchant, config.merchant, config);
  if (payer !== null) verifyTokenAccount(payer, config.payer, config);
  check(mint !== null || (merchant === null && payer === null), 'ORPHAN_TOKEN_ACCOUNTS');
  const operatorSol = walletBalance(operatorWallet, true), payerSol = walletBalance(payerWallet, true);
  const merchantSol = walletBalance(merchantWallet, false);
  if (merchant && payer) {
    const balances = [merchant, payer].map(a => Buffer.from(a.data[0], 'base64').readBigUInt64LE(64));
    check(balances[0] + balances[1] <= config.supply, 'TOKEN_AMOUNT_RANGE');
  }
  check(payerSol >= config.payerMinimum, 'INSUFFICIENT_TEST_PAYER_SOL');
  return { mint, merchant, payer, operatorSol, merchantSol, merchantAta, payerAta, slot: result.context.slot };
}

function base58(bytes) {
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex')}`), output = '';
  while (value > 0n) { output = ALPHABET[Number(value % 58n)] + output; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; output = '1' + output; }
  return output;
}

async function confirmOnce(rpc, signature, blockHeight, pause) {
  for (let poll = 0; poll < 20; poll++) {
    const result = await rpc.call('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
    check(Array.isArray(result?.value) && result.value.length === 1, 'SUBMISSION_UNKNOWN_NO_RETRY');
    const status = result.value[0];
    if (status) {
      check(status.err === null, 'SETUP_TRANSACTION_FAILED');
      if (status.confirmationStatus === 'finalized') return;
    }
    const height = await rpc.call('getBlockHeight', [{ commitment: 'finalized' }]);
    check(Number.isSafeInteger(height) && height >= 0, 'SUBMISSION_UNKNOWN_NO_RETRY');
    check(height <= blockHeight, 'SUBMISSION_EXPIRED_INSPECT_SIGNATURE');
    if (poll < 19) await pause(1000);
  }
  fail('SUBMISSION_UNKNOWN_NO_RETRY');
}

export async function runSetup(config, { execute = false, rpc, signerLoader, receiptStore,
  report = () => {}, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  // No environment variable can replace this genesis or enable execution.
  httpsRpc(config.rpcUrl);
  check(typeof execute === 'boolean', 'INVALID_EXECUTE_FLAG');
  await assertDevnet(rpc);
  const state = await snapshot(rpc, config);
  const actions = [];
  const transaction = new Transaction();
  let rent = 0n;
  const mintRent = lamports(await rpc.call('getMinimumBalanceForRentExemption', [MINT_SIZE, { commitment: 'finalized' }]));
  const tokenRent = lamports(await rpc.call('getMinimumBalanceForRentExemption', [TOKEN_SIZE, { commitment: 'finalized' }]));
  const walletRent = lamports(await rpc.call('getMinimumBalanceForRentExemption', [0, { commitment: 'finalized' }]));
  const merchantTarget = config.merchantMinimum > walletRent ? config.merchantMinimum : walletRent;
  check(merchantTarget <= 10000000n, 'MERCHANT_TEST_SOL_CAP');
  if (state.mint) check(lamports(state.mint.lamports) >= mintRent, 'MINT_NOT_RENT_EXEMPT');
  for (const account of [state.merchant, state.payer]) {
    if (account) check(lamports(account.lamports) >= tokenRent, 'TOKEN_NOT_RENT_EXEMPT');
  }
  if (state.mint === null) {
    check(mintRent > 0n && mintRent <= config.maxSetupLamports, 'SETUP_SPEND_CAP');
    transaction.add(SystemProgram.createAccount({ fromPubkey: config.operator, newAccountPubkey: config.mint,
      lamports: Number(mintRent), space: MINT_SIZE, programId: TOKEN_PROGRAM }));
    transaction.add(initializeMint(config.mint, config.operator, config.decimals));
    rent += mintRent; actions.push('create-classic-test-mint');
  }
  for (const [account, owner, action] of [[state.merchant, config.merchant, 'preprovision-merchant-ata'],
    [state.payer, config.payer, 'create-dedicated-test-payer-ata']]) {
    if (account === null) {
      check(tokenRent > 0n, 'INVALID_RENT');
      transaction.add(createAta(config.operator, owner, config.mint));
      rent += tokenRent; actions.push(action);
    }
  }
  if (state.mint === null) {
    transaction.add(mintToChecked(config.mint, state.payerAta, config.operator, config.supply, config.decimals));
    actions.push('mint-initial-test-supply-once');
  }
  const merchantFunding = state.merchantSol < merchantTarget ? merchantTarget - state.merchantSol : 0n;
  if (merchantFunding) {
    transaction.add(SystemProgram.transfer({ fromPubkey: config.operator, toPubkey: config.merchant,
      lamports: merchantFunding }));
    actions.push('preprovision-merchant-test-sol');
  }
  const output = { mode: execute ? 'execute-devnet' : 'dry-run', token: 'CUSTOM_TEST_TOKEN_NOT_REAL_SKR',
    cluster: 'devnet', genesisHash: DEVNET_GENESIS, mint: config.mint.toBase58(), decimals: config.decimals,
    initialSupplyBaseUnits: config.supply.toString(), merchant: config.merchant.toBase58(),
    merchantAta: state.merchantAta.toBase58(), testPayer: config.payer.toBase58(),
    testPayerAta: state.payerAta.toBase58(), mintAuthority: config.operator.toBase58(), freezeAuthority: null,
    COMMERCE_RECIPIENT: config.merchant.toBase58(), COMMERCE_SKR_MINT: config.mint.toBase58(),
    COMMERCE_SKR_DECIMALS: String(config.decimals), actions };
  if (!actions.length) { report({ ...output, status: 'already-prepared-no-mint-no-send' }); return output; }
  if (execute) {
    check(receiptStore && typeof receiptStore.read === 'function' && typeof receiptStore.claim === 'function',
      'DURABLE_SUBMISSION_RECEIPT_REQUIRED');
    const prior = await receiptStore.read();
    if (prior) {
      check(prior.binding === receiptBinding(config), 'SUBMISSION_RECEIPT_CONFIG_MISMATCH');
      report({ status: 'prior-submission-inspect-no-resend', signature: prior.signature });
      fail('PRIOR_SUBMISSION_INSPECT_NO_RESEND');
    }
  }
  const latest = await rpc.call('getLatestBlockhash', [{ commitment: 'finalized', minContextSlot: state.slot }]);
  check(latest?.value && typeof latest.value.blockhash === 'string'
    && Number.isSafeInteger(latest.value.lastValidBlockHeight) && latest.value.lastValidBlockHeight >= 0, 'INVALID_BLOCKHASH');
  try { check(new PublicKey(latest.value.blockhash).toBase58() === latest.value.blockhash, 'INVALID_BLOCKHASH'); }
  catch { fail('INVALID_BLOCKHASH'); }
  transaction.feePayer = config.operator; transaction.recentBlockhash = latest.value.blockhash;
  const feeResult = await rpc.call('getFeeForMessage', [transaction.compileMessage().serialize().toString('base64'),
    { commitment: 'finalized', minContextSlot: state.slot }]);
  check(feeResult?.value !== null, 'FEE_UNAVAILABLE');
  const fee = lamports(feeResult?.value), total = rent + fee + merchantFunding;
  check(total <= config.maxSetupLamports, 'SETUP_SPEND_CAP');
  check(state.operatorSol >= total + config.operatorReserve, 'INSUFFICIENT_OPERATOR_TEST_SOL');
  report({ ...output, rentLamports: rent.toString(), feeLamports: fee.toString(),
    merchantFundingLamports: merchantFunding.toString(), totalLamports: total.toString() });
  if (!execute) return output;

  // Recheck immediately before loading dedicated secrets and signing. The signed transaction is never logged.
  await assertDevnet(rpc);
  check(typeof signerLoader === 'function', 'DEDICATED_SECRETS_REQUIRED');
  const signers = signerLoader(state.mint === null);
  try {
    check(Array.isArray(signers) && signers.length === (state.mint === null ? 2 : 1)
      && signers[0]?.publicKey.equals(config.operator)
      && (state.mint !== null || signers[1]?.publicKey.equals(config.mint)), 'SECRET_PUBLIC_KEY_MISMATCH');
    transaction.sign(...signers);
    const raw = transaction.serialize(), signature = base58(transaction.signature);
    // Exclusive/fsynced claim precedes broadcast; ambiguity can never trigger an automatic resend.
    await receiptStore.claim({ version: 1, binding: receiptBinding(config), signature });
    // Public receipt before submission lets operators investigate an unknown result without resending.
    report({ status: 'submitting-once-devnet', signature });
    let returned;
    try {
      returned = await rpc.call('sendTransaction', [raw.toString('base64'), { encoding: 'base64',
        skipPreflight: false, preflightCommitment: 'finalized', maxRetries: 0, minContextSlot: state.slot }]);
    } finally { raw.fill(0); }
    check(returned === signature, 'SUBMISSION_UNKNOWN_NO_RETRY');
    await confirmOnce(rpc, signature, latest.value.lastValidBlockHeight, pause);
    await assertDevnet(rpc);
    const verified = await snapshot(rpc, config);
    check(verified.mint !== null && verified.merchant !== null && verified.payer !== null, 'POST_SETUP_VERIFICATION_FAILED');
    verifyMint(verified.mint, config);
    verifyTokenAccount(verified.merchant, config.merchant, config);
    verifyTokenAccount(verified.payer, config.payer, config);
    check(verified.merchantSol >= merchantTarget && lamports(verified.mint.lamports) >= mintRent
      && lamports(verified.merchant.lamports) >= tokenRent && lamports(verified.payer.lamports) >= tokenRent,
    'POST_SETUP_VERIFICATION_FAILED');
    report({ ...output, status: 'finalized-and-verified', signature });
    return output;
  } finally {
    // Best effort only: SDK getters and JS strings may retain independent copies until process exit.
    for (const signer of signers ?? []) signer.secretKey?.fill(0);
  }
}

export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  let execute = false, privateEnv;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--execute' && !execute) execute = true;
    else if (args[index] === '--private-env' && privateEnv === undefined && args[index + 1]) privateEnv = args[++index];
    else fail('CLI_ARGUMENTS_FORBIDDEN');
  }
  check(typeof privateEnv === 'string' && path.isAbsolute(privateEnv) && path.basename(privateEnv) === 'private.env', 'PRIVATE_ENV_PATH');
  return { execute, privateEnv };
}

export async function main(args = process.argv.slice(2), { stdout = console.log, stderr = console.error } = {}) {
  let env;
  try {
    const options = parseArgs(args);
    if (options.help) {
      stdout('Operator-only custom test token (NOT real SKR). --private-env ABSOLUTE_PATH/private.env [--execute]. Default: dry-run.');
      return 0;
    }
    check(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'TLS_VERIFICATION_REQUIRED');
    env = await readPrivateEnv(options.privateEnv);
    const config = readConfig(env), rpc = createRpc({ url: config.rpcUrl, timeoutMs: config.timeoutMs });
    await runSetup(config, { execute: options.execute, rpc,
      receiptStore: createReceiptStore(await realpath(options.privateEnv)),
      signerLoader: needsMint => {
        try { return loadSigners(env, config, needsMint); }
        finally { for (const name of SECRET_FIELDS) delete env[name]; }
      }, report: item => stdout(JSON.stringify(item)) });
    return 0;
  } catch (error) {
    stderr(safeCode(error));
    return 1;
  } finally {
    if (env) for (const name of SECRET_FIELDS) delete env[name];
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
