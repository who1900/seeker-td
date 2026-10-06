import { decodeWallet } from './identity.mjs';

const deny = () => { throw new Error('RUN_STORE_DENIED'); };
const uidValid = value => typeof value === 'string' && value.length > 0 && value.length <= 128
  && !/[\u0000-\u001f\u007f]/.test(value) && Buffer.from(value).toString('utf8') === value;
function pathFor(key, write) {
  if (typeof key !== 'string' || key.length > 1100) deny();
  const match = /^(identityUids|identityWallets|shadowEntitlements|shadowRuns|shadowRunRequests|shadowRunActive)\/([a-f0-9]+)(?:-([a-f0-9]{32}))?$/.exec(key);
  if (!match) deny();
  const [, kind, hex, request] = match;
  if (write && kind.startsWith('identity')) deny();
  if (kind === 'shadowRuns') {
    if (hex.length !== 32 || request !== undefined) deny();
  } else {
    if (hex.length % 2 || (kind === 'shadowRunRequests') !== (request !== undefined)) deny();
    const decoded = Buffer.from(hex, 'hex').toString('utf8');
    if (Buffer.from(decoded).toString('hex') !== hex) deny();
    if (kind === 'identityWallets') { try { decodeWallet(decoded); } catch { deny(); } }
    else if (!uidValid(decoded)) deny();
  }
  return key;
}
function recordCopy(value) {
  let nodes = 0, bytes = 0;
  const copy = (item, depth) => {
    if (++nodes > 256 || depth > 6) deny();
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') { if (!Number.isFinite(item) || Object.is(item, -0)) deny(); return item; }
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item);
      if (bytes > 8192 || Buffer.from(item).toString('utf8') !== item) deny(); return item;
    }
    if (!item || typeof item !== 'object' || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)) deny();
    const array = Array.isArray(item), keys = Reflect.ownKeys(item);
    if (keys.length > 64) deny();
    if (array && (item.length > 63 || keys.length !== item.length + 1
      || keys.some(key => key !== 'length' && (typeof key !== 'string'
        || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)))) deny();
    const result = array ? [] : {};
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || key === '__proto__' || key === 'constructor' || key === 'prototype') deny();
      bytes += Buffer.byteLength(key);
      if (bytes > 8192 || Buffer.from(key).toString('utf8') !== key) deny();
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) deny();
      if (array && !/^(0|[1-9][0-9]*)$/.test(key)) deny();
      result[key] = copy(descriptor.value, depth + 1);
    }
    if (array && result.length !== keys.length - 1) deny();
    return result;
  };
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) deny();
  return copy(value, 0);
}

// Injected privileged SDK only: no SDK initialization, credentials, listener or memory fallback.
export function createFirebaseRunAdmissionSdkBridge({ projectId, firestore, checkPrivilege } = {}) {
  if (typeof checkPrivilege !== 'function') deny();
  const check = () => {
    if (checkPrivilege() !== undefined || typeof projectId !== 'string'
      || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)
      || firestore?.projectId !== projectId || typeof firestore?.doc !== 'function'
      || typeof firestore?.runTransaction !== 'function') deny();
  };
  check();
  return Object.freeze({ async transaction(callback) {
    check(); if (typeof callback !== 'function') deny();
    const committed = await firestore.runTransaction(async sdk => {
      check(); if (typeof sdk?.get !== 'function' || typeof sdk?.set !== 'function') deny();
      let active = true, poisoned = false, wrote = false, pending = 0, operations = 0;
      const guard = () => { check(); if (!active || poisoned) deny(); };
      const tx = Object.freeze({
        async get(key) {
          try {
            guard(); if (wrote || ++operations > 32) deny();
            const ref = firestore.doc(pathFor(key, false)); pending++;
            try {
              const snap = await sdk.get(ref); guard();
              if (!snap || typeof snap.exists !== 'boolean' || typeof snap.data !== 'function') deny();
              return snap.exists ? recordCopy(snap.data()) : undefined;
            } finally { pending--; }
          } catch (error) { poisoned = true; throw error; }
        },
        async set(key, value) {
          try {
            guard(); if (pending || ++operations > 32) deny();
            const ref = firestore.doc(pathFor(key, true)), data = recordCopy(value);
            wrote = true; pending++;
            try { await sdk.set(ref, data); guard(); } finally { pending--; }
          } catch (error) { poisoned = true; throw error; }
        },
      });
      try {
        const result = await callback(tx); guard(); if (pending) deny();
        return result;
      } finally { active = false; }
    });
    check(); return committed;
  } });
}
