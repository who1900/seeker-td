import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { captureReplaySources } from './replayFingerprint.mjs';

const ts = createRequire(new URL('../package.json', import.meta.url))('typescript');
const compilerOptions = Object.freeze({ target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
  isolatedModules: true, useDefineForClassFields: true, newLine: ts.NewLineKind.LineFeed,
  sourceMap: false, inlineSourceMap: false, removeComments: false });
const fail = () => { throw new Error('REPLAY_RUNTIME_INVALID'); };
function record(value, permitted, required = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => !permitted.includes(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))
    || required.some(key => !Object.hasOwn(value, key))) fail();
}

// Trusted local sources execute as ordinary JS, not as untrusted code in a sandbox.
export function createReplayRuntime(options) {
  record(options, ['projectRoot', 'version', 'budgets'], ['projectRoot', 'version']);
  if (options.version !== 1) fail();
  const budgets = options.budgets === undefined ? {} : options.budgets;
  record(budgets, ['sourceBounds', 'processorBounds']);
  const processorBounds = budgets.processorBounds === undefined ? {} : budgets.processorBounds;
  record(processorBounds, ['maxChunkBytes', 'maxEvents', 'maxChunkTicks', 'workTicks', 'workEvents', 'maxStateBytes', 'maxStateNodes']);
  const trustedBudgets = Object.freeze({ ...processorBounds });
  const snapshot = captureReplaySources(options.projectRoot, budgets.sourceBounds);
  const compiled = new Map();
  for (const source of snapshot.sources) {
    const result = ts.transpileModule(source.text, { fileName: source.path, compilerOptions, reportDiagnostics: true });
    if (result.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) {
      throw new Error('REPLAY_RUNTIME_COMPILER_ERROR');
    }
    compiled.set(source.path, result.outputText);
  }
  const runtimeProfile = Object.freeze({ ...snapshot.fingerprint.runtimeProfile,
    binding: 'captured-source-commonjs-v1', compiler: `typescript-${ts.version}`,
    compilerOptions: JSON.stringify(compilerOptions), node: process.version });
  const identity = createHash('sha256');
  const frame = value => {
    const bytes = Buffer.from(value, 'utf8'), length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length); identity.update(length); identity.update(bytes);
  };
  frame('seeker-td:replay-runtime-fingerprint:v1'); frame(snapshot.fingerprint.hash);
  for (const [key, value] of Object.entries(runtimeProfile)) { frame(key); frame(value); }
  const fingerprint = Object.freeze({ version: 1, hash: identity.digest('hex'),
    sourceHashes: snapshot.fingerprint.sourceHashes, runtimeProfile });
  const cache = new Map();
  const load = filename => {
    if (!compiled.has(filename)) fail();
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    const localRequire = specifier => {
      if (typeof specifier !== 'string' || !specifier.startsWith('./') && !specifier.startsWith('../')
        || specifier.includes('\\')) fail();
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(filename), specifier));
      return load(resolved.endsWith('.ts') ? resolved : `${resolved}.ts`);
    };
    try {
      new Function('exports', 'require', 'module', compiled.get(filename))(module.exports, localRequire, module);
      return module.exports;
    } catch (error) { cache.delete(filename); throw error; }
  };
  const { createReplayProcessor: processorFactory } = load('src/game/replayChunk.ts');
  if (typeof processorFactory !== 'function') fail();
  const digest = bytes => createHash('sha256').update(bytes).digest();
  const start = trusted => {
    record(trusted, ['seed', 'config'], ['seed', 'config']);
    return processorFactory({ seed: trusted.seed, config: trusted.config,
      budgets: trustedBudgets, fingerprint: fingerprint.hash, digest });
  };
  start({ seed: 0, config: { mode: 'endless', waveLimit: 1, durationSeconds: 300 } });
  return Object.freeze({ version: 1, fingerprint, start });
}
