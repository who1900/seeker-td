import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { demoNetworkTarget } from './emulatorIdentityNetwork.test-support.mjs';

test('test network permits only exact loopback emulator ports', () => {
  assert.equal(demoNetworkTarget('127.0.0.1', 8089), true);
  assert.equal(demoNetworkTarget('127.0.0.1', 9099), true);
  for (const host of ['localhost', '::1', 'metadata.google.internal', '169.254.169.254', 'example.com']) {
    assert.equal(demoNetworkTarget(host, 8089), false);
  }
  assert.equal(demoNetworkTarget('127.0.0.1', 443), false);
  assert.equal(demoNetworkTarget('127.0.0.1', 18089), false);
  assert.equal(demoNetworkTarget('127.0.0.1', 18089, { allowIdentityHttp: true }), true);
  for (const port of [18088, 18090, 443]) assert.equal(demoNetworkTarget('127.0.0.1', port, { allowIdentityHttp: true }), false);
  for (const port of ['018089', '18089.0', ' 18089', [18089]]) {
    assert.equal(demoNetworkTarget('127.0.0.1', port, { allowIdentityHttp: true }), false);
  }
  for (const host of ['localhost', '::1', '0.0.0.0', 'example.com']) {
    assert.equal(demoNetworkTarget(host, 18089, { allowIdentityHttp: true }), false);
  }
  for (const options of [null, { allowIdentityHttp: 18089 }, { port: 18089 }, { allowIdentityHttp: true, host: 'localhost' }]) {
    assert.throws(() => demoNetworkTarget('127.0.0.1', 18089, options), /IDENTITY_TEST_NETWORK_CONFIG/);
  }
  assert.throws(() => demoNetworkTarget('127.0.0.1', 18089, { get allowIdentityHttp() { assert.fail('getter executed'); } }),
    /IDENTITY_TEST_NETWORK_CONFIG/);
});

test('installed opt-in survives defaults; default guard cannot widen afterwards', () => {
  const setup = `process.env.GCLOUD_PROJECT='demo-seeker-td';process.env.FIRESTORE_EMULATOR_HOST='127.0.0.1:8089';
    process.env.FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099';
    const {installDemoNetworkGuard}=await import('./emulatorIdentityNetwork.test-support.mjs');
    const assert=(await import('node:assert/strict')).default;`;
  for (const body of [
    `installDemoNetworkGuard();assert.throws(()=>installDemoNetworkGuard({allowIdentityHttp:true}),/ALREADY_INSTALLED/);`,
    `installDemoNetworkGuard({allowIdentityHttp:true});installDemoNetworkGuard();installDemoNetworkGuard({allowIdentityHttp:false});
     const http=await import('node:http');
     const req=http.request({host:'127.0.0.1',port:18089,agent:false});req.on('error',()=>{});req.destroy();`,
  ]) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', setup + body], {
      cwd: new URL('.', import.meta.url), encoding: 'utf8', timeout: 10000, maxBuffer: 65536, windowsHide: true,
    });
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /"blocked":0/);
  }
});

test('supported metadata none avoids probe; caught HTTP/DNS attempts remain sticky failures', () => {
  const setup = `process.env.GCLOUD_PROJECT='demo-seeker-td';process.env.FIRESTORE_EMULATOR_HOST='127.0.0.1:8089';
    process.env.FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099';
    const {installDemoNetworkGuard,demoNetworkDiagnostics}=await import('./emulatorIdentityNetwork.test-support.mjs');
    installDemoNetworkGuard();`;
  const cases = [
    [`const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);
      const metadata=require('gcp-metadata');if(await metadata.isAvailable())throw Error('metadata unexpectedly available');
      if(demoNetworkDiagnostics().blocked)throw Error('probe attempted');`, 0],
    [`try{(await import('node:http')).get('http://metadata.google.internal');}catch{}process.exitCode=0;`, 1],
    [`try{(await import('node:dns')).lookup('metadata.google.internal',()=>{});}catch{}process.exitCode=0;`, 1],
    [`try{await(await import('node:dns/promises')).resolve4('example.com');}catch{}process.exitCode=0;`, 1],
    [`try{(await import('node:http')).request({host:'127.0.0.1',port:18089});}catch{}process.exitCode=0;`, 1],
  ];
  for (const [body, status] of cases) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', setup + body], {
      cwd: new URL('.', import.meta.url), encoding: 'utf8', timeout: 10000, maxBuffer: 65536, windowsHide: true,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, status, child.stderr);
  }
});
