import { decodeWallet } from './identity.mjs';

const deny = () => { throw new Error('IDENTITY_ADAPTER_DENIED'); };
const uidValid = uid => typeof uid === 'string' && uid.length > 0 && uid.length <= 128
  && !/[\u0000-\u001f\u007f]/.test(uid) && Buffer.from(uid, 'utf8').toString('utf8') === uid;
const collections = Object.freeze({ challenges: 'identityChallenges', rates: 'identityRates',
  uids: 'identityUids', wallets: 'identityWallets' });

function documentPath(key) {
  if (typeof key !== 'string' || key.length > 1035) deny();
  const match = /^(challenges|rates|uids|wallets)\/([a-f0-9]+)$/.exec(key);
  if (!match || match[2].length % 2) deny();
  const [, kind, encoded] = match;
  const value = Buffer.from(encoded, 'hex').toString('utf8');
  if (Buffer.from(value, 'utf8').toString('hex') !== encoded) deny();
  if (kind === 'challenges') {
    if (!/^[a-f0-9]{64}$/.test(value)) deny();
  } else if (kind === 'wallets') {
    decodeWallet(value);
  } else if (!uidValid(value)) deny();
  return `${collections[kind]}/${encoded}`;
}

export function createFirebaseSdkBridge({ projectId, firebaseAuth, firestore, checkPrivilege } = {}) {
  if (typeof checkPrivilege !== 'function') deny();
  const check = () => { if (checkPrivilege() !== undefined) deny(); };
  check();
  if (typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)
    || typeof firebaseAuth?.verifyIdToken !== 'function' || firebaseAuth.app?.options?.projectId !== projectId
    || typeof firestore?.runTransaction !== 'function' || typeof firestore?.doc !== 'function'
    || firestore.projectId !== projectId) deny();

  const checkProject = () => {
    check();
    if (firebaseAuth.app?.options?.projectId !== projectId || firestore.projectId !== projectId) deny();
  };
  async function authenticateToken(token) {
    checkProject();
    if (typeof token !== 'string' || !token || token.length > 16384) deny();
    const decoded = await firebaseAuth.verifyIdToken(token, true);
    checkProject();
    if (!decoded || !uidValid(decoded.uid) || decoded.sub !== decoded.uid
      || decoded.aud !== projectId || decoded.iss !== `https://securetoken.google.com/${projectId}`) deny();
    return { uid: decoded.uid };
  }

  const store = Object.freeze({
    async transaction(callback) {
      checkProject();
      if (typeof callback !== 'function') deny();
      // Returning runTransaction's promise preserves the SDK commit boundary.
      const committed = await firestore.runTransaction(async sdkTransaction => {
        checkProject();
        if (typeof sdkTransaction?.get !== 'function' || typeof sdkTransaction?.set !== 'function') deny();
        let active = true;
        let wrote = false;
        let reading = 0;
        let failed = false;
        const guard = () => { checkProject(); if (!active || failed) deny(); };
        const tx = Object.freeze({
          async get(key) {
            guard();
            try {
              if (wrote) deny();
              const ref = firestore.doc(documentPath(key));
              reading++;
              try {
                const snap = await sdkTransaction.get(ref);
                guard();
                if (!snap || typeof snap.exists !== 'boolean' || typeof snap.data !== 'function') deny();
                if (!snap.exists) return undefined;
                const data = snap.data();
                if (!data || Object.getPrototypeOf(data) !== Object.prototype) deny();
                return data;
              } finally { reading--; }
            } catch (error) { failed = true; throw error; }
          },
          async set(key, value) {
            guard();
            try {
              if (reading || !value || Object.getPrototypeOf(value) !== Object.prototype) deny();
              const ref = firestore.doc(documentPath(key));
              wrote = true;
              sdkTransaction.set(ref, value);
              guard();
            } catch (error) { failed = true; throw error; }
          },
        });
        try {
          const result = await callback(tx);
          checkProject();
          if (failed || reading) deny();
          checkProject();
          return result;
        } finally { active = false; }
      });
      checkProject();
      return committed;
    },
  });
  return Object.freeze({ authenticateToken, store });
}
