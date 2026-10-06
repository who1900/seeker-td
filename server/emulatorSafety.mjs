export const DEMO_PROJECT = 'demo-seeker-td';
export const EMULATOR_HOST = '127.0.0.1';
export const EMULATOR_PORT = 8089;

export function assertDemoEmulator(env = process.env) {
  if (env.FIRESTORE_EMULATOR_HOST !== `${EMULATOR_HOST}:${EMULATOR_PORT}`) {
    throw new Error('Only Firestore emulator 127.0.0.1:8089 is allowed');
  }
  for (const key of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'FIREBASE_PROJECT_ID']) {
    if (env[key] !== undefined && env[key] !== DEMO_PROJECT) {
      throw new Error(`${key} must be ${DEMO_PROJECT}`);
    }
  }
  if (env.GCLOUD_PROJECT !== DEMO_PROJECT) throw new Error('Explicit demo GCLOUD_PROJECT required');
  return { projectId: DEMO_PROJECT, host: EMULATOR_HOST, port: EMULATOR_PORT };
}
