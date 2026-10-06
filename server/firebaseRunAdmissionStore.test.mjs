import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFirebaseRunAdmissionStore } from './firebaseRunAdmissionStore.mjs';

const uid = Buffer.from('uid/a').toString('hex');
const run = 'a'.repeat(32);
const paths = [`shadowEntitlements/${uid}`, `shadowRuns/${run}`, `shadowRunRequests/${uid}-${run}`, `shadowRunActive/${uid}`];
function fixture() {
  let data = new Map(), privilege = true;
  const calls = [];
  const firestore = { projectId: 'seeker-test', failSet: false, failCommit: false, getHook: null, setHook: null,
    doc(path) { calls.push(path); return { path }; },
    async runTransaction(callback) {
      const draft = structuredClone(data);
      const result = await callback({
        get: async ref => { if (firestore.getHook) await firestore.getHook();
          return { exists: draft.has(ref.path), data: () => structuredClone(draft.get(ref.path)) }; },
        set: async (ref, value) => { if (firestore.setHook) await firestore.setHook();
          if (firestore.failSet) throw new Error('SDK set failed'); draft.set(ref.path, structuredClone(value)); },
      });
      if (firestore.failCommit) throw new Error('SDK commit failed');
      data = draft; return result;
    },
  };
  const options = { projectId: 'seeker-test', firestore, checkPrivilege: () => { if (!privilege) throw new Error('privilege denied'); } };
  return { firestore, calls, options, store: createFirebaseRunAdmissionStore(options),
    revoke() { privilege = false; }, seed(key, value) { data.set(key, value); }, snapshot: () => structuredClone(data) };
}

test('factory requires explicit privilege, exact SDK project and methods', () => {
  const f = fixture();
  for (const options of [{}, { ...f.options, checkPrivilege: undefined }, { ...f.options, checkPrivilege: () => true },
    { ...f.options, projectId: 'other-test' }, { ...f.options, firestore: {} }, { ...f.options, projectId: '../bad' }]) {
    assert.throws(() => createFirebaseRunAdmissionStore(options));
  }
});

test('canonical paths, identity read-only, shadow writes and isolated copies', async () => {
  const f = fixture(); f.seed(`identityUids/${uid}`, { wallet: 'fixture' });
  await f.store.transaction(async tx => {
    const binding = await tx.get(`identityUids/${uid}`); binding.wallet = 'mutated';
    assert.equal(await tx.get(paths[0]), undefined);
    for (const path of paths) await tx.set(path, { credits: 1, config: { mode: 'waves' } });
  });
  assert.equal(f.snapshot().get(`identityUids/${uid}`).wallet, 'fixture');
  assert.deepEqual(f.calls, [`identityUids/${uid}`, paths[0], ...paths]);
  for (const key of [`identityUids/${uid}`, `identityWallets/${uid}`, `players/${uid}`, `identityRates/${uid}`]) {
    await assert.rejects(f.store.transaction(async tx => { try { await tx.set(key, {}); } catch {} }));
  }
});

test('invalid namespace/key encoding fails closed even if caught', async () => {
  for (const key of ['players/a', 'shadowRuns/abc', `shadowRuns/${run}/extra`, `shadowRuns/${run.toUpperCase()}`,
    'shadowEntitlements/ff', 'shadowEntitlements/61f', 'shadowEntitlements/00', `shadowRunRequests/${uid}`,
    `shadowRunActive/${uid}-${run}`, `identityWallets/${uid}`, `shadowRunRequests/${uid}-${run}-x`, 'a'.repeat(1101)]) {
    const f = fixture();
    await assert.rejects(f.store.transaction(async tx => { try { await tx.get(key); } catch {} }));
    assert.equal(f.snapshot().size, 0);
  }
});

test('runtime project/privilege failures poison swallowed errors after await', async () => {
  for (const mutate of [f => f.revoke(), f => { f.firestore.projectId = 'other-test'; }, f => { f.firestore.doc = null; }]) {
    const f = fixture(); f.firestore.getHook = async () => mutate(f);
    await assert.rejects(f.store.transaction(async tx => { try { await tx.get(paths[0]); } catch {} }));
    assert.equal(f.snapshot().size, 0);
  }
  const f = fixture();
  await assert.rejects(f.store.transaction(async tx => { f.revoke(); try { await tx.set(paths[0], {}); } catch {} }));
});

test('read-after-write/pending operations and escaped handles cannot commit', async () => {
  const f = fixture();
  await assert.rejects(f.store.transaction(async tx => {
    await tx.set(paths[0], { credits: 1 }); try { await tx.get(paths[1]); } catch {}
  }));
  assert.equal(f.snapshot().size, 0);
  let escaped;
  await f.store.transaction(async tx => { escaped = tx; });
  await assert.rejects(escaped.set(paths[0], {}));
  let release; f.firestore.getHook = () => new Promise(resolve => { release = resolve; });
  await assert.rejects(f.store.transaction(async tx => {
    const reading = tx.get(paths[0]);
    try { await tx.set(paths[1], {}); } catch {}
    release(); await assert.rejects(reading);
  }));
});

test('awaited SDK set rejection and commit errors preserve atomic rollback', async () => {
  for (const kind of ['failSet', 'failCommit']) {
    const f = fixture(); f.firestore[kind] = true;
    await assert.rejects(f.store.transaction(async tx => {
      try { await tx.set(paths[0], { credits: 0 }); } catch {}
    }));
    assert.equal(f.snapshot().size, 0);
  }
  const f = fixture(); f.firestore.setHook = async () => f.revoke();
  await assert.rejects(f.store.transaction(async tx => { try { await tx.set(paths[0], {}); } catch {} }));
  assert.equal(f.snapshot().size, 0);
});

test('bounded records and operation budget reject corruption without getters', async () => {
  let getterCalls = 0;
  const getter = {}; Object.defineProperty(getter, 'secret', { enumerable: true, get() { getterCalls++; return 1; } });
  const cycle = {}; cycle.self = cycle;
  const huge = []; huge[4294967294] = 1;
  for (const value of [null, [], new Date(), { bad: NaN }, { bad: -0 }, { bad: '\ud800' },
    { bad: undefined }, getter, cycle, { bad: huge }, { bad: Array(2) },
    { large: 'a'.repeat(8193) }, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [i, 1]))]) {
    const f = fixture();
    await assert.rejects(f.store.transaction(async tx => { try { await tx.set(paths[0], value); } catch {} }));
    const raw = fixture();
    raw.firestore.runTransaction = callback => callback({ get: async () => ({ exists: true, data: () => value }), set() {} });
    await assert.rejects(raw.store.transaction(async tx => { try { await tx.get(paths[0]); } catch {} }));
  }
  // The SDK mock clones snapshots; a raw corrupted SDK snapshot verifies accessor rejection directly.
  const f = fixture(); f.firestore.runTransaction = callback => callback({ get: async () => ({ exists: true, data: () => getter }), set() {} });
  await assert.rejects(f.store.transaction(tx => tx.get(paths[0])));
  assert.equal(getterCalls, 0);
  const g = fixture();
  await assert.rejects(g.store.transaction(async tx => { for (let i = 0; i < 33; i++) { try { await tx.get(paths[0]); } catch {} } }));
  assert.equal(g.calls.length, 32);
});

test('emulator env denied at factory and runtime, including empty values', async () => {
  for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) {
    const old = process.env[key]; const f = fixture();
    try {
      process.env[key] = '';
      assert.throws(() => createFirebaseRunAdmissionStore(f.options));
      await assert.rejects(f.store.transaction(async () => {}));
    } finally { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
  }
});
