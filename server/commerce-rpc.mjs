import { fail } from './commerce-common.mjs';

// Preserve unsafe JSON integers as decimal strings before JSON.parse can round them.
export function parseRpcJson(text) {
  let output = '', offset = 0;
  const tokens = /"(?:[^"\\]|\\[\s\S])*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g;
  for (const match of text.matchAll(tokens)) {
    output += text.slice(offset, match.index);
    const token = match[0];
    output += /^-?[0-9]+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token;
    offset = match.index + token.length;
  }
  return JSON.parse(output + text.slice(offset));
}
export function createCommerceRpc({ url, timeoutMilliseconds = 8000 } = {}) {
  let endpoint; try { endpoint = new URL(url); } catch { fail('COMMERCE_RPC_CONFIG'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash
    || !Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 15000) fail('COMMERCE_RPC_CONFIG');
  const target = endpoint.href;
  let sequence = 0;
  return Object.freeze({ async call(method, params = []) {
    if (!['getGenesisHash', 'getTransaction', 'getSignatureStatuses', 'getMultipleAccounts'].includes(method)) fail('COMMERCE_RPC_METHOD');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMilliseconds);
    try {
      const id = ++sequence;
      const response = await fetch(target, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      if (!response.ok || !response.body) fail('COMMERCE_RPC_UNAVAILABLE');
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 1048576) fail('COMMERCE_RPC_UNAVAILABLE');
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const result = parseRpcJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (result?.jsonrpc !== '2.0' || result.id !== id || Object.hasOwn(result, 'error')
        || !Object.hasOwn(result, 'result')) fail('COMMERCE_RPC_UNAVAILABLE');
      return result.result;
    } catch { controller.abort(); fail('COMMERCE_RPC_UNAVAILABLE'); }
    finally { clearTimeout(timer); }
  } });
}
