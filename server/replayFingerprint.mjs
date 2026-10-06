import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ts = createRequire(new URL('../package.json', import.meta.url))('typescript');
const sources = Object.freeze(['types', 'data', 'engine', 'combatShots', 'combatStatus', 'waveManager',
  'pathfinding', 'gameplayRandom', 'replayTiming', 'replayCommands', 'replayChunk'].map(name => `src/game/${name}.ts`));
const allowed = new Set(sources);
const profile = Object.freeze({ declaration: 'compatibility-target-only-not-cross-platform-proof',
  runtime: 'Node.js >=22', language: 'ES2020', numbers: 'IEEE754-binary64',
  codec: 'canonicalReplayBytes-v1', projection: 'gameplay-minus-particles-soundQueue-lifeFlashUntil-v1',
  rng: 'mulberry32-v1' });
const fail = () => { throw new Error('REPLAY_FINGERPRINT_INVALID'); };
const limited = () => { throw new Error('REPLAY_FINGERPRINT_RESOURCE_LIMITED'); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function closure(filename, text) {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
  if (source.parseDiagnostics.length || source.referencedFiles.length || source.typeReferenceDirectives.length
    || source.libReferenceDirectives.length) fail();
  const dependency = node => {
    if (!ts.isStringLiteral(node) || !node.text.startsWith('./') && !node.text.startsWith('../')
      || node.text.includes('\\')) fail();
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(filename), node.text));
    if (!allowed.has(resolved.endsWith('.ts') ? resolved : `${resolved}.ts`)) fail();
  };
  const visit = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) dependency(node.moduleSpecifier);
    }
    if (ts.isImportTypeNode(node)) {
      if (!ts.isLiteralTypeNode(node.argument)) fail();
      dependency(node.argument.literal);
    }
    if (ts.isImportEqualsDeclaration(node)) fail();
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
      && node.argumentExpression.text === 'require') fail();
    if (node.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node) && node.text === 'require') fail();
    ts.forEachChild(node, visit);
  };
  visit(source);
}

// projectRoot is trusted server configuration, never a client request field.
export function createReplayFingerprint(projectRoot, bounds = {}) {
  return captureReplaySources(projectRoot, bounds).fingerprint;
}

// Internal server capture; callers cannot supply source hashes or replacement snapshots.
export function captureReplaySources(projectRoot, bounds = {}) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)
    || !bounds || Object.getPrototypeOf(bounds) !== Object.prototype
    || Reflect.ownKeys(bounds).some(key => !['maxFileBytes', 'maxTotalBytes'].includes(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(bounds, key), 'value'))) fail();
  const { maxFileBytes = 1048576, maxTotalBytes = 8388608 } = bounds;
  if (![maxFileBytes, maxTotalBytes].every(value => Number.isSafeInteger(value) && value > 0)
    || maxFileBytes > 1048576 || maxTotalBytes > 8388608) fail();
  const root = realpathSync(projectRoot);
  let total = 0;
  const captured = [];
  const sourceHashes = sources.map(relativePath => {
    const real = realpathSync(path.join(root, relativePath));
    if (!inside(root, real)) fail();
    const fd = openSync(real, 'r');
    let bytes;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) fail();
      if (stat.size > maxFileBytes || stat.size > maxTotalBytes - total) limited();
      const buffer = Buffer.alloc(Math.min(maxFileBytes, maxTotalBytes - total) + 1);
      let size = 0, count;
      while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += count;
      if (size > maxFileBytes || size > maxTotalBytes - total) limited();
      bytes = buffer.subarray(0, size);
      total += size;
    } finally { closeSync(fd); }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    closure(relativePath, text);
    captured.push(Object.freeze({ path: relativePath, text }));
    return Object.freeze({ path: relativePath, hash: sha(bytes) });
  });
  const hash = createHash('sha256');
  const frame = value => {
    const bytes = Buffer.from(value, 'utf8'), length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length); hash.update(length); hash.update(bytes);
  };
  frame('seeker-td:replay-source-fingerprint:v1');
  for (const [key, value] of Object.entries(profile)) { frame(key); frame(value); }
  for (const source of sourceHashes) { frame(source.path); frame(source.hash); }
  const fingerprint = Object.freeze({ version: 1, hash: hash.digest('hex'), sourceHashes: Object.freeze(sourceHashes), runtimeProfile: profile });
  return Object.freeze({ fingerprint, sources: Object.freeze(captured) });
}
