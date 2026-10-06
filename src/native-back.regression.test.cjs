const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const activity = fs.readFileSync(path.join(root, 'android/app/src/main/java/app/seekdef/game/MainActivity.java'), 'utf8');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

function method(signature) {
  const start = activity.indexOf(signature);
  assert.ok(start >= 0, `Missing ${signature}`);
  const open = activity.indexOf('{', start);
  let depth = 1;
  for (let i = open + 1; i < activity.length; i++) {
    if (activity[i] === '{') depth++;
    if (activity[i] === '}' && --depth === 0) return activity.slice(open + 1, i);
  }
  assert.fail(`Unclosed ${signature}`);
}

const scriptExpression = activity.match(/private static final String NATIVE_BACK_SCRIPT\s*=([\s\S]*?);\r?\n/);
assert.ok(scriptExpression, 'Test the actual Java-embedded JavaScript, not a duplicate implementation');
const literals = scriptExpression[1].match(/"(?:\\.|[^"\\])*"/g);
assert.ok(literals && literals.length);
assert.equal(scriptExpression[1].replace(/"(?:\\.|[^"\\])*"/g, '').replace(/[+\s]/g, ''), '');
const script = literals.map(literal => JSON.parse(literal)).join('');
const dispatch = method('private void dispatchNativeBack()');
const resultBody = dispatch.slice(dispatch.indexOf('result -> {'));
const consumedResult = resultBody.match(/if\s*\(!"([^"]+)"\.equals\(result\)\)\s*\{\s*platformBack\(\);\s*\}/);
assert.ok(consumedResult, 'Native callback must fallback on every result except the exact consumed token');
function nativeConsumes(result) { return result === consumedResult[1]; }
function boundary(window = new EventTarget(), overrides = {}) {
  const context = vm.createContext({ window, Event, ...overrides });
  return { window, run: () => vm.runInContext(script, context, { timeout: 1000 }),
    nativeResult: () => JSON.stringify(vm.runInContext(script, context, { timeout: 1000 })) };
}

test('AndroidX lifecycle-owned Back callback preserves Capacitor onCreate and existing focus bridge', () => {
  assert.match(activity, /import androidx\.activity\.OnBackPressedCallback;/);
  const create = method('protected void onCreate(Bundle savedInstanceState)');
  assert.ok(create.indexOf('super.onCreate(savedInstanceState);') < create.indexOf('new OnBackPressedCallback(true)'));
  assert.match(create, /public void handleOnBackPressed\(\)\s*\{\s*dispatchNativeBack\(\);\s*\}/);
  assert.match(create, /getOnBackPressedDispatcher\(\)\.addCallback\(this, nativeBackCallback\);/);
  assert.ok(activity.indexOf('protected void onCreate(') < activity.indexOf('public void onWindowFocusChanged('));
  const compact = text => text.replace(/\s+/g, ' ').trim();
  assert.equal(compact(method('public void onWindowFocusChanged(boolean hasFocus)')), compact(`
    super.onWindowFocusChanged(hasFocus);
    Bridge bridge = getBridge();
    if (bridge == null) { return; }
    WebView webView = bridge.getWebView();
    if (webView == null) { return; }
    String eventName = hasFocus ? "focus" : "blur";
    webView.evaluateJavascript("window.dispatchEvent(new Event('" + eventName + "'));", null);
  `));
  assert.match(read('node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/BridgeActivity.java'), /extends AppCompatActivity/);
  assert.match(read('node_modules/@capacitor/android/capacitor/build.gradle'), /androidx\.activity:activity:\$androidxActivityVersion/);
  assert.ok(!/@capacitor\/app/.test(read('package.json')));
  assert.ok(!/addJavascriptInterface|setWebViewClient|setWebChromeClient|setJavaScriptEnabled|setAllow|loadUrl|startActivity|finish\(|moveTaskToBack|onKeyDown|public void onBackPressed\(/.test(activity));
});

test('Actual Java-embedded JS emits cancelable event to window; no listener means honest fallback', () => {
  const h = boundary();
  let seen;
  h.window.addEventListener('seeker-native-back', event => { seen = event; });
  const result = h.nativeResult();
  assert.equal(result, 'false');
  assert.equal(nativeConsumes(result), false);
  assert.equal(seen.type, 'seeker-native-back');
  assert.equal(seen.cancelable, true);
  assert.equal(seen.target, h.window);
  assert.equal(seen.defaultPrevented, false);
  assert.equal(seen.isTrusted, false);
  assert.equal(nativeConsumes(boundary().nativeResult()), false);
});

test('Synchronous preventDefault consumes Back and survives other non-owning window listeners', () => {
  const h = boundary();
  const seen = [];
  h.window.addEventListener('seeker-native-back', event => { seen.push('Game'); event.preventDefault(); });
  h.window.addEventListener('seeker-native-back', event => { seen.push('App'); assert.equal(event.defaultPrevented, true); });
  assert.equal(h.nativeResult(), 'true');
  assert.equal(nativeConsumes('true'), true);
  assert.deepEqual(seen, ['Game', 'App']);
});

test('stopPropagation alone does not consume Back; removing consumer restores platform fallback', () => {
  const h = boundary();
  const consume = event => event.preventDefault();
  h.window.addEventListener('seeker-native-back', event => event.stopPropagation());
  assert.equal(nativeConsumes(h.nativeResult()), false);
  h.window.addEventListener('seeker-native-back', consume);
  assert.equal(nativeConsumes(h.nativeResult()), true);
  h.window.removeEventListener('seeker-native-back', consume);
  assert.equal(nativeConsumes(h.nativeResult()), false);
});

test('Async confirmation must synchronously preventDefault; late cancellation cannot retroactively consume', async () => {
  const late = boundary();
  late.window.addEventListener('seeker-native-back', event => { Promise.resolve().then(() => event.preventDefault()); });
  const result = late.nativeResult();
  assert.equal(nativeConsumes(result), false);
  await Promise.resolve();
  assert.equal(nativeConsumes(result), false);
  const owned = boundary();
  let confirmationShown = false;
  owned.window.addEventListener('seeker-native-back', event => {
    event.preventDefault();
    Promise.resolve().then(() => { confirmationShown = true; });
  });
  assert.equal(nativeConsumes(owned.nativeResult()), true);
  await Promise.resolve();
  assert.equal(confirmationShown, true);
});

test('JS not ready, unavailable event API or throwing dispatch returns boolean false without trapping Back', () => {
  for (const overrides of [{ window: undefined }, { window: null }, { window: {} }, { Event: undefined },
    { Event: () => { throw new Error('not constructible'); } },
    { window: { dispatchEvent() { throw new Error('JS_NOT_READY'); } } }]) {
    const h = boundary(new EventTarget(), overrides);
    assert.equal(h.run(), false);
    assert.equal(nativeConsumes(h.nativeResult()), false);
  }
  assert.equal(nativeConsumes(vm.runInNewContext(script, {}, { timeout: 1000 })), false);
});

test('Native result gate only accepts JSON boolean true; null, quoted strings and invalid results fallback', () => {
  assert.equal(consumedResult[1], 'true');
  assert.equal(nativeConsumes('true'), true);
  for (const result of [null, undefined, true, false, 'false', 'null', 'undefined', '"true"', '1', 'TRUE', '', '{}']) {
    assert.equal(nativeConsumes(result), false, `Unexpected consumed result ${String(result)}`);
  }
  assert.match(dispatch, /webView\.evaluateJavascript\(NATIVE_BACK_SCRIPT, result -> \{/);
});

test('Native null bridges, evaluation failure and missing callback have a bounded exactly-once fallback', () => {
  assert.match(dispatch, /if \(nativeBackPending \|\| isFinishing\(\) \|\| isDestroyed\(\)\)\s*\{\s*return;\s*\}/);
  assert.match(dispatch, /Bridge bridge = getBridge\(\);\s*WebView webView = bridge == null \? null : bridge\.getWebView\(\);/);
  assert.match(dispatch, /if \(webView == null\)\s*\{\s*platformBack\(\);\s*return;\s*\}/);
  assert.match(activity, /NATIVE_BACK_TIMEOUT_MS = 500;/);
  assert.match(dispatch, /Handler handler = new Handler\(Looper\.getMainLooper\(\)\);/);
  assert.match(dispatch, /AtomicBoolean completed = new AtomicBoolean\(false\);/);
  const gate = /if \(!completed\.compareAndSet\(false, true\)\)\s*\{\s*return;\s*\}/g;
  assert.equal([...dispatch.matchAll(gate)].length, 2, 'Both watchdog and JS reply must settle once');
  assert.match(dispatch, /Runnable fallback = \(\) -> \{[\s\S]*?nativeBackPending = false;\s*platformBack\(\);\s*\};/);
  assert.ok(dispatch.indexOf('handler.postDelayed(fallback, NATIVE_BACK_TIMEOUT_MS);') < dispatch.indexOf('webView.evaluateJavascript('));
  assert.match(resultBody, /handler\.removeCallbacks\(fallback\);\s*nativeBackPending = false;/);
  assert.match(dispatch, /catch \(RuntimeException error\)\s*\{\s*handler\.removeCallbacks\(fallback\);\s*fallback\.run\(\);\s*\}/);
  assert.equal((dispatch.match(/nativeBackPending = true;/g) || []).length, 1);
});

test('Platform fallback delegates once with own callback disabled and restores it even if dispatch throws', () => {
  assert.equal(method('private void platformBack()').replace(/\s+/g, ' ').trim(), `
    if (isFinishing() || isDestroyed()) { return; }
    nativeBackCallback.setEnabled(false);
    try { getOnBackPressedDispatcher().onBackPressed(); }
    finally { nativeBackCallback.setEnabled(true); }
  `.replace(/\s+/g, ' ').trim());
  assert.equal((activity.match(/getOnBackPressedDispatcher\(\)\.onBackPressed\(\);/g) || []).length, 1);
});
