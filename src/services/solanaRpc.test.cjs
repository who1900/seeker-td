const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const sdk = require('@solana/web3.js');
const RPC = 'https://api.devnet.solana.com/';
const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const request = (id = 'request-1') => ({ method: 'POST', headers: { 'Content-Type': 'application/json', 'solana-client': 'js/mock' },
  body: JSON.stringify({ jsonrpc: '2.0', id, method: 'getGenesisHash', params: [] }) });

function fixture(env = {}) {
  const cache = new Map(), calls = [], timers = new Map();
  let timerId = 0, clock = 1000;
  const state = { native: true, platform: 'android' };
  const capacitor = { isNativePlatform: () => state.native, getPlatform: () => state.platform };
  const http = { async request(options) {
    calls.push(options);
    if (state.error) throw state.error;
    if (state.pending) return state.pending;
    const parsed = JSON.parse(options.data), result = rpc => ({ jsonrpc: '2.0', id: rpc.id, result: state.genesis ?? GENESIS });
    return state.response ?? { status: 200, url: options.url, headers: { 'Content-Type': 'application/json; charset=utf-8' },
      data: Array.isArray(parsed) ? parsed.map(result) : result(parsed) };
  } };
  class Clock extends Date { static now() { return clock; } }
  const context = vm.createContext({ console, Error, DOMException, Date: Clock, URL, Headers, Response, TextEncoder, AbortController,
    __testEnv: { VITE_SOLANA_CLUSTER: 'devnet', VITE_SOLANA_RPC_URL: RPC, ...env },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  function load(filename) {
    filename = path.resolve(__dirname, filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8').replaceAll('import.meta.env', '__testEnv'), {
      fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const run = vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename });
    run(name => name === '@capacitor/core' ? { Capacitor: capacitor, CapacitorHttp: http }
      : name === '@solana/web3.js' ? sdk : name.startsWith('.') ? load(`${path.resolve(path.dirname(filename), name)}.ts`) : require(name), module, module.exports);
    return module.exports;
  }
  const api = load('solanaRpc.ts');
  return { api, config: load('solanaConfig.ts'), calls, state, timers,
    fetch: signal => api.getSolanaConnectionConfig(RPC, signal).fetch,
    timeout() { assert.equal(timers.size, 1); [...timers.values()][0].callback(); },
    advance(ms) { clock += ms; } };
}

test('real Connection.getGenesisHash uses scoped Android HTTP POST, no preflight/global fetch patch', async () => {
  const originalFetch = globalThis.fetch, f = fixture();
  assert.equal(await f.api.createSolanaConnection(RPC).getGenesisHash(), GENESIS);
  assert.equal(f.calls.length, 1);
  const options = f.calls[0];
  assert.equal(options.url, RPC); assert.equal(options.method, 'POST'); assert.equal(options.disableRedirects, true);
  assert.equal(options.connectTimeout, 10000); assert.equal(options.readTimeout, 15000); assert.equal(options.responseType, 'text');
  assert.equal(JSON.parse(options.data).method, 'getGenesisHash'); assert.equal(options.headers['content-type'], 'application/json');
  assert.ok(options.headers['solana-client']); assert.equal(options.headers.origin, undefined);
  assert.equal(f.api.getSolanaConnectionConfig(RPC).disableRetryOnRateLimit, true);
  assert.equal(globalThis.fetch, originalFetch); assert.equal(f.timers.size, 0);
});

test('browser and other platforms retain default fetch without native request or retry-policy override', () => {
  const f = fixture();
  for (const [native, platform] of [[false, 'web'], [false, 'android'], [true, 'ios']]) {
    f.state.native = native; f.state.platform = platform;
    const options = f.api.getSolanaConnectionConfig(RPC);
    assert.equal(options.fetch, undefined); assert.equal(options.disableRetryOnRateLimit, undefined);
    assert.equal(options.commitment, 'confirmed');
  }
  assert.equal(f.calls.length, 0);
});

test('wrong URL/method/credentials/headers/body rejected before native HTTP', async () => {
  const f = fixture(), fetch = f.fetch();
  for (const url of ['http://api.devnet.solana.com/', 'https://evil.invalid/', `${RPC}other`, `${RPC}?new=1`, `${RPC}#fragment`,
    'https://user:password@api.devnet.solana.com/', 'https://api.mainnet-beta.solana.com/']) {
    await assert.rejects(fetch(url, request()));
    assert.throws(() => f.api.getSolanaConnectionConfig(url));
  }
  for (const change of [{ method: 'GET' }, { credentials: 'include' }, { redirect: 'follow' },
    { headers: { 'Content-Type': 'application/json', Authorization: 'blocked' } },
    { headers: { 'Content-Type': 'text/plain' } }, { body: 'not JSON' }, { body: 'x'.repeat(128 * 1024 + 1) },
    { body: JSON.stringify({ jsonrpc: '2.0', method: 'getGenesisHash', params: [] }) },
    { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [], url: 'https://evil.invalid' }) }]) {
    await assert.rejects(fetch(RPC, { ...request(), ...change }));
  }
  assert.equal(f.calls.length, 0);
});

test('redirects, unexpected HTTP status/final URL/MIME/envelope/ID and oversized responses fail closed', async () => {
  const data = { jsonrpc: '2.0', id: 'request-1', result: GENESIS };
  const base = { status: 200, url: RPC, headers: { 'content-type': 'application/json' }, data };
  for (const extra of [{ status: 301 }, { status: 307 }, { status: 429 }, { status: 403 },
    { url: 'https://evil.invalid/' }, { url: `${RPC}?secret=changed` }, { url: undefined },
    { headers: { 'content-type': 'application/json', Location: RPC } }, { headers: { 'content-type': 'text/html' } },
    { headers: {} }, { data: 'not JSON' }, { data: undefined }, { data: 'x'.repeat(2 * 1024 * 1024 + 1) },
    { data: { ...data, id: 'wrong-id' } }, { data: { ...data, jsonrpc: '1.0' } },
    { data: { ...data, error: { code: -1, message: 'ambiguous' } } }, { data: [data] }]) {
    const f = fixture(); f.state.response = { ...base, ...extra };
    await assert.rejects(f.fetch()(RPC, request())); assert.equal(f.calls.length, 1); assert.equal(f.timers.size, 0);
  }
});

test('JSON-RPC errors and batch IDs preserved; wrong cluster still rejected by configured genesis check', async () => {
  const f = fixture(); f.state.response = { status: 200, url: RPC, headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ jsonrpc: '2.0', id: 'request-1', error: { code: -32000, message: 'RPC denied', data: null } }) };
  assert.equal((await (await f.fetch()(RPC, request())).json()).error.code, -32000);
  const batch = fixture();
  const body = JSON.stringify([JSON.parse(request('one').body), JSON.parse(request(2).body)]);
  const result = await (await batch.fetch()(RPC, { ...request(), body })).json();
  assert.deepEqual(result.map(response => response.id), ['one', 2]);
  await assert.rejects(batch.fetch()(RPC, { ...request(), body: JSON.stringify([JSON.parse(request(1).body), JSON.parse(request(1).body)]) }), /Duplicate/);
  const wrong = fixture(); wrong.state.genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
  await assert.rejects(wrong.config.assertSolanaRpcCluster(wrong.api.createSolanaConnection(RPC)), /cluster\/genesis/);
});

test('AbortSignal rejects immediately and ignores late native response, including fetch-init cancellation', async () => {
  for (const signalInInit of [false, true]) {
    const f = fixture(), pending = deferred(), controller = new AbortController(); f.state.pending = pending.promise;
    const fetch = f.fetch(signalInInit ? undefined : controller.signal);
    const work = fetch(RPC, { ...request(), ...(signalInInit ? { signal: controller.signal } : {}) }); await tick();
    assert.equal(f.calls.length, 1); controller.abort(); await assert.rejects(work, error => error.name === 'AbortError');
    pending.resolve({ status: 200, url: RPC, headers: { 'content-type': 'application/json' }, data: { jsonrpc: '2.0', id: 'request-1', result: GENESIS } });
    await tick(); assert.equal(f.timers.size, 0);
  }
  const f = fixture(), cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(f.fetch(cancelled.signal)(RPC, request()), error => error.name === 'AbortError'); assert.equal(f.calls.length, 0);
});

test('total deadline bounds native HTTP even if timers are throttled; failures have no browser fallback', async () => {
  for (const throttled of [false, true]) {
    const f = fixture({ VITE_WALLET_TIMEOUT_MS: '2000' }), pending = deferred(); f.state.pending = pending.promise;
    const work = f.fetch()(RPC, request()); await tick();
    assert.equal(f.calls[0].readTimeout, 2000); assert.equal(f.calls[0].connectTimeout, 2000);
    if (throttled) {
      f.advance(2001); pending.resolve({ status: 200, url: RPC, headers: { 'content-type': 'application/json' }, data: { jsonrpc: '2.0', id: 'request-1', result: GENESIS } });
    } else f.timeout();
    await assert.rejects(work, /timed out/);
    pending.reject(new Error('late transport failure')); await tick(); assert.equal(f.timers.size, 0); assert.equal(f.calls.length, 1);
  }
  const failure = fixture(); failure.state.error = { message: 'native plugin failure' };
  await assert.rejects(failure.api.createSolanaConnection(RPC).getGenesisHash(), /Native Solana RPC request failed/);
  assert.equal(failure.calls.length, 1);
});

test('wallet/provider/commerce use scoped helper; commerce journal-before-broadcast and network policy remain intact', () => {
  const read = file => fs.readFileSync(path.resolve(__dirname, file), 'utf8');
  const wallet = read('../wallet.ts'), commerce = read('commerceWallet.ts'), provider = read('../SolanaProvider.tsx');
  assert.ok(!/new Connection\(/.test(wallet)); assert.ok(!/new Connection\(/.test(commerce));
  assert.match(wallet, /createSolanaConnection\(config.endpoint, operation.signal\)/);
  assert.match(commerce, /createSolanaConnection\(config.rpcUrl, signal\)/);
  assert.match(commerce, /createSolanaConnection\(config.rpcUrl, operationSignal\)/);
  assert.ok(commerce.indexOf('beforeBroadcast(signed.signature)') < commerce.indexOf('sendingConnection.sendRawTransaction'));
  assert.match(provider, /config=\{connectionConfig\}/);
  const capacitor = read('../../capacitor.config.ts');
  assert.ok(!/CapacitorHttp\s*:\s*\{\s*enabled\s*:\s*true/.test(capacitor));
  assert.ok(!/allowMixedContent\s*:\s*true/.test(capacitor));
  assert.match(read('../../android/app/src/main/res/xml/network_security_config.xml'), /base-config cleartextTrafficPermitted="false"/);
  assert.ok(!/usesCleartextTraffic/.test(read('../../android/app/src/main/AndroidManifest.xml')));
  assert.match(read('../../android/capacitor.settings.gradle'), /new File\('\.\.\/node_modules\/@capacitor\/android\/capacitor'\)/);
});
