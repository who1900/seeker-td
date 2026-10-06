import { readdirSync } from 'node:fs';
import { resolve, relative, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CHILD = join(ROOT, 'scripts', 'regression-child.cjs');
export const LIMITS = Object.freeze({ timeout: 60000, maxBuffer: 256 * 1024, suites: 512 });

export function discoverSuites(root = ROOT) {
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('REGRESSION_SYMLINK_DENIED');
      const filename = join(directory, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (/\.test\.(ts|tsx|cjs)$/.test(entry.name)) {
        files.push(filename);
        if (files.length > LIMITS.suites) throw new Error('REGRESSION_SUITE_LIMIT');
      }
    }
  }
  walk(join(root, 'src'));
  files.sort();
  if (!files.some(f => /\.tsx?$/.test(f)) || !files.some(f => f.endsWith('.cjs'))) {
    throw new Error('REGRESSION_EMPTY_TEST_GROUP');
  }
  return files;
}

export function runSuite(filename, options = {}) {
  const child = spawnSync(process.execPath, [CHILD, resolve(filename)], {
    cwd: ROOT, encoding: 'utf8', timeout: LIMITS.timeout, maxBuffer: LIMITS.maxBuffer,
    windowsHide: true, ...options,
  });
  return { passed: child.status === 0 && !child.error && !child.signal, status: child.status,
    signal: child.signal, error: child.error?.code ?? null,
    stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
}

export function runRegression(files = discoverSuites()) {
  if (!files.length || files.length > LIMITS.suites) throw new Error('REGRESSION_INVALID_SUITE_COUNT');
  const totals = { TS: { pass: 0, fail: 0 }, CJS: { pass: 0, fail: 0 } };
  for (const filename of files) {
    const kind = filename.endsWith('.cjs') ? 'CJS' : 'TS';
    const result = runSuite(filename);
    totals[kind][result.passed ? 'pass' : 'fail']++;
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${kind} ${relative(ROOT, filename)}`);
    const output = `${result.stdout}${result.stderr}`;
    if (output) console.log(output.slice(0, result.passed ? 2000 : 8000).trimEnd());
    if (!result.passed) console.error(`status=${result.status} signal=${result.signal} error=${result.error}`);
  }
  console.log(`TOTALS ${JSON.stringify(totals)}`);
  return { totals, passed: !totals.TS.fail && !totals.CJS.fail };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runRegression().passed ? 0 : 1; }
  catch (error) { console.error(error); process.exitCode = 1; }
}
