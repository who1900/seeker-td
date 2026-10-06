const { strict: assert } = require('node:assert');
const mode = process.env.SEEKER_REGRESSION_FIXTURE;
if (mode) {
  if (mode === 'fail') throw new Error('expected fixture failure');
  if (mode === 'hang') setInterval(() => {}, 1000);
  if (mode === 'output') process.stdout.write('x'.repeat(1024 * 1024));
  if (mode === 'network') {
    try { require('node:https').get('https://example.invalid'); } catch {}
  }
  if (mode === 'network-reset') {
    try { require('node:https').get('https://example.invalid'); } catch {}
    process.exitCode = 0;
  }
} else {
  const { test } = require('node:test');
  const runner = import('./regression-runner.mjs');
  const fixture = (value, extra = {}) => ({ env: { ...process.env, SEEKER_REGRESSION_FIXTURE: value }, ...extra });
  test('discovery stays in src and contains TS/CJS, excluding server/selftests', async () => {
    const { discoverSuites, ROOT } = await runner;
    const files = discoverSuites();
    assert.ok(files.every(f => f.startsWith(require('node:path').join(ROOT, 'src') + require('node:path').sep)));
    assert.equal(new Set(files).size, files.length);
    assert.ok(files.some(f => f.endsWith('.ts')) && files.some(f => f.endsWith('.cjs')));
    assert.deepEqual(files, [...files].sort());
  });
  test('missing/failing/timeout/output/network fail closed; passing fixture succeeds', async () => {
    const { runSuite } = await runner;
    assert.equal(runSuite(__filename, fixture('pass')).passed, true);
    assert.equal(runSuite(`${__dirname}/missing.test.cjs`).passed, false);
    assert.equal(runSuite(__filename, fixture('fail')).passed, false);
    const timeout = runSuite(__filename, fixture('hang', { timeout: 150 }));
    assert.equal(timeout.passed, false);
    assert.equal(timeout.error, 'ETIMEDOUT');
    const output = runSuite(__filename, fixture('output', { maxBuffer: 1024 }));
    assert.equal(output.passed, false);
    assert.equal(output.error, 'ENOBUFS');
    assert.equal(runSuite(__filename, fixture('network')).passed, false);
    const reset = runSuite(__filename, fixture('network-reset'));
    assert.equal(reset.passed, false);
    assert.equal(reset.status, 1, 'caught network attempt stays failed after exitCode reset');
  });
  test('TS ES imports compile in memory through the same isolated loader', async () => {
    const { runSuite, ROOT } = await runner;
    assert.equal(runSuite(require('node:path').join(ROOT, 'src/screens/shopCosmetics.test.ts')).passed, true);
  });
}
