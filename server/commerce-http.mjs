import { exact, fail } from './commerce-common.mjs';

// Firebase/Express parsed-body adapter; not a standalone raw node:http listener.
export function createCommerceHttpHandler({ commerce, identity, origin, operationMilliseconds = 45000 }) {
  if (typeof commerce?.catalog !== 'function' || typeof commerce.quote !== 'function' || typeof commerce.receipt !== 'function'
    || typeof identity?.issueChallenge !== 'function' || typeof identity.complete !== 'function'
    || typeof origin !== 'string' || !Number.isSafeInteger(operationMilliseconds)
    || operationMilliseconds < 1 || operationMilliseconds > 45000) fail('COMMERCE_HTTP_CONFIG');
  const paths = new Map([['/commerce/quote', 'quote'], ['/commerce/receipt', 'receipt'],
    ['/identity/challenge', 'issueChallenge'], ['/identity/complete', 'complete']]);
  let active = 0;
  return async (req, res) => {
    const send = (status, value) => {
      if (res.headersSent || res.writableEnded || res.destroyed) return;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
      res.statusCode = status; res.end(JSON.stringify(value));
    };
    let timer, entered = false;
    try {
      const requestOrigin = req.headers?.origin;
      if (requestOrigin !== undefined && requestOrigin !== origin) { send(403, { error: 'COMMERCE_ORIGIN' }); return; }
      if (requestOrigin === origin) {
        res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        if ((!paths.has(req.url) && req.url !== '/commerce/catalog') || requestOrigin !== origin) {
          send(404, { error: 'COMMERCE_NOT_FOUND' }); return;
        }
        res.setHeader('access-control-allow-methods', 'GET, POST');
        res.setHeader('access-control-allow-headers', 'Authorization, Content-Type');
        send(204, null); return;
      }
      const catalog = req.url === '/commerce/catalog' && req.method === 'GET', action = paths.get(req.url);
      if (!catalog && (!action || req.method !== 'POST')) { send(404, { error: 'COMMERCE_NOT_FOUND' }); return; }
      if (active >= 16) { send(503, { error: 'COMMERCE_BUSY' }); return; }
      active++; entered = true;
      timer = setTimeout(() => send(503, { error: 'COMMERCE_TIMEOUT_RETRY_SAME_RECEIPT' }), operationMilliseconds);
      if (catalog) { send(200, await commerce.catalog()); return; }
      const auth = req.headers?.authorization;
      if (typeof auth !== 'string' || !/^Bearer [^\s]{1,16384}$/.test(auth)
        || (req.rawHeaders && req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === 'authorization').length !== 1)) {
        send(401, { error: 'COMMERCE_AUTH_REQUIRED' }); return;
      }
      if (typeof req.headers?.['content-type'] !== 'string'
        || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'])) {
        send(415, { error: 'COMMERCE_JSON_REQUIRED' }); return;
      }
      let body;
      try {
        if (Buffer.isBuffer(req.rawBody)) {
          if (req.rawBody.length > 4096) throw new Error();
          body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(req.rawBody));
        } else {
          if (!req.body || Buffer.byteLength(JSON.stringify(req.body)) > 4096) throw new Error();
          body = structuredClone(req.body);
        }
        const expected = action === 'quote' ? ['productId', 'currency', 'payer'] : action === 'receipt'
          ? ['quoteId', 'signature'] : action === 'issueChallenge' ? ['wallet'] : ['challengeId', 'signature'];
        if (!exact(body, expected)) throw new Error();
      } catch { send(400, { error: 'COMMERCE_BAD_REQUEST' }); return; }
      const result = await (action === 'quote' || action === 'receipt' ? commerce : identity)[action](auth.slice(7), body);
      send(200, result);
    } catch (error) {
      const code = error?.message;
      if (['COMMERCE_DENIED', 'COMMERCE_REPLAY', 'IDENTITY_DENIED', 'IDENTITY_ADAPTER_DENIED'].includes(code)) send(403, { error: code });
      else if (code === 'COMMERCE_LOCKED') send(409, { error: code });
      else send(503, { error: 'COMMERCE_UNAVAILABLE' });
    } finally { clearTimeout(timer); if (entered) active--; }
  };
}
