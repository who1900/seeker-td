const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const sdk = require('@solana/web3.js');
const { webcrypto } = require('node:crypto');

const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const payerKey = sdk.Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const otherKey = sdk.Keypair.fromSeed(new Uint8Array(32).fill(17));
const payer = payerKey.publicKey.toBase58();
const other = otherKey.publicKey.toBase58();
const mint = sdk.Keypair.fromSeed(new Uint8Array(32).fill(23)).publicKey.toBase58();
const encoded = Buffer.from(payerKey.publicKey.toBytes()).toString('base64');
const signature = bytes => {
  const tx = new sdk.Transaction();
  tx.signatures = [{ publicKey: payerKey.publicKey, signature: null }];
  // Sign arbitrary off-chain bytes with the same audited Ed25519 implementation as web3.
  return require('@noble/curves/ed25519').ed25519.sign(bytes, payerKey.secretKey.slice(0, 32));
};
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const protocolSource = fs.readFileSync(path.resolve(__dirname, '../node_modules/@solana-mobile/mobile-wallet-adapter-protocol/lib/esm/index.browser.js'), 'utf8');
const normalizeCapabilities = vm.runInNewContext(protocolSource.slice(protocolSource.indexOf('function handleMobileWalletResponse('),
  protocolSource.indexOf('async function signInFallback(')) + '\nhandleMobileWalletResponse', {
  SolanaSignTransactions: 'solana:signTransactions', SolanaCloneAuthorization: 'solana:cloneAuthorization',
});

function fixture(env = {}, desktop = false) {
  const cache = new Map(), timers = new Map();
  let timerId = 0;
  const calls = { authorize: [], reauthorize: [], deauthorize: [], messages: [], transactions: [], associations: [], rpc: [] };
  const state = {
    genesis: env.VITE_SOLANA_CLUSTER === 'mainnet-beta' ? MAINNET : DEVNET,
    auth: { auth_token: 'token-1', accounts: [{ address: encoded, chains: ['solana:devnet'] }] },
    capabilities: { supported_transaction_versions: ['legacy', 0], features: ['solana:signTransactions'], max_messages_per_request: 1, max_transactions_per_request: 1 },
    tokenAccounts: [],
    mint: { owner: new sdk.PublicKey(TOKEN), executable: false, data: { program: 'spl-token', space: 82,
      parsed: { type: 'mint', info: { decimals: 6, isInitialized: true, freezeAuthority: null } } } },
  };
  const wallet = {
    async authorize(params) { calls.authorize.push(params); return state.authorize ? state.authorize(params) : state.auth; },
    async reauthorize(params) { calls.reauthorize.push(params); return state.reauthorize ? state.reauthorize(params) : { ...state.auth, auth_token: 'token-2' }; },
    async deauthorize(params) { calls.deauthorize.push(params); return {}; },
    async getCapabilities() { return state.capabilities; },
    async signMessages(params) {
      calls.messages.push(params);
      if (state.signMessages) return state.signMessages(params);
      const bytes = Buffer.from(params.payloads[0], 'base64');
      return { signed_payloads: [Buffer.concat([bytes, Buffer.from(signature(bytes))]).toString('base64')] };
    },
    async signTransactions(params) {
      calls.transactions.push(params);
      if (state.signTransactions) return state.signTransactions(params);
      const tx = sdk.VersionedTransaction.deserialize(Buffer.from(params.payloads[0], 'base64'));
      tx.sign([payerKey]);
      return { signed_payloads: [Buffer.from(tx.serialize()).toString('base64')] };
    },
    async signAndSendTransactions() { assert.fail('No real or mocked broadcast permitted in wallet tests'); },
  };
  class Connection {
    constructor(endpoint) { calls.rpc.push(endpoint); }
    async getGenesisHash() { return state.getGenesis ? state.getGenesis() : state.genesis; }
    async getBalance() { return state.solBalance ?? 1234567890; }
    async getParsedAccountInfo() { return { value: state.mint }; }
    async getParsedTokenAccountsByOwner(owner, filter) {
      assert.equal(owner.toBase58(), payer); assert.equal(filter.mint.toBase58(), mint);
      return { value: state.tokenAccounts };
    }
    async sendRawTransaction() { assert.fail('Network broadcast is forbidden'); }
  }
  const provider = { publicKey: payerKey.publicKey,
    async connect() { return { publicKey: provider.publicKey }; },
    async signMessage(bytes) { return { signature: signature(bytes), publicKey: provider.publicKey }; },
    async disconnect() { provider.publicKey = null; },
  };
  const window = { solana: desktop ? provider : undefined };
  const navigator = { userAgent: desktop ? 'Desktop' : 'Android' };
  const context = vm.createContext({ console, Uint8Array, TextEncoder, URL, AbortController, crypto: webcrypto,
    atob, btoa, Date, __testEnv: env, window, navigator,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    localStorage: { getItem() { assert.fail('No persisted authorization reads'); }, setItem() { assert.fail('No persisted authorization writes'); } },
  });
  function load(filename) {
    filename = path.resolve(__dirname, filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    const source = fs.readFileSync(filename, 'utf8').replaceAll('import.meta.env', '__testEnv');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const requireLocal = name => {
      if (name === '@solana/web3.js') return { ...sdk, Connection };
      if (name === '@solana-mobile/mobile-wallet-adapter-protocol') return { transact: async (callback, options) => {
        calls.associations.push(options); return callback(wallet);
      } };
      if (name.startsWith('.')) return load(`${path.resolve(path.dirname(filename), name)}.ts`);
      return require(name);
    };
    const compiled = vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename });
    compiled(requireLocal, module, module.exports);
    return module.exports;
  }
  return { api: load('wallet.ts'), config: load('services/solanaConfig.ts'), state, calls, timers, wallet, provider, window, navigator,
    timeout() { const timer = [...timers.values()].find(value => value.delay >= 1000); assert.ok(timer); timer.callback(); } };
}

function unsigned(version = 0, key = payerKey) {
  const builder = new sdk.TransactionMessage({ payerKey: key.publicKey, recentBlockhash: mint,
    instructions: [sdk.SystemProgram.transfer({ fromPubkey: key.publicKey, toPubkey: otherKey.publicKey, lamports: 1 })] });
  return new sdk.VersionedTransaction(version === 0 ? builder.compileToV0Message() : builder.compileToLegacyMessage()).serialize();
}
function tokenAccount(raw, key = other) {
  return { pubkey: new sdk.PublicKey(key), account: { owner: new sdk.PublicKey(TOKEN), executable: false,
    data: { program: 'spl-token', space: 165, parsed: { type: 'account', info: { owner: payer, mint, state: 'initialized',
      tokenAmount: { amount: raw, decimals: 6, uiAmount: NaN, uiAmountString: 'DO NOT TRUST' } } } } } };
}

test('strict shared config, identity, exact full genesis and no fallback on invalid env', async () => {
  const f = fixture({ VITE_SOLANA_CLUSTER: 'mainnet-beta', VITE_SOLANA_RPC_URL: 'https://rpc.example.invalid',
    VITE_SOLANA_IDENTITY_URI: 'https://github.com/who1900/seeker-td', VITE_SOLANA_IDENTITY_NAME: 'Test' });
  const config = f.api.getSolanaConfig();
  assert.equal(config.chain, 'solana:mainnet'); assert.equal(config.rpcUrl, config.endpoint); assert.equal(config.genesisHash, MAINNET);
  assert.equal(f.api.getWalletCluster(), 'mainnet-beta'); assert.equal(config.skrMint, null);
  assert.equal(f.api.getPurchaseAvailability().enabled, false);
  for (const env of [{ VITE_SOLANA_CLUSTER: 'DEVNET' }, { VITE_SOLANA_CLUSTER: '' },
    { VITE_SOLANA_RPC_URL: '' }, { VITE_SOLANA_RPC_URL: 'http://rpc.invalid' },
    { VITE_SOLANA_IDENTITY_URI: 'https://user:pass@example.invalid' }, { VITE_SOLANA_IDENTITY_ICON: '../icon.png' },
    { VITE_WALLET_TIMEOUT_MS: 'NaN' }, { VITE_SKR_MINT: mint }]) assert.throws(() => f.config.getSolanaConfig(env));
  const bad = fixture({ VITE_SOLANA_CLUSTER: 'invalid' });
  await assert.rejects(bad.api.connectWallet(), /cluster/); assert.equal(bad.calls.associations.length, 0);
  const wrong = fixture(); wrong.state.genesis = MAINNET;
  await assert.rejects(wrong.api.connectWallet(), /cluster\/genesis/); assert.equal(wrong.calls.associations.length, 0);
  wrong.state.genesis = DEVNET.slice(0, -1) + 'C';
  await assert.rejects(wrong.api.getSolBalance(payer), /cluster\/genesis/);
});

test('canonical 32-byte MWA accounts, wrong-account and wrong-cluster rejection', async () => {
  for (const address of [payer, encoded.slice(0, -1), encoded + '\n', Buffer.alloc(31).toString('base64'),
    Buffer.alloc(33).toString('base64'), encoded.slice(0, -2) + 'B=']) {
    const f = fixture(); f.state.auth.accounts[0].address = address;
    await assert.rejects(f.api.connectWallet()); assert.equal(f.calls.messages.length, 0);
  }
  const wrong = fixture(); wrong.state.auth.accounts[0].chains = ['solana:mainnet'];
  await assert.rejects(wrong.api.connectWallet(), /cluster/);
  const account = fixture(); await assert.rejects(account.api.signWalletMessage('proof', other), /expected payer/);
  assert.equal(account.calls.messages.length, 0);
  const f = fixture(); assert.deepEqual({ ...await f.api.connectWallet() }, { address: payer, authToken: 'token-1' });
  assert.equal(f.calls.authorize[0].chain, 'solana:devnet'); assert.equal(f.calls.authorize[0].identity.uri, 'https://github.com/who1900/seeker-td');
});

test('reauth rotation, invalid-token recovery only, decline propagates, logout deauthorizes', async () => {
  const f = fixture(); await f.api.connectWallet();
  assert.equal((await f.api.reauthorizeWallet(payer)).authToken, 'token-2');
  assert.equal(f.calls.reauthorize[0].auth_token, 'token-1');
  await f.api.disconnectWallet(); assert.equal(f.calls.deauthorize.at(-1).auth_token, 'token-2');
  await f.api.connectWallet(); assert.equal(f.calls.authorize.length, 2);
  f.state.reauthorize = () => { throw Object.assign(new Error('invalid token'), { code: -1 }); };
  await f.api.reauthorizeWallet(payer); assert.equal(f.calls.authorize.length, 3);
  f.state.reauthorize = () => { throw Object.assign(new Error('declined'), { code: -3 }); };
  await assert.rejects(f.api.reauthorizeWallet(payer), /declined/); assert.equal(f.calls.authorize.length, 3);
  assert.equal(f.timers.size, 0);
});

test('UTF-8 proof returns canonical detached signature; altered payload/count/signer fail closed', async () => {
  const f = fixture(), message = 'Серверный challenge 🚀';
  const result = await f.api.signWalletMessage(message, payer);
  assert.equal(result, Buffer.from(signature(Buffer.from(message))).toString('base64'));
  assert.equal(Buffer.from(result, 'base64').length, 64);
  assert.equal(f.calls.messages[0].addresses[0], encoded);
  assert.equal(f.calls.messages[0].payloads[0], Buffer.from(message).toString('base64'));
  for (const variant of ['altered', 'count', 'unsigned', 'badSignature']) {
    const bad = fixture(); bad.state.signMessages = params => {
      const payload = Buffer.from(params.payloads[0], 'base64');
      if (variant === 'altered') payload[0] ^= 1;
      const bytes = variant === 'unsigned' ? payload : Buffer.concat([payload, Buffer.alloc(64)]);
      return { signed_payloads: variant === 'count' ? [] : [bytes.toString('base64')] };
    };
    await assert.rejects(bad.api.signWalletMessage('exact proof', payer));
  }
  assert.throws(() => f.api.signWalletMessage('', payer));
  assert.throws(() => f.api.signWalletMessage('é'.repeat(2049), payer));
});

test('sign-only legacy/v0 validates payer, capabilities, signed bytes and NEVER broadcasts', async () => {
  for (const version of [0, 'legacy']) {
    const f = fixture(), input = unsigned(version);
    const result = await f.api.signWalletTransaction(input, payer);
    assert.ok(sdk.VersionedTransaction.deserialize(result).signatures[0].some(byte => byte !== 0));
    assert.equal(f.calls.transactions.length, 1); assert.equal(f.calls.messages.length, 0);
    assert.ok(Buffer.from(result).includes(Buffer.from(sdk.VersionedTransaction.deserialize(input).message.serialize())));
  }
  const wrong = fixture(); assert.throws(() => wrong.api.signWalletTransaction(unsigned(0, otherKey), payer), /payer/);
  const mainnet = fixture({ VITE_SOLANA_CLUSTER: 'mainnet-beta' });
  assert.throws(() => mainnet.api.signWalletTransaction(unsigned(), payer), /locked/); assert.equal(mainnet.calls.associations.length, 0);
  const legacy = fixture(); legacy.state.capabilities.supported_transaction_versions = ['legacy'];
  await assert.rejects(legacy.api.signWalletTransaction(unsigned(), payer), /version/);
  const noSign = fixture(); noSign.state.capabilities.features = [];
  await assert.rejects(noSign.api.signWalletTransaction(unsigned(), payer), /version/);
  for (const mutate of [tx => { tx.message.recentBlockhash = other; }, tx => { tx.signatures[0] = new Uint8Array(64); }]) {
    const bad = fixture(); bad.state.signTransactions = params => {
      const tx = sdk.VersionedTransaction.deserialize(Buffer.from(params.payloads[0], 'base64'));
      tx.sign([payerKey]); mutate(tx); return { signed_payloads: [Buffer.from(tx.serialize()).toString('base64')] };
    };
    await assert.rejects(bad.api.signWalletTransaction(unsigned(), payer));
  }
});

test('capabilities preserve future 7-bit versions without inventing legacy/v0 or enabling unsupported signing', async () => {
  const f = fixture(); f.state.capabilities.supported_transaction_versions = ['legacy', 0, 1, 127];
  await f.api.connectWallet();
  const caps = await f.api.getWalletCapabilities({ requireV0: true });
  assert.deepEqual(Array.from(caps.supportedTransactionVersions), ['legacy', 0, 1, 127]);
  assert.ok(Object.isFrozen(caps.supportedTransactionVersions));
  for (const version of ['legacy', 0]) await f.api.signWalletTransaction(unsigned(version), payer);
  assert.equal(f.calls.transactions.length, 2);
  const future = fixture(); future.state.capabilities.supported_transaction_versions = [1, 127];
  await future.api.connectWallet();
  const futureCaps = await future.api.getWalletCapabilities();
  assert.equal(futureCaps.supportsV0, false);
  assert.deepEqual(Array.from(futureCaps.supportedTransactionVersions), [1, 127]);
  await assert.rejects(future.api.getWalletCapabilities({ requireV0: true }), /does not support v0/);
  for (const version of ['legacy', 0]) await assert.rejects(future.api.signWalletTransaction(unsigned(version), payer), /version/);
  assert.equal(future.calls.transactions.length, 0);
});

test('actual SDK legacy/v1 normalization accepts omitted optional limits; zero limits and absent signing feature stay gated', async () => {
  for (const protocol of ['legacy', 'v1']) {
    const f = fixture();
    const raw = protocol === 'legacy'
      ? { supported_transaction_versions: ['legacy', 0, 1], supports_clone_authorization: false, supports_sign_and_send_transactions: false }
      : { supported_transaction_versions: ['legacy', 0, 1], features: ['solana:signTransactions'] };
    f.state.capabilities = normalizeCapabilities('getCapabilities', raw, protocol);
    await f.api.connectWallet();
    const caps = await f.api.getWalletCapabilities();
    assert.equal(caps.maxMessagesPerRequest, undefined); assert.equal(caps.maxTransactionsPerRequest, undefined);
    assert.equal(caps.supportsSignTransactions, true);
    await f.api.signWalletMessage('exact proof', payer);
    await f.api.signWalletTransaction(unsigned(), payer);
    assert.equal(f.calls.messages.length, 1); assert.equal(f.calls.transactions.length, 1);
  }
  const noSign = fixture(); noSign.state.capabilities = normalizeCapabilities('getCapabilities', {
    supported_transaction_versions: ['legacy', 0, 1], features: [],
  }, 'v1');
  await noSign.api.connectWallet();
  assert.equal((await noSign.api.getWalletCapabilities()).supportsSignTransactions, false);
  await assert.rejects(noSign.api.signWalletTransaction(unsigned(), payer), /version/);
  assert.equal(noSign.calls.transactions.length, 0);
  for (const field of ['max_messages_per_request', 'max_transactions_per_request']) {
    const f = fixture(); f.state.capabilities[field] = 0;
    if (field === 'max_messages_per_request') await assert.rejects(f.api.signWalletMessage('proof', payer), /cannot sign messages/);
    else await assert.rejects(f.api.signWalletTransaction(unsigned(), payer), /version/);
    assert.equal(f.calls.messages.length + f.calls.transactions.length, 0);
  }
});

test('malformed/missing/empty capability versions, limits and features fail closed with safe diagnostics', async () => {
  const mutations = [
    caps => { delete caps.supported_transaction_versions; },
    ...[null, [], 'legacy', ['0'], ['legacy', '1'], ['legacy', -1], ['legacy', 128], ['legacy', 0.5],
      ['legacy', NaN], ['legacy', Infinity], [true], [{}], [null], [undefined], new Array(1)].map(versions => caps => {
        caps.supported_transaction_versions = versions;
      }),
    ...[null, undefined, {}, [null], [''], ['solana:signTransactions', 1], new Array(1)].map(features => caps => { caps.features = features; }),
    ...['max_messages_per_request', 'max_transactions_per_request'].flatMap(field =>
      [null, -1, 0.5, '1', true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(limit => caps => { caps[field] = limit; })),
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f.state.capabilities);
    await assert.rejects(f.api.connectWallet(), error => {
      assert.match(error.message, /Invalid wallet capabilit/);
      assert.ok(!error.message.includes(encoded) && !error.message.includes(payer) && !error.message.includes('token-1'));
      return true;
    });
    assert.equal(f.calls.deauthorize.length, 1);
    assert.equal(f.calls.messages.length + f.calls.transactions.length, 0);
    f.state.capabilities = { supported_transaction_versions: ['legacy', 0, 1], features: ['solana:signTransactions'] };
    await f.api.connectWallet();
    assert.equal(f.calls.reauthorize.length, 0);
  }
});

test('shared mutex, AbortSignal, timeout, late authorization cannot revive session/sign', async () => {
  for (const cancellation of ['abort', 'timeout', 'cancel']) {
    const f = fixture(), auth = deferred(), controller = new AbortController();
    f.state.authorize = () => auth.promise;
    const pending = f.api.signWalletTransaction(unsigned(), payer, controller.signal);
    await tick();
    await assert.rejects(f.api.connectWallet(), /in progress/);
    if (cancellation === 'abort') controller.abort(); else if (cancellation === 'timeout') f.timeout(); else f.api.cancelWalletOperation();
    await assert.rejects(pending, /cancelled|timed out/);
    await assert.rejects(f.api.connectWallet(), /in progress/);
    auth.resolve(f.state.auth); await tick();
    assert.equal(f.calls.transactions.length, 0); assert.equal(f.calls.deauthorize.length, 1);
    delete f.state.authorize;
    await f.api.connectWallet(); assert.equal(f.calls.reauthorize.length, 0); assert.equal(f.calls.authorize.length, 2);
    assert.equal(f.timers.size, 0);
  }
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.api.signWalletTransaction(unsigned(), payer, controller.signal), /cancelled/);
  await f.api.connectWallet();
});

test('late signed response is rejected, and logout during auth clears authorization', async () => {
  const f = fixture(), signed = deferred(), controller = new AbortController();
  f.state.signMessages = () => signed.promise;
  const result = f.api.signWalletMessage('proof', payer, { signal: controller.signal }); await tick();
  controller.abort(); await assert.rejects(result, /cancelled/);
  signed.resolve({ signed_payloads: [Buffer.concat([Buffer.from('proof'), Buffer.from(signature(Buffer.from('proof')))]).toString('base64')] });
  await tick(); assert.equal(f.calls.deauthorize.length, 1);
  const late = fixture(), auth = deferred(); late.state.authorize = () => auth.promise;
  const connection = late.api.connectWallet(); await tick();
  const logout = late.api.logoutWallet(); await assert.rejects(connection, /cancelled/);
  auth.resolve(late.state.auth); await logout;
  assert.equal(late.calls.deauthorize.length, 1);
});

test('exact SKR decimal/raw strings, multiple accounts, zero, and owner/mint/decimals validation', async () => {
  const env = { VITE_SKR_MINT: mint, VITE_SKR_DECIMALS: '6', VITE_SKR_CLUSTER: 'devnet' };
  const f = fixture(env); f.state.tokenAccounts = [tokenAccount('9007199254740993'), tokenAccount('7', mint)];
  const balance = await f.api.getSkrBalance(payer);
  assert.equal(balance.raw, '9007199254741000'); assert.equal(balance.decimal, '9007199254.741000'); assert.equal(balance.decimals, 6);
  f.state.tokenAccounts = []; assert.equal((await f.api.getSkrBalance(payer)).decimal, '0.000000');
  await assert.rejects(fixture().api.getSkrBalance(payer), /SKR unavailable/);
  await assert.rejects(fixture({ ...env, VITE_SKR_CLUSTER: 'mainnet-beta' }).api.getSkrBalance(payer), /configuration/);
  for (const mutate of [f => { f.state.mint.owner = otherKey.publicKey; }, f => { f.state.mint.data.parsed.info.decimals = 9; },
    f => { f.state.mint.data.space = 83; }, f => { f.state.tokenAccounts[0].account.data.parsed.info.owner = other; },
    f => { f.state.tokenAccounts[0].account.data.parsed.info.mint = other; }, f => { f.state.tokenAccounts[0].account.data.parsed.info.tokenAmount.decimals = 9; },
    f => { f.state.tokenAccounts[0].account.owner = otherKey.publicKey; },
    f => { f.state.tokenAccounts[0].account.data.parsed.info.tokenAmount.amount = '18446744073709551616'; },
    f => { f.state.tokenAccounts[0].account.data.parsed.info.tokenAmount.amount = '01'; },
    f => { f.state.tokenAccounts.push(f.state.tokenAccounts[0]); }]) {
    const bad = fixture(env); bad.state.tokenAccounts = [tokenAccount('1')]; mutate(bad);
    await assert.rejects(bad.api.getSkrBalance(payer), /Invalid SKR/);
  }
});

test('in-memory cache, desktop exact proof, and Capacitor does not reuse HTTPS association endpoint', async () => {
  const f = fixture(), cache = f.api.createInMemoryWalletAuthorizationCache();
  await cache.set(f.state.auth); assert.equal((await cache.get()).auth_token, 'token-1');
  await f.api.logoutWallet(); assert.equal(await cache.get(), undefined);
  const native = fixture(); native.window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
  native.state.auth.wallet_uri_base = 'https://wallet.example.invalid';
  await native.api.connectWallet(); await native.api.reauthorizeWallet(payer);
  assert.equal(native.calls.associations[1], undefined);
  const web = fixture(); web.state.auth.wallet_uri_base = 'https://wallet.example.invalid';
  await web.api.connectWallet(); await web.api.reauthorizeWallet(payer);
  assert.equal(web.calls.associations[1].baseUri, 'https://wallet.example.invalid/');
  const desktop = fixture({}, true); assert.equal((await desktop.api.connectWallet()).authToken, '');
  assert.equal(await desktop.api.signWalletMessage('proof', payer), Buffer.from(signature(Buffer.from('proof'))).toString('base64'));
  desktop.provider.publicKey = otherKey.publicKey;
  await assert.rejects(desktop.api.signWalletMessage('proof', payer), /expected payer/);
});

test('iOS is rejected honestly and account-specific signing features are enforced', async () => {
  const ios = fixture(); ios.navigator.userAgent = 'iPhone';
  await assert.rejects(ios.api.connectWallet(), /not supported on iOS/);
  await assert.rejects(ios.api.signWalletTransaction(unsigned(), payer), /not supported on iOS/);
  assert.equal(ios.calls.associations.length, 0);
  const noMessages = fixture(); noMessages.state.auth.accounts[0].features = ['solana:signTransactions'];
  await assert.rejects(noMessages.api.signWalletMessage('proof', payer), /cannot sign messages/);
  const noTransactions = fixture(); noTransactions.state.auth.accounts[0].features = ['solana:signMessages'];
  await assert.rejects(noTransactions.api.signWalletTransaction(unsigned(), payer), /cannot sign/);
});

test('validated in-memory capabilities avoid an extra hop; signing still reauthenticates/rechecks capabilities', async () => {
  const env = {}, f = fixture(env);
  await f.api.connectWallet();
  const cached = await f.api.getWalletCapabilities({ requireV0: true });
  assert.equal(cached.supportsV0, true); assert.equal(f.calls.associations.length, 1);
  assert.equal(await f.api.getWalletCapabilities(), cached);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(f.api.getWalletCapabilities({ signal: aborted.signal }), /cancelled/);
  assert.equal(f.calls.associations.length, 1);
  f.state.capabilities.supported_transaction_versions = ['legacy'];
  await assert.rejects(f.api.signWalletTransaction(unsigned(), payer), /version/);
  assert.equal(f.calls.reauthorize.length, 1); assert.equal(f.calls.transactions.length, 0);
  const current = fixture(env); await current.api.connectWallet();
  const held = deferred(); current.state.reauthorize = () => held.promise;
  const signing = current.api.signWalletTransaction(unsigned(), payer); await tick();
  await assert.rejects(current.api.getWalletCapabilities(), /in progress/);
  current.api.cancelWalletOperation(); await assert.rejects(signing, /cancelled/);
  held.resolve(current.state.auth); await tick();
  const changed = fixture(env); await changed.api.connectWallet(); env.VITE_SOLANA_CLUSTER = 'testnet';
  await assert.rejects(changed.api.getWalletCapabilities(), /cluster mismatch/);
  assert.equal(changed.calls.associations.length, 1);
});

test('React adapter cache accepts validated Wallet Standard public accounts and revokes all cached tokens', async () => {
  const f = fixture(), cache = f.api.createInMemoryWalletAuthorizationCache();
  const standard = { ...f.state.auth, auth_token: 'provider-token', chain: 'solana:devnet', capabilities: f.state.capabilities,
    accounts: [{ address: payer, publicKey: payerKey.publicKey.toBytes(), chains: ['solana:devnet'], features: ['solana:signMessages'] }] };
  await cache.set(standard); assert.equal((await cache.get()).accounts[0].address, payer);
  await f.api.connectWallet();
  await f.api.logoutWallet();
  assert.deepEqual(f.calls.deauthorize.map(call => call.auth_token).sort(), ['provider-token', 'token-1']);
  await assert.rejects(cache.set(standard), /cancelled/);
  assert.equal(await cache.get(), undefined);
  await cache.set(standard); assert.equal((await cache.get()).auth_token, 'provider-token');
  await assert.rejects(cache.set({ ...standard, accounts: [{ ...standard.accounts[0], address: other }] }), /cached wallet account/);
  await assert.rejects(cache.set({ ...standard, chain: 'solana:mainnet' }), /cluster/);
});
