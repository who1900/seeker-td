import { address, encoded, fail, uidValid } from './commerce-common.mjs';

function pathFor(key, write, authority) {
  if (typeof key !== 'string' || key.length > 1100) fail('COMMERCE_STORE');
  const m = /^(identityUids|identityWallets|commerceQuotes|commerceReceipts|commerceSignatures|commerceBalances|commerceLedger|commercePools|authorityRequests|authorityUidQuota|authorityWalletQuota)\/([A-Za-z0-9]+)$/.exec(key);
  if (!m || (write && m[1].startsWith('identity'))) fail('COMMERCE_STORE');
  const [, kind, id] = m;
  if (kind.startsWith('authority') && authority !== true) fail('COMMERCE_STORE');
  if (kind === 'commercePools') { if (!['SOL', 'SKR'].includes(id)) fail('COMMERCE_STORE'); }
  else if (['commerceQuotes', 'commerceReceipts', 'commerceLedger', 'authorityRequests'].includes(kind)) {
    if (!/^[a-f0-9]{32}$/.test(id)) fail('COMMERCE_STORE');
  } else if (kind === 'commerceSignatures') {
    if (!/^[a-f0-9]{64}$/.test(id)) fail('COMMERCE_STORE');
  } else {
    const value = Buffer.from(id, 'hex').toString('utf8');
    if (encoded(value) !== id || !(['identityWallets', 'authorityWalletQuota'].includes(kind) ? address(value) : uidValid(value))) fail('COMMERCE_STORE');
  }
  return key;
}
function copyRecord(value) {
  let nodes = 0, bytes = 0;
  const copy = (v, depth) => {
    if (++nodes > 256 || depth > 8) fail('COMMERCE_STORE');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') { if (!Number.isSafeInteger(v) || Object.is(v, -0)) fail('COMMERCE_STORE'); return v; }
    if (typeof v === 'string') {
      bytes += Buffer.byteLength(v); if (bytes > 16384 || Buffer.from(v).toString('utf8') !== v) fail('COMMERCE_STORE'); return v;
    }
    if (!v || Object.getPrototypeOf(v) !== Object.prototype) fail('COMMERCE_STORE');
    const keys = Reflect.ownKeys(v); if (keys.length > 40) fail('COMMERCE_STORE');
    const result = {};
    for (const key of keys) {
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('COMMERCE_STORE');
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d.enumerable || !Object.hasOwn(d, 'value')) fail('COMMERCE_STORE');
      bytes += Buffer.byteLength(key); if (bytes > 16384) fail('COMMERCE_STORE');
      result[key] = copy(d.value, depth + 1);
    }
    return result;
  };
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail('COMMERCE_STORE');
  return copy(value, 0);
}
export function createCommerceFirestoreStore({ projectId, firestore, checkPrivilege, authority = false }) {
  const check = () => {
    if (typeof authority !== 'boolean' || typeof checkPrivilege !== 'function' || checkPrivilege() !== undefined
      || typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)
      || firestore?.projectId !== projectId || typeof firestore.runTransaction !== 'function'
      || typeof firestore.doc !== 'function') fail('COMMERCE_STORE');
  };
  check();
  return Object.freeze({ async transaction(callback) {
    check(); if (typeof callback !== 'function') fail('COMMERCE_STORE');
    const committed = await firestore.runTransaction(async sdk => {
      check(); if (typeof sdk?.get !== 'function' || typeof sdk?.set !== 'function') fail('COMMERCE_STORE');
      let active = true, poisoned = false, wrote = false, pending = 0, operations = 0;
      const guard = () => { check(); if (!active || poisoned) fail('COMMERCE_STORE'); };
      const tx = Object.freeze({
        async get(key) {
          try {
            guard(); if (wrote || ++operations > 32) fail('COMMERCE_STORE');
            const ref = firestore.doc(pathFor(key, false, authority)); pending++;
            try {
              const snap = await sdk.get(ref); guard();
              if (typeof snap?.exists !== 'boolean' || typeof snap.data !== 'function') fail('COMMERCE_STORE');
              return snap.exists ? copyRecord(snap.data()) : undefined;
            } finally { pending--; }
          } catch (error) { poisoned = true; throw error; }
        },
        async set(key, value) {
          try {
            guard(); if (pending || ++operations > 32) fail('COMMERCE_STORE');
            const ref = firestore.doc(pathFor(key, true, authority)), data = copyRecord(value);
            wrote = true; pending++;
            try { await sdk.set(ref, data); guard(); } finally { pending--; }
          } catch (error) { poisoned = true; throw error; }
        },
      });
      try { const result = await callback(tx); guard(); if (pending) fail('COMMERCE_STORE'); return result; }
      finally { active = false; }
    });
    check(); return committed;
  } });
}
