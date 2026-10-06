import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { encodeBase58 } from './identity.mjs';
import { createRunAdmissionService } from './runAdmission.mjs';
import { createReplayRuntime } from './replayRuntime.mjs';
import { fileURLToPath } from 'node:url';

const runtimeFingerprint = createReplayRuntime({ projectRoot: fileURLToPath(new URL('../', import.meta.url)), version: 1 }).fingerprint;

const mode = { mode: 'waves', waveLimit: 10, durationMinutes: 5 };
const alternative = { mode: 'timed', waveLimit: 10, durationMinutes: 10 };
const policy = () => ({ engineVersion: 'engine-v1', dataVersion: 'data-v1', protocolVersion: 'shadow-placeholder-v1',
  replayRuntimeVersion: runtimeFingerprint.version, replayRuntimeHash: runtimeFingerprint.hash,
  ttlMilliseconds: 60000, allowedConfigs: [{ ...mode }, { ...alternative }] });
const hex = value => Buffer.from(value).toString('hex');
const body = (id = 'a'.repeat(32), config = mode) => ({ requestId: id, config: { ...config } });
const wallet = () => encodeBase58(generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
// Test-only serialized atomic adapter; never exported/imported by runtime code.
function memory() {
  let data = new Map(), queue = Promise.resolve();
  return { failWrite: 0, failCommit: false, onRead: null, retry: null, reads: [], writes: [],
    seed(key, value) { data.set(key, structuredClone(value)); },
    snapshot() { return structuredClone(data); },
    transaction(callback) {
      const operation = queue.then(async () => {
        const attempt = async () => {
          const draft = structuredClone(data); let wrote = false, writes = 0;
          const result = await callback({
            get: async key => { assert.equal(wrote, false, 'reads precede writes'); this.reads.push(key);
              if (this.onRead) await this.onRead(key); return structuredClone(draft.get(key)); },
            set: async (key, value) => { wrote = true; this.writes.push(key);
              if (++writes === this.failWrite) throw new Error('test write failed'); draft.set(key, structuredClone(value)); },
          }); return { draft, result };
        };
        let done = await attempt();
        if (this.retry) { const retry = this.retry; this.retry = null; retry(); done = await attempt(); }
        if (this.failCommit) throw new Error('test commit failed');
        data = done.draft; return done.result;
      }); queue = operation.catch(() => {}); return operation;
    },
  };
}
function fixture(credits = 2) {
  const store = memory(), wallets = { 'uid/a': wallet(), 'uid/b': wallet() }; let time = 1000000;
  for (const [uid, address] of Object.entries(wallets)) {
    store.seed(`identityUids/${hex(uid)}`, { wallet: address });
    store.seed(`identityWallets/${hex(address)}`, { uid });
    store.seed(`shadowEntitlements/${hex(uid)}`, { credits });
  }
  const config = policy();
  const authenticateToken = async token => { if (token === 'token-a') return { uid: 'uid/a' };
    if (token === 'token-b') return { uid: 'uid/b' }; throw new Error('auth denied'); };
  const service = createRunAdmissionService({ authenticateToken, store, config, runtimeFingerprint, now: () => time });
  return { store, service, wallets, config, authenticateToken, now: () => time, time(value) { time = value; } };
}

test('strict trusted policy/dependencies and client schemas, no seed/UID/balance claims', async () => {
  const f = fixture();
  for (const config of [null, {}, { ...policy(), ttlMilliseconds: 0 }, { ...policy(), ttlMilliseconds: Infinity },
    { ...policy(), ttlMilliseconds: 86400001 }, { ...policy(), engineVersion: '' }, { ...policy(), extra: true },
    { ...policy(), allowedConfigs: [] }, { ...policy(), allowedConfigs: [mode, mode] },
    { ...policy(), allowedConfigs: [mode, { durationMinutes: 5, waveLimit: 10, mode: 'waves' }] },
    { ...policy(), allowedConfigs: [{ ...mode, access: 'ranked' }] }]) {
    assert.throws(() => createRunAdmissionService({ authenticateToken: f.authenticateToken, store: f.store, config, runtimeFingerprint }), /RUN_ADMISSION_DENIED/);
  }
  assert.throws(() => createRunAdmissionService({ config: policy() }), /RUN_ADMISSION_DENIED/);
  for (const input of [null, { ...body(), uid: 'uid/a' }, { ...body(), combatSeed: 0 }, { ...body(), balance: 100 },
    { ...body(), replayRuntimeVersion: 1 }, { ...body(), replayRuntimeHash: runtimeFingerprint.hash },
    { ...body(), engineVersion: 'evil' }, body('A'.repeat(32)), body('a'.repeat(31)),
    body('a'.repeat(32), { ...mode, mode: 'ranked' }), body('a'.repeat(32), { ...mode, waveLimit: 11 }),
    body('a'.repeat(32), { ...mode, access: 'practice' }), body('a'.repeat(32), { ...mode, durationMinutes: 20 })]) {
    await assert.rejects(f.service.admit('token-a', input), /RUN_ADMISSION_DENIED/);
  }
  await assert.rejects(f.service.admit('', body()), /RUN_ADMISSION_DENIED/);
  await assert.rejects(f.service.admit('wrong', body()));
  assert.equal(f.store.writes.length, 0);
});

test('server crypto admission is immutable/idempotent with one atomic debit and canonical namespaces', async () => {
  const f = fixture(); const admitted = await f.service.admit('token-a', body());
  assert.match(admitted.runId, /^[a-f0-9]{32}$/); assert.equal(admitted.purpose, 'shadow');
  assert.equal(admitted.uid, 'uid/a'); assert.equal(admitted.wallet, f.wallets['uid/a']);
  assert.equal(admitted.admittedAt, f.now()); assert.equal(admitted.expiresAt, f.now() + 60000);
  assert.equal(admitted.protocolVersion, 'shadow-placeholder-v1'); assert.equal(admitted.rngAlgorithm, 'mulberry32');
  assert.equal(admitted.replayRuntimeVersion, runtimeFingerprint.version);
  assert.equal(admitted.replayRuntimeHash, runtimeFingerprint.hash);
  assert.equal(admitted.rngVersion, 1); assert.ok(Number.isInteger(admitted.combatSeed) && admitted.combatSeed >= 0 && admitted.combatSeed <= 0xffffffff);
  assert.equal(f.store.snapshot().get(`shadowEntitlements/${hex('uid/a')}`).credits, 1);
  assert.equal(f.store.writes.length, 4);
  assert.deepEqual(await f.service.admit('token-a', body()), admitted); assert.equal(f.store.writes.length, 4);
  admitted.config.waveLimit = 999; admitted.combatSeed = -1;
  const retry = await f.service.admit('token-a', body()); assert.equal(retry.config.waveLimit, 10); assert.notEqual(retry.combatSeed, -1);
  await assert.rejects(f.service.admit('token-a', body('a'.repeat(32), alternative)), /RUN_ADMISSION_DENIED/);
  assert.ok(f.store.reads.every(key => /^(identityUids|identityWallets|shadowEntitlements|shadowRunRequests|shadowRunActive|shadowRuns)\/[a-f0-9]+(?:-[a-f0-9]{32})?$/.test(key)));
  assert.ok(f.store.writes.every(key => key.startsWith('shadow')));
});

test('concurrent same request debits once; different requests admit once; UIDs isolated', async () => {
  const f = fixture(1);
  const same = await Promise.all(Array.from({ length: 8 }, () => f.service.admit('token-a', body())));
  same.forEach(record => assert.deepEqual(record, same[0])); assert.equal(f.store.writes.length, 4);
  const b = await f.service.admit('token-b', body()); assert.notEqual(b.runId, same[0].runId);
  assert.notEqual(b.wallet, same[0].wallet);
  const g = fixture(2);
  const competing = await Promise.allSettled([g.service.admit('token-a', body()), g.service.admit('token-a', body('b'.repeat(32)))]);
  assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1); assert.equal(g.store.writes.length, 4);
});

test('no entitlement, malformed binding/reverse owner and corrupt state fail closed', async () => {
  const zero = fixture(0); await assert.rejects(zero.service.admit('token-a', body()), /RUN_ADMISSION_DENIED/);
  for (const [kind, value] of [['shadowEntitlements', undefined], ['shadowEntitlements', { credits: -1 }],
    ['shadowEntitlements', { credits: .5 }], ['shadowEntitlements', { credits: Infinity }], ['shadowEntitlements', { credits: 2, paid: true }],
    ['identityUids', undefined], ['identityUids', { wallet: 'z'.repeat(44) }], ['identityUids', { wallet: wallet(), extra: true }],
    ['shadowRunActive', { runId: 'bad' }], ['shadowRunActive', { runId: 'a'.repeat(32) }],
    ['shadowRunRequests', { runId: 'a'.repeat(32), config: mode }]]) {
    const f = fixture(); const key = `${kind}/${hex('uid/a')}${kind === 'shadowRunRequests' ? '-' + 'a'.repeat(32) : ''}`;
    f.store.seed(key, value); await assert.rejects(f.service.admit('token-a', body()), /RUN_ADMISSION_DENIED/);
    assert.equal(f.store.writes.length, 0);
  }
  const f = fixture(); f.store.seed(`identityWallets/${hex(f.wallets['uid/a'])}`, { uid: 'uid/b' });
  await assert.rejects(f.service.admit('token-a', body()), /RUN_ADMISSION_DENIED/);
  for (const uid of ['', 'x'.repeat(129), '\u0000', '\ud800']) {
    const bad = createRunAdmissionService({ authenticateToken: async () => ({ uid }), store: f.store, config: policy(), runtimeFingerprint, now: f.now });
    await assert.rejects(bad.admit('token', body()), /RUN_ADMISSION_DENIED/);
  }
});

test('expired active remains blocked; idempotent old record is not renewed', async () => {
  const f = fixture(); const record = await f.service.admit('token-a', body());
  f.time(record.expiresAt); assert.deepEqual(await f.service.admit('token-a', body()), record);
  await assert.rejects(f.service.admit('token-a', body('b'.repeat(32))), /RUN_ADMISSION_DENIED/);
  assert.equal(f.store.writes.length, 4); assert.equal(f.store.snapshot().get(`shadowEntitlements/${hex('uid/a')}`).credits, 1);
});

test('clock guard after awaits and retries; safe integer TTL boundaries', async () => {
  for (const time of [-1, .1, NaN, Infinity, Number.MAX_SAFE_INTEGER - 59999]) {
    const f = fixture(); f.time(time); await assert.rejects(f.service.admit('token-a', body()), /RUN_ADMISSION_DENIED/);
  }
  const limit = fixture(); limit.time(Number.MAX_SAFE_INTEGER - 60000);
  assert.equal((await limit.service.admit('token-a', body())).expiresAt, Number.MAX_SAFE_INTEGER);
  const stale = fixture(); stale.store.onRead = () => { stale.time(999999); };
  await assert.rejects(stale.service.admit('token-a', body()), /RUN_ADMISSION_DENIED/); assert.equal(stale.store.writes.length, 0);
  const retried = fixture(); retried.store.retry = () => retried.time(999999);
  const before = retried.store.snapshot(); await assert.rejects(retried.service.admit('token-a', body()), /RUN_ADMISSION_DENIED/);
  assert.deepEqual(retried.store.snapshot(), before);
  const advanced = fixture(); advanced.store.retry = () => advanced.time(1000100);
  const admitted = await advanced.service.admit('token-a', body()); assert.equal(admitted.admittedAt, 1000100);
  assert.equal(advanced.store.snapshot().get(`shadowEntitlements/${hex('uid/a')}`).credits, 1);
});

test('each write/commit failure rolls back debit/admission/idempotency/active pointer', async () => {
  for (const failWrite of [1, 2, 3, 4, 0]) {
    const f = fixture(); f.store.failWrite = failWrite; f.store.failCommit = failWrite === 0;
    const before = f.store.snapshot(); await assert.rejects(f.service.admit('token-a', body()));
    assert.deepEqual(f.store.snapshot(), before);
    f.store.failWrite = 0; f.store.failCommit = false;
    assert.equal((await f.service.admit('token-a', body())).purpose, 'shadow');
  }
});

test('corrupt admitted records/pointers fail closed on idempotent retry', async () => {
  for (const change of [record => ({ ...record, combatSeed: -1 }), record => ({ ...record, purpose: 'paid' }),
    record => ({ ...record, replayRuntimeVersion: 2 }), record => ({ ...record, replayRuntimeHash: '0'.repeat(64) }),
    record => { const { replayRuntimeVersion, replayRuntimeHash, ...old } = record; return old; },
    record => ({ ...record, engineVersion: 'other' }), record => ({ ...record, expiresAt: record.expiresAt + 1 }),
    record => ({ ...record, uid: 'uid/b' }), record => ({ ...record, requestId: 'b'.repeat(32) }),
    record => ({ ...record, extra: true })]) {
    const f = fixture(); const record = await f.service.admit('token-a', body());
    f.store.seed(`shadowRuns/${record.runId}`, change(record));
    const before = f.store.snapshot(); await assert.rejects(f.service.admit('token-a', body()), /RUN_ADMISSION_DENIED/);
    assert.deepEqual(f.store.snapshot(), before);
  }
});

test('caller/trusted config mutation across awaits cannot alter immutable admission', async () => {
  const f = fixture(), input = body();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const service = createRunAdmissionService({ authenticateToken: async () => { await gate; return { uid: 'uid/a' }; },
    store: f.store, config: f.config, runtimeFingerprint, now: f.now });
  const pending = service.admit('token-a', input);
  input.requestId = 'b'.repeat(32); input.config.waveLimit = 999; f.config.engineVersion = 'tampered'; f.config.allowedConfigs[0].waveLimit = 999;
  f.config.replayRuntimeVersion = 2; f.config.replayRuntimeHash = '0'.repeat(64);
  release(); const record = await pending;
  assert.equal(record.requestId, 'a'.repeat(32)); assert.equal(record.config.waveLimit, 10); assert.equal(record.engineVersion, 'engine-v1');
  assert.equal(record.replayRuntimeVersion, runtimeFingerprint.version); assert.equal(record.replayRuntimeHash, runtimeFingerprint.hash);
});

test('trusted runtime-produced DTO is mandatory; labels and unbound policy hashes are insufficient', () => {
  const f = fixture();
  const make = (config, fingerprint = runtimeFingerprint) => createRunAdmissionService({
    authenticateToken: f.authenticateToken, store: f.store, config, runtimeFingerprint: fingerprint, now: f.now });
  for (const config of [{ ...policy(), replayRuntimeVersion: 2 }, { ...policy(), replayRuntimeHash: '0'.repeat(64) },
    { ...policy(), replayRuntimeHash: runtimeFingerprint.hash.toUpperCase() },
    (() => { const { replayRuntimeVersion, replayRuntimeHash, ...old } = policy(); return old; })()]) {
    assert.throws(() => make(config), /RUN_ADMISSION_DENIED/);
  }
  for (const fingerprint of [undefined, { ...runtimeFingerprint }, Object.freeze({ version: 1, hash: runtimeFingerprint.hash })]) {
    assert.throws(() => make(policy(), fingerprint === undefined ? null : fingerprint), /RUN_ADMISSION_DENIED/);
  }
  const accessorProfile = { ...runtimeFingerprint.runtimeProfile };
  Object.defineProperty(accessorProfile, 'compiler', { enumerable: true, get() { assert.fail('DTO getter executed'); } });
  assert.throws(() => make(policy(), Object.freeze({ ...runtimeFingerprint,
    runtimeProfile: Object.freeze(accessorProfile) })), /RUN_ADMISSION_DENIED/);
  const sourceHashes = [...runtimeFingerprint.sourceHashes];
  sourceHashes[0] = Object.freeze({ ...sourceHashes[0], path: 'src/game/palette.ts' });
  assert.throws(() => make(policy(), Object.freeze({ ...runtimeFingerprint,
    sourceHashes: Object.freeze(sourceHashes) })), /RUN_ADMISSION_DENIED/);
  assert.equal(f.store.writes.length, 0);
});
