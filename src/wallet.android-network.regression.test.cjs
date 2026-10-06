const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const policy = read('android/app/src/main/res/xml/network_security_config.xml');

test('Android MWA cleartext policy is exact loopback only; physical transport remains unverified', () => {
  assert.match(policy, /<network-security-config>/);
  assert.equal((policy.match(/<base-config\b/g) || []).length, 1);
  assert.match(policy, /<base-config\s+cleartextTrafficPermitted="false"\s*\/>/);
  assert.equal((policy.match(/<domain-config\b/g) || []).length, 1);
  assert.match(policy, /<domain-config\s+cleartextTrafficPermitted="true">/);
  const domains = [...policy.matchAll(/<domain\s+includeSubdomains="(true|false)">([^<]+)<\/domain>/g)];
  assert.deepEqual(domains.map(match => match[2]).sort(), ['127.0.0.1', '[::1]', 'localhost']);
  assert.ok(domains.every(match => match[1] === 'false'));
  assert.equal((policy.match(/<domain(?=\s|>)/g) || []).length, 3);
  assert.ok(!/<(?:debug-overrides|trust-anchors|certificates|pin-set)\b/.test(policy));
  const allowed = host => domains.some(match => host === match[2]);
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.equal(allowed(host), true);
  for (const host of ['sub.localhost', 'localhost.evil.invalid', '127.0.0.2', '0.0.0.0', '10.0.2.2', '[::]', 'api.devnet.solana.com']) {
    assert.equal(allowed(host), false);
  }
});

test('Manifest references scoped policy; no global cleartext, HTTPS secure context unchanged', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android:networkSecurityConfig="@xml\/network_security_config"/);
  assert.equal((manifest.match(/android:networkSecurityConfig=/g) || []).length, 1);
  assert.ok(!/android:usesCleartextTraffic\s*=/.test(manifest));
  assert.match(manifest, /android:scheme="solana-wallet"/);
  const capacitor = read('capacitor.config.ts');
  assert.match(capacitor, /androidScheme:\s*'https'/);
  assert.ok(!/allowMixedContent\s*:\s*true/.test(capacitor));
  assert.match(read('android/variables.gradle'), /targetSdkVersion\s*=\s*34/);
  const provider = read('src/SolanaProvider.tsx');
  assert.match(provider, /getSolanaConfig\(\)/);
  assert.match(provider, /endpoint=\{config\.endpoint\}/);
  assert.match(provider, /chain:\s*config\.chain/);
  assert.ok(!/WalletAdapterNetwork\.Devnet|createDefaultAuthorizationResultCache|seekdef\.app/.test(provider));
});
