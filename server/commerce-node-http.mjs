import { createServer } from 'node:http';

const BODY_BYTES = 4096;
const routes = new Map([
  ['/commerce/catalog', 'GET'], ['/commerce/quote', 'POST'], ['/commerce/receipt', 'POST'],
  ['/identity/challenge', 'POST'], ['/identity/complete', 'POST'], ['/ready', 'GET'],
]);
const configError = () => { throw new Error('COMMERCE_NODE_CONFIG'); };

export function rejectCommerceNodeEmulators(env = process.env) {
  if (Object.keys(env).some(key => /EMULATOR/i.test(key) && env[key] !== undefined)) {
    throw new Error('COMMERCE_PRODUCTION_ONLY');
  }
}

export function readCommerceNodeConfig(env = process.env) {
  rejectCommerceNodeEmulators(env);
  const integer = (key, fallback, max) => {
    const value = env[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) configError();
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number > max) configError();
    return number;
  };
  const host = env.COMMERCE_NODE_HOST ?? '127.0.0.1';
  const origin = env.COMMERCE_IDENTITY_ORIGIN;
  let parsed;
  try { parsed = new URL(origin); } catch { configError(); }
  if (host !== '127.0.0.1' || typeof origin !== 'string' || origin.length > 2048
    || parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password) configError();
  return Object.freeze({
    host, origin, port: integer('COMMERCE_NODE_PORT', 8787, 65535),
    maxConcurrent: integer('COMMERCE_NODE_CONCURRENCY', 16, 16),
    bodyMilliseconds: integer('COMMERCE_NODE_BODY_MS', 5000, 10000),
    headersMilliseconds: integer('COMMERCE_NODE_HEADERS_MS', 5000, 10000),
    operationMilliseconds: integer('COMMERCE_NODE_OPERATION_MS', 45000, 45000),
    shutdownMilliseconds: integer('COMMERCE_NODE_SHUTDOWN_MS', 55000, 60000),
  });
}

function send(res, status, error, headers = {}) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(status === 204 ? undefined : JSON.stringify(error ? { error } : { ready: true }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const done = (error, body) => {
      req.off('data', data); req.off('end', end); req.off('error', failed); req.off('aborted', failed);
      if (error) { req.pause(); reject(error); } else resolve(body);
    };
    const failed = () => done(new Error('COMMERCE_BAD_REQUEST'));
    const data = chunk => {
      size += chunk.length;
      if (size > BODY_BYTES) done(new Error('COMMERCE_BODY_TOO_LARGE'));
      else chunks.push(chunk);
    };
    const end = () => done(null, Buffer.concat(chunks, size));
    req.on('data', data); req.once('end', end); req.once('error', failed); req.once('aborted', failed);
  });
}

// Dependency injection is a transport seam for offline unit tests, never a runtime fallback.
export function createCommerceNodeServer({ handler, config }) {
  if (typeof handler !== 'function' || !config || config.host !== '127.0.0.1'
    || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535) configError();
  const validated = readCommerceNodeConfig({ COMMERCE_IDENTITY_ORIGIN: config.origin,
    COMMERCE_NODE_HOST: config.host, COMMERCE_NODE_PORT: String(config.port || 8787),
    COMMERCE_NODE_CONCURRENCY: String(config.maxConcurrent), COMMERCE_NODE_BODY_MS: String(config.bodyMilliseconds),
    COMMERCE_NODE_HEADERS_MS: String(config.headersMilliseconds),
    COMMERCE_NODE_OPERATION_MS: String(config.operationMilliseconds),
    COMMERCE_NODE_SHUTDOWN_MS: String(config.shutdownMilliseconds) });
  config = Object.freeze({ ...validated, port: config.port });
  const sockets = new Set(), tasks = new Set(), headerTimers = new WeakMap();
  let listening = false, stopping = false, stopPromise;
  const closeSend = (req, res, status, error, headers) => {
    req.on('error', () => {});
    req.pause();
    res.once('finish', () => req.socket.destroy());
    send(res, status, error, { connection: 'close', ...headers });
  };
  async function handle(req, res) {
    let bodyTimer, operationTimer, admitted = false;
    try {
      rejectCommerceNodeEmulators();
      if (req.rawHeaders.length > 256) { closeSend(req, res, 413, 'COMMERCE_HEADERS_TOO_LARGE'); return; }
      const counts = new Map();
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i].toLowerCase();
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      if ((counts.get('authorization') ?? 0) > 1) {
        closeSend(req, res, 401, 'COMMERCE_AUTH_REQUIRED'); return;
      }
      if ([...counts.values()].some(count => count !== 1)) {
        closeSend(req, res, 400, 'COMMERCE_BAD_REQUEST'); return;
      }
      const address = server.address();
      const authority = `${config.host}:${address?.port}`;
      if (req.headers.host !== authority || req.headers.expect !== undefined || req.headers.upgrade !== undefined
        || req.headers.trailer !== undefined || req.headers.cookie !== undefined || req.headers.cookie2 !== undefined
        || req.headers['proxy-authorization'] !== undefined || /upgrade/i.test(req.headers.connection ?? '')) {
        closeSend(req, res, 400, 'COMMERCE_BAD_REQUEST'); return;
      }
      if (req.headers.origin !== undefined && req.headers.origin !== config.origin) {
        closeSend(req, res, 403, 'COMMERCE_ORIGIN'); return;
      }
      if (req.headers.origin === config.origin) {
        res.setHeader('access-control-allow-origin', config.origin); res.setHeader('vary', 'Origin');
      }
      const method = routes.get(req.url);
      if (!method) { closeSend(req, res, 404, 'COMMERCE_NOT_FOUND'); return; }
      if (req.method !== method && req.method !== 'OPTIONS') {
        closeSend(req, res, 405, 'COMMERCE_METHOD', { allow: `${method}, OPTIONS` }); return;
      }
      if (req.headers['content-encoding'] !== undefined) {
        closeSend(req, res, 415, 'COMMERCE_JSON_REQUIRED'); return;
      }
      if (req.headers['transfer-encoding'] !== undefined && req.headers['transfer-encoding'] !== 'chunked') {
        closeSend(req, res, 400, 'COMMERCE_BAD_REQUEST'); return;
      }
      if (req.method !== 'POST' && (req.headers['transfer-encoding'] !== undefined
        || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0'))) {
        closeSend(req, res, 400, 'COMMERCE_BAD_REQUEST'); return;
      }
      if (stopping || !listening) { closeSend(req, res, 503, 'COMMERCE_UNAVAILABLE'); return; }
      if (req.method === 'OPTIONS') {
        const requested = req.headers['access-control-request-headers'];
        if (req.url === '/ready' || req.headers.origin !== config.origin
          || req.headers['access-control-request-method'] !== method
          || (requested !== undefined && !/^(authorization|content-type)(\s*,\s*(authorization|content-type))*$/i.test(requested))) {
          closeSend(req, res, 403, 'COMMERCE_CORS'); return;
        }
        send(res, 204, null, { 'access-control-allow-methods': method,
          'access-control-allow-headers': 'Authorization, Content-Type',
          vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers' }); return;
      }
      if (tasks.size > config.maxConcurrent) { closeSend(req, res, 503, 'COMMERCE_BUSY'); return; }
      if (req.url === '/ready') { send(res, 200); return; }
      if (req.method === 'POST') {
        if (typeof req.headers.authorization !== 'string' || !/^Bearer [^\s]{1,16384}$/.test(req.headers.authorization)) {
          closeSend(req, res, 401, 'COMMERCE_AUTH_REQUIRED'); return;
        }
        if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
          closeSend(req, res, 415, 'COMMERCE_JSON_REQUIRED'); return;
        }
        const length = req.headers['content-length'];
        if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > BODY_BYTES)) {
          closeSend(req, res, 413, 'COMMERCE_BODY_TOO_LARGE'); return;
        }
        admitted = true;
        let rejectDeadline;
        const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
        bodyTimer = setTimeout(() => {
          closeSend(req, res, 408, 'COMMERCE_BODY_TIMEOUT');
          rejectDeadline(new Error('COMMERCE_BODY_TIMEOUT'));
        }, config.bodyMilliseconds);
        req.rawBody = await Promise.race([readBody(req), deadline]);
        clearTimeout(bodyTimer);
        if (req.rawTrailers.length || (length !== undefined && req.rawBody.length !== Number(length))
          || req.rawBody.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
          closeSend(req, res, 400, 'COMMERCE_BAD_REQUEST'); return;
        }
      }
      admitted = true;
      operationTimer = setTimeout(() => closeSend(req, res, 503, 'COMMERCE_TIMEOUT_RETRY_SAME_RECEIPT'), config.operationMilliseconds);
      await handler(req, res);
      if (!res.writableEnded && !res.destroyed) closeSend(req, res, 503, 'COMMERCE_UNAVAILABLE');
    } catch (error) {
      closeSend(req, res, error?.message === 'COMMERCE_BODY_TOO_LARGE' ? 413 :
        error?.message === 'COMMERCE_BAD_REQUEST' ? 400 : 503,
      ['COMMERCE_BODY_TOO_LARGE', 'COMMERCE_BAD_REQUEST'].includes(error?.message) ? error.message : 'COMMERCE_UNAVAILABLE');
    } finally {
      clearTimeout(bodyTimer); clearTimeout(operationTimer);
      if (!admitted) req.pause();
    }
  }
  const server = createServer({ maxHeaderSize: 20480, insecureHTTPParser: false, requireHostHeader: true }, (req, res) => {
    clearTimeout(headerTimers.get(req.socket));
    req.on('error', () => {});
    res.on('error', () => res.destroy());
    res.setHeader('connection', 'close');
    // Add before handling so synchronous/slow body requests share the same bounded admission count.
    const task = Promise.resolve().then(() => handle(req, res));
    tasks.add(task); task.finally(() => tasks.delete(task));
  });
  server.maxHeadersCount = 0;
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 1;
  server.headersTimeout = config.headersMilliseconds;
  server.requestTimeout = Math.max(config.headersMilliseconds, config.bodyMilliseconds) + 1000;
  server.keepAliveTimeout = 1000;
  server.setTimeout(config.operationMilliseconds + config.bodyMilliseconds + 1000, socket => socket.destroy());
  server.on('connection', socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    const timer = setTimeout(() => socket.destroy(), config.headersMilliseconds);
    headerTimers.set(socket, timer);
    socket.once('close', () => clearTimeout(timer));
  });
  server.on('checkContinue', (req, res) => closeSend(req, res, 417, 'COMMERCE_EXPECTATION'));
  server.on('checkExpectation', (req, res) => closeSend(req, res, 417, 'COMMERCE_EXPECTATION'));
  server.on('upgrade', (req, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  server.on('clientError', (_, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else socket.destroy();
  });
  server.on('error', () => { listening = false; });
  return Object.freeze({ server,
    async listen() {
      if (stopping || listening) configError();
      await new Promise((resolve, reject) => {
        const failed = error => { server.off('listening', opened); reject(error); };
        const opened = () => { server.off('error', failed); listening = true; resolve(); };
        server.once('error', failed); server.once('listening', opened);
        server.listen(config.port, config.host);
      });
      return server.address();
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopping = true; listening = false;
      stopPromise = (async () => {
        let timer;
        const closed = new Promise(resolve => server.close(() => resolve()));
        server.closeIdleConnections();
        const drained = await Promise.race([
          Promise.all([closed, ...tasks]).then(() => true),
          new Promise(resolve => { timer = setTimeout(() => resolve(false), config.shutdownMilliseconds); }),
        ]);
        clearTimeout(timer);
        if (!drained) { for (const socket of sockets) socket.destroy(); server.closeAllConnections(); }
        return Object.freeze({ drained });
      })();
      return stopPromise;
    },
  });
}
