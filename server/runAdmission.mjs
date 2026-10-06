import { randomBytes } from 'node:crypto';
import { decodeWallet } from './identity.mjs';

const deny = () => { throw new Error('RUN_ADMISSION_DENIED'); };
const exact = (value, keys) => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const hexId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const version = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const uidValid = uid => typeof uid === 'string' && uid.length > 0 && uid.length <= 128
  && !/[\u0000-\u001f\u007f]/.test(uid) && Buffer.from(uid, 'utf8').toString('utf8') === uid;
const runConfig = value => exact(value, ['mode', 'waveLimit', 'durationMinutes'])
  && ['waves', 'timed', 'endless'].includes(value.mode) && Number.isSafeInteger(value.waveLimit)
  && value.waveLimit >= 1 && value.waveLimit <= 10000 && [5, 10, 20, 40].includes(value.durationMinutes);
const sameConfig = (a, b) => a.mode === b.mode && a.waveLimit === b.waveLimit && a.durationMinutes === b.durationMinutes;
const encoded = value => Buffer.from(value, 'utf8').toString('hex');
const runtimeHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const runtimeSourcePaths = ['types', 'data', 'engine', 'combatShots', 'combatStatus', 'waveManager',
  'pathfinding', 'gameplayRandom', 'replayTiming', 'replayCommands', 'replayChunk'].map(name => `src/game/${name}.ts`);
const runtimeProfileKeys = ['declaration', 'runtime', 'language', 'numbers', 'codec', 'projection', 'rng',
  'binding', 'compiler', 'compilerOptions', 'node'];
const runtimeFingerprintValid = value => exact(value, ['version', 'hash', 'sourceHashes', 'runtimeProfile'])
  && Object.isFrozen(value) && value.version === 1 && runtimeHash(value.hash)
  && Array.isArray(value.sourceHashes) && Object.isFrozen(value.sourceHashes) && value.sourceHashes.length === 11
  && Reflect.ownKeys(value.sourceHashes).length === 12
  && runtimeSourcePaths.every((sourcePath, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value.sourceHashes, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false;
    const source = descriptor.value;
    return exact(source, ['path', 'hash']) && Object.isFrozen(source)
      && source.path === sourcePath && runtimeHash(source.hash);
  })
  && exact(value.runtimeProfile, runtimeProfileKeys)
  && Object.isFrozen(value.runtimeProfile)
  && runtimeProfileKeys.every(key => typeof value.runtimeProfile[key] === 'string' && value.runtimeProfile[key].length > 0)
  && value.runtimeProfile.binding === 'captured-source-commonjs-v1';
const recordKeys = ['purpose', 'runId', 'requestId', 'uid', 'wallet', 'config', 'admittedAt', 'expiresAt',
  'engineVersion', 'dataVersion', 'protocolVersion', 'replayRuntimeVersion', 'replayRuntimeHash',
  'combatSeed', 'rngAlgorithm', 'rngVersion'];

// Shadow-only admission. Protocol version pins a contract; no replay or money authorization is implemented here.
export function createRunAdmissionService({ authenticateToken, store, config, runtimeFingerprint, now = Date.now } = {}) {
  if (typeof authenticateToken !== 'function' || typeof store?.transaction !== 'function' || typeof now !== 'function'
    || !runtimeFingerprintValid(runtimeFingerprint)
    || !exact(config, ['engineVersion', 'dataVersion', 'protocolVersion', 'replayRuntimeVersion', 'replayRuntimeHash', 'ttlMilliseconds', 'allowedConfigs'])
    || config.replayRuntimeVersion !== runtimeFingerprint.version || config.replayRuntimeHash !== runtimeFingerprint.hash
    || ![config.engineVersion, config.dataVersion, config.protocolVersion].every(version)
    || !Number.isSafeInteger(config.ttlMilliseconds) || config.ttlMilliseconds < 1 || config.ttlMilliseconds > 86400000
    || !Array.isArray(config.allowedConfigs) || !config.allowedConfigs.length || config.allowedConfigs.length > 64
    || !config.allowedConfigs.every(runConfig)) deny();
  const trusted = Object.freeze({ engineVersion: config.engineVersion, dataVersion: config.dataVersion,
    replayRuntimeVersion: runtimeFingerprint.version, replayRuntimeHash: runtimeFingerprint.hash,
    protocolVersion: config.protocolVersion, ttlMilliseconds: config.ttlMilliseconds,
    allowedConfigs: Object.freeze(config.allowedConfigs.map(value => Object.freeze({ ...value }))) });
  if (new Set(trusted.allowedConfigs.map(value => JSON.stringify([value.mode, value.waveLimit, value.durationMinutes]))).size !== trusted.allowedConfigs.length) deny();
  const allowed = value => runConfig(value) && trusted.allowedConfigs.some(item => sameConfig(item, value));
  const clock = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - trusted.ttlMilliseconds) deny();
    return value;
  };
  const validRecord = (value, uid, wallet, time) => exact(value, recordKeys) && value.purpose === 'shadow'
    && hexId(value.runId) && hexId(value.requestId) && value.uid === uid && value.wallet === wallet && allowed(value.config)
    && value.engineVersion === trusted.engineVersion && value.dataVersion === trusted.dataVersion
    && value.replayRuntimeVersion === trusted.replayRuntimeVersion && value.replayRuntimeHash === trusted.replayRuntimeHash
    && value.protocolVersion === trusted.protocolVersion && value.rngAlgorithm === 'mulberry32' && value.rngVersion === 1
    && Number.isInteger(value.combatSeed) && value.combatSeed >= 0 && value.combatSeed <= 0xffffffff
    && Number.isSafeInteger(value.admittedAt) && value.admittedAt >= 0 && value.admittedAt <= time
    && value.admittedAt <= Number.MAX_SAFE_INTEGER - trusted.ttlMilliseconds
    && value.expiresAt === value.admittedAt + trusted.ttlMilliseconds;
  return Object.freeze({
    async admit(token, body) {
      if (typeof token !== 'string' || !token.length || token.length > 16384
        || !exact(body, ['requestId', 'config']) || !hexId(body.requestId) || !allowed(body.config)) deny();
      // Copy before auth/transaction awaits: caller mutation cannot change the admitted request.
      const requestId = body.requestId, requested = Object.freeze({ ...body.config });
      let observed = clock();
      const readClock = () => { const value = clock(); if (value < observed) deny(); observed = value; return value; };
      const authenticated = await authenticateToken(token);
      readClock();
      if (!uidValid(authenticated?.uid)) deny();
      const uid = authenticated.uid, uidKey = encoded(uid);
      const runId = randomBytes(16).toString('hex'), combatSeed = randomBytes(4).readUInt32BE(0);
      return store.transaction(async tx => {
        if (typeof tx?.get !== 'function' || typeof tx?.set !== 'function') deny();
        const time = readClock();
        const bindingKey = `identityUids/${uidKey}`, entitlementKey = `shadowEntitlements/${uidKey}`;
        const requestKey = `shadowRunRequests/${uidKey}-${requestId}`, activeKey = `shadowRunActive/${uidKey}`;
        const candidateKey = `shadowRuns/${runId}`;
        const [binding, entitlement, request, active, collision] = await Promise.all([
          tx.get(bindingKey), tx.get(entitlementKey), tx.get(requestKey), tx.get(activeKey), tx.get(candidateKey),
        ]);
        if (!exact(binding, ['wallet'])) deny();
        try { decodeWallet(binding.wallet); } catch { deny(); }
        const owner = await tx.get(`identityWallets/${encoded(binding.wallet)}`);
        if (!exact(owner, ['uid']) || owner.uid !== uid || !exact(entitlement, ['credits'])
          || !Number.isSafeInteger(entitlement.credits) || entitlement.credits < 0) deny();
        if (active !== undefined && (!exact(active, ['runId']) || !hexId(active.runId))) deny();
        if (request !== undefined && (!exact(request, ['runId', 'config']) || !hexId(request.runId) || !allowed(request.config))) deny();
        const current = active === undefined ? undefined : await tx.get(`shadowRuns/${active.runId}`);
        const commitTime = readClock();
        if (commitTime < time || (active !== undefined && (!validRecord(current, uid, binding.wallet, commitTime)
          || current.runId !== active.runId))) deny();
        if (request !== undefined) {
          if (!sameConfig(request.config, requested) || !current || request.runId !== active.runId
            || current.requestId !== requestId || !sameConfig(current.config, requested)) deny();
          // An expired admission remains expired; idempotency is not permission to resume it.
          return structuredClone(current);
        }
        if (active !== undefined || collision !== undefined || entitlement.credits < 1) deny();
        const record = { purpose: 'shadow', runId, requestId, uid, wallet: binding.wallet, config: { ...requested },
          admittedAt: commitTime, expiresAt: commitTime + trusted.ttlMilliseconds,
          engineVersion: trusted.engineVersion, dataVersion: trusted.dataVersion, protocolVersion: trusted.protocolVersion,
          replayRuntimeVersion: trusted.replayRuntimeVersion, replayRuntimeHash: trusted.replayRuntimeHash,
          combatSeed, rngAlgorithm: 'mulberry32', rngVersion: 1 };
        await tx.set(entitlementKey, { credits: entitlement.credits - 1 });
        await tx.set(candidateKey, record);
        await tx.set(requestKey, { runId, config: { ...requested } });
        await tx.set(activeKey, { runId });
        return structuredClone(record);
      });
    },
  });
}
