import { readCommerceConfig } from './commerce-config.mjs';
import { createCommerceRpc } from './commerce-rpc.mjs';
import { createCommerceVerifier } from './commerce-verifier.mjs';
import { createCommerceFirestoreStore } from './commerce-firestore.mjs';
import { createCommerceService } from './commerce.mjs';
import { createCommerceHttpHandler } from './commerce-http.mjs';
import { createFirebaseAdapters } from './firebaseAdapters.mjs';
import { createIdentityService } from './identity.mjs';
import { fail } from './commerce-common.mjs';

export function rejectCommerceEmulators() {
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST !== undefined || process.env.FIRESTORE_EMULATOR_HOST !== undefined) fail('COMMERCE_PRODUCTION_ONLY');
}
export async function createCommerceFirebaseRuntime() {
  rejectCommerceEmulators();
  const config = readCommerceConfig(), projectId = process.env.COMMERCE_FIREBASE_PROJECT_ID;
  if (typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) fail('COMMERCE_CONFIG');
  const origin = process.env.COMMERCE_IDENTITY_ORIGIN;
  // Real Admin SDK only. ADC is managed by the host; no embedded credentials or verifier switches.
  const [{ initializeApp, getApps, applicationDefault }, { getAuth }, { getFirestore }] = await Promise.all([
    import('firebase-admin/app'), import('firebase-admin/auth'), import('firebase-admin/firestore'),
  ]);
  rejectCommerceEmulators();
  const name = 'seeker-td-commerce';
  const app = getApps().find(a => a.name === name) ?? initializeApp({ projectId, credential: applicationDefault() }, name);
  if (app.options.projectId !== projectId) fail('COMMERCE_CONFIG');
  const firestore = getFirestore(app), firebaseAuth = getAuth(app);
  const adapters = createFirebaseAdapters({ projectId, firebaseAuth, firestore });
  const identity = createIdentityService({ ...adapters, config: { audience: projectId, origin, cluster: config.cluster } });
  const store = createCommerceFirestoreStore({ projectId, firestore, checkPrivilege: rejectCommerceEmulators });
  // Missing RPC config permits a disabled public catalog, never a quote/receipt verification fallback.
  const verifier = config.rpcUrl ? createCommerceVerifier({ rpc: createCommerceRpc({ url: config.rpcUrl }), config })
    : Object.freeze({ async checkCurrency() { fail('COMMERCE_LOCKED'); }, async verify() { fail('COMMERCE_LOCKED'); } });
  const commerce = createCommerceService({ authenticateToken: adapters.authenticateToken, store, config, verifier });
  return Object.freeze({ commerce, identity, handler: createCommerceHttpHandler({ commerce, identity, origin }) });
}

let runtimePromise;
export async function commerceHttp(req, res) {
  try {
    rejectCommerceEmulators();
    runtimePromise ??= createCommerceFirebaseRuntime().catch(error => { runtimePromise = undefined; throw error; });
    const runtime = await runtimePromise;
    return await runtime.handler(req, res);
  } catch {
    if (!res.headersSent && !res.writableEnded) {
      res.statusCode = 503; res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify({ error: 'COMMERCE_UNAVAILABLE' }));
    }
  }
}

// Function registration only; importing never initializes Admin or contacts cloud/RPC.
export async function createFirebaseCommerceFunction() {
  const { onRequest } = await import('firebase-functions/v2/https');
  return onRequest({ cors: false, concurrency: 16, maxInstances: 2, timeoutSeconds: 60 }, commerceHttp);
}
