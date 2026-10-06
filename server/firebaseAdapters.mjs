import { createFirebaseSdkBridge } from './firebaseSdkBridge.mjs';

const rejectEmulators = () => {
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST !== undefined || process.env.FIRESTORE_EMULATOR_HOST !== undefined) {
    throw new Error('IDENTITY_ADAPTER_DENIED');
  }
};

export function createFirebaseAdapters({ projectId, firebaseAuth, firestore } = {}) {
  rejectEmulators();
  return createFirebaseSdkBridge({ projectId, firebaseAuth, firestore, checkPrivilege: rejectEmulators });
}
