import { createPublicKey, randomBytes, verify } from 'node:crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const TTL = 300_000;
const PURPOSE = 'SEEKER:TD/wallet-identity/v1';
const deny = () => { throw new Error('IDENTITY_DENIED'); };
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uidValid = uid => typeof uid === 'string' && uid.length > 0 && uid.length <= 128 && !/[\u0000-\u001f\u007f]/.test(uid);
const keyFor = (kind, value) => `${kind}/${Buffer.from(value).toString('hex')}`;

export function encodeBase58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  let result = '';
  while (n > 0n) { result = ALPHABET[Number(n % 58n)] + result; n /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; result = '1' + result; }
  return result;
}

export function decodeWallet(wallet) {
  if (typeof wallet !== 'string' || wallet.length < 32 || wallet.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(wallet)) deny();
  let n = 0n;
  for (const char of wallet) n = n * 58n + BigInt(ALPHABET.indexOf(char));
  const hex = n.toString(16);
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  const zeroes = wallet.match(/^1*/)[0].length;
  const bytes = Buffer.concat([Buffer.alloc(zeroes), body]);
  if (bytes.length !== 32 || encodeBase58(bytes) !== wallet) deny();
  return bytes;
}

function decodeSignature(signature) {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) deny();
  const bytes = Buffer.from(signature, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== signature) deny();
  return bytes;
}

function canonicalMessage(config, record) {
  return JSON.stringify({ audience: config.audience, origin: config.origin, purpose: PURPOSE,
    uid: record.uid, wallet: record.wallet, cluster: config.cluster, nonce: record.nonce,
    issuedAt: record.issuedAt, expiresAt: record.expiresAt });
}

export function createIdentityService({ authenticateToken, store, config, now = Date.now } = {}) {
  if (typeof authenticateToken !== 'function' || typeof store?.transaction !== 'function' || typeof now !== 'function'
    || !exact(config, ['audience', 'origin', 'cluster']) || typeof config.audience !== 'string'
    || !/^[\x21-\x7e]{1,200}$/.test(config.audience) || !['devnet', 'testnet'].includes(config.cluster)) deny();
  if (typeof config.origin !== 'string' || config.origin.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(config.origin)) deny();
  let origin;
  try { origin = new URL(config.origin); } catch { deny(); }
  if (typeof config.origin !== 'string' || origin.protocol !== 'https:' || origin.origin !== config.origin
    || origin.username || origin.password) deny();
  const trusted = Object.freeze({ ...config });
  const clock = () => {
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0 || time > Number.MAX_SAFE_INTEGER - TTL) deny();
    return time;
  };
  async function auth(token) {
    if (typeof token !== 'string' || !token || token.length > 16384) deny();
    const verified = await authenticateToken(token);
    if (!uidValid(verified?.uid)) deny();
    return verified.uid;
  }
  function transaction(action) {
    return store.transaction(async tx => {
      if (typeof tx?.get !== 'function' || typeof tx?.set !== 'function') deny();
      return action(tx);
    });
  }
  return Object.freeze({
    async issueChallenge(token, body) {
      if (!exact(body, ['wallet'])) deny();
      const wallet = body.wallet;
      decodeWallet(wallet);
      const uid = await auth(token);
      const nonce = randomBytes(32).toString('hex');
      return transaction(async tx => {
        const time = clock();
        const challengeKey = keyFor('challenges', nonce);
        const rateKey = keyFor('rates', uid);
        const [rate, collision, bound, owner] = await Promise.all([
          tx.get(rateKey), tx.get(challengeKey), tx.get(keyFor('uids', uid)), tx.get(keyFor('wallets', wallet)),
        ]);
        if (collision != null || (bound != null && (!exact(bound, ['wallet']) || bound.wallet !== wallet))
          || (owner != null && (!exact(owner, ['uid']) || owner.uid !== uid))) deny();
        let times = [];
        if (rate != null) {
          if (!exact(rate, ['times']) || !Array.isArray(rate.times) || rate.times.length > 5
            || rate.times.some(t => !Number.isSafeInteger(t) || t < 0 || t > time)) deny();
          times = rate.times.filter(t => time - t < 60_000);
        }
        if (times.length >= 5) deny();
        const record = { uid, wallet, nonce, issuedAt: time, expiresAt: time + TTL, consumed: false };
        record.message = canonicalMessage(trusted, record);
        await tx.set(rateKey, { times: [...times, time] });
        await tx.set(challengeKey, record);
        return { challengeId: nonce, message: record.message, expiresAt: record.expiresAt };
      });
    },
    async complete(token, body) {
      if (!exact(body, ['challengeId', 'signature']) || typeof body.challengeId !== 'string'
        || !/^[a-f0-9]{64}$/.test(body.challengeId)) deny();
      const signature = decodeSignature(body.signature);
      const challengeId = body.challengeId;
      const uid = await auth(token);
      return transaction(async tx => {
        const challengeKey = keyFor('challenges', challengeId);
        const record = await tx.get(challengeKey);
        const time = clock();
        if (!exact(record, ['uid', 'wallet', 'nonce', 'issuedAt', 'expiresAt', 'consumed', 'message'])
          || record.uid !== uid || record.nonce !== challengeId || record.consumed !== false
          || !Number.isSafeInteger(record.issuedAt) || record.issuedAt < 0 || record.issuedAt > time
          || !Number.isSafeInteger(record.expiresAt) || record.expiresAt !== record.issuedAt + TTL
          || time >= record.expiresAt || record.message !== canonicalMessage(trusted, record)) deny();
        const bytes = decodeWallet(record.wallet);
        const publicKey = createPublicKey({ key: Buffer.concat([
          Buffer.from('302a300506032b6570032100', 'hex'), bytes,
        ]), format: 'der', type: 'spki' });
        if (!verify(null, Buffer.from(record.message, 'utf8'), publicKey, signature)) deny();
        const uidKey = keyFor('uids', uid);
        const walletKey = keyFor('wallets', record.wallet);
        const [bound, owner] = await Promise.all([tx.get(uidKey), tx.get(walletKey)]);
        if ((bound != null && (!exact(bound, ['wallet']) || bound.wallet !== record.wallet))
          || (owner != null && (!exact(owner, ['uid']) || owner.uid !== uid))) deny();
        const commitAttemptTime = clock();
        if (commitAttemptTime < record.issuedAt || commitAttemptTime >= record.expiresAt) deny();
        await tx.set(challengeKey, { ...record, consumed: true });
        await tx.set(uidKey, { wallet: record.wallet });
        await tx.set(walletKey, { uid });
        return { uid, wallet: record.wallet, cluster: trusted.cluster };
      });
    },
  });
}
