import { assertIdentityEmulators } from './emulatorIdentitySafety.mjs';
import { createDemoIdentityRuntime } from './emulatorIdentityRuntime.test-support.mjs';
import { createIdentityService } from './identity.mjs';
import { createCommerceFirestoreStore } from './commerce-firestore.mjs';
import { createCommerceService } from './commerce.mjs';
import { createCommerceHttpHandler } from './commerce-http.mjs';

// Explicit local-only dependency injection. Never imported by index.mjs or commerce-functions.mjs.
export async function createDemoCommerceRuntime({ name, config, verifier, now, onWrite = () => {} }) {
  const target = assertIdentityEmulators();
  const runtime = await createDemoIdentityRuntime(name);
  const track = (store, identity) => ({ transaction: callback => store.transaction(tx => callback({ get: key => tx.get(key),
    async set(key, value) {
      const names = { challenges: 'identityChallenges', rates: 'identityRates', uids: 'identityUids', wallets: 'identityWallets' };
      const [kind, id] = key.split('/'); onWrite(identity ? `${names[kind]}/${id}` : key);
      await tx.set(key, value);
    },
  })) });
  const store = track(createCommerceFirestoreStore({ projectId: target.projectId, firestore: runtime.firestore,
    checkPrivilege() { assertIdentityEmulators(); } }), false);
  const identity = createIdentityService({ authenticateToken: runtime.authenticateToken, store: track(runtime.store, true),
    config: { audience: target.projectId, origin: 'https://localhost', cluster: 'devnet' }, now });
  const commerce = createCommerceService({ authenticateToken: runtime.authenticateToken, store, config, verifier, now });
  return { ...runtime, store, identity, commerce,
    handler: createCommerceHttpHandler({ commerce, identity, origin: 'https://localhost' }) };
}
