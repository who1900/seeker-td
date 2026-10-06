import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertDemoEmulator } from './emulatorSafety.mjs';

test('actual Firestore rules deny client writes/private reads and retain public players reads', { timeout: 120000 }, async t => {
  const target = assertDemoEmulator();
  const { initializeTestEnvironment, assertFails, assertSucceeds } = await import('@firebase/rules-unit-testing');
  const { doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc } = await import('firebase/firestore');
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const environment = await initializeTestEnvironment({
    projectId: target.projectId,
    firestore: { host: target.host, port: target.port, rules },
  });
  const clearDemo = async () => {
    assert.deepEqual(assertDemoEmulator(), target);
    await environment.clearFirestore();
  };
  const existing = [
    'players/owner', 'players/other',
    'identityChallenges/owner', 'identityRates/owner', 'identityUids/owner', 'identityWallets/owner',
    'players/owner/private/secret', 'privateTrust/owner', 'identityUids/owner/private/secret',
  ];
  const privateCollections = ['identityChallenges', 'identityRates', 'identityUids', 'identityWallets',
    'players/owner/private', 'privateTrust', 'identityUids/owner/private'];
  try {
    await clearDemo();
    await environment.withSecurityRulesDisabled(async context => {
      const db = context.firestore();
      for (const path of existing) await setDoc(doc(db, path), {
        bestWave: 5, walletAddr: 'fixture-wallet', uid: 'owner', marker: 'existing-demo-fixture',
      });
    });
    for (const [name, context] of [
      ['unauthenticated', environment.unauthenticatedContext()],
      ['authenticated owner', environment.authenticatedContext('owner')],
      ['authenticated other UID', environment.authenticatedContext('other')],
    ]) {
      await t.test(name, async () => {
        const db = context.firestore();
        for (const uid of ['owner', 'other']) {
          const snap = await assertSucceeds(getDoc(doc(db, `players/${uid}`)));
          assert.equal(snap.exists(), true);
          assert.equal(snap.data().bestWave, 5);
        }
        const publicList = await assertSucceeds(getDocs(collection(db, 'players')));
        assert.equal(publicList.size, 2);
        for (const path of existing) {
          await assertFails(updateDoc(doc(db, path), { bestWave: 10000, arbitrary: true }));
          await assertFails(setDoc(doc(db, path), { bestWave: 0, walletAddr: 'replacement' }));
          await assertFails(deleteDoc(doc(db, path)));
        }
        for (const path of ['players/new-player', 'identityChallenges/new', 'identityRates/new',
          'identityUids/new', 'identityWallets/new', 'privateTrust/new', 'players/owner/private/new']) {
          for (const bestWave of [0, 10000]) {
            await assertFails(setDoc(doc(db, path), { bestWave, walletAddr: 'client-value', arbitrary: true }));
          }
        }
        for (const path of existing.filter(path => !/^players\/[^/]+$/.test(path))) {
          await assertFails(getDoc(doc(db, path)));
        }
        for (const path of privateCollections) await assertFails(getDocs(collection(db, path)));
      });
    }
    await environment.withSecurityRulesDisabled(async context => {
      for (const path of existing) {
        const snap = await getDoc(doc(context.firestore(), path));
        assert.equal(snap.exists(), true, 'denied delete must preserve fixture');
        assert.equal(snap.data().bestWave, 5, 'denied writes must preserve fixture');
      }
      assert.equal((await getDoc(doc(context.firestore(), 'players/new-player'))).exists(), false);
    });
  } finally {
    try { await clearDemo(); } finally { await environment.cleanup(); }
  }
});
