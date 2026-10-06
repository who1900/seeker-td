const { strict: assert } = require('node:assert');
const { readFileSync } = require('node:fs');
const { transpileModule, ModuleKind, ScriptTarget } = require('typescript');

const source = readFileSync(`${__dirname}/paperAssets.ts`, 'utf8');
const loader = source.slice(source.indexOf('export function canRetryPaperAssets('), source.indexOf('export function usePaperAssets('));
function fixture({ manifestFails = false, permanent = false } = {}) {
  const sprites = new Map();
  const calls = [];
  const statuses = [];
  let fetches = 0;
  let failed = false;
  const exports = {};
  const code = transpileModule(`let manifest; let loading; let attempts = 0; let status = 'loading'; ${loader}`,
    { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020 } }).outputText;
  new Function('exports', 'root', 'fetch', 'sprites', 'load', 'listeners', 'PAPER_FX_PATHS', 'PAPER_ENVIRONMENT_PATHS', 'console', code)(
    exports, '/paper-assets/', async () => {
      fetches++;
      if (manifestFails && fetches === 1) throw new Error('offline');
      return { ok: true, json: async () => ({ towers: {}, mobs: {} }) };
    }, sprites, async path => {
      calls.push(path);
      if (path === 'branding/wordmark.png' && (permanent || !failed)) {
        failed = true;
        throw new Error('missing PNG');
      }
      sprites.set(path, { path });
    }, new Set([() => statuses.push('notified')]), [], [], { warn() {} });
  return { load: exports.loadPaperAssets, canRetry: exports.canRetryPaperAssets, sprites, calls, statuses, fetches: () => fetches };
}

(async () => {
  const transient = fixture();
  const first = transient.load();
  assert.equal(transient.load({ retry: true }), first, 'in-flight calls coalesce');
  await first;
  assert.equal(transient.canRetry(), true);
  const hero = transient.sprites.get('ui/illustrations/home_hero.png');
  assert.equal(transient.load(), first, 'ordinary calls do not auto-retry');
  const retry = transient.load({ retry: true });
  assert.equal(transient.canRetry(), false, 'loading cannot retry');
  assert.notEqual(retry, first);
  assert.equal(transient.load({ retry: true }), retry);
  await retry;
  assert.equal(transient.sprites.size, 3);
  assert.equal(transient.canRetry(), false, 'ready cannot retry');
  assert.equal(transient.sprites.get('ui/illustrations/home_hero.png'), hero);
  assert.deepEqual(transient.calls.slice(3), ['branding/wordmark.png']);
  assert.equal(transient.fetches(), 1);
  assert.equal(transient.load({ retry: true }), retry, 'ready is memoized');

  const missing = fixture({ permanent: true });
  await missing.load();
  await missing.load({ retry: true });
  const last = missing.load({ retry: true });
  await last;
  assert.equal(missing.canRetry(), false, 'exhausted cannot retry');
  assert.equal(missing.load({ retry: true }), last, 'two retries maximum');
  assert.equal(missing.calls.length, 5);

  const offline = fixture({ manifestFails: true });
  await offline.load();
  await offline.load({ retry: true });
  assert.equal(offline.fetches(), 2, 'failed manifest can be fetched again');
  await offline.load({ retry: true });
  assert.equal(offline.sprites.size, 3);
  assert.equal(offline.fetches(), 2);
  assert.ok(transient.statuses.length >= 4, 'subscribers notified at start and completion');
  console.log('paperAssets regression: passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
