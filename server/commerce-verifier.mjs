import { PublicKey } from '@solana/web3.js';
import { encodeBase58 } from './identity.mjs';
import { address, DEVNET_GENESIS, fail, quoteValid, timeValid, uint } from './commerce-common.mjs';

// Protocol identifiers, never merchant wallets, token mints or signing keys.
export const SYSTEM = '11111111111111111111111111111111';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ASSOCIATED = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(value, length) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value) || value.length > 100) fail();
  let n = 0n; for (const c of value) n = n * 58n + BigInt(alphabet.indexOf(c));
  const h = n.toString(16), body = n === 0n ? Buffer.alloc(0) : Buffer.from(h.length % 2 ? `0${h}` : h, 'hex');
  const bytes = Buffer.concat([Buffer.alloc(value.match(/^1*/)[0].length), body]);
  if ((length !== undefined && bytes.length !== length) || encodeBase58(bytes) !== value) fail();
  return bytes;
}
export const signatureValid = value => {
  try { return base58(value, 64).length === 64; } catch { return false; }
};
export function associatedAddress(owner, mint) {
  if (!address(owner) || !address(mint)) fail();
  return PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), new PublicKey(TOKEN).toBuffer(),
    new PublicKey(mint).toBuffer()], new PublicKey(ASSOCIATED))[0].toBase58();
}
const integer = value => {
  if (typeof value === 'number') { if (!Number.isSafeInteger(value) || value < 0) fail(); value = String(value); }
  if (!uint(value)) fail(); return BigInt(value);
};
const accountValid = a => a && a.executable === false && a.owner === TOKEN && a.data?.program === 'spl-token';
export function verifyMintAccount(account, decimals) {
  const p = account?.data?.parsed;
  if (!accountValid(account) || account.space !== 82 || p?.type !== 'mint'
    || p.info?.isInitialized !== true || p.info.decimals !== decimals || p.info.freezeAuthority !== null) fail();
}
export function verifyTokenAccount(account, mint, owner, decimals) {
  const p = account?.data?.parsed, info = p?.info;
  if (!accountValid(account) || account.space !== 165 || p?.type !== 'account' || info?.mint !== mint
    || info.owner !== owner || info.state !== 'initialized' || info.tokenAmount?.decimals !== decimals
    || !uint(info.tokenAmount.amount) || info.isNative !== false) fail();
}
function tokenBalances(meta, keys, q, source, destination) {
  const validate = balances => {
    if (!Array.isArray(balances) || balances.length !== 2) fail();
    const result = new Map();
    for (const b of balances) {
      const key = keys[b.accountIndex]?.pubkey;
      if (!Number.isSafeInteger(b.accountIndex) || ![source, destination].includes(key) || result.has(key)
        || b.programId !== TOKEN || b.mint !== q.mint || b.owner !== (key === source ? q.payer : q.recipient)
        || b.uiTokenAmount?.decimals !== q.decimals || !uint(b.uiTokenAmount.amount)) fail();
      result.set(key, BigInt(b.uiTokenAmount.amount));
    }
    return result;
  };
  const before = validate(meta.preTokenBalances), after = validate(meta.postTokenBalances);
  if (before.get(source) - after.get(source) !== BigInt(q.amount)
    || after.get(destination) - before.get(destination) !== BigInt(q.amount)) fail();
}
export function verifyCommerceTransaction({ quote: q, issuedAt, signature, transaction: result, status }) {
  if (!quoteValid(q) || !timeValid(issuedAt) || issuedAt >= q.expiresAt || !signatureValid(signature)
    || status?.err !== null || status.confirmationStatus !== 'finalized' || status.confirmations !== null
    || !Number.isSafeInteger(result?.slot) || result.slot < 0 || status.slot !== result.slot
    || !Number.isSafeInteger(result.blockTime) || result.blockTime < Math.floor(issuedAt / 1000)
    || result.blockTime * 1000 >= q.expiresAt || result.meta?.err !== null
    || (result.version !== 'legacy' && result.version !== undefined && result.version !== 0)) fail();
  const tx = result.transaction, message = tx?.message, meta = result.meta, keys = message?.accountKeys;
  if (!Array.isArray(tx?.signatures) || tx.signatures.length !== 1 || tx.signatures[0] !== signature
    || !Array.isArray(keys) || keys.length < 3 || keys.length > 16 || keys[0]?.pubkey !== q.payer
    || keys[0].signer !== true || keys[0].writable !== true
    || keys.some((k, i) => !address(k.pubkey) || typeof k.writable !== 'boolean' || k.signer !== (i === 0)
      || (k.source !== undefined && k.source !== 'transaction'))
    || new Set(keys.map(k => k.pubkey)).size !== keys.length
    || (message.addressTableLookups && (!Array.isArray(message.addressTableLookups) || message.addressTableLookups.length !== 0))
    || !Array.isArray(message.instructions) || message.instructions.length < 2 || message.instructions.length > 4
    || (meta.innerInstructions !== null && (!Array.isArray(meta.innerInstructions) || meta.innerInstructions.length !== 0))
    || (meta.rewards != null && (!Array.isArray(meta.rewards) || meta.rewards.length !== 0))
    || (meta.loadedAddresses && (meta.loadedAddresses.writable?.length || meta.loadedAddresses.readonly?.length))) fail();
  let transfers = 0, memos = 0; const computeKinds = new Set();
  const source = q.currency === 'SKR' ? associatedAddress(q.payer, q.mint) : q.payer;
  const destination = q.currency === 'SKR' ? associatedAddress(q.recipient, q.mint) : q.recipient;
  for (const ix of message.instructions) {
    if (ix.programId === MEMO) {
      if (++memos !== 1 || ix.parsed !== q.memo || ix.program !== 'spl-memo') fail();
    } else if (ix.programId === COMPUTE) {
      const data = base58(ix.data);
      if (!Array.isArray(ix.accounts) || ix.accounts.length || ![2, 3].includes(data[0])
        || data.length !== (data[0] === 2 ? 5 : 9) || computeKinds.has(data[0])) fail();
      computeKinds.add(data[0]);
    } else if (q.currency === 'SOL' && ix.programId === SYSTEM) {
      const p = ix.parsed;
      if (++transfers !== 1 || ix.program !== 'system' || p?.type !== 'transfer'
        || p.info?.source !== q.payer || p.info.destination !== q.recipient
        || integer(p.info.lamports) !== BigInt(q.amount)) fail();
    } else if (q.currency === 'SKR' && ix.programId === TOKEN) {
      const p = ix.parsed, info = p?.info;
      if (++transfers !== 1 || ix.program !== 'spl-token' || p?.type !== 'transferChecked'
        || info?.source !== source || info.destination !== destination || info.authority !== q.payer
        || info.mint !== q.mint || info.tokenAmount?.amount !== q.amount || info.tokenAmount.decimals !== q.decimals
        || Object.hasOwn(info, 'multisigAuthority') || Object.hasOwn(info, 'signers')) fail();
    } else fail();
  }
  if (transfers !== 1 || memos !== 1 || !keys.some(k => k.pubkey === destination && k.writable)
    || !keys.some(k => k.pubkey === source && k.writable)
    || keys.some(k => k.writable && ![q.payer, source, destination].includes(k.pubkey))) fail();
  if (!Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances)
    || meta.preBalances.length !== keys.length || meta.postBalances.length !== keys.length) fail();
  const fee = integer(meta.fee);
  for (let i = 0; i < keys.length; i++) {
    const delta = integer(meta.postBalances[i]) - integer(meta.preBalances[i]);
    const expected = keys[i].pubkey === q.payer ? -fee - (q.currency === 'SOL' ? BigInt(q.amount) : 0n)
      : keys[i].pubkey === q.recipient && q.currency === 'SOL' ? BigInt(q.amount) : 0n;
    if (delta !== expected) fail();
  }
  if (q.currency === 'SOL') {
    if (!Array.isArray(meta.preTokenBalances) || meta.preTokenBalances.length
      || !Array.isArray(meta.postTokenBalances) || meta.postTokenBalances.length) fail();
  } else {
    // Historical token metadata is authoritative; later ATA closure must not burn a paid entitlement.
    tokenBalances(meta, keys, q, source, destination);
  }
  return Object.freeze({ slot: result.slot, blockTime: result.blockTime });
}
export function createCommerceVerifier({ rpc, config }) {
  if (typeof rpc?.call !== 'function' || config.cluster !== 'devnet') fail();
  const genesis = config.genesisHash, mint = config.mint, decimals = config.decimals, recipient = config.recipient;
  const network = async () => {
    if (genesis !== DEVNET_GENESIS
      || await rpc.call('getGenesisHash') !== genesis) fail('COMMERCE_NETWORK');
  };
  return Object.freeze({
    async checkCurrency(currency) {
      await network();
      if (currency === 'SKR') {
        const response = await rpc.call('getMultipleAccounts', [[mint, associatedAddress(recipient, mint)],
          { encoding: 'jsonParsed', commitment: 'finalized' }]);
        if (!Number.isSafeInteger(response?.context?.slot) || !Array.isArray(response.value) || response.value.length !== 2) fail();
        verifyMintAccount(response.value[0], decimals);
        verifyTokenAccount(response.value[1], mint, recipient, decimals);
      } else if (currency !== 'SOL') fail();
    },
    async verify(quote, signature, issuedAt) {
      if (!quoteValid(quote) || quote.genesisHash !== genesis || !signatureValid(signature)) fail();
      await network();
      let transaction, statuses;
      try {
        [transaction, statuses] = await Promise.all([
          rpc.call('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]),
          rpc.call('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]),
        ]);
      } catch { fail('COMMERCE_PENDING'); }
      await network();
      const status = Array.isArray(statuses?.value) && statuses.value.length === 1 ? statuses.value[0] : null;
      if (!Number.isSafeInteger(transaction?.slot) || !Number.isSafeInteger(transaction?.blockTime)
        || status?.confirmationStatus !== 'finalized' || status.confirmations !== null
        || status.slot !== transaction.slot) fail('COMMERCE_PENDING');
      // No signed-message journal is persisted server-side yet. Ineligible/failed evidence cannot safely release a client hold.
      try { return verifyCommerceTransaction({ quote, issuedAt, signature, transaction, status }); }
      catch { fail('COMMERCE_PENDING'); }
    },
  });
}
