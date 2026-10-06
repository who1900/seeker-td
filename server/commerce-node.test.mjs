import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { connect } from 'node:net';
import { spawnSync } from 'node:child_process';
import { createCommerceNodeServer, readCommerceNodeConfig, rejectCommerceNodeEmulators } from './commerce-node-http.mjs';
import { createCommerceHttpHandler } from './commerce-http.mjs';
import { fixture } from './commerce.test-support.mjs';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, chmod, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireCommerceNodeVersion, validateCommerceNodeAdc, validateCommerceServiceAccount } from './commerce-node-startup.mjs';

const origin = 'https://localhost';
const defaults = () => ({ ...readCommerceNodeConfig({ COMMERCE_IDENTITY_ORIGIN: origin }), port: 0 });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function listener(t, overrides = {}, handler) {
  const calls = [];
  const commerce = {
    async catalog() { calls.push('catalog'); return { enabled: false, cluster: 'devnet' }; },
    async quote(token, body) { calls.push({ action: 'quote', token, body }); return { id: 'quote' }; },
    async receipt(token, body) { calls.push({ action: 'receipt', token, body }); return { status: 'confirmed' }; },
  };
  const identity = {
    async issueChallenge(token, body) { calls.push({ action: 'challenge', token, body }); return { challengeId: 'challenge' }; },
    async complete(token, body) { calls.push({ action: 'complete', token, body }); return { uid: 'owner' }; },
  };
  const config = { ...defaults(), ...overrides };
  const node = createCommerceNodeServer({ config, handler: handler ?? createCommerceHttpHandler({ commerce, identity, origin,
    operationMilliseconds: config.operationMilliseconds }) });
  const address = await node.listen();
  t.after(() => node.stop());
  return { ...node, port: address.port, calls };
}

function http(node, { path = '/commerce/quote', method = 'POST', body = '{"productId":"runs-1","currency":"SOL","payer":"wallet"}',
  headers = {}, chunked = false, write } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: node.port, path, method, agent: false,
      headers: { ...(method === 'POST' ? { authorization: 'Bearer unit-token', 'content-type': 'application/json',
        ...(chunked ? {} : { 'content-length': bytes.length }) } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('TEST_HTTP_TIMEOUT')));
    if (write) write(req); else req.end(bytes);
  });
}

function wire(node, headers, body = '') {
  return new Promise((resolve, reject) => {
    const socket = connect(node.port, '127.0.0.1'), chunks = [];
    socket.setTimeout(3000, () => socket.destroy(new Error('TEST_WIRE_TIMEOUT')));
    socket.on('error', reject); socket.on('data', chunk => chunks.push(chunk));
    socket.on('close', () => resolve(Buffer.concat(chunks).toString()));
    socket.on('connect', () => socket.write(`POST /commerce/quote HTTP/1.1\r\nHost: 127.0.0.1:${node.port}\r\n${headers}\r\n\r\n${body}`));
  });
}

test('real HTTP parses raw JSON and delegates all existing commerce/identity routes', async t => {
  const node = await listener(t);
  for (const [path, body, action] of [
    ['/commerce/quote', { productId: 'runs-1', currency: 'SOL', payer: 'wallet' }, 'quote'],
    ['/commerce/receipt', { quoteId: 'quote', signature: 'tx' }, 'receipt'],
    ['/identity/challenge', { wallet: 'wallet' }, 'challenge'],
    ['/identity/complete', { challengeId: 'challenge', signature: 'proof' }, 'complete'],
  ]) {
    const res = await http(node, { path, body: JSON.stringify(body), headers: { origin } });
    assert.equal(res.status, 200);
    assert.deepEqual(node.calls.at(-1), { action, token: 'unit-token', body });
    assert.equal(res.headers['access-control-allow-origin'], origin);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  }
  const catalog = await http(node, { path: '/commerce/catalog', method: 'GET', body: '' });
  assert.equal(catalog.status, 200);
  assert.equal(catalog.headers['access-control-allow-origin'], undefined);
  assert.equal(node.server.address().address, '127.0.0.1');
});

test('real HTTP retains existing Firebase authentication and receipt verifier/store contract', async t => {
  const f = fixture(), identity = { async issueChallenge() {}, async complete() {} };
  const node = await listener(t, {}, createCommerceHttpHandler({ commerce: f.service, identity, origin }));
  const body = JSON.stringify({ productId: 'runs-1', currency: 'SOL', payer: f.payer });
  assert.equal((await http(node, { body, headers: { authorization: 'Bearer forged-token' } })).status, 403);
  const quote = await http(node, { body, headers: { authorization: 'Bearer owner-token' } });
  assert.equal(quote.status, 200);
  const q = JSON.parse(quote.text), { sig } = f.pay(q);
  const receipt = () => http(node, { path: '/commerce/receipt', body: JSON.stringify({ quoteId: q.id, signature: sig }),
    headers: { authorization: 'Bearer owner-token' } });
  const first = await receipt(), again = await receipt();
  assert.equal(first.status, 200); assert.equal(again.status, 200);
  assert.equal(JSON.parse(first.text).status, 'confirmed'); assert.equal(first.text, again.text);
  assert.equal([...f.sdk.docs.keys()].filter(key => key.startsWith('commerceLedger/')).length, 1);
});

for (const [name, body] of [
  ['malformed JSON', '{'], ['array JSON', '[]'], ['primitive JSON', 'null'],
  ['extra field', '{"productId":"x","currency":"SOL","payer":"x","amount":"1"}'],
  ['invalid UTF-8', Buffer.from([0xc3, 0x28])],
  ['UTF-8 BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"productId":"runs-1","currency":"SOL","payer":"wallet"}')])],
]) test(`HTTP rejects ${name} before calling a service`, async t => {
  const node = await listener(t);
  assert.equal((await http(node, { body })).status, 400); assert.equal(node.calls.length, 0);
});

test('HTTP enforces 4096 raw bytes, not characters, and accepts the exact limit', async t => {
  const node = await listener(t);
  const prefix = '{"wallet":"', suffix = '"}';
  const body = prefix + 'x'.repeat(4096 - Buffer.byteLength(prefix + suffix)) + suffix;
  assert.equal((await http(node, { path: '/identity/challenge', body })).status, 200);
  node.calls.length = 0;
  assert.equal((await http(node, { body: Buffer.alloc(4097, 0x20) })).status, 413);
  assert.equal((await http(node, { body: 'я'.repeat(3000) })).status, 413);
  assert.equal(node.calls.length, 0);
});

test('HTTP rejects oversized streamed chunked JSON before parsed handler', async t => {
  const node = await listener(t);
  const res = await http(node, { chunked: true, write(req) { req.write(Buffer.alloc(2048, 0x20)); req.end(Buffer.alloc(2049, 0x20)); } });
  assert.equal(res.status, 413); assert.equal(node.calls.length, 0);
});

test('HTTP rejects duplicate Authorization using raw headers', async t => {
  const node = await listener(t);
  const res = await wire(node, 'Authorization: Bearer first\r\naUtHoRiZaTiOn: Bearer second\r\nContent-Type: application/json\r\nContent-Length: 2', '{}');
  assert.match(res, /^HTTP\/1.1 401/); assert.equal(node.calls.length, 0);
});

for (const [name, headers, status] of [
  ['duplicate origin', 'Origin: https://localhost\r\nOrigin: https://localhost\r\nContent-Length: 0', 400],
  ['duplicate content-type', 'Content-Type: application/json\r\nContent-Type: text/plain\r\nContent-Length: 0', 400],
  ['ambiguous framing', 'Transfer-Encoding: chunked\r\nContent-Length: 1', 400],
  ['expect continue', 'Expect: 100-continue\r\nContent-Length: 1', 417],
  ['other expectation', 'Expect: unexpected\r\nContent-Length: 1', 417],
  ['upgrade', 'Connection: Upgrade\r\nUpgrade: websocket', 400],
]) test(`HTTP rejects ${name} without service calls`, async t => {
  const node = await listener(t);
  assert.match(await wire(node, headers), new RegExp(`^HTTP/1.1 ${status}`));
  assert.equal(node.calls.length, 0);
});

test('HTTP enforces allowed origin and exact paths/methods/content type/authority', async t => {
  const node = await listener(t);
  for (const [options, status] of [
    [{ headers: { origin: 'https://attacker.invalid' } }, 403],
    [{ headers: { authorization: '' } }, 401],
    [{ headers: { authorization: 'Basic unit-token' } }, 401],
    [{ headers: { 'content-type': 'text/plain' } }, 415],
    [{ headers: { 'content-encoding': 'gzip' } }, 415],
    [{ headers: { host: 'attacker.invalid' } }, 400],
    [{ headers: { cookie: 'session=untrusted' } }, 400],
    [{ headers: { 'proxy-authorization': 'Bearer untrusted' } }, 400],
    [{ path: '/commerce/quote?x=1' }, 404],
    [{ path: '/commerce/%71uote' }, 404],
    [{ path: '/commerce/quote/' }, 404],
    [{ path: '/unknown' }, 404],
    [{ method: 'PUT' }, 405],
    [{ path: '/commerce/catalog', method: 'POST' }, 405],
    [{ path: '/commerce/catalog', method: 'GET', headers: { 'content-length': 2 }, body: '{}' }, 400],
  ]) assert.equal((await http(node, options)).status, status, JSON.stringify(options));
  assert.equal(node.calls.length, 0);
});

test('HTTP CORS preflight is route-specific and permits only supported headers', async t => {
  const node = await listener(t);
  const options = { method: 'OPTIONS', body: '', headers: { origin, 'access-control-request-method': 'POST',
    'access-control-request-headers': 'authorization, content-type' } };
  const res = await http(node, options);
  assert.equal(res.status, 204); assert.equal(res.text, '');
  assert.equal(res.headers['access-control-allow-origin'], origin);
  assert.equal(res.headers['access-control-allow-methods'], 'POST');
  assert.equal(res.headers['access-control-allow-credentials'], undefined);
  for (const headers of [{}, { origin }, { ...options.headers, origin: 'null' },
    { ...options.headers, 'access-control-request-method': 'DELETE' },
    { ...options.headers, 'access-control-request-headers': 'x-admin' }]) {
    assert.equal((await http(node, { ...options, headers })).status, 403);
  }
  assert.equal(node.calls.length, 0);
});

test('HTTP absolute slow-body deadline rejects drip traffic and releases the slot', async t => {
  const node = await listener(t, { bodyMilliseconds: 80, maxConcurrent: 1 });
  let interval;
  const started = performance.now();
  const res = await http(node, { chunked: true, write(req) {
    req.flushHeaders(); req.write('{'); interval = setInterval(() => req.write(' '), 10);
  } }).catch(error => error).finally(() => clearInterval(interval));
  if (res instanceof Error) assert.ok(['ECONNRESET', 'EPIPE'].includes(res.code));
  else assert.equal(res.status, 408);
  assert.ok(performance.now() - started >= 70);
  assert.ok(performance.now() - started < 1500);
  assert.equal(node.calls.length, 0);
  assert.equal((await http(node, { path: '/ready', method: 'GET', body: '' })).status, 200);
});

test('slow body consumes concurrency before any parsed handler runs', async t => {
  const node = await listener(t, { bodyMilliseconds: 150, maxConcurrent: 1 });
  const begun = deferred();
  const slow = http(node, { chunked: true, write(req) { req.flushHeaders(); req.write('{'); begun.resolve(); } });
  await begun.promise;
  // A completed probe ensures the server has received the preceding body headers.
  const res = await http(node);
  assert.equal(res.status, 503); assert.equal(JSON.parse(res.text).error, 'COMMERCE_BUSY');
  assert.equal((await slow).status, 408); assert.equal(node.calls.length, 0);
});

test('HTTP concurrent operation timeout retains capacity until underlying work settles', async t => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const node = await listener(t, { operationMilliseconds: 80, maxConcurrent: 1 }, async (req, res) => {
    calls++; entered.resolve(); await release.promise;
    if (!res.destroyed && !res.writableEnded) res.end('{}');
  });
  const first = http(node); await entered.promise;
  assert.equal((await http(node)).status, 503);
  assert.equal((await http(node, { path: '/ready', method: 'GET', body: '' })).status, 503);
  const timed = await first;
  assert.equal(timed.status, 503); assert.equal(JSON.parse(timed.text).error, 'COMMERCE_TIMEOUT_RETRY_SAME_RECEIPT');
  assert.equal((await http(node)).status, 503); assert.equal(calls, 1);
  release.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await http(node, { path: '/ready', method: 'GET', body: '' })).status, 200);
});

test('client disconnect retains admission until the actual service operation settles', async t => {
  const entered = deferred(), release = deferred(); let calls = 0, client;
  t.after(() => release.resolve());
  const node = await listener(t, { maxConcurrent: 1 }, async () => {
    calls++; entered.resolve(); await release.promise;
  });
  const pending = http(node, { write(req) { client = req; req.end('{"productId":"runs-1","currency":"SOL","payer":"wallet"}'); } }).catch(error => error);
  await entered.promise; client.destroy(); assert.ok(await pending instanceof Error);
  for (let i = 0; i < 4; i++) assert.equal((await http(node)).status, 503);
  assert.equal(calls, 1);
  release.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await http(node, { path: '/ready', method: 'GET', body: '' })).status, 200);
});

test('aborted body never enters the service and releases only its body admission', async t => {
  const node = await listener(t, { maxConcurrent: 1 });
  await new Promise((resolve, reject) => {
    const socket = connect(node.port, '127.0.0.1');
    socket.on('error', reject); socket.on('close', resolve);
    socket.on('connect', () => {
      socket.write(`POST /commerce/quote HTTP/1.1\r\nHost: 127.0.0.1:${node.port}\r\nAuthorization: Bearer unit-token\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
      socket.end();
    });
    socket.resume();
  });
  assert.equal(node.calls.length, 0);
  assert.equal((await http(node, { path: '/ready', method: 'GET', body: '' })).status, 200);
});

test('declared and undeclared chunked trailers are rejected before parsed handler', async t => {
  const node = await listener(t);
  const headers = 'Authorization: Bearer unit-token\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked';
  const body = '{"productId":"runs-1","currency":"SOL","payer":"wallet"}';
  const chunks = `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\nX-Untrusted: yes\r\n\r\n`;
  assert.match(await wire(node, headers, chunks), /^HTTP\/1.1 400/);
  assert.match(await wire(node, `${headers}\r\nTrailer: X-Untrusted`, chunks), /^HTTP\/1.1 400/);
  assert.equal(node.calls.length, 0);
});

test('raw header count is bounded before building the parsed header map', async t => {
  const node = await listener(t);
  const headers = Array.from({ length: 129 }, (_, i) => `X-${i}: x`).join('\r\n');
  assert.match(await wire(node, headers), /^HTTP\/1.1 413/); assert.equal(node.calls.length, 0);
});

test('graceful stop drains admitted work, is idempotent and closes loopback socket', async t => {
  const entered = deferred(), release = deferred();
  const node = await listener(t, { shutdownMilliseconds: 1000 }, async (req, res) => {
    entered.resolve(); await release.promise; res.end('{}');
  });
  const pending = http(node); await entered.promise;
  const stopping = node.stop(); assert.equal(node.stop(), stopping);
  release.resolve(); assert.equal((await pending).status, 200);
  assert.deepEqual(await stopping, { drained: true });
  await assert.rejects(http(node, { path: '/ready', method: 'GET', body: '' }), /ECONNREFUSED|ECONNRESET/);
});

test('graceful stop has a finite deadline even for uncancellable operations', async t => {
  const entered = deferred(), release = deferred();
  const node = await listener(t, { shutdownMilliseconds: 60 }, async () => { entered.resolve(); await release.promise; });
  const pending = http(node).catch(error => error); await entered.promise;
  assert.deepEqual(await node.stop(), { drained: false });
  assert.ok(await pending instanceof Error); release.resolve();
});

test('slow/incomplete headers are closed before handler and without waiting for node periodic checks', async t => {
  const node = await listener(t, { headersMilliseconds: 80 });
  await new Promise((resolve, reject) => {
    const socket = connect(node.port, '127.0.0.1');
    socket.setTimeout(1000, () => socket.destroy(new Error('TEST_HEADER_TIMEOUT')));
    socket.on('error', reject); socket.on('close', resolve);
    socket.on('connect', () => socket.write('POST /commerce/quote HTTP/1.1\r\nHost:'));
  });
  assert.equal(node.calls.length, 0);
});

test('HTTP runtime errors are sanitized and readiness does not call Firebase/RPC', async t => {
  const node = await listener(t, {}, async () => { throw new Error('secret-value'); });
  assert.equal((await http(node, { path: '/ready', method: 'GET', body: '' })).status, 200);
  const res = await http(node);
  assert.equal(res.status, 503); assert.equal(res.text, '{"error":"COMMERCE_UNAVAILABLE"}');
});

test('configuration rejects public/IPv6 bind, invalid bounds/origins and every emulator variable', () => {
  for (const override of [
    { COMMERCE_NODE_HOST: '0.0.0.0' }, { COMMERCE_NODE_HOST: '::1' }, { COMMERCE_NODE_PORT: '0' },
    { COMMERCE_NODE_PORT: '65536' }, { COMMERCE_NODE_CONCURRENCY: '17' }, { COMMERCE_NODE_BODY_MS: '10001' },
    { COMMERCE_NODE_OPERATION_MS: '45001' }, { COMMERCE_NODE_SHUTDOWN_MS: '60001' },
    { COMMERCE_IDENTITY_ORIGIN: '*' }, { COMMERCE_IDENTITY_ORIGIN: 'http://localhost' },
    { COMMERCE_IDENTITY_ORIGIN: 'https://localhost/' },
  ]) assert.throws(() => readCommerceNodeConfig({ COMMERCE_IDENTITY_ORIGIN: origin, ...override }), /CONFIG/);
  for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB',
    'FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST', 'PUBSUB_EMULATOR_HOST']) {
    assert.throws(() => rejectCommerceNodeEmulators({ [key]: '' }), /PRODUCTION_ONLY/);
  }
});

test('dry launcher import performs no ADC, SDK registration, network or auto-listen even with emulator env', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const require = createRequire(import.meta.url);
    const forbidden = () => { throw new Error('DRY_IMPORT_SIDE_EFFECT'); };
    for (const name of ['node:http', 'node:https']) {
      const module = require(name); module.request = forbidden; module.get = forbidden; module.createServer = forbidden;
    }
    require('node:net').Socket.prototype.connect = forbidden;
    require('node:net').Server.prototype.listen = forbidden;
    require('node:tls').connect = forbidden; require('node:dns').lookup = forbidden;
    const Module = require('node:module'), original = Module._load;
    Module._load = function(name, ...args) {
      if (/firebase-admin|firebase-functions|google-auth-library/.test(name)) forbidden();
      return original.call(this, name, ...args);
    };
    globalThis.fetch = forbidden; syncBuiltinESMExports();
    const launcher = await import('./commerce-node.mjs');
    assert.equal(typeof launcher.startCommerceNode, 'function');
    await assert.rejects(launcher.startCommerceNode(), /COMMERCE_PRODUCTION_ONLY/);
    console.log('DRY_IMPORT_OK');
  `;
  const env = { ...process.env, FIRESTORE_EMULATOR_HOST: '127.0.0.1:1',
    GOOGLE_APPLICATION_CREDENTIALS: 'C:/nonexistent/commerce-dry-import.env' };
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script],
    { cwd: new URL('.', import.meta.url), env, timeout: 5000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'DRY_IMPORT_OK');
});

test('standalone rejects Node below 22 before credentials/runtime initialization', () => {
  for (const version of ['20.20.1', '21.7.0', 'invalid']) assert.throws(() => requireCommerceNodeVersion(version), /^Error: COMMERCE_NODE_VERSION$/);
  for (const version of ['22.0.0', '24.19.0']) assert.doesNotThrow(() => requireCommerceNodeVersion(version));
});

test('startup rejects missing/relative/nonexistent ADC with no privileged file path or details', async () => {
  for (const env of [{}, { GOOGLE_APPLICATION_CREDENTIALS: 'credentials.env' },
    { GOOGLE_APPLICATION_CREDENTIALS: join(tmpdir(), 'not-an-env-adc.json') },
    { GOOGLE_APPLICATION_CREDENTIALS: join(tmpdir(), 'missing-commerce-adc-private-path.env') }]) {
    await assert.rejects(validateCommerceNodeAdc(env), error => error.message === 'COMMERCE_NODE_ADC');
  }
});

test('standalone service-account project/type/key validation is strict and sanitized', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const record = { type: 'service_account', project_id: 'demo-commerce-test',
    client_email: 'unit-test@demo-commerce-test.iam.gserviceaccount.com', private_key: privateKey };
  assert.doesNotThrow(() => validateCommerceServiceAccount(record, 'demo-commerce-test'));
  for (const override of [{ project_id: 'different-project' }, { type: 'authorized_user' },
    { client_email: 'test@other-project.iam.gserviceaccount.com' }, { private_key: 'UNIT_TEST_SECRET_SENTINEL' }]) {
    assert.throws(() => validateCommerceServiceAccount({ ...record, ...override }, 'demo-commerce-test'), /^Error: COMMERCE_NODE_ADC$/);
  }
});

test('POSIX standalone ADC must be an existing private owned file in a trusted directory', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'commerce-adc-unit-'));
  const path = join(dir, 'firebase-admin.env');
  t.after(async () => { await unlink(path); await rmdir(dir); });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const record = { type: 'service_account', project_id: 'demo-commerce-test',
    client_email: 'unit-test@demo-commerce-test.iam.gserviceaccount.com', private_key: privateKey };
  const env = { GOOGLE_APPLICATION_CREDENTIALS: path, COMMERCE_FIREBASE_PROJECT_ID: record.project_id };
  await writeFile(path, JSON.stringify(record), { mode: 0o600 });
  await validateCommerceNodeAdc(env);
  await chmod(path, 0o644); await assert.rejects(validateCommerceNodeAdc(env), /^Error: COMMERCE_NODE_ADC$/);
  await chmod(path, 0o600); await assert.rejects(validateCommerceNodeAdc({ ...env, COMMERCE_FIREBASE_PROJECT_ID: 'other-project' }), /^Error: COMMERCE_NODE_ADC$/);
  await chmod(dir, 0o777); await assert.rejects(validateCommerceNodeAdc(env), /^Error: COMMERCE_NODE_ADC$/);
  await chmod(dir, 0o700);
});

test('executable startup fails closed without ADC and never falls back to metadata/mock runtime', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/EMULATOR/i.test(key)));
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  delete env.google_application_credentials;
  env.COMMERCE_IDENTITY_ORIGIN = origin;
  env.COMMERCE_FIREBASE_PROJECT_ID = 'demo-commerce-test';
  env.METADATA_SERVER_DETECTION = 'assume-present';
  const result = spawnSync(process.execPath, ['commerce-node.mjs'],
    { cwd: new URL('.', import.meta.url), env, timeout: 5000, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'COMMERCE_NODE_START_FAILED');
});
