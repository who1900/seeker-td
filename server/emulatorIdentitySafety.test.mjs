import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertIdentityEmulators } from './emulatorIdentitySafety.mjs';
import { createFirebaseSdkBridge } from './firebaseSdkBridge.mjs';

const env = { GCLOUD_PROJECT: 'demo-seeker-td', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8089',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' };
test('identity test-only construction requires exact demo/loopback and rejects credential config', () => {
  assert.equal(assertIdentityEmulators(env).projectId, 'demo-seeker-td');
  for (const key of Object.keys(env)) {
    assert.throws(() => assertIdentityEmulators({ ...env, [key]: '' }));
    assert.throws(() => assertIdentityEmulators({ ...env, [key]: 'production.example:443' }));
  }
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CONFIG']) {
    assert.throws(() => assertIdentityEmulators({ ...env, [key]: '' }));
  }
  assert.throws(() => assertIdentityEmulators({ ...env, GOOGLE_CLOUD_PROJECT: 'other-project' }));
  assert.equal(assertIdentityEmulators({ ...env, METADATA_SERVER_DETECTION: 'none' }).projectId, 'demo-seeker-td');
  assert.throws(() => assertIdentityEmulators({ ...env, METADATA_SERVER_DETECTION: 'assume-present' }), /METADATA_SERVER_DETECTION/);
});

test('only canonical CLI demo FIREBASE_CONFIG allowed; diagnostics contain field names, not values', () => {
  const cli = { projectId: 'demo-seeker-td', storageBucket: 'demo-seeker-td.appspot.com',
    databaseURL: 'https://demo-seeker-td.firebaseio.com' };
  for (const config of [cli]) {
    assert.equal(assertIdentityEmulators({ ...env, FIREBASE_CONFIG: JSON.stringify(config) }).projectId, cli.projectId);
  }
  assert.throws(() => assertIdentityEmulators({ ...env, FIREBASE_CONFIG: JSON.stringify({ projectId: cli.projectId }) }),
    /FIREBASE_CONFIG_fields/);
  assert.throws(() => assertIdentityEmulators({ ...env, FIREBASE_CONFIG: ' '.repeat(1025) }), /FIREBASE_CONFIG_format/);
  for (const field of Object.keys(cli)) {
    const incomplete = { ...cli };
    delete incomplete[field];
    assert.throws(() => assertIdentityEmulators({ ...env, FIREBASE_CONFIG: JSON.stringify(incomplete) }));
  }
  for (const raw of ['C:/private/config.json', '{', 'null', '[]', '"secret-value"']) {
    assert.throws(() => assertIdentityEmulators({ ...env, FIREBASE_CONFIG: raw }), error =>
      /^IDENTITY_DEMO_ONLY:FIREBASE_CONFIG_/.test(error.message) && !error.message.includes(raw));
  }
  for (const [field, value] of [['projectId', 'production-secret'], ['storageBucket', 'other.appspot.com'],
    ['databaseURL', `${cli.databaseURL}/path`], ['databaseURL', 'http://demo-seeker-td.firebaseio.com'],
    ['credential', 'secret-value'], ['__proto__', {}], ['storageBucket', null]]) {
    const config = { ...cli, [field]: value };
    assert.throws(() => assertIdentityEmulators({ ...env, FIREBASE_CONFIG: JSON.stringify(config) }),
      error => error.message.startsWith('IDENTITY_DEMO_ONLY:') && !error.message.includes('secret-value')
        && !error.message.includes('production-secret'));
  }
  assert.throws(() => assertIdentityEmulators({ ...env, FIREBASE_CONFIG: JSON.stringify(cli),
    GOOGLE_APPLICATION_CREDENTIALS: '' }), /GOOGLE_APPLICATION_CREDENTIALS/);
});

test('shared privileged bridge requires synchronous guard and rechecks after SDK awaits', async () => {
  const projectId = 'demo-seeker-td';
  let allowed = true, afterAuth = false, afterRead = false, afterCommit = false;
  const checkPrivilege = () => { if (!allowed) throw new Error('guard'); };
  const firebaseAuth = { app: { options: { projectId } }, async verifyIdToken() {
    if (afterAuth) allowed = false;
    return { uid: 'fixture', sub: 'fixture', aud: projectId, iss: `https://securetoken.google.com/${projectId}` };
  } };
  const firestore = { projectId, doc: path => ({ path }), async runTransaction(callback) {
    const result = await callback({ async get() {
      if (afterRead) allowed = false;
      return { exists: false, data: () => undefined };
    }, set() {} });
    if (afterCommit) allowed = false;
    return result;
  } };
  assert.throws(() => createFirebaseSdkBridge({ projectId, firebaseAuth, firestore }));
  assert.throws(() => createFirebaseSdkBridge({ projectId, firebaseAuth, firestore, checkPrivilege: async () => {} }));
  const bridge = createFirebaseSdkBridge({ projectId, firebaseAuth, firestore, checkPrivilege });
  afterAuth = true;
  await assert.rejects(bridge.authenticateToken('fixture'), /guard/);
  allowed = true; afterAuth = false; afterRead = true;
  await assert.rejects(bridge.store.transaction(tx => tx.get(`uids/${Buffer.from('fixture').toString('hex')}`)), /guard/);
  allowed = true; afterRead = false; afterCommit = true;
  await assert.rejects(bridge.store.transaction(async () => 'committed'), /guard/);
});
