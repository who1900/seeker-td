const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const { test } = require('node:test');
const source = fs.readFileSync(`${__dirname}/paperAssets.ts`, 'utf8');
const ast = ts.createSourceFile('paperAssets.ts', source, ts.ScriptTarget.Latest, true);
const names = ['load', 'canRetryPaperAssets', 'loadPaperAssets'];
const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
assert.equal(declarations.length, 3);
const code = ts.transpileModule(`let manifest, loading; let attempts=0, generation=0, status='loading';
  const root='/paper-assets/', PAPER_ASSET_TIMEOUT_MS=12000, sprites=new Map(), listeners=new Set();
  const paperUrl=path=>root+'runtime/'+path;
  const PAPER_FX_PATHS=[], PAPER_ENVIRONMENT_PATHS=[];
  ${declarations.map(node => node.getText(ast)).join('\n')}
  exports.inspect=()=>({status,attempts,generation,sprites});`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function fixture(mode = 'images') {
  const timers = new Map(), images = [], result = {};
  let timerId = 0, fetches = 0, lateManifest;
  class Image {
    constructor() { this.width=1; this.height=1; images.push(this); }
  }
  const document = { createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: [1,2,3,255] }) }) }) };
  const fetch = async () => {
    fetches++;
    if (fetches === 1 && mode === 'fetch') return new Promise(resolve => { lateManifest = resolve; });
    return { ok: true, json: () => fetches === 1 && mode === 'json' ? new Promise(resolve => { lateManifest = resolve; })
      : Promise.resolve({ towers: {}, mobs: {} }) };
  };
  new Function('exports', 'Image', 'document', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout', 'console', 'tintedPart', 'paperLateUpgradeDrawCommands', code)(
    result, Image, document, fetch, AbortController,
    (callback, delay) => { assert.equal(delay, 12000); timers.set(++timerId, callback); return timerId; },
    id => timers.delete(id), { warn() {} }, () => {}, () => {});
  return { ...result, images, timers, expire() { for (const callback of [...timers.values()]) callback(); },
    complete() { for (const image of images) image.onload?.(); }, late() { lateManifest?.({ towers: { stale: {} }, mobs: {} }); } };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

test('never-settling Image exits loading, permits bounded Retry, ignores old onload generation', async () => {
  const f = fixture();
  const pending = f.loadPaperAssets(); await flush();
  assert.equal(f.inspect().status, 'loading');
  assert.equal(f.images.length, 3);
  const late = f.images.map(image => image.onload);
  f.expire(); await pending;
  assert.match(f.inspect().status, /fallback active/);
  assert.equal(f.canRetryPaperAssets(), true);
  assert.equal(f.timers.size, 0);
  const retry = f.loadPaperAssets({ retry: true }); await flush();
  for (const callback of late) callback();
  assert.equal(f.inspect().sprites.size, 0, 'old late callbacks cannot publish sprites');
  f.complete(); await retry;
  assert.equal(f.inspect().status, 'ready');
  assert.equal(f.inspect().sprites.size, 3);
  assert.equal(f.timers.size, 0);
});

for (const mode of ['fetch', 'json']) test(`manifest ${mode} deadline covers entire fetch + JSON parse`, async () => {
  const f = fixture(mode);
  const pending = f.loadPaperAssets(); await flush();
  assert.equal(f.inspect().status, 'loading');
  f.expire(); await pending;
  assert.match(f.inspect().status, /fallback active/);
  assert.equal(f.canRetryPaperAssets(), true);
  const retry = f.loadPaperAssets({ retry: true }); await flush();
  f.late(); await flush();
  f.complete(); await retry;
  assert.equal(f.inspect().status, 'ready');
  assert.equal(f.inspect().sprites.size, 3, 'late prior manifest cannot replace fresh generation');
  assert.equal(f.timers.size, 0);
});
