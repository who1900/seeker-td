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
function fixture(enabled = false) {
  const cache = new Map(), calls = { wallet: 0, balances: 0, commerce: 0 };
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    vm.runInNewContext(code, { module, exports: module.exports, console, AbortController, Date, setTimeout, clearTimeout,
      require: id => {
        if (id.endsWith('.css')) return {};
        if (id === '../wallet') return { getWalletCluster: () => 'devnet',
          connectWallet() { calls.wallet++; throw new Error('REAL_WALLET_DENIED'); },
          disconnectWallet() { calls.wallet++; throw new Error('REAL_WALLET_DENIED'); },
          signWalletMessage() { calls.wallet++; throw new Error('REAL_WALLET_DENIED'); },
          getSolBalance() { calls.balances++; throw new Error('REAL_RPC_DENIED'); },
          getSkrBalance() { calls.balances++; throw new Error('REAL_RPC_DENIED'); },
        };
        if (id.includes('commerceRuntime')) return { commerceRuntimeAvailability: () => ({ enabled, reason: 'RAW_ENV_ERROR' }),
          commerceFirebaseUid: async () => null, getCommerceClient() { calls.commerce++; throw new Error('REAL_HTTP_DENIED'); },
          getCommerceWalletTransport() { calls.wallet++; throw new Error('REAL_WALLET_DENIED'); } };
        if (id.startsWith('.')) {
          const base = path.resolve(path.dirname(file), id);
          return load(['.ts', '.tsx'].map(ext => base + ext).find(candidate => fs.existsSync(candidate)));
        }
        return require(id);
      },
    }, { filename: file }); return module.exports;
  }
  return { load: name => load(path.join(__dirname, name)), calls };
}
const state = { walletConnected: true, walletAddr: payer, tokens: 420, paidRuns: 2, dailyFreeLeft: 1, dailyFreeMax: 3 };
function render(f, name, props = {}) {
  const Component = f.load(`${name}.tsx`)[name];
  return renderToStaticMarkup(React.createElement(Component, { state, setState() { throw new Error('SSR state write'); }, nav() {}, ...props }));
}
test('connected Wallet: one Devnet badge, truncated accessible address, copy, three balance cells and concise actions', () => {
  const f = fixture(), html = render(f, 'WalletScreen');
  assert.ok(html.includes('<h1>Wallet</h1>')); assert.equal((html.match(/>Devnet<\/span>/g) || []).length, 1);
  assert.ok(html.includes(`>${payer.slice(0, 4)}...${payer.slice(-4)}</span>`));
  assert.ok(html.includes(`aria-label="Wallet address: ${payer}"`)); assert.ok(html.includes('aria-label="Copy wallet address"'));
  for (const unit of ['SOL', 'SKR', 'STD']) assert.ok(html.includes(`<dt>${unit}</dt>`));
  assert.ok(html.includes('Refresh')); assert.ok(html.includes('Disconnect')); assert.ok(!html.includes('Verify wallet'));
  assert.equal((html.match(/Purchases unavailable/g) || []).length, 0);
  assert.ok(html.includes('Activity')); assert.ok(html.includes('No verified purchases yet.'));
  assert.doesNotMatch(html, /Mobile Wallet Adapter|seed phrase|Cached address|ownership|Mainnet locked|test SOL|test SKR|RAW_ENV_ERROR|VITE_|closed in-game|withdraw/);
  assert.deepEqual(f.calls, { wallet: 0, balances: 0, commerce: 0 });
});
test('wallet verification appears only with configured commerce; disconnected state offers Connect wallet', () => {
  const enabled = fixture(true); assert.ok(render(enabled, 'WalletScreen').includes('Verify wallet'));
  const f = fixture(), html = render(f, 'WalletScreen', { state: { ...state, walletConnected: false, walletAddr: '' } });
  assert.ok(html.includes('Connect wallet')); assert.ok(!html.includes('Disconnect')); assert.ok(!html.includes('Verify wallet'));
  assert.deepEqual(f.calls, { wallet: 0, balances: 0, commerce: 0 });
});
test('Runs: compact free/extra counts, one Devnet badge, Play/Wallet nav and no diagnostic paragraphs', () => {
  const f = fixture(), html = render(f, 'Paywall');
  assert.ok(html.includes('<h1>Runs</h1>')); assert.ok(html.includes('<dt>Free</dt><dd>1 / 3</dd>'));
  assert.ok(html.includes('<dt>Extra</dt><dd>2</dd>')); assert.ok(html.includes('Practice unlimited'));
  assert.ok(html.includes('>Play</button>')); assert.ok(html.includes('>Wallet</button>'));
  assert.equal((html.match(/>Devnet<\/span>/g) || []).length, 1);
  assert.equal((html.match(/Purchases unavailable/g) || []).length, 0);
  assert.ok(html.includes('Run checkout appears only when needed.'));
  assert.doesNotMatch(html, /Run credits|reset at|DEVNET pilot|USD pilot|No withdrawal|VITE_|Mainnet locked/);
  assert.deepEqual(f.calls, { wallet: 0, balances: 0, commerce: 0 });
});
test('balance-only formatting is compact without wrapping; quote amounts are not rounded', () => {
  const { compactWalletBalance } = fixture().load('WalletScreen.tsx');
  assert.equal(compactWalletBalance('2.48294532'), '2.4829');
  assert.equal(compactWalletBalance('0.000000001'), '<0.0001');
  assert.equal(compactWalletBalance(null), '—'); assert.equal(compactWalletBalance('0'), '0');
  assert.ok(compactWalletBalance('1234567890.123456').length <= 8);
  const css = fs.readFileSync(path.join(__dirname, '../components/commerce.css'), 'utf8');
  assert.match(css, /\.wallet-balances dd\s*\{[^}]*white-space:\s*nowrap/);
  const purchase = fs.readFileSync(path.join(__dirname, '../components/CommercePurchases.tsx'), 'utf8');
  assert.doesNotMatch(purchase, /compactWalletBalance/);
  assert.match(purchase, /formatAtomic\(checkout\.quote\.amount, checkout\.quote\.decimals\)/);
});
