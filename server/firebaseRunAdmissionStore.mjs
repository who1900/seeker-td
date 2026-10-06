import { createFirebaseRunAdmissionSdkBridge } from './firebaseRunAdmissionSdkBridge.mjs';

export function createFirebaseRunAdmissionStore({ checkPrivilege, ...options } = {}) {
  const check = () => {
    if (process.env.FIRESTORE_EMULATOR_HOST !== undefined || process.env.FIREBASE_AUTH_EMULATOR_HOST !== undefined
      || typeof checkPrivilege !== 'function' || checkPrivilege() !== undefined) throw new Error('RUN_STORE_DENIED');
  };
  check();
  return createFirebaseRunAdmissionSdkBridge({ ...options, checkPrivilege: check });
}
