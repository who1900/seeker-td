import { assertDemoEmulator, DEMO_PROJECT } from './emulatorSafety.mjs';

const deny = reason => { throw new Error(`IDENTITY_DEMO_ONLY:${reason}`); };

function checkCliConfig(raw) {
  if (raw === undefined) return;
  if (typeof raw !== 'string' || raw.length > 1024) deny('FIREBASE_CONFIG_format');
  let config;
  try { config = JSON.parse(raw); } catch { deny('FIREBASE_CONFIG_json'); }
  if (!config || Object.getPrototypeOf(config) !== Object.prototype) deny('FIREBASE_CONFIG_object');
  const expected = { projectId: DEMO_PROJECT, storageBucket: `${DEMO_PROJECT}.appspot.com`,
    databaseURL: `https://${DEMO_PROJECT}.firebaseio.com` };
  if (Object.keys(config).some(key => !Object.hasOwn(expected, key))) deny('FIREBASE_CONFIG_unknown_key');
  if (Reflect.ownKeys(config).length !== 3) deny('FIREBASE_CONFIG_fields');
  if (config.projectId !== DEMO_PROJECT) deny('FIREBASE_CONFIG_projectId');
  for (const key of ['storageBucket', 'databaseURL']) {
    if (!Object.hasOwn(config, key) || config[key] !== expected[key]) deny(`FIREBASE_CONFIG_${key}`);
  }
}

export function assertIdentityEmulators(env = process.env) {
  if (env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8089') deny('FIRESTORE_EMULATOR_HOST');
  if (env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9099') deny('FIREBASE_AUTH_EMULATOR_HOST');
  for (const key of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'FIREBASE_PROJECT_ID']) {
    if ((key === 'GCLOUD_PROJECT' || env[key] !== undefined) && env[key] !== DEMO_PROJECT) deny(key);
  }
  if (env.GOOGLE_APPLICATION_CREDENTIALS !== undefined) deny('GOOGLE_APPLICATION_CREDENTIALS');
  if (env.METADATA_SERVER_DETECTION !== undefined && env.METADATA_SERVER_DETECTION !== 'none') {
    deny('METADATA_SERVER_DETECTION');
  }
  checkCliConfig(env.FIREBASE_CONFIG);
  const target = assertDemoEmulator(env);
  return target;
}
