const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript');

function load(auth, signInAnonymously, config = { apiKey: 'offline-fixture', projectId: 'offline-project' }, app = {}) {
  const module = { exports: {} };
  const filename = path.join(__dirname, 'firebase.ts');
  const warnings = [];
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { module, exports: module.exports, console: { warn: (...args) => warnings.push(args) },
    require: id => {
      if (id === 'firebase/app') return { initializeApp: () => app };
      if (id === 'firebase/firestore') return { getFirestore: () => null };
      if (id === 'firebase/auth') return { getAuth: () => auth, signInAnonymously };
      if (id === './firebase.config') return { FIREBASE_CONFIG: config };
      throw new Error('UNEXPECTED_AUTH_DEPENDENCY');
    },
  }, { filename });
  return { api: module.exports, warnings };
}

test('actual installed Firebase SDK: parallel UID/token/snapshot callers issue one delayed signUp and reuse currentUser', async () => {
  const appSdk = require('firebase/app'), authSdk = require('firebase/auth');
  const sdkRequire = createRequire(require.resolve('firebase/auth'));
  const sdkDir = path.dirname(sdkRequire.resolve('@firebase/auth'));
  const internal = require(path.join(sdkDir, fs.readdirSync(sdkDir).find(name => /^totp-.*\.js$/.test(name))));
  const fetchProvider = internal.FetchProvider;
  assert.equal(typeof fetchProvider.initialize, 'function');
  const previousFetch = fetchProvider.fetch();
  const config = { apiKey: 'offline-fixture', projectId: 'offline-project' };
  const app = appSdk.initializeApp(config, `auth-singleflight-${Date.now()}`);
  const auth = authSdk.initializeAuth(app, { persistence: authSdk.inMemoryPersistence });
  const uid = 'fixture-uid-a';
  const claims = { sub: uid, user_id: uid, aud: config.projectId, iss: `https://securetoken.google.com/${config.projectId}`,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;
  let signups = 0, lookups = 0, release;
  fetchProvider.initialize(async (url, init) => {
    const target = new URL(url);
    assert.equal(target.hostname, 'identitytoolkit.googleapis.com');
    if (target.pathname === '/v1/accounts:signUp') {
      signups++;
      assert.equal(JSON.parse(init.body).returnSecureToken, true);
      await new Promise(resolve => { release = resolve; });
      return new Response(JSON.stringify({ localId: uid, idToken: token, refreshToken: 'offline-refresh', expiresIn: '3600' }));
    }
    if (target.pathname === '/v1/accounts:lookup') {
      lookups++;
      assert.equal(JSON.parse(init.body).idToken, token);
      return new Response(JSON.stringify({ users: [{ localId: uid, createdAt: '1000', lastLoginAt: '1000' }] }));
    }
    throw new Error('UNEXPECTED_SDK_HTTP_BOUNDARY');
  });
  try {
    const { api } = load(auth, authSdk.signInAnonymously, config, app);
    const requests = [api.ensureAuth(), api.getFirebaseIdToken(), api.getFirebaseAuthSnapshot(), api.ensureAuth(), api.getFirebaseIdToken()];
    for (let i = 0; i < 20 && !release; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(release); assert.equal(signups, 1);
    release();
    const result = await Promise.all(requests);
    assert.equal(result[0], uid); assert.equal(result[1], token);
    assert.deepEqual(JSON.parse(JSON.stringify(result[2])), { uid, token });
    assert.equal(result[3], uid); assert.equal(result[4], token);
    assert.equal(auth.currentUser.uid, uid); assert.equal(signups, 1); assert.equal(lookups, 1);
    assert.equal(await api.ensureAuth(), uid); assert.equal(await api.getFirebaseIdToken(), token);
    assert.equal(signups, 1);
  } finally {
    fetchProvider.initialize(previousFetch);
    await appSdk.deleteApp(app);
  }
});

test('persistence hydration precedes sign-in, reuses restored nonanonymous currentUser and follows identity changes', async () => {
  let hydrate, signs = 0;
  const restored = { uid: 'restored', getIdToken: async () => 'restored-token' };
  const auth = { currentUser: null, authStateReady: () => new Promise(resolve => { hydrate = resolve; }) };
  const { api } = load(auth, async () => { signs++; throw new Error('SHOULD_NOT_SIGN'); });
  const pending = [api.ensureAuth(), api.getFirebaseAuthSnapshot()];
  await Promise.resolve(); assert.equal(signs, 0);
  auth.currentUser = restored; hydrate();
  const [uid, snapshot] = await Promise.all(pending);
  assert.equal(uid, 'restored'); assert.equal(snapshot.token, 'restored-token'); assert.equal(signs, 0);
  auth.authStateReady = async () => {};
  auth.currentUser = { uid: 'other', getIdToken: async () => 'other-token' };
  assert.equal(await api.ensureAuth(), 'other');
  assert.equal((await api.getFirebaseAuthSnapshot()).uid, 'other');
});

test('token retrieval during identity replacement returns no mixed snapshot or bearer', async () => {
  let release;
  const auth = { authStateReady: async () => {}, currentUser: {
    uid: 'a', getIdToken: () => new Promise(resolve => { release = resolve; }),
  } };
  const { api } = load(auth, () => { throw new Error('SHOULD_NOT_SIGN'); });
  const pending = api.getFirebaseAuthSnapshot();
  for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
  assert.ok(release);
  auth.currentUser = { uid: 'b', getIdToken: async () => 'b-token' }; release('a-token');
  assert.equal(await pending, null);
  assert.equal(await api.getFirebaseIdToken(), 'b-token');
});

test('shared failed sign-in is retryable and does not log SDK exception payloads; disabled config never signs', async () => {
  let calls = 0;
  const auth = { currentUser: null, authStateReady: async () => {} };
  const { api, warnings } = load(auth, async () => {
    calls++;
    if (calls === 1) throw new Error('PRIVATE_PAYLOAD_DO_NOT_PRINT');
    auth.currentUser = { uid: 'retry', getIdToken: async () => 'retry-token' };
    return { user: auth.currentUser };
  });
  assert.deepEqual(await Promise.all([api.ensureAuth(), api.ensureAuth(), api.getFirebaseIdToken()]), [null, null, null]);
  assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(warnings), /PRIVATE_PAYLOAD/);
  assert.equal(await api.ensureAuth(), 'retry'); assert.equal(calls, 2);
  const disabled = load(auth, () => { throw new Error('DISABLED_AUTH_CALLED'); }, {}).api;
  assert.equal(await disabled.ensureAuth(), null); assert.equal(await disabled.getFirebaseAuthSnapshot(), null);
});

test('identity subscription invalidates only UID changes, not token refresh, and cleans up', () => {
  let notify, invalidations = 0, unsubscribed = false;
  const auth = { currentUser: { uid: 'a' }, onAuthStateChanged(listener) {
    notify = listener; return () => { unsubscribed = true; };
  } };
  const { api } = load(auth, () => { throw new Error('SHOULD_NOT_SIGN'); });
  const unsubscribe = api.subscribeFirebaseIdentity(() => { invalidations++; });
  notify({ uid: 'a' }); notify({ uid: 'a' }); assert.equal(invalidations, 0);
  notify({ uid: 'b' }); assert.equal(invalidations, 1);
  notify(null); notify(null); assert.equal(invalidations, 2);
  unsubscribe(); assert.equal(unsubscribed, true);
});
