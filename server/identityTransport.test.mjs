import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createIdentityTransport } from './identityTransport.mjs';
import { createIdentityService, encodeBase58 } from './identity.mjs';

const wallet = '1'.repeat(32), challengeId = 'a'.repeat(64), signature = Buffer.alloc(64).toString('base64');
const challenge = { challengeId, message: 'exact trusted service message', expiresAt: 300000 };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject }; };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(service, limits = {}) {
  let transport;
  const server = http.createServer({ maxHeaderSize: 32768 }, (req, res) => transport.handler(req, res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port, expectedHost = `127.0.0.1:${port}`;
  transport = createIdentityTransport({ service, expectedHost, limits: { bodyMs: 100, operationMs: 100, ...limits } });
  return { transport, port, expectedHost, async close() {
    transport.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } };
}
function request(f, { method = 'POST', path = '/identity/challenge', headers = {}, body = JSON.stringify({ wallet }) } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: f.port, method, path,
      headers: { Host: f.expectedHost, Authorization: 'Bearer test.token', 'Content-Type': 'application/json', ...headers }, agent: false }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(body);
  });
}
async function raw(f, payload) {
  const socket = net.createConnection({ host: '127.0.0.1', port: f.port });
  await once(socket, 'connect');
  let response = ''; socket.on('data', chunk => { response += chunk.toString(); });
  const closed = once(socket, 'close'); socket.write(payload); await closed;
  return response;
}
const service = { async issueChallenge() { return challenge; }, async complete() { return { uid: 'verified-uid', wallet, cluster: 'testnet' }; } };

test('configuration is bounded; construction does not listen or invoke service', () => {
  for (const config of [{}, { service, expectedHost: 'user@localhost' }, { service, expectedHost: 'LOCALHOST' },
    { service, expectedHost: 'localhost', limits: { maxActive: 33 } }, { service, expectedHost: 'localhost', limits: { bodyBytes: 4097 } },
    { service, expectedHost: 'localhost', limits: { operationMs: Infinity } }, { service, expectedHost: 'localhost', limits: { unknown: 1 } }]) {
    assert.throws(() => createIdentityTransport(config), /IDENTITY_TRANSPORT_CONFIG/);
  }
  const transport = createIdentityTransport({ service, expectedHost: 'localhost' });
  assert.equal(transport.active, 0); transport.close(); transport.close();
});

test('exact routes forward only token/body and preserve trusted service outputs', { timeout: 5000 }, async () => {
  const calls = [], f = await fixture({
    async issueChallenge(...args) { calls.push(['issue', ...args]); return challenge; },
    async complete(...args) { calls.push(['complete', ...args]); return service.complete(); },
  });
  try {
    const issue = await request(f); assert.equal(issue.status, 200); assert.deepEqual(issue.body, challenge);
    assert.equal(issue.headers['cache-control'], 'no-store'); assert.equal(issue.headers['access-control-allow-origin'], undefined);
    const complete = await request(f, { path: '/identity/complete', body: JSON.stringify({ challengeId, signature }) });
    assert.equal(complete.status, 200); assert.deepEqual(complete.body, await service.complete());
    assert.deepEqual(calls, [['issue', 'test.token', { wallet }], ['complete', 'test.token', { challengeId, signature }]]);
    assert.equal(f.transport.active, 0);
  } finally { await f.close(); }
});

test('transport rejects malformed/oversized/media/credentials and never invokes service', { timeout: 10000 }, async () => {
  let calls = 0;
  const f = await fixture({ issueChallenge() { calls++; return challenge; }, complete() { calls++; } });
  try {
    for (const [options, status] of [
      [{ method: 'GET' }, 400], [{ method: 'OPTIONS' }, 400], [{ path: '/identity/challenge?x=1' }, 400],
      [{ path: '/identity/challenge/' }, 400], [{ headers: { Host: 'other.invalid' } }, 400],
      [{ headers: { Authorization: '' } }, 401], [{ headers: { Authorization: 'Basic token' } }, 400],
      [{ headers: { Cookie: 'session=secret' } }, 400], [{ headers: { Origin: 'http://other.invalid' } }, 400],
      [{ headers: { 'Content-Type': 'text/plain' } }, 415], [{ headers: { 'Content-Encoding': 'gzip' } }, 415],
      [{ body: '{' }, 400], [{ body: '[]' }, 400], [{ body: JSON.stringify({ wallet, uid: 'attacker' }) }, 400],
      [{ body: JSON.stringify({ wallet: 123 }) }, 400], [{ body: JSON.stringify({ wallet: 'bad' }) }, 400],
      [{ path: '/identity/complete', body: JSON.stringify({ challengeId, signature, wallet }) }, 400],
      [{ path: '/identity/complete', body: JSON.stringify({ challengeId, signature: 'bad' }) }, 400],
      [{ body: Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]) }, 400],
      [{ body: ' '.repeat(4097) }, 413], [{ headers: { 'Content-Length': '4097' }, body: '' }, 413],
      [{ headers: { 'X-Padding': 'x'.repeat(24576) } }, 413],
    ]) assert.equal((await request(f, options)).status, status, JSON.stringify(options).slice(0, 120));
    for (const extra of ['Authorization: Bearer second\r\n', `Host: ${f.expectedHost}\r\n`, 'Trailer: X-Test\r\n']) {
      const response = await raw(f, `POST /identity/challenge HTTP/1.1\r\nHost: ${f.expectedHost}\r\nAuthorization: Bearer test.token\r\nContent-Type: application/json\r\n${extra}Content-Length: 0\r\n\r\n`);
      assert.match(response, /^HTTP\/1\.1 400/);
    }
    const trailer = await raw(f, `POST /identity/challenge HTTP/1.1\r\nHost: ${f.expectedHost}\r\nAuthorization: Bearer test.token\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\nX-Test: trailer\r\n\r\n`);
    assert.match(trailer, /^HTTP\/1\.1 400/); assert.equal(calls, 0);
  } finally { await f.close(); }
});

test('denial/infrastructure/synchronous throw are generic without secret logging', { timeout: 5000 }, async () => {
  for (const [error, expected] of [[new Error('IDENTITY_DENIED'), 403], [new Error('secret-token credential stack'), 503]]) {
    const f = await fixture({ issueChallenge() { throw error; }, complete() { return Promise.reject(error); } });
    try {
      for (const options of [{}, { path: '/identity/complete', body: JSON.stringify({ challengeId, signature }) }]) {
        const response = await request(f, options); assert.equal(response.status, expected);
        assert.ok(!JSON.stringify(response.body).includes('secret')); assert.equal(f.transport.active, 0);
      }
    } finally { await f.close(); }
  }
});

test('slow body deadline and aborted body release admission without invoking operation', { timeout: 5000 }, async () => {
  let calls = 0; const f = await fixture({ issueChallenge() { calls++; }, complete() {} }, { maxActive: 1, bodyMs: 30 });
  try {
    const response = await raw(f, `POST /identity/challenge HTTP/1.1\r\nHost: ${f.expectedHost}\r\nAuthorization: Bearer test.token\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
    assert.match(response, /^HTTP\/1\.1 400/); assert.match(response, /IDENTITY_BODY_TIMEOUT/);
    assert.equal(f.transport.active, 0);
    const socket = net.createConnection({ host: '127.0.0.1', port: f.port }); await once(socket, 'connect');
    socket.write(`POST /identity/challenge HTTP/1.1\r\nHost: ${f.expectedHost}\r\nAuthorization: Bearer test.token\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
    await wait(10); socket.destroy(); await wait(10);
    assert.equal(f.transport.active, 0); assert.equal(calls, 0);
  } finally { await f.close(); }
});

test('timed-out operation retains slot until late settle, including late rejection', { timeout: 5000 }, async () => {
  for (const reject of [false, true]) {
    const operation = deferred(); let calls = 0;
    const f = await fixture({ issueChallenge() { calls++; return operation.promise; }, complete() {} }, { maxActive: 1, operationMs: 30 });
    try {
      const response = await request(f); assert.equal(response.status, 503); assert.equal(response.body.outcome, 'unknown');
      assert.equal(f.transport.active, 1);
      for (let i = 0; i < 3; i++) assert.equal((await request(f)).status, 503);
      assert.equal(calls, 1, 'cannot bypass admission with repeated deadline requests');
      if (reject) operation.reject(new Error('late secret')); else operation.resolve(challenge);
      await wait(10); assert.equal(f.transport.active, 0);
      assert.equal((await request(f)).status, reject ? 503 : 200);
    } finally { operation.resolve(challenge); await f.close(); }
  }
});

test('disconnected operation and lifecycle close retain slot until actual settle', { timeout: 5000 }, async () => {
  const operation = deferred(), started = deferred();
  const f = await fixture({ issueChallenge() { started.resolve(); return operation.promise; }, complete() {} }, { maxActive: 1 });
  try {
    const socket = net.createConnection({ host: '127.0.0.1', port: f.port }); await once(socket, 'connect');
    const body = JSON.stringify({ wallet });
    socket.write(`POST /identity/challenge HTTP/1.1\r\nHost: ${f.expectedHost}\r\nAuthorization: Bearer test.token\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    await started.promise; socket.destroy(); await wait(10);
    assert.equal(f.transport.active, 1); assert.equal((await request(f)).status, 503);
    f.transport.close(); f.transport.close(); assert.equal(f.transport.active, 1);
    operation.reject(new Error('late disconnected failure')); await wait(10);
    assert.equal(f.transport.active, 0); assert.equal((await request(f)).status, 503, 'closed transport stays closed');
  } finally { operation.resolve(challenge); await f.close(); }
});

test('success output rejects extra credentials, malformed shapes/accessors and toJSON hooks', { timeout: 5000 }, async () => {
  let getters = 0;
  const accessor = { ...challenge }; Object.defineProperty(accessor, 'message', { enumerable: true, get() { getters++; return 'secret'; } });
  for (const output of [{ ...challenge, token: 'secret' }, { ...challenge, message: 'x'.repeat(4097) },
    { ...challenge, expiresAt: Infinity }, { ...challenge, toJSON() { throw new Error('secret'); } }, null,
    { ...challenge, message: { token: 'secret' } }, { ...challenge, message: 'é'.repeat(2049) }, accessor,
    { uid: 'user', wallet, cluster: 'mainnet-beta' }]) {
    const f = await fixture({ issueChallenge() { return output; }, complete() { return { uid: 'user', wallet, cluster: 'testnet', credential: 'secret' }; } });
    try {
      const issue = await request(f); assert.equal(issue.status, 503); assert.ok(!JSON.stringify(issue.body).includes('secret'));
      assert.equal((await request(f, { path: '/identity/complete', body: JSON.stringify({ challengeId, signature }) })).status, 503);
    } finally { await f.close(); }
  }
  assert.equal(getters, 0, 'accessor output is rejected without executing getter');
  for (const output of [{ uid: 'user', wallet: 'z'.repeat(44), cluster: 'testnet' }, { uid: 'x'.repeat(129), wallet, cluster: 'testnet' },
    { uid: '\u0000', wallet, cluster: 'testnet' }, { uid: '\ud800', wallet, cluster: 'testnet' }]) {
    const f = await fixture({ issueChallenge() {}, complete() { return output; } });
    try { assert.equal((await request(f, { path: '/identity/complete', body: JSON.stringify({ challengeId, signature }) })).status, 503); }
    finally { await f.close(); }
  }
});

test('ambiguous Bearer grammar fails before service', { timeout: 5000 }, async () => {
  const f = await fixture({ issueChallenge() { assert.fail('ambiguous authorization reached service'); }, complete() {} });
  try {
    for (const authorization of ['Bearer one,two', 'Bearer  two', 'Bearer one two', 'bearer token', 'Bearer\ttoken', `Bearer ${'a'.repeat(16385)}`]) {
      assert.equal((await request(f, { headers: { Authorization: authorization } })).status, 400);
    }
  } finally { await f.close(); }
});

test('Node normalizes outer HTTP OWS; body-close lifecycle remains safe', { timeout: 5000 }, async () => {
  const f = await fixture(service, { bodyMs: 500 });
  try {
    assert.equal((await request(f, { headers: { Authorization: 'Bearer test.token ' } })).status, 200);
    const socket = net.createConnection({ host: '127.0.0.1', port: f.port }); await once(socket, 'connect');
    socket.on('error', () => {});
    socket.write(`POST /identity/challenge HTTP/1.1\r\nHost: ${f.expectedHost}\r\nAuthorization: Bearer test.token\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
    await wait(10); assert.equal(f.transport.active, 1);
    f.transport.close(); f.transport.close(); await wait(10);
    assert.equal(f.transport.active, 0); socket.destroy();
  } finally { await f.close(); }
});

test('real core Ed25519 issue/complete/replay/UID/rate/expiry through loopback; memory is test-only', { timeout: 10000 }, async () => {
  let records = new Map(), queue = Promise.resolve(), now = 1000000;
  const store = { transaction(callback) {
    const pending = queue.then(async () => {
      const draft = structuredClone(records);
      const result = await callback({ async get(key) { return structuredClone(draft.get(key)); },
        async set(key, value) { draft.set(key, structuredClone(value)); } });
      records = draft; return result;
    });
    queue = pending.catch(() => {}); return pending;
  } };
  const core = createIdentityService({ store, now: () => now,
    config: { audience: 'demo-seeker-td', origin: 'https://identity.example.invalid', cluster: 'testnet' },
    authenticateToken: async token => { if (!['user-a', 'user-b'].includes(token)) throw new Error('IDENTITY_DENIED'); return { uid: token }; } });
  const f = await fixture(core);
  const keys = generateKeyPairSync('ed25519');
  const address = encodeBase58(keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  const issue = token => request(f, { headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ wallet: address }) });
  const complete = (token, issued) => request(f, { path: '/identity/complete', headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ challengeId: issued.challengeId, signature: sign(null, Buffer.from(issued.message, 'utf8'), keys.privateKey).toString('base64') }) });
  try {
    const issued = (await issue('user-a')).body;
    assert.equal(JSON.parse(issued.message).origin, 'https://identity.example.invalid', 'Host never becomes trusted signed origin');
    assert.equal((await complete('user-b', issued)).status, 403);
    const concurrent = await Promise.all([complete('user-a', issued), complete('user-a', issued)]);
    assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 403]);
    assert.equal((await complete('user-a', issued)).status, 403);
    for (let i = 0; i < 4; i++) assert.equal((await issue('user-a')).status, 200);
    assert.equal((await issue('user-a')).status, 403);
    now += 60001; const expired = (await issue('user-a')).body; now += 300000;
    assert.equal((await complete('user-a', expired)).status, 403);
    assert.equal((await issue('invalid-token')).status, 403);
  } finally { await f.close(); }
});
