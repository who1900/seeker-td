import { createFirebaseAdapters } from './firebaseAdapters.mjs';
import { createCommerceFirestoreStore } from './commerce-firestore.mjs';

// Supply real Admin Auth/Firestore from the same privileged app; no initialization or credentials here.
export function createGameAuthorityFirebaseAdapters({ projectId, firebaseAuth, firestore } = {}) {
  const adapters = createFirebaseAdapters({ projectId, firebaseAuth, firestore });
  const checkPrivilege = () => {
    if (process.env.FIREBASE_AUTH_EMULATOR_HOST !== undefined || process.env.FIRESTORE_EMULATOR_HOST !== undefined
      || firebaseAuth.app?.options?.projectId !== projectId) throw new Error('AUTHORITY_STORE');
  };
  const store = createCommerceFirestoreStore({ projectId, firestore, checkPrivilege, authority: true });
  return Object.freeze({ authenticateToken: adapters.authenticateToken, store });
}
