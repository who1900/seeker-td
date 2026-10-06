import { assertIdentityEmulators } from './emulatorIdentitySafety.mjs';
import { installDemoNetworkGuard } from './emulatorIdentityNetwork.test-support.mjs';
import { createFirebaseRunAdmissionSdkBridge } from './firebaseRunAdmissionSdkBridge.mjs';
import { createDemoIdentityRuntime } from './emulatorIdentityRuntime.test-support.mjs';

// Test-only: existing runtime supplies guarded explicit owner credential, never ADC.
export async function createDemoRunAdmissionRuntime(name) {
  assertIdentityEmulators();
  installDemoNetworkGuard();
  const runtime = await createDemoIdentityRuntime(name);
  try {
    const { projectId } = assertIdentityEmulators();
    const store = createFirebaseRunAdmissionSdkBridge({ projectId, firestore: runtime.firestore,
      checkPrivilege: () => { assertIdentityEmulators(); } });
    return { ...runtime, identityStore: runtime.store, store };
  } catch (error) { await runtime.close(); throw error; }
}
