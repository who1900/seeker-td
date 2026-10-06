import { assertIdentityEmulators } from './emulatorIdentitySafety.mjs';
import { createFirebaseSdkBridge } from './firebaseSdkBridge.mjs';
import { installDemoNetworkGuard } from './emulatorIdentityNetwork.test-support.mjs';

// Test-only emulator owner credential; never ADC or a service-account key.
export async function createDemoIdentityRuntime(name) {
  const { projectId, host, port } = assertIdentityEmulators();
  installDemoNetworkGuard();
  const [{ initializeApp, deleteApp }, { getAuth }, { Firestore }] = await Promise.all([
    import('firebase-admin/app'), import('firebase-admin/auth'), import('firebase-admin/firestore'),
  ]);
  assertIdentityEmulators();
  const checkPrivilege = () => { assertIdentityEmulators(); };
  const credential = { async getAccessToken() {
    checkPrivilege(); return { access_token: 'owner', expires_in: 3600 };
  } };
  const app = initializeApp({ projectId, credential }, name);
  const firebaseAuth = getAuth(app);
  const firestore = new Firestore({ projectId, host: `${host}:${port}`, ssl: false });
  const adapters = createFirebaseSdkBridge({ projectId, firebaseAuth, firestore, checkPrivilege });
  return { ...adapters, firebaseAuth, firestore, checkPrivilege,
    async close() { checkPrivilege(); await firestore.terminate(); checkPrivilege(); await deleteApp(app); checkPrivilege(); } };
}
