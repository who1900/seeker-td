const fail = () => { throw new Error('AUTHORITY_HTTP_CONFIG'); };
const prefix = '/api/game-authority/v1/';

// Parsed-body HTTPS adapter only; intentionally not registered in any production listener.
export function createGameAuthorityHttpHandler({ authority, origin, enabled = false, timeoutMilliseconds = 10000 } = {}) {
  let parsed;
  try { parsed = new URL(origin); } catch { fail(); }
  if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password
    || typeof enabled !== 'boolean' || !Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1
    || timeoutMilliseconds > 15000 || !['balance', 'debit', 'settle', 'payout'].every(k => typeof authority?.[k] === 'function')) fail();
  let active = 0;
  return async (req, res) => {
    const send = (status, value) => {
      if (res.headersSent || res.writableEnded || res.destroyed) return;
      res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
      res.end(JSON.stringify(value));
    };
    let timer, entered = false;
    try {
      if (!enabled) { send(503, { error: 'AUTHORITY_DISABLED' }); return; }
      const action = ['balance', 'debit', 'settle', 'payout'].find(k => req.url === prefix + k);
      if (!action || req.method !== 'POST') { send(404, { error: 'AUTHORITY_NOT_FOUND' }); return; }
      if (req.protocol !== 'https' && req.socket?.encrypted !== true) { send(403, { error: 'AUTHORITY_HTTPS_REQUIRED' }); return; }
      if (req.headers?.origin !== undefined && req.headers.origin !== origin) { send(403, { error: 'AUTHORITY_ORIGIN' }); return; }
      const auth = req.headers?.authorization;
      if (typeof auth !== 'string' || !/^Bearer [\x21-\x7e]{1,16384}$/.test(auth)
        || (req.rawHeaders && req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === 'authorization').length !== 1)) {
        send(401, { error: 'AUTHORITY_AUTH_REQUIRED' }); return;
      }
      if (req.headers['content-encoding'] !== undefined || req.headers.cookie !== undefined
        || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
        send(415, { error: 'AUTHORITY_JSON_REQUIRED' }); return;
      }
      let body;
      try {
        if (Buffer.isBuffer(req.rawBody)) {
          if (req.rawBody.length > 4096 || req.rawBody.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw new Error();
          body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(req.rawBody));
        } else {
          if (!req.body || Buffer.byteLength(JSON.stringify(req.body)) > 4096) throw new Error();
          body = structuredClone(req.body);
        }
      } catch { send(400, { error: 'AUTHORITY_BAD_REQUEST' }); return; }
      if (active >= 16) { send(503, { error: 'AUTHORITY_BUSY' }); return; }
      entered = true; active++;
      timer = setTimeout(() => send(503, { error: 'AUTHORITY_TIMEOUT_RETRY_SAME_REQUEST' }), timeoutMilliseconds);
      send(200, await authority[action](auth.slice(7), body));
    } catch (error) {
      const code = error?.message;
      if (['AUTHORITY_DENIED', 'AUTHORITY_REPLAY', 'IDENTITY_DENIED', 'IDENTITY_ADAPTER_DENIED'].includes(code)) send(403, { error: code });
      else if (['AUTHORITY_FUNDS', 'AUTHORITY_QUOTA'].includes(code)) send(409, { error: code });
      else if (['AUTHORITY_DISABLED', 'AUTHORITY_SETTLEMENT_DISABLED', 'AUTHORITY_PAYOUT_DISABLED'].includes(code)) send(503, { error: code });
      else send(503, { error: 'AUTHORITY_UNAVAILABLE' });
    } finally { clearTimeout(timer); if (entered) active--; }
  };
}
