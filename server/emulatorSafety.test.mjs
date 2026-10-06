import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertDemoEmulator, DEMO_PROJECT, EMULATOR_HOST, EMULATOR_PORT } from './emulatorSafety.mjs';

test('demo guard rejects missing, remote and wrong-project endpoints before SDK initialization', () => {
  const valid = { GCLOUD_PROJECT: DEMO_PROJECT, FIRESTORE_EMULATOR_HOST: `${EMULATOR_HOST}:${EMULATOR_PORT}` };
  assert.deepEqual(assertDemoEmulator(valid), { projectId: DEMO_PROJECT, host: EMULATOR_HOST, port: EMULATOR_PORT });
  for (const host of [undefined, '', 'localhost:8089', '127.0.0.1:8080', '0.0.0.0:8089', 'example.com:8089', 'https://127.0.0.1:8089']) {
    assert.throws(() => assertDemoEmulator({ ...valid, FIRESTORE_EMULATOR_HOST: host }));
  }
  assert.throws(() => assertDemoEmulator({ FIRESTORE_EMULATOR_HOST: valid.FIRESTORE_EMULATOR_HOST }));
  for (const key of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'FIREBASE_PROJECT_ID']) {
    for (const value of ['', 'seekdef', 'demo-other']) assert.throws(() => assertDemoEmulator({ ...valid, [key]: value }));
  }
});

test('dedicated emulator config keeps all enabled endpoints on loopback', () => {
  const config = JSON.parse(readFileSync(new URL('./emulator.firebase.json', import.meta.url), 'utf8'));
  assert.equal(config.firestore.rules, fileURLToPath(new URL('../firestore.rules', import.meta.url)).replaceAll('\\', '/'));
  assert.deepEqual(config.emulators.firestore, { host: EMULATOR_HOST, port: EMULATOR_PORT, websocketPort: 9159 });
  assert.deepEqual(config.emulators.auth, { host: EMULATOR_HOST, port: 9099 });
  assert.deepEqual(config.emulators.hub, { host: EMULATOR_HOST, port: 4409 });
  assert.deepEqual(config.emulators.logging, { host: EMULATOR_HOST, port: 4509 });
  assert.deepEqual(config.emulators.ui, { enabled: false });
  assert.equal(config.emulators.singleProjectMode, true);
  assert.deepEqual(Object.keys(config.emulators).sort(), ['auth', 'firestore', 'hub', 'logging', 'singleProjectMode', 'ui']);
});
