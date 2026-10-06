const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { Keypair } = require('@solana/web3.js');
const payer = Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey.toBase58();
const other = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey.toBase58();
const quote = { id: 'a'.repeat(32), productId: 'runs-1', currency: 'SOL', amount: '1000000', decimals: 9, mint: null,
  payer, recipient: other, cluster: 'devnet', genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  expiresAt: Date.now() + 60000, runs: 1, std: 0, memo: `SEEKER:TD/commerce/v1/${'a'.repeat(32)}` };
const catalog = { enabled: true, reason: null, recipient: other, genesisHash: quote.genesisHash, cluster: 'devnet',
  products: [{ id: 'runs-1', title: '1 extra run', runs: 1, std: 0, usdCents: 25,
    prices: [{ currency: 'SOL', amount: '1000000', decimals: 9, mint: null }] }] };
function load(react = React) {
  const cache = new Map();
  function at(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    vm.runInNewContext(code, { module, exports: module.exports, console, AbortController, Date, setTimeout, clearTimeout,
      require: id => id === 'react' ? react : id.endsWith('.css') ? {}
        : id.includes('commerceRuntime') ? {
          commerceRuntimeAvailability: () => ({ enabled: false, reason: 'Purchases disabled: no trusted HTTPS commerce server.' }),
          commerceFirebaseUid: async () => null,
          getCommerceClient() { throw new Error('REAL_HTTP_DENIED'); },
          getCommerceWalletTransport() { throw new Error('REAL_WALLET_DENIED'); },
        } : id.startsWith('.') ? at(path.resolve(path.dirname(filename), `${id}.ts`)) : require(id),
    }, { filename }); return module.exports;
  }
  return at(path.join(__dirname, 'CommercePurchases.tsx'));
}
test('compact SSR: one unavailable status, plain currencies, Devnet badge and no invented prices', () => {
  const { CommercePurchases, CommerceCurrencySelector, CommerceAddress, commerceErrorMessage } = load();
  const state = { tokens: 0, paidRuns: 0, walletConnected: true, walletAddr: payer };
  const html = renderToStaticMarkup(React.createElement(CommercePurchases, { state, setState() { throw new Error('SSR write'); }, kind: 'runs' }));
  assert.equal((html.match(/Purchases unavailable/g) || []).length, 1);
  assert.ok(html.includes('>SOL</button>')); assert.ok(html.includes('>SKR</button>')); assert.ok(html.includes('>Devnet</span>'));
  assert.ok(!html.includes('Buy 0.01')); assert.ok(!html.includes('EARN SOL')); assert.ok(!html.includes('USD pilot reference'));
  assert.doesNotMatch(html, /test SOL|test SKR|Mainnet locked|closed in-game|withdrawal|token value|VITE_|HTTPS|server catalog|Firebase/);
  const buttons = renderToStaticMarkup(React.createElement(CommerceCurrencySelector, { currency: 'SKR', onChange() {}, disabled: false }));
  assert.ok(buttons.includes('aria-pressed="true">SKR')); assert.ok(buttons.includes('role="group"'));
  const address = renderToStaticMarkup(React.createElement(CommerceAddress, { address: payer, label: 'Wallet address' }));
  assert.ok(address.includes(`>${payer.slice(0, 4)}...${payer.slice(-4)}</span>`));
  assert.ok(address.includes(`title="${payer}"`)); assert.ok(address.includes(`aria-label="Wallet address: ${payer}"`));
  assert.ok(address.includes('aria-label="Copy wallet address"'));
  assert.equal(commerceErrorMessage(new Error('Timed out RPC with SECRET_TOKEN')), 'Connection lost. Check status.');
  assert.equal(commerceErrorMessage(new Error('VITE_COMMERCE_URL is not configured')), 'Purchases unavailable');
  assert.equal(commerceErrorMessage(new Error('Cancelled. No automatic resend.')), 'Cancelled');
  const css = fs.readFileSync(path.join(__dirname, 'commerce.css'), 'utf8');
  assert.match(css, /min-height:\s*48px/); assert.match(css, /min-width:\s*48px/); assert.match(css, /focus-visible/);
  assert.match(css, /font-family:\s*var\(--sans\)/); assert.match(css, /font-size:\s*14px/);
  assert.doesNotMatch(css, /Inter|Roboto Mono|#fafaf3/);
});
function harness() {
  const slots = []; let cursor = 0, effects = [], tree;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(action, deps) {
      const i = cursor++, previous = slots[i];
      if (!previous || deps.some((value, index) => value !== previous.deps[index])) {
        previous?.cleanup?.(); slots[i] = { deps }; effects.push(() => { slots[i].cleanup = action(); });
      }
    },
  };
  const { CommercePurchases } = load(hooks), pending = [];
  const calls = { quotes: 0, prepares: 0, sends: 0, receipts: 0 };
  let uid = 'uid-a', receiptStatus = 'pending', delayed;
  const props = { state: { tokens: 420, paidRuns: 0, walletConnected: true, walletAddr: payer }, kind: 'runs',
    getUid: async () => uid, setState(update) { props.state = update(props.state); },
    client: { catalog: async () => catalog, pending: () => pending, quote: async () => { calls.quotes++; return quote; },
      purchase: async () => { calls.sends++; pending.push({ uid, quote, signature: '2'.repeat(88) }); return null; },
      reconcile: async () => { calls.receipts++; return receiptStatus === 'pending' ? null
        : { id: quote.id, quoteId: quote.id, signature: '2'.repeat(88), payer, runs: 1, std: 0, status: 'confirmed' }; },
    }, transport: { prepare: async (_q, signal) => { calls.prepares++; if (delayed) await delayed(signal);
      return { feeLamports: '5000', rentLamports: '0', send() { throw new Error('Shared client owns send'); } }; } },
  };
  function render() { cursor = 0; tree = CommercePurchases(props); return tree; }
  function nodes(element, result = []) {
    if (!element || typeof element !== 'object') return result;
    if (typeof element.type === 'function') return nodes(element.type(element.props), result);
    result.push(element);
    for (const child of [element.props?.children].flat(Infinity)) nodes(child, result);
    return result;
  }
  function text(element) {
    if (element == null || typeof element === 'boolean') return '';
    if (typeof element !== 'object') return String(element);
    return [element.props?.children].flat(Infinity).map(text).join('');
  }
  async function flush() {
    for (let i = 0; i < 24; i++) { render(); const jobs = effects; effects = []; jobs.forEach(job => job()); await Promise.resolve(); }
    render();
  }
  function button(label) { render(); return nodes(tree).find(node => node.type === 'button' && text(node).includes(label)); }
  return { props, calls, flush, button, setUid(value) { uid = value; }, confirm() { receiptStatus = 'confirmed'; },
    delay(work) { delayed = work; }, content: () => text(render()) };
}
test('UI: quote review is explicit; pending recovery never signs twice and deduplicates server credits', async () => {
  const h = harness(); await h.flush();
  assert.equal(h.calls.sends, 0); const review = h.button('Buy 0.001 SOL'); assert.equal(review.props.disabled, false);
  await review.props.onClick(); await h.flush();
  assert.equal(h.calls.quotes, 1); assert.equal(h.calls.prepares, 1); assert.equal(h.calls.sends, 0);
  assert.ok(h.content().includes('Confirm purchase')); assert.ok(h.content().includes('0.000005 SOL'));
  assert.ok(h.content().includes('1 run')); assert.ok(h.content().includes('0.001 SOL'));
  assert.ok(h.content().includes('Total')); assert.ok(h.content().includes('0.001005 SOL'));
  assert.doesNotMatch(h.content(), /Payer:|mint:|Programs:|Expires:|nonce|USD/);
  await h.button('Confirm').props.onClick(); await h.flush();
  assert.equal(h.calls.sends, 1); assert.equal(h.props.state.paidRuns, 0); assert.ok(h.button('Check status'));
  assert.equal(h.button('Buy 0.001 SOL').props.disabled, true);
  await h.button('Check status').props.onClick(); await h.flush();
  assert.equal(h.calls.sends, 1); assert.equal(h.props.state.paidRuns, 0);
  h.confirm(); const checkStatus = h.button('Check status'); await checkStatus.props.onClick(); await h.flush();
  assert.equal(h.calls.sends, 1); assert.equal(h.props.state.paidRuns, 1);
  assert.equal(h.props.state.tokens, 0); assert.ok(h.content().includes('Purchase complete'));
  await checkStatus.props.onClick(); await h.flush();
  assert.equal(h.props.state.paidRuns, 1); assert.equal(h.calls.sends, 1);
});
test('wallet switch cancels late quote preparation and prevents original credits reaching another wallet', async () => {
  const h = harness(); await h.flush(); let release;
  h.delay(() => new Promise(resolve => { release = resolve; }));
  h.button('Buy 0.001 SOL').props.onClick(); await h.flush(); assert.ok(release);
  h.props.state = { ...h.props.state, walletAddr: other }; await h.flush(); release(); await h.flush();
  assert.equal(h.calls.sends, 0); assert.equal(h.props.state.paidRuns, 0); assert.ok(!h.button('Confirm'));
});
test('short Cancel still clears review without any payment; changed UID prevents approval', async () => {
  const h = harness(); await h.flush(); await h.button('Buy 0.001 SOL').props.onClick(); await h.flush();
  h.button('Cancel').props.onClick(); await h.flush();
  assert.equal(h.calls.sends, 0); assert.ok(!h.button('Confirm')); assert.ok(h.content().includes('Cancelled'));
  await h.button('Buy 0.001 SOL').props.onClick(); await h.flush(); h.setUid('uid-b');
  await h.button('Confirm').props.onClick(); await h.flush();
  assert.equal(h.calls.sends, 0); assert.equal(h.props.state.paidRuns, 0);
  assert.ok(h.content().includes('Reconnect the purchase wallet.'));
});

test('onComplete follows durable receipt application, stays outside updater and is once per component/scope/quote', async () => {
  const h = harness(), callbacks = [];
  let inUpdater = false;
  h.props.setState = update => {
    inUpdater = true;
    const next = update(h.props.state);
    update(h.props.state);
    inUpdater = false;
    h.props.state = next;
    return true;
  };
  h.props.onComplete = receipt => {
    assert.equal(inUpdater, false);
    assert.equal(h.props.state.paidRuns, 1);
    assert.ok(h.props.state.commerceReceiptIds.includes(receipt.id));
    callbacks.push(receipt);
  };
  await h.flush(); await h.button('Buy 0.001 SOL').props.onClick(); await h.flush();
  await h.button('Confirm').props.onClick(); await h.flush();
  assert.equal(callbacks.length, 0);
  h.confirm(); const check = h.button('Check status');
  await check.props.onClick(); await h.flush();
  assert.equal(callbacks.length, 1);
  await check.props.onClick(); await h.flush();
  assert.equal(callbacks.length, 1);
  h.props.state = { ...h.props.state, walletAddr: other }; await h.flush();
  h.props.state = { ...h.props.state, walletAddr: payer }; await h.flush();
  await check.props.onClick(); await h.flush();
  assert.equal(callbacks.length, 1);
});

test('failed receipt persistence retains recovery, never announces completion and retries callback after durable apply', async () => {
  const h = harness(), callbacks = [];
  h.props.onComplete = receipt => callbacks.push(receipt);
  await h.flush(); await h.button('Buy 0.001 SOL').props.onClick(); await h.flush();
  await h.button('Confirm').props.onClick(); await h.flush(); h.confirm();
  h.props.setState = update => { update(h.props.state); return false; };
  await h.button('Check status').props.onClick(); await h.flush();
  assert.equal(h.props.state.paidRuns, 0); assert.equal(callbacks.length, 0);
  assert.ok(h.button('Check status')); assert.doesNotMatch(h.content(), /Purchase complete/);
  h.props.setState = update => { h.props.state = update(h.props.state); return true; };
  await h.button('Check status').props.onClick(); await h.flush();
  assert.equal(h.props.state.paidRuns, 1); assert.equal(callbacks.length, 1);
});

test('late confirmed receipt after UID change, wallet change, disconnect or Cancel never credits or calls completion', async () => {
  for (const change of ['uid', 'wallet', 'disconnect', 'cancel']) {
    const h = harness(), callbacks = [];
    h.props.onComplete = receipt => callbacks.push(receipt);
    await h.flush(); await h.button('Buy 0.001 SOL').props.onClick(); await h.flush();
    await h.button('Confirm').props.onClick(); await h.flush();
    let release;
    h.props.client.reconcile = () => new Promise(resolve => { release = resolve; });
    await h.button('Check status').props.onClick(); await h.flush(); assert.ok(release);
    if (change === 'uid') h.setUid('uid-b');
    if (change === 'wallet') h.props.state = { ...h.props.state, walletAddr: other };
    if (change === 'disconnect') h.props.state = { ...h.props.state, walletConnected: false };
    if (change === 'cancel') h.button('Cancel').props.onClick();
    await h.flush();
    release({ id: quote.id, quoteId: quote.id, signature: '2'.repeat(88), payer, runs: 1, std: 0, status: 'confirmed' });
    await h.flush();
    assert.equal(h.props.state.paidRuns, 0, change); assert.equal(callbacks.length, 0, change);
  }
});

test('immediate confirmed purchase callback requires synchronous persistence; void fixtures remain compatible', async () => {
  for (const setter of ['boolean', 'void', 'false', 'deferred']) {
    const h = harness(), callbacks = [];
    h.props.onComplete = receipt => callbacks.push(receipt);
    h.props.client.purchase = async () => ({ id: quote.id, quoteId: quote.id, signature: '2'.repeat(88), payer, runs: 1, std: 0, status: 'confirmed' });
    await h.flush(); await h.button('Buy 0.001 SOL').props.onClick(); await h.flush();
    h.props.setState = update => {
      if (setter === 'deferred') return;
      const next = update(h.props.state);
      if (setter === 'false') return false;
      h.props.state = next;
      return setter === 'boolean' ? true : undefined;
    };
    await h.button('Confirm').props.onClick(); await h.flush();
    assert.equal(callbacks.length, ['boolean', 'void'].includes(setter) ? 1 : 0, setter);
    if (['false', 'deferred'].includes(setter)) assert.doesNotMatch(h.content(), /Purchase complete/);
  }
});

test('repeated updater ending in another account cannot report a successful scoped apply', async () => {
  const h = harness(), callbacks = [];
  h.props.onComplete = receipt => callbacks.push(receipt);
  await h.flush(); await h.button('Buy 0.001 SOL').props.onClick(); await h.flush();
  await h.button('Confirm').props.onClick(); await h.flush(); h.confirm();
  h.props.setState = update => {
    update(h.props.state);
    h.props.state = update({ ...h.props.state, walletAddr: other, commerceAccount: `uid-a:${other}` });
    return true;
  };
  await h.button('Check status').props.onClick(); await h.flush();
  assert.equal(callbacks.length, 0); assert.equal(h.props.state.paidRuns, 0);
  assert.doesNotMatch(h.content(), /Purchase complete/);
});

test('recovery callbacks are product-kind scoped; empty recovery cannot fabricate completion', async () => {
  const h = harness(), callbacks = [];
  h.props.onComplete = receipt => callbacks.push(receipt);
  await h.flush(); await h.button('Buy 0.001 SOL').props.onClick(); await h.flush();
  await h.button('Confirm').props.onClick(); await h.flush();
  h.props.kind = 'std'; h.confirm();
  const check = h.button('Check status');
  await check.props.onClick(); await h.flush();
  assert.equal(callbacks.length, 0); assert.equal(h.props.state.paidRuns, 1);
  h.props.client.pending = () => [];
  await check.props.onClick(); await h.flush();
  assert.equal(callbacks.length, 0); assert.doesNotMatch(h.content(), /Purchase complete/);
});
