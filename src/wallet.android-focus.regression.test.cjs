const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const activity = read('android/app/src/main/java/app/seekdef/game/MainActivity.java');
const sdk = read('node_modules/@solana-mobile/mobile-wallet-adapter-protocol/lib/esm/index.browser.js');
const detection = sdk.slice(sdk.indexOf('function getDetectionPromise()'), sdk.indexOf('let _frame = null;'));
const launch = sdk.slice(sdk.indexOf('async function launchAssociation('), sdk.indexOf('async function startSession('));

function harness() {
  const eventNames = activity.match(/String eventName = hasFocus \? "([^"]+)" : "([^"]+)";/);
  const scriptParts = activity.match(/webView\.evaluateJavascript\(\s*("(?:\\.|[^"\\])*")\s*\+\s*eventName\s*\+\s*("(?:\\.|[^"\\])*")\s*,\s*null\s*\);/);
  assert.ok(eventNames && scriptParts, 'Use the actual Java event mapping and evaluated JavaScript');
  const timers = new Map();
  const calls = [];
  const window = new EventTarget();
  window.location = { assign: url => calls.push(url.toString()) };
  const context = vm.createContext({ window, Event,
    Browser: { Other: 'Other', Firefox: 'Firefox' }, getBrowser: () => 'Other',
    assertUnreachable: () => { throw new Error('UNEXPECTED_BROWSER'); },
    launchUrlThroughHiddenFrame: () => { throw new Error('UNEXPECTED_IFRAME'); },
    SolanaMobileWalletAdapterError: class extends Error {
      constructor(code, message) { super(message); this.code = code; }
    },
    SolanaMobileWalletAdapterErrorCode: { ERROR_WALLET_NOT_FOUND: 'ERROR_WALLET_NOT_FOUND' },
    setTimeout: (callback, ms) => { const id = {}; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(detection + '\n' + launch, context);
  return { window, timers, calls,
    launch: () => context.launchAssociation(new URL('solana-wallet:/v1/associate/local?association=mock&port=49152')),
    focus: hasFocus => vm.runInContext(JSON.parse(scriptParts[1]) + eventNames[hasFocus ? 1 : 2] + JSON.parse(scriptParts[2]), context),
    expire: () => { for (const { callback } of [...timers.values()]) callback(); },
  };
}

test('Native focus bridge uses real callback, superclass and null guards only; Capacitor 6 APIs exist', () => {
  const method = activity.match(/public void onWindowFocusChanged\(boolean hasFocus\) \{([\s\S]*)\}\s*\}\s*$/);
  assert.ok(method);
  const expected = `super.onWindowFocusChanged(hasFocus);
    Bridge bridge = getBridge();
    if (bridge == null) { return; }
    WebView webView = bridge.getWebView();
    if (webView == null) { return; }
    String eventName = hasFocus ? "focus" : "blur";
    webView.evaluateJavascript("window.dispatchEvent(new Event('" + eventName + "'));", null);`;
  const compact = value => value.replace(/\s+/g, ' ').trim();
  assert.equal(compact(method[1]), compact(expected));
  assert.equal((activity.match(/@Override/g) || []).length, 1);
  assert.ok(!/onPause|onResume|onCreate|postDelayed|setTimeout|userAgent|WebSocket|startActivity|authorize/.test(activity));
  assert.match(read('node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/BridgeActivity.java'), /public Bridge getBridge\(\)/);
  assert.match(read('node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/Bridge.java'), /public WebView getWebView\(\)/);
});

test('Actual SDK association resolves on forwarded Android blur, with unchanged URI and cleanup', async () => {
  const h = harness();
  const events = [];
  h.window.addEventListener('blur', event => events.push({ type: event.type, trusted: event.isTrusted }));
  h.window.addEventListener('focus', event => events.push({ type: event.type, trusted: event.isTrusted }));
  const pending = h.launch();
  assert.deepEqual(h.calls, ['solana-wallet:/v1/associate/local?association=mock&port=49152']);
  assert.deepEqual([...h.timers.values()].map(timer => timer.ms), [3000]);
  h.focus(false);
  await pending;
  assert.equal(h.timers.size, 0);
  h.focus(true);
  assert.deepEqual(events, [{ type: 'blur', trusted: false }, { type: 'focus', trusted: false }]);
  assert.equal(h.calls.length, 1);
});

test('Focus gain is not wallet detection; missing Android blur still fails closed after SDK timeout', async () => {
  const h = harness();
  let state = 'pending';
  const pending = h.launch().then(() => { state = 'resolved'; }, error => { state = 'rejected'; throw error; });
  const rejected = assert.rejects(pending, /Found no installed wallet that supports the mobile wallet protocol/);
  h.focus(true);
  await Promise.resolve();
  assert.equal(state, 'pending');
  assert.equal(h.timers.size, 1);
  h.expire();
  await rejected;
  assert.equal(state, 'rejected');
  assert.equal(h.timers.size, 0);
  h.focus(false);
  assert.equal(state, 'rejected');
});

test('Prior Android blur is not cached proof for a later association; SDK listener remains one-shot', async () => {
  const h = harness();
  h.focus(false);
  const pending = h.launch();
  const rejected = assert.rejects(pending, /Found no installed wallet/);
  assert.equal(h.timers.size, 1);
  h.expire();
  await rejected;
  const next = h.launch();
  h.focus(false);
  await next;
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls.length, 2);
});
