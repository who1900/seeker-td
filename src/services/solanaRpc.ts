import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Connection } from '@solana/web3.js';
import type { ConnectionConfig } from '@solana/web3.js';
import { getSolanaConfig } from './solanaConfig';

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
type RpcId = string | number;

function trustedUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || value.trim() !== value) {
    throw new Error('Native Solana RPC requires the configured HTTPS endpoint');
  }
  return url.toString();
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requestIds(body: string): { ids: RpcId[]; batch: boolean } {
  if (body.length > MAX_REQUEST_BYTES || new TextEncoder().encode(body).length > MAX_REQUEST_BYTES) {
    throw new Error('Native Solana RPC request exceeds size limit');
  }
  const parsed: unknown = JSON.parse(body);
  const batch = Array.isArray(parsed);
  const requests = batch ? parsed : [parsed];
  if (!requests.length || requests.length > 32) throw new Error('Invalid native Solana RPC batch');
  const ids: RpcId[] = [];
  for (const request of requests) {
    if (!object(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string'
      || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(request.method)
      || (typeof request.id !== 'string' && typeof request.id !== 'number')
      || (typeof request.id === 'string' && (!request.id || request.id.length > 128))
      || (typeof request.id === 'number' && !Number.isSafeInteger(request.id))
      || (request.params !== undefined && !Array.isArray(request.params))
      || Object.keys(request).some(key => !['jsonrpc', 'method', 'id', 'params'].includes(key))) {
      throw new Error('Invalid native Solana JSON-RPC request');
    }
    if (ids.includes(request.id)) throw new Error('Duplicate native Solana RPC request ID');
    ids.push(request.id);
  }
  return { ids, batch };
}

function responseJson(data: unknown, ids: RpcId[], batch: boolean): string {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  if (typeof text !== 'string' || text.length > MAX_RESPONSE_BYTES
    || new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw new Error('Invalid native Solana RPC response size');
  const parsed: unknown = JSON.parse(text);
  if (Array.isArray(parsed) !== batch) throw new Error('Native Solana RPC response shape mismatch');
  const responses = Array.isArray(parsed) ? parsed : [parsed];
  const seen = new Set<RpcId>();
  if (responses.length !== ids.length) throw new Error('Native Solana RPC response count mismatch');
  for (const response of responses) {
    if (!object(response) || response.jsonrpc !== '2.0'
      || (typeof response.id !== 'string' && typeof response.id !== 'number') || !ids.includes(response.id) || seen.has(response.id)
      || Object.keys(response).some(key => !['jsonrpc', 'id', 'result', 'error'].includes(key))
      || Object.prototype.hasOwnProperty.call(response, 'result') === Object.prototype.hasOwnProperty.call(response, 'error')) {
      throw new Error('Native Solana RPC response ID/envelope mismatch');
    }
    if ('error' in response && (!object(response.error) || !Number.isSafeInteger(response.error.code)
      || typeof response.error.message !== 'string' || !response.error.message || response.error.message.length > 4096)) {
      throw new Error('Invalid native Solana RPC error');
    }
    seen.add(response.id);
  }
  return text;
}

export function getSolanaConnectionConfig(endpoint: string, signal?: AbortSignal): ConnectionConfig {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return { commitment: 'confirmed' };
  const config = getSolanaConfig();
  const url = trustedUrl(config.endpoint);
  if (trustedUrl(endpoint) !== url) throw new Error('Native Solana RPC endpoint does not match configured endpoint');
  const timeoutMs = Math.min(config.timeoutMs, 15000);
  const fetch: NonNullable<ConnectionConfig['fetch']> = async (input, init) => {
    if ((typeof input !== 'string' && !(input instanceof URL)) || trustedUrl(String(input)) !== url
      || init?.method !== 'POST' || typeof init.body !== 'string'
      || (init.credentials !== undefined && init.credentials !== 'omit')
      || (init.redirect !== undefined && init.redirect !== 'error')) {
      throw new Error('Native Solana RPC accepts only configured HTTPS JSON POST requests');
    }
    const { ids, batch } = requestIds(init.body);
    const headers = new Headers(init.headers);
    if (headers.get('content-type')?.toLowerCase() !== 'application/json') throw new Error('Invalid native Solana RPC content type');
    for (const [name, value] of headers) {
      if (!['content-type', 'accept', 'solana-client'].includes(name) || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
        throw new Error('Unsupported native Solana RPC request header');
      }
    }
    const signals = [signal, init.signal].filter((value): value is AbortSignal => value !== undefined && value !== null);
    if (signals.some(value => value.aborted)) throw new DOMException('Solana RPC request cancelled', 'AbortError');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    const deadline = Date.now() + timeoutMs;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(new DOMException('Solana RPC request cancelled', 'AbortError'));
        for (const value of signals) value.addEventListener('abort', abort, { once: true });
        if (signals.some(value => value.aborted)) abort();
        timer = setTimeout(() => reject(new Error('Native Solana RPC request timed out')), timeoutMs);
      });
      const request = Promise.resolve().then(() => {
        if (signals.some(value => value.aborted)) throw new DOMException('Solana RPC request cancelled', 'AbortError');
        return CapacitorHttp.request({ url, method: 'POST', data: init.body, headers: Object.fromEntries(headers),
          disableRedirects: true, connectTimeout: Math.min(timeoutMs, 10000), readTimeout: timeoutMs, responseType: 'text' });
      }).catch(() => { throw new Error('Native Solana RPC request failed'); });
      const response = await Promise.race([request, cancelled]);
      if (signals.some(value => value.aborted)) throw new DOMException('Solana RPC request cancelled', 'AbortError');
      if (Date.now() >= deadline) throw new Error('Native Solana RPC request timed out');
      if (!response || response.status !== 200 || typeof response.url !== 'string' || trustedUrl(response.url) !== url
        || !object(response.headers)) throw new Error('Native Solana RPC status/URL mismatch or redirect');
      const returnedHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (typeof value !== 'string') throw new Error('Invalid native Solana RPC response headers');
        returnedHeaders.append(name, value);
      }
      const contentType = returnedHeaders.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (returnedHeaders.has('location') || !contentType || !/^application\/(?:json|json-rpc|[a-z0-9.-]+\+json)$/.test(contentType)) {
        throw new Error('Native Solana RPC response is not JSON or attempted redirect');
      }
      const text = responseJson(response.data, ids, batch);
      if (signals.some(value => value.aborted)) throw new DOMException('Solana RPC request cancelled', 'AbortError');
      if (Date.now() >= deadline) throw new Error('Native Solana RPC request timed out');
      return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      for (const value of signals) value.removeEventListener('abort', abort);
    }
  };
  return { commitment: 'confirmed', fetch, disableRetryOnRateLimit: true };
}

export function createSolanaConnection(endpoint = getSolanaConfig().endpoint, signal?: AbortSignal): Connection {
  return new Connection(endpoint, getSolanaConnectionConfig(endpoint, signal));
}
