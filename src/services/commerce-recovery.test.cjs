const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createPrivateKey, sign } = require('node:crypto');
const ts = require('typescript');
const web3 = require('@solana/web3.js');

// Offline HTTP/RPC/Firestore fixtures, not live devnet or wallet-device evidence.
const payer = web3.Keypair.fromSeed(new Uint8Array(32).fill(1));
const merchant = web3.Keypair.fromSeed(new Uint8Array(32).fill(2));
const other = web3.Keypair.fromSeed(new Uint8Array(32).fill(4));
const mint = web3.Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey;
const origin = 'https://localhost';
const signal = () => new AbortController().signal;
const plain = value => JSON.parse(JSON.stringify(value));
const server = name => import(pathToFileURL(path.resolve(__dirname, '../../server', name)).href);

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

function loadClient(storage, hooks) {
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8').replaceAll('import.meta.env', '__testEnv'), {
      fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
        jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    vm.runInNewContext(compiled, { module, exports: module.exports, Buffer, Uint8Array, URL, AbortController,
      Date, console, atob, btoa, setTimeout, clearTimeout, localStorage: storage, __testEnv: {},
      require: id => {
        if (id.endsWith('.css')) return {};
        if (id === 'react' && hooks) return hooks;
        if (id.includes('commerceRuntime')) return {
          commerceRuntimeAvailability() { throw new Error('REAL_RUNTIME_DENIED'); },
          getCommerceClient() { throw new Error('REAL_RUNTIME_DENIED'); },
          getCommerceWalletTransport() { throw new Error('REAL_RUNTIME_DENIED'); },
        };
        if (id === '../wallet') return {
          getWalletCapabilities() { throw new Error('REAL_WALLET_DENIED'); },
          signWalletTransaction() { throw new Error('REAL_WALLET_DENIED'); },
        };
        if (id.startsWith('.')) {
          const base = path.resolve(path.dirname(filename), id);
          const target = ['.ts', '.tsx'].map(ext => base + ext).find(file => fs.existsSync(file));
          if (!target) throw new Error(`Missing scoped module: ${id}`);
          return load(target);
        }
        return require(id);
      },
    }, { filename });
    return module.exports;
  }
  return { commerce: load(path.join(__dirname, 'commerce.ts')), wallet: load(path.join(__dirname, 'commerceWallet.ts')),
    store: load(path.resolve(__dirname, '../state/store.ts')), runs: load(path.resolve(__dirname, '../state/runs.ts')), load };
}

function mountPurchases(f) {
  const slots = []; let cursor = 0, effects = [], tree, writes = 0;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(action, deps) { const i = cursor++, previous = slots[i];
      if (!previous || deps.some((value, index) => value !== previous.deps[index])) {
        previous?.cleanup?.(); slots[i] = { deps }; effects.push(() => { slots[i].cleanup = action(); });
      }
    },
  };
  const modules = loadClient(f.disk, hooks);
  const { CommercePurchases } = modules.load(path.resolve(__dirname, '../components/CommercePurchases.tsx'));
  const props = { state: { ...f.lib.store.DEFAULT_STATE, walletConnected: true, walletAddr: payer.publicKey.toBase58() },
    kind: 'runs', client: f.api, transport: f.transport, getUid: f.getUid,
    setState(update) { writes++; props.state = update(props.state); },
  };
  function render() { cursor = 0; tree = CommercePurchases(props); }
  function text(element) {
    if (element == null || typeof element === 'boolean') return '';
    if (typeof element !== 'object') return String(element);
    return [element.props?.children].flat(Infinity).map(text).join('');
  }
  function button(label, element) {
    if (!element || typeof element !== 'object') return null;
    if (element.type === 'button' && text(element).includes(label)) return element;
    for (const child of [element.props?.children].flat(Infinity)) {
      const found = button(label, child); if (found) return found;
    }
    return null;
  }
  return { props, get writes() { return writes; },
    async flush() { for (let i = 0; i < 12; i++) {
      render(); const jobs = effects; effects = []; jobs.forEach(job => job());
      await new Promise(resolve => setImmediate(resolve));
    } render(); },
    click(label) { render(); const found = button(label, tree); assert.ok(found, `Missing ${label}`);
      assert.equal(found.props.disabled, false); found.props.onClick(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

async function fixture(options = {}) {
  const [support, identityLib, bridgeLib, storeLib, configLib, serviceLib, verifierLib, httpLib] = await Promise.all([
    server('commerce.test-support.mjs'), server('identity.mjs'), server('firebaseSdkBridge.mjs'),
    server('commerce-firestore.mjs'), server('commerce-config.mjs'), server('commerce.mjs'),
    server('commerce-verifier.mjs'), server('commerce-http.mjs'),
  ]);
  let time = 1_000_000, uid = 'fixture-owner', visible = options.visible ?? true;
  let broadcastMode = options.broadcastMode, receiptMode = options.receiptMode, delayedSign;
  const disk = memoryStorage(), sdk = support.fakeFirestore(), evidence = new Map(), calls = [], events = [];
  const counts = { signs: 0, broadcasts: 0, proofSigns: 0 };
  const config = configLib.readCommerceConfig(support.environment(time, {
    COMMERCE_RECIPIENT: merchant.publicKey.toBase58(), COMMERCE_SKR_MINT: mint.toBase58(),
  }));
  const authenticateToken = async token => {
    const value = token === 'fixture-token' ? 'fixture-owner' : token === 'fixture-other-token' ? 'fixture-other' : null;
    if (!value) throw new Error('IDENTITY_DENIED');
    return { uid: value, sub: value, aud: sdk.projectId, iss: `https://securetoken.google.com/${sdk.projectId}` };
  };
  const bridge = bridgeLib.createFirebaseSdkBridge({ projectId: sdk.projectId, firestore: sdk, checkPrivilege() {},
    firebaseAuth: { app: { options: { projectId: sdk.projectId } }, verifyIdToken: async (token, revoked) => {
      assert.equal(revoked, true); return authenticateToken(token);
    } },
  });
  const identity = identityLib.createIdentityService({ ...bridge, now: () => time,
    config: { audience: sdk.projectId, origin, cluster: 'devnet' } });
  const templateQuote = { currency: 'SKR', payer: payer.publicKey.toBase58(), recipient: config.recipient,
    mint: config.mint, decimals: 6, amount: '1' };
  const currencyAccounts = support.transactionFixture(templateQuote, 'unused', time).accounts;
  const rpc = { async call(method, params = []) {
    if (method === 'getGenesisHash') return config.genesisHash;
    if (method === 'getMultipleAccounts') return { context: { slot: 42 }, value: [currencyAccounts.mint, currencyAccounts.destination] };
    const payment = visible ? evidence.get(method === 'getSignatureStatuses' ? params[0][0] : params[0]) : null;
    if (method === 'getTransaction') return payment?.transaction ?? null;
    if (method === 'getSignatureStatuses') return { value: [payment?.status ?? null] };
    throw new Error('FIXTURE_RPC_METHOD_DENIED');
  } };
  const store = storeLib.createCommerceFirestoreStore({ projectId: sdk.projectId, firestore: sdk, checkPrivilege() {} });
  const verifier = verifierLib.createCommerceVerifier({ config, rpc });
  const commerce = serviceLib.createCommerceService({ authenticateToken: bridge.authenticateToken, store, config, verifier, now: () => time });
  const handler = httpLib.createCommerceHttpHandler({ commerce, identity, origin });
  async function fetchFixture(url, init) {
    assert.equal(new URL(url).origin, 'https://commerce.example.invalid');
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
    const route = new URL(url).pathname;
    calls.push({ route, body: init.body ? JSON.parse(init.body) : null });
    const res = { statusCode: 0, headers: {}, headersSent: false, writableEnded: false,
      setHeader(key, value) { this.headers[key] = value; },
      end(text) { this.text = text; this.headersSent = true; this.writableEnded = true; },
    };
    await handler({ url: route, method: init.method, headers: { authorization: init.headers.Authorization,
      'content-type': init.headers['Content-Type'], origin }, rawHeaders: ['Authorization', init.headers.Authorization],
      rawBody: Buffer.from(init.body ?? '{}') }, res);
    assert.equal(res.headers['cache-control'], 'no-store');
    if (route === '/commerce/receipt' && res.statusCode === 200) {
      if (receiptMode === 'lost') { receiptMode = null; throw new Error('fixture network response lost'); }
      if (receiptMode === 'hold') {
        receiptMode = null; await new Promise((_resolve, reject) => {
          const abort = () => reject(new Error('fixture background request aborted'));
          if (init.signal.aborted) abort(); else init.signal.addEventListener('abort', abort, { once: true });
        });
      }
    }
    return new Response(res.text, { status: res.statusCode });
  }
  function client(lib) {
    return lib.commerce.createCommerceClient({ url: 'https://commerce.example.invalid', storage: disk,
      getToken: async () => uid === 'fixture-owner' ? 'fixture-token' : 'fixture-other-token', getUid: async () => uid,
      fetch: fetchFixture, now: () => time, timeoutMs: 1000, identityAudience: sdk.projectId, identityOrigin: origin });
  }
  const lib = loadClient(disk);
  function tokenAccount(owner) {
    const data = Buffer.alloc(165); mint.toBuffer().copy(data); owner.toBuffer().copy(data, 32);
    data.writeBigUInt64LE(1_000_000n, 64); data[108] = 1;
    return { data, owner: lib.wallet.COMMERCE_TOKEN_PROGRAM, executable: false, lamports: 2039280 };
  }
  const mintData = Buffer.alloc(82); mintData[44] = 6; mintData[45] = 1;
  const connection = {
    getGenesisHash: async () => config.genesisHash,
    getAccountInfo: async key => key.equals(mint)
      ? { data: mintData, owner: lib.wallet.COMMERCE_TOKEN_PROGRAM, executable: false, lamports: 1 }
      : { data: Buffer.alloc(0), owner: web3.SystemProgram.programId, executable: false, lamports: 1_000_000_000 },
    getMultipleAccountsInfo: async keys => {
      assert.deepEqual(Array.from(keys, k => k.toBase58()), [lib.wallet.commerceAta(payer.publicKey, mint).toBase58(),
        lib.wallet.commerceAta(merchant.publicKey, mint).toBase58()]);
      return [tokenAccount(payer.publicKey), tokenAccount(merchant.publicKey)];
    },
    getLatestBlockhash: async () => ({ blockhash: merchant.publicKey.toBase58(), lastValidBlockHeight: 99 }),
    getFeeForMessage: async () => ({ value: 5000 }),
    simulateTransaction: async tx => { assert.equal(tx.message.compiledInstructions.length, 2); return { value: { err: null } }; },
    getBlockHeight: async () => 1,
    async sendRawTransaction(raw, settings) {
      counts.broadcasts++; events.push('broadcast');
      assert.equal(settings.maxRetries, 0); assert.equal(settings.skipPreflight, false);
      const tx = web3.VersionedTransaction.deserialize(raw), message = tx.message;
      const sig = lib.wallet.validateCommerceSignedTransaction(raw, message.serialize(), tx.version);
      const keys = tx.version === 0 ? message.staticAccountKeys : message.accountKeys;
      const [transfer, memo] = message.compiledInstructions;
      assert.equal(keys[memo.programIdIndex].toBase58(), verifierLib.MEMO);
      const quoteId = Buffer.from(memo.data).toString().split('/').at(-1);
      const record = sdk.docs.get(`commerceQuotes/${quoteId}`), q = record.quote;
      assert.equal(lib.commerce.readCommercePending(disk).find(p => p.quote.id === q.id)?.signature, sig);
      const accounts = transfer.accountKeyIndexes ?? transfer.accounts;
      const data = Buffer.from(transfer.data);
      const isSol = keys[transfer.programIdIndex].equals(web3.SystemProgram.programId);
      const amount = data.readBigUInt64LE(isSol ? 4 : 1).toString();
      assert.equal(amount, q.amount); assert.equal(q.currency, isSol ? 'SOL' : 'SKR');
      assert.equal(data.length, isSol ? 12 : 10); assert.equal(isSol ? data.readUInt32LE(0) : data[0], isSol ? 2 : 12);
      const info = isSol ? { source: keys[accounts[0]].toBase58(), destination: keys[accounts[1]].toBase58(), lamports: amount }
        : { source: keys[accounts[0]].toBase58(), mint: keys[accounts[1]].toBase58(), destination: keys[accounts[2]].toBase58(),
          authority: keys[accounts[3]].toBase58(), tokenAmount: { amount, decimals: data[9] } };
      const f = support.transactionFixture(q, sig, record.issuedAt), oldKeys = f.transaction.transaction.message.accountKeys;
      const actualKeys = keys.map((key, i) => ({ pubkey: key.toBase58(), signer: message.isAccountSigner(i),
        writable: message.isAccountWritable(i), source: 'transaction' }));
      for (const field of ['preBalances', 'postBalances']) {
        const balances = f.transaction.meta[field];
        f.transaction.meta[field] = actualKeys.map(key => balances[oldKeys.findIndex(k => k.pubkey === key.pubkey)]);
      }
      for (const field of ['preTokenBalances', 'postTokenBalances']) for (const balance of f.transaction.meta[field]) {
        balance.accountIndex = actualKeys.findIndex(key => key.pubkey === oldKeys[balance.accountIndex].pubkey);
      }
      f.transaction.version = tx.version;
      f.transaction.transaction.message = { accountKeys: actualKeys, recentBlockhash: message.recentBlockhash,
        instructions: [{ programId: keys[transfer.programIdIndex].toBase58(), program: isSol ? 'system' : 'spl-token',
          parsed: { type: isSol ? 'transfer' : 'transferChecked', info } },
        { programId: verifierLib.MEMO, program: 'spl-memo', parsed: Buffer.from(memo.data).toString() }] };
      evidence.set(sig, f);
      if (broadcastMode === 'lost') { broadcastMode = null; throw new Error('fixture RPC response lost'); }
      if (broadcastMode === 'different') { broadcastMode = null; return 'different-signature'; }
      return sig;
    },
  };
  const transport = lib.wallet.createCommerceWalletTransport({ cluster: 'devnet', rpcUrl: 'https://rpc.example.invalid',
    genesisHash: config.genesisHash, skrMint: config.mint, skrDecimals: config.decimals, identity: { name: 'Fixture', uri: origin } }, {
    connection, now: () => time, walletTimeoutMs: 1000,
    capabilities: async () => ({ supportsV0: !options.legacy, supportedTransactionVersions: options.legacy ? ['legacy'] : [0] }),
    sign: async (raw, expected, operationSignal) => {
      counts.signs++; events.push('sign'); assert.equal(expected, payer.publicKey.toBase58());
      if (delayedSign) await delayedSign(operationSignal);
      const tx = web3.VersionedTransaction.deserialize(raw); tx.sign([payer]); return tx.serialize();
    },
  });
  const api = client(lib);
  async function bind(signer = payer) {
    await api.bindWallet(payer.publicKey.toBase58(), async message => {
      counts.proofSigns++;
      const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'),
        Buffer.from(signer.secretKey.subarray(0, 32))]), format: 'der', type: 'pkcs8' });
      return sign(null, Buffer.from(message), key).toString('base64');
    }, signal());
  }
  function balance() { return sdk.docs.get(`commerceBalances/${Buffer.from('fixture-owner').toString('hex')}`); }
  return { api, lib, transport, disk, sdk, calls, counts, events, client, bind, balance,
    request: (route, body) => fetchFixture(`https://commerce.example.invalid${route}`, { method: 'POST',
      headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: signal(), redirect: 'error', credentials: 'omit', cache: 'no-store' }),
    reveal() { visible = true; }, advance(ms) { time += ms; }, setUid(value) { uid = value; }, getUid: async () => uid,
    holdSign(work) { delayedSign = work; }, get time() { return time; },
    reload() { const next = loadClient(disk); return { lib: next, api: client(next) }; },
  };
}

for (const productId of ['runs-3', 'std-500']) for (const currency of ['SOL', 'SKR']) {
  test(`fixture HTTP E2E: wallet proof -> ${productId}/${currency} -> signed transaction -> receipt`, async () => {
    const f = await fixture({ legacy: currency === 'SOL' });
    await assert.rejects(f.api.quote(productId, currency, payer.publicKey.toBase58(), signal()), /ownership/);
    assert.equal(f.counts.signs, 0); assert.equal(f.sdk.docs.size, 0);
    await f.bind();
    const q = await f.api.quote(productId, currency, payer.publicKey.toBase58(), signal());
    const prepared = await f.transport.prepare(q, signal());
    assert.equal(f.counts.signs, 0); assert.equal(f.api.pending().length, 0);
    const receipt = await f.api.purchase(q, prepared, signal());
    assert.equal(receipt.status, 'confirmed'); assert.equal(f.counts.broadcasts, 1);
    assert.deepEqual(f.events, ['sign', 'broadcast']);
    assert.deepEqual(f.balance(), { runs: String(q.runs), std: String(q.std) });
    const quoteCall = f.calls.find(call => call.route === '/commerce/quote' && call.body.productId === productId);
    assert.deepEqual(quoteCall.body, { productId, currency, payer: payer.publicKey.toBase58() });
    let state = f.lib.commerce.switchCommerceAccount(f.lib.store.DEFAULT_STATE, 'fixture-owner', q.payer);
    const before = state;
    state = f.lib.commerce.applyScopedCommerceReceipt(state, receipt, 'fixture-owner');
    assert.equal(state.paidRuns, q.runs); assert.equal(state.tokens, q.std);
    assert.equal(state.dailyFreeLeft, before.dailyFreeLeft); assert.equal(state.prizePool, before.prizePool);
    f.lib.store.saveState(state);
    const reload = f.reload(), restored = reload.lib.store.loadState();
    const repeats = await Promise.all(Array.from({ length: 4 }, () => reload.api.reconcile(reload.api.pending()[0], signal())));
    for (const repeated of repeats) assert.strictEqual(reload.lib.commerce.applyScopedCommerceReceipt(restored, repeated, 'fixture-owner'), restored);
    assert.deepEqual(f.balance(), { runs: String(q.runs), std: String(q.std) });
    await assert.rejects(reload.api.purchase(q, prepared, signal()), /already signed/);
    assert.equal(f.counts.signs, 1); assert.equal(f.counts.broadcasts, 1);
    assert.equal([...f.sdk.docs.keys()].filter(key => key.startsWith('commerceReceipts/')).length, 1);
    assert.equal([...f.sdk.docs.keys()].filter(key => key.startsWith('commerceLedger/')).length, 1);
  });

  test(`fixture recovery: ambiguous RPC + unavailable history + expired quote/reload ${productId}/${currency}`, async () => {
    const f = await fixture({ broadcastMode: 'lost', visible: false }); await f.bind();
    const q = await f.api.quote(productId, currency, payer.publicKey.toBase58(), signal());
    const prepared = await f.transport.prepare(q, signal());
    await assert.rejects(f.api.purchase(q, prepared, signal()), /RPC response lost/);
    assert.equal(f.counts.broadcasts, 1); assert.equal(f.api.pending().length, 1); assert.equal(f.balance(), undefined);
    const reload = f.reload();
    await assert.rejects(reload.api.reconcile(reload.api.pending()[0], signal()), /ownership or commerce configuration/);
    assert.equal(f.balance(), undefined); assert.equal(f.counts.signs, 1);
    f.advance(600001); f.reveal();
    const receipt = await reload.api.reconcile(reload.api.pending()[0], signal());
    assert.equal(receipt.quoteId, q.id); assert.deepEqual(f.balance(), { runs: String(q.runs), std: String(q.std) });
    const again = await reload.api.reconcile(reload.api.pending()[0], signal());
    assert.deepEqual(plain(again), plain(receipt)); assert.equal(f.counts.broadcasts, 1);
    assert.equal(f.calls.filter(call => call.route === '/commerce/quote').length, 1);
  });
}

test('fixture receipt response loss after server commit recovers once after client reload', async () => {
  const f = await fixture({ receiptMode: 'lost' }); await f.bind();
  const q = await f.api.quote('std-500', 'SKR', payer.publicKey.toBase58(), signal());
  await assert.rejects(f.api.purchase(q, await f.transport.prepare(q, signal()), signal()), /response lost/);
  assert.deepEqual(f.balance(), { runs: '0', std: '500' });
  const reload = f.reload();
  const receipt = await reload.api.reconcile(reload.api.pending()[0], signal());
  const state = reload.lib.commerce.switchCommerceAccount(reload.lib.store.DEFAULT_STATE, 'fixture-owner', q.payer);
  const credited = reload.lib.commerce.applyScopedCommerceReceipt(state, receipt, 'fixture-owner');
  assert.equal(credited.tokens, 500); assert.equal(credited.paidRuns, 0);
  assert.strictEqual(reload.lib.commerce.applyScopedCommerceReceipt(credited, receipt, 'fixture-owner'), credited);
  assert.deepEqual(f.balance(), { runs: '0', std: '500' }); assert.equal(f.counts.broadcasts, 1);
});

test('fixture wrong RPC response signature preserves original journal; recovery does not rebroadcast', async () => {
  const f = await fixture({ broadcastMode: 'different' }); await f.bind();
  const q = await f.api.quote('runs-3', 'SOL', payer.publicKey.toBase58(), signal());
  await assert.rejects(f.api.purchase(q, await f.transport.prepare(q, signal()), signal()), /different transaction signature/);
  const pending = f.api.pending()[0]; assert.notEqual(pending.signature, 'different-signature');
  const receipt = await f.api.reconcile(pending, signal()); assert.equal(receipt.signature, pending.signature);
  assert.equal(f.counts.signs, 1); assert.equal(f.counts.broadcasts, 1);
});

test('fixture ownership proof rejects wrong signer and challenge replay; account change cannot steal receipts', async () => {
  const f = await fixture(); await assert.rejects(f.bind(other), /ownership/);
  assert.equal(f.balance(), undefined); await f.bind();
  const completed = f.calls.filter(call => call.route === '/identity/complete').at(-1);
  const challengeKey = `identityChallenges/${Buffer.from(completed.body.challengeId).toString('hex')}`;
  assert.equal(f.sdk.docs.get(challengeKey).consumed, true);
  const replay = await f.request('/identity/complete', completed.body);
  assert.equal(replay.status, 403); assert.equal((await replay.json()).error, 'IDENTITY_DENIED');
  const q = await f.api.quote('runs-3', 'SKR', payer.publicKey.toBase58(), signal());
  const receipt = await f.api.purchase(q, await f.transport.prepare(q, signal()), signal());
  f.setUid('fixture-other'); const before = f.calls.length;
  await assert.rejects(f.api.reconcile(f.api.pending()[0], signal()), /original purchase account/);
  assert.equal(f.calls.length, before);
  const scoped = f.lib.commerce.switchCommerceAccount(f.lib.store.DEFAULT_STATE, 'fixture-owner', q.payer);
  const credited = f.lib.commerce.applyScopedCommerceReceipt(scoped, receipt, 'fixture-owner');
  for (const [uid, wallet] of [['fixture-other', q.payer], ['fixture-owner', other.publicKey.toBase58()]]) {
    const switched = f.lib.commerce.switchCommerceAccount(credited, uid, wallet);
    assert.equal(switched.paidRuns, 0); assert.equal(switched.tokens, 0);
    assert.strictEqual(f.lib.commerce.applyScopedCommerceReceipt(switched, receipt, 'fixture-owner'), switched);
  }
  f.setUid('fixture-owner');
  assert.equal((await f.api.reconcile(f.api.pending()[0], signal())).quoteId, q.id);
  assert.deepEqual(f.balance(), { runs: '3', std: '0' }); assert.equal(f.counts.broadcasts, 1);
});

test('fixture background cancellation before sign resolves suppresses late journal and broadcast', async () => {
  const f = await fixture(); await f.bind(); let release, entered;
  const signing = new Promise(resolve => { entered = resolve; });
  f.holdSign(() => new Promise(resolve => { release = resolve; entered(); }));
  const q = await f.api.quote('runs-3', 'SOL', payer.publicKey.toBase58(), signal()), controller = new AbortController();
  const purchase = f.api.purchase(q, await f.transport.prepare(q, signal()), controller.signal);
  await signing; controller.abort(); await assert.rejects(purchase, /Cancelled/);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.api.pending().length, 0); assert.equal(f.counts.broadcasts, 0); assert.equal(f.balance(), undefined);
});

test('fixture background cancellation after broadcast/receipt commit preserves reload recovery', async () => {
  const f = await fixture({ receiptMode: 'hold' }); await f.bind();
  const q = await f.api.quote('runs-3', 'SKR', payer.publicKey.toBase58(), signal()), controller = new AbortController();
  const purchase = f.api.purchase(q, await f.transport.prepare(q, signal()), controller.signal);
  const failure = assert.rejects(purchase, /Cancelled/);
  for (let i = 0; i < 50 && !f.balance(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.balance(), { runs: '3', std: '0' }); controller.abort(); await failure;
  const reload = f.reload();
  const receipt = await reload.api.reconcile(reload.api.pending()[0], signal());
  assert.equal(receipt.runs, 3); assert.equal(f.counts.broadcasts, 1); assert.equal(f.counts.signs, 1);
});

test('actual purchase component unmount aborts late signing without broadcasting', async () => {
  const f = await fixture(); await f.bind(); let release;
  f.holdSign(() => new Promise(resolve => { release = resolve; }));
  const mounted = mountPurchases(f); await mounted.flush(); mounted.click('Buy'); await mounted.flush();
  assert.equal(f.counts.signs, 0); mounted.click('Confirm'); await mounted.flush(); assert.ok(release);
  const writes = mounted.writes; mounted.unmount(); release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mounted.writes, writes); assert.equal(f.counts.broadcasts, 0); assert.equal(f.api.pending().length, 0);
});

test('actual purchase component unmount after committed receipt leaves recovery for original account', async () => {
  const f = await fixture({ receiptMode: 'hold' }); await f.bind();
  const mounted = mountPurchases(f); await mounted.flush(); mounted.click('Buy'); await mounted.flush();
  mounted.click('Confirm'); await mounted.flush();
  assert.deepEqual(f.balance(), { runs: '1', std: '0' }); assert.equal(mounted.props.state.paidRuns, 0);
  const writes = mounted.writes; mounted.unmount(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(mounted.writes, writes);
  const reload = f.reload(), pending = reload.api.pending()[0];
  const receipt = await reload.api.reconcile(pending, signal());
  const restored = reload.lib.commerce.applyScopedCommerceReceipt(mounted.props.state, receipt, 'fixture-owner');
  assert.equal(restored.paidRuns, 1); assert.equal(f.counts.signs, 1); assert.equal(f.counts.broadcasts, 1);
});

test('fixture receipt credits are used by local game admission, not authoritative server counter debits', async () => {
  const f = await fixture(); await f.bind();
  const q = await f.api.quote('runs-3', 'SOL', payer.publicKey.toBase58(), signal());
  const receipt = await f.api.purchase(q, await f.transport.prepare(q, signal()), signal());
  let state = f.lib.commerce.switchCommerceAccount(f.lib.store.DEFAULT_STATE, 'fixture-owner', q.payer);
  state = f.lib.commerce.applyScopedCommerceReceipt(state, receipt, 'fixture-owner');
  state = { ...state, dailyFreeLeft: 0, lastRunReset: f.lib.store.todayStr(f.time) };
  const callsBefore = f.calls.length;
  const admitted = f.lib.runs.admitRun(state, { mode: 'waves', access: 'standard', waveLimit: 10, durationMinutes: 5 }, f.time);
  assert.equal(admitted.run.debit, 'paid'); assert.equal(admitted.state.paidRuns, 2);
  assert.equal(f.calls.length, callsBefore); assert.deepEqual(f.balance(), { runs: '3', std: '0' });
});

test('callable client blocks a new quote while same UID/payer broadcast outcome is unknown', async () => {
  const f = await fixture({ broadcastMode: 'lost', visible: false }); await f.bind();
  const first = await f.api.quote('runs-3', 'SOL', payer.publicKey.toBase58(), signal());
  await assert.rejects(f.api.purchase(first, await f.transport.prepare(first, signal()), signal()), /RPC response lost/);
  assert.equal(f.api.pending().length, 1); assert.equal(f.counts.broadcasts, 1); assert.equal(f.balance(), undefined);
  const second = await f.api.quote('runs-3', 'SOL', payer.publicKey.toBase58(), signal());
  assert.notEqual(second.id, first.id);
  await assert.rejects(f.api.purchase(second, await f.transport.prepare(second, signal()), signal()), /outcome is unknown/);
  assert.equal(f.counts.signs, 1); assert.equal(f.counts.broadcasts, 1); assert.equal(f.api.pending().length, 1);
  assert.equal(f.balance(), undefined);
  f.reveal();
  for (const pending of f.api.pending()) await f.api.reconcile(pending, signal());
  assert.deepEqual(f.balance(), { runs: '3', std: '0' });
  assert.equal(f.api.pending()[0].confirmedReceipt.quoteId, first.id);
  const secondReceipt = await f.api.purchase(second, await f.transport.prepare(second, signal()), signal());
  assert.equal(secondReceipt.quoteId, second.id); assert.equal(f.counts.broadcasts, 2);
  assert.deepEqual(f.balance(), { runs: '6', std: '0' });
});

test('pending entries from another UID or payer do not block the current wallet scope', async () => {
  const f = await fixture(); await f.bind();
  const q = await f.api.quote('runs-3', 'SOL', payer.publicKey.toBase58(), signal());
  for (const [id, uid, wallet, signature] of [
    ['b'.repeat(32), 'fixture-other', q.payer, '2'.repeat(88)],
    ['c'.repeat(32), 'fixture-owner', other.publicKey.toBase58(), '3'.repeat(88)],
  ]) f.lib.commerce.recordCommercePending(f.disk, { uid, signature,
    quote: { ...q, id, payer: wallet, memo: `SEEKER:TD/commerce/v1/${id}` } });
  const receipt = await f.api.purchase(q, await f.transport.prepare(q, signal()), signal());
  assert.equal(receipt.runs, 3); assert.equal(f.counts.broadcasts, 1); assert.equal(f.api.pending().length, 3);
  assert.deepEqual(f.balance(), { runs: '3', std: '0' });
});

test('confirmed history is retained; fixture-filled 256-entry acknowledged journal blocks later signing', async () => {
  const f = await fixture(); await f.bind();
  const q = await f.api.quote('runs-3', 'SOL', payer.publicKey.toBase58(), signal());
  const receipt = await f.api.purchase(q, await f.transport.prepare(q, signal()), signal());
  assert.equal(receipt.status, 'confirmed'); assert.equal(f.api.pending().length, 1);
  // Seed the remaining capacity; only the first entry above is a verified server receipt.
  const { encodeBase58 } = await server('identity.mjs');
  for (let i = 1; i < 256; i++) {
    const id = i.toString(16).padStart(32, '0');
    const signature = encodeBase58(Buffer.alloc(64, i));
    f.lib.commerce.recordCommercePending(f.disk, { uid: 'fixture-owner', signature,
      quote: { ...q, id, memo: `SEEKER:TD/commerce/v1/${id}` },
      confirmedReceipt: { id, quoteId: id, signature, payer: q.payer, runs: q.runs, std: q.std, status: 'confirmed' } });
  }
  assert.equal(f.api.pending().length, 256);
  const next = await f.api.quote('runs-3', 'SOL', q.payer, signal());
  await assert.rejects(f.api.purchase(next, await f.transport.prepare(next, signal()), signal()), /journal is full/);
  assert.equal(f.counts.signs, 1);
  assert.equal(f.counts.broadcasts, 1); assert.equal(f.api.pending().length, 256);
  assert.deepEqual(f.balance(), { runs: '3', std: '0' });
});

test('durable acknowledgement before cache update survives crash and restores the grant exactly once', async () => {
  const f = await fixture(); await f.bind();
  const q = await f.api.quote('std-500', 'SKR', payer.publicKey.toBase58(), signal());
  await f.api.purchase(q, await f.transport.prepare(q, signal()), signal());
  assert.equal(f.api.pending()[0].confirmedReceipt.std, 500);
  const reload = f.reload();
  let state = reload.lib.commerce.switchCommerceAccount(reload.lib.store.loadState(), 'fixture-owner', q.payer);
  assert.equal(state.tokens, 0);
  const pending = reload.api.pending()[0], before = f.calls.length;
  const receipt = await reload.api.reconcile(pending, signal());
  assert.equal(f.calls.length, before + 1);
  state = reload.lib.commerce.applyScopedCommerceReceipt(state, receipt, 'fixture-owner');
  reload.lib.store.saveState(state);
  const again = f.reload(), restored = again.lib.store.loadState();
  assert.equal(restored.tokens, 500);
  assert.strictEqual(again.lib.commerce.applyScopedCommerceReceipt(restored,
    await again.api.reconcile(again.api.pending()[0], signal()), 'fixture-owner'), restored);
  const next = await again.api.quote('runs-3', 'SOL', q.payer, signal());
  await again.api.purchase(next, await f.transport.prepare(next, signal()), signal());
  assert.equal(f.counts.broadcasts, 2); assert.equal(again.api.pending().length, 2);
  assert.deepEqual(f.balance(), { runs: '3', std: '500' });
});

test('concurrent prepared new quotes are checked again at the durable journal boundary', async () => {
  const f = await fixture({ broadcastMode: 'lost', visible: false }); await f.bind();
  const quotes = await Promise.all(['SOL', 'SKR'].map(currency => f.api.quote('runs-3', currency, payer.publicKey.toBase58(), signal())));
  const prepared = await Promise.all(quotes.map(q => f.transport.prepare(q, signal()))), releases = [];
  f.holdSign(() => new Promise(resolve => releases.push(resolve)));
  const purchases = quotes.map((q, i) => f.api.purchase(q, prepared[i], signal()));
  const results = Promise.allSettled(purchases);
  for (let i = 0; i < 50 && releases.length < 2; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 2);
  releases[0](); releases[1]();
  const settled = await results;
  assert.equal(settled[0].status, 'rejected'); assert.match(settled[0].reason.message, /RPC response lost/);
  assert.equal(settled[1].status, 'rejected'); assert.match(settled[1].reason.message, /outcome is unknown/);
  assert.equal(f.counts.signs, 2); assert.equal(f.counts.broadcasts, 1); assert.equal(f.api.pending().length, 1);
  assert.equal(f.balance(), undefined);
});

test('failed or dropped acknowledgement storage stays unknown and recovers without broadcasting again', async () => {
  for (const mode of ['throw', 'drop']) {
    const f = await fixture(); await f.bind();
    const originalWrite = f.disk.setItem;
    f.disk.setItem = (key, value) => {
      if (value.includes('confirmedReceipt')) { if (mode === 'throw') throw new Error('fixture ack disk full'); return; }
      originalWrite(key, value);
    };
    const q = await f.api.quote('runs-3', 'SOL', payer.publicKey.toBase58(), signal());
    await assert.rejects(f.api.purchase(q, await f.transport.prepare(q, signal()), signal()), /ack disk full|persist confirmed/);
    assert.equal(f.api.pending()[0].confirmedReceipt, undefined); assert.deepEqual(f.balance(), { runs: '3', std: '0' });
    const next = await f.api.quote('std-500', 'SKR', q.payer, signal());
    await assert.rejects(f.api.purchase(next, await f.transport.prepare(next, signal()), signal()), /outcome is unknown/);
    assert.equal(f.counts.signs, 1); assert.equal(f.counts.broadcasts, 1);
    f.disk.setItem = originalWrite;
    const reload = f.reload();
    assert.equal((await reload.api.reconcile(reload.api.pending()[0], signal())).quoteId, q.id);
    assert.equal(reload.api.pending()[0].confirmedReceipt.quoteId, q.id);
    assert.equal(f.counts.broadcasts, 1); assert.deepEqual(f.balance(), { runs: '3', std: '0' });
  }
});
