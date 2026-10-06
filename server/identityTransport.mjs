import { decodeWallet } from './identity.mjs';

const DEFAULTS = Object.freeze({ maxActive: 8, bodyBytes: 4096, headerBytes: 24576,
  bodyMs: 5000, operationMs: 10000 });
const exact = (value, keys) => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const successBody = (result, issue) => {
  if (issue) {
    if (!exact(result, ['challengeId', 'message', 'expiresAt']) || typeof result.challengeId !== 'string'
      || !/^[a-f0-9]{64}$/.test(result.challengeId) || typeof result.message !== 'string'
      || !result.message.length || Buffer.byteLength(result.message) > 4096
      || !Number.isSafeInteger(result.expiresAt) || result.expiresAt < 0) throw new Error('IDENTITY_TRANSPORT_RESPONSE');
    return { challengeId: result.challengeId, message: result.message, expiresAt: result.expiresAt };
  }
  if (!exact(result, ['uid', 'wallet', 'cluster']) || typeof result.uid !== 'string' || !result.uid.length
    || result.uid.length > 128 || /[\u0000-\u001f\u007f]/.test(result.uid)
    || Buffer.from(result.uid, 'utf8').toString('utf8') !== result.uid || typeof result.wallet !== 'string'
    || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(result.wallet) || !['devnet', 'testnet'].includes(result.cluster)) {
    throw new Error('IDENTITY_TRANSPORT_RESPONSE');
  }
  try { decodeWallet(result.wallet); } catch { throw new Error('IDENTITY_TRANSPORT_RESPONSE'); }
  return { uid: result.uid, wallet: result.wallet, cluster: result.cluster };
};

export function createIdentityTransport({ service, expectedHost, limits = {} } = {}) {
  if (typeof service?.issueChallenge !== 'function' || typeof service?.complete !== 'function'
    || typeof expectedHost !== 'string' || expectedHost.length > 255 || /[\s/@?#\\]/.test(expectedHost)) {
    throw new Error('IDENTITY_TRANSPORT_CONFIG');
  }
  let host;
  try { host = new URL(`http://${expectedHost}`); } catch { throw new Error('IDENTITY_TRANSPORT_CONFIG'); }
  if (host.host !== expectedHost || host.username || host.password || host.pathname !== '/') throw new Error('IDENTITY_TRANSPORT_CONFIG');
  if (!limits || Object.getPrototypeOf(limits) !== Object.prototype
    || Reflect.ownKeys(limits).some(key => !Object.hasOwn(DEFAULTS, key))) throw new Error('IDENTITY_TRANSPORT_CONFIG');
  const config = Object.freeze({ ...DEFAULTS, ...limits });
  for (const [key, value] of Object.entries(config)) {
    const cap = key === 'maxActive' ? 32 : key === 'bodyBytes' ? 4096 : key === 'headerBytes' ? 24576 : 60000;
    if (!Number.isSafeInteger(value) || value < 1 || value > cap) throw new Error('IDENTITY_TRANSPORT_CONFIG');
  }
  const active = new Set();
  let closed = false;
  const respond = (req, res, status, body) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', Connection: 'close' });
    res.once('finish', () => { if (!req.complete) req.destroy(); });
    res.end(JSON.stringify(body));
  };
  const unavailable = (req, res, unknown = false) => respond(req, res, 503,
    unknown ? { error: 'IDENTITY_UNAVAILABLE', outcome: 'unknown' } : { error: 'IDENTITY_UNAVAILABLE' });
  const handler = (req, res) => {
    res.once('error', () => { if (!res.destroyed) res.destroy(); });
    const fail = (status, code) => respond(req, res, status, { error: code });
    if (closed || active.size >= config.maxActive) { unavailable(req, res); return; }
    if (req.method !== 'POST' || !['/identity/challenge', '/identity/complete'].includes(req.url)) {
      fail(400, 'IDENTITY_BAD_REQUEST'); return;
    }
    const headers = new Map();
    let headerBytes = Buffer.byteLength(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`) + 2;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i].toLowerCase(), value = req.rawHeaders[i + 1];
      headerBytes += Buffer.byteLength(req.rawHeaders[i]) + Buffer.byteLength(value) + 4;
      const values = headers.get(name) ?? []; values.push(value); headers.set(name, values);
    }
    if (headerBytes > config.headerBytes || req.rawHeaders.length > 256) { fail(413, 'IDENTITY_TOO_LARGE'); return; }
    if (headers.get('host')?.length !== 1 || headers.get('host')[0] !== expectedHost
      || ['cookie', 'cookie2', 'proxy-authorization', 'origin', 'trailer', 'expect'].some(key => headers.has(key))
      || ['authorization', 'content-type', 'content-length', 'content-encoding', 'transfer-encoding'].some(key => (headers.get(key)?.length ?? 0) > 1)) {
      fail(400, 'IDENTITY_BAD_REQUEST'); return;
    }
    const authorization = headers.get('authorization')?.[0];
    if (!authorization) { fail(401, 'IDENTITY_AUTH_REQUIRED'); return; }
    const bearer = /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/.exec(authorization);
    if (!bearer || bearer[1].length > 16384) { fail(400, 'IDENTITY_BAD_REQUEST'); return; }
    if (headers.has('content-encoding') || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers.get('content-type')?.[0] ?? '')) {
      fail(415, 'IDENTITY_UNSUPPORTED_MEDIA'); return;
    }
    const length = headers.get('content-length')?.[0];
    if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > config.bodyBytes)) {
      fail(Number(length) > config.bodyBytes ? 413 : 400, 'IDENTITY_BAD_REQUEST'); return;
    }
    if (headers.has('transfer-encoding') && headers.get('transfer-encoding')[0] !== 'chunked') {
      fail(400, 'IDENTITY_BAD_REQUEST'); return;
    }
    const record = { req, res, operation: false, timer: undefined, release: undefined };
    active.add(record);
    let chunks = [], bytes = 0, ended = false;
    const release = () => {
      clearTimeout(record.timer); record.timer = undefined;
      chunks = []; active.delete(record);
      req.off('data', onData); req.off('end', onEnd);
    };
    record.release = release;
    const bodyFailure = (status, code) => {
      if (ended) return;
      ended = true; fail(status, code); release();
    };
    const onData = chunk => {
      if (ended) return;
      bytes += chunk.length;
      if (bytes > config.bodyBytes) { bodyFailure(413, 'IDENTITY_TOO_LARGE'); return; }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (ended) return;
      ended = true; clearTimeout(record.timer);
      let body;
      try {
        if (req.rawTrailers.length || (length !== undefined && bytes !== Number(length))) throw new Error();
        body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, bytes)));
        const issue = req.url === '/identity/challenge';
        if (issue ? !exact(body, ['wallet']) || typeof body.wallet !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(body.wallet)
          : !exact(body, ['challengeId', 'signature']) || typeof body.challengeId !== 'string' || !/^[a-f0-9]{64}$/.test(body.challengeId)
            || typeof body.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(body.signature)) throw new Error();
      } catch { fail(400, 'IDENTITY_BAD_REQUEST'); release(); return; }
      chunks = []; record.operation = true;
      record.timer = setTimeout(() => { record.timer = undefined; unavailable(req, res, true); }, config.operationMs);
      Promise.resolve().then(() => req.url === '/identity/challenge'
        ? service.issueChallenge(bearer[1], body) : service.complete(bearer[1], body))
        .then(result => {
          if (res.destroyed || res.writableEnded) return;
          const json = JSON.stringify(successBody(result, req.url === '/identity/challenge'));
          if (typeof json !== 'string' || Buffer.byteLength(json) > 8192) throw new Error('IDENTITY_TRANSPORT_RESPONSE');
          respond(req, res, 200, JSON.parse(json));
        }).catch(error => {
          if (error?.message === 'IDENTITY_DENIED') fail(403, 'IDENTITY_DENIED');
          else unavailable(req, res, true);
        }).finally(release);
    };
    req.on('data', onData); req.on('end', onEnd);
    req.once('error', () => { if (!record.operation) { ended = true; release(); } });
    req.once('aborted', () => { if (!record.operation) { ended = true; release(); } });
    res.once('close', () => { if (!record.operation) { ended = true; release(); } });
    record.timer = setTimeout(() => bodyFailure(400, 'IDENTITY_BODY_TIMEOUT'), config.bodyMs);
  };
  return Object.freeze({ handler, get active() { return active.size; },
    close() {
      closed = true;
      for (const record of active) {
        clearTimeout(record.timer); unavailable(record.req, record.res, record.operation);
        if (!record.operation) { record.release(); record.req.destroy(); }
      }
    },
  });
}
