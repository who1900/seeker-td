import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import { assertIdentityEmulators } from './emulatorIdentitySafety.mjs';

let installed = false;
let identityHttp = false;
const httpOptIn = options => {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype
    || Reflect.ownKeys(options).some(key => key !== 'allowIdentityHttp')
    || (Object.hasOwn(options, 'allowIdentityHttp')
      && (!Object.hasOwn(Object.getOwnPropertyDescriptor(options, 'allowIdentityHttp'), 'value')
        || typeof options.allowIdentityHttp !== 'boolean'))) {
    throw new Error('IDENTITY_TEST_NETWORK_CONFIG');
  }
  return options.allowIdentityHttp === true;
};
const diagnostics = { blocked: 0, metadataWarnings: 0 };
const deny = () => {
  diagnostics.blocked++;
  process.exitCode = 1;
  throw new Error('IDENTITY_TEST_EXTERNAL_NETWORK_DENIED');
};
export function demoNetworkDiagnostics() { return { ...diagnostics }; }
export function demoNetworkTarget(host, port, options = {}) {
  const allowIdentityHttp = httpOptIn(options);
  return host === '127.0.0.1' && (Number(port) === 8089 || Number(port) === 9099
    || (allowIdentityHttp && (port === 18089 || port === '18089')));
}
export function installDemoNetworkGuard(options = {}) {
  const allowIdentityHttp = httpOptIn(options);
  assertIdentityEmulators();
  if (process.env.METADATA_SERVER_DETECTION !== undefined && process.env.METADATA_SERVER_DETECTION !== 'none') {
    throw new Error('IDENTITY_DEMO_ONLY:METADATA_SERVER_DETECTION');
  }
  process.env.METADATA_SERVER_DETECTION = 'none';
  if (installed) {
    if (allowIdentityHttp && !identityHttp) throw new Error('IDENTITY_TEST_NETWORK_ALREADY_INSTALLED');
    return;
  }
  identityHttp = allowIdentityHttp;
  installed = true;
  const permits = (host, port) => demoNetworkTarget(host, port, { allowIdentityHttp: identityHttp });
  process.on('exit', () => {
    if (diagnostics.blocked || diagnostics.metadataWarnings) process.exitCode = 1;
    console.log(`identity test network diagnostics ${JSON.stringify(diagnostics)}`);
  });
  process.on('warning', warning => {
    if (warning.name === 'MetadataLookupWarning') { diagnostics.metadataWarnings++; process.exitCode = 1; }
  });
  for (const module of [http, https]) for (const method of ['request', 'get']) {
    const original = module[method];
    module[method] = function (...args) {
      const first = args[0];
      let host, port, protocol;
      if (typeof first === 'string' || first instanceof URL) {
        const url = new URL(first);
        host = url.hostname; port = url.port; protocol = url.protocol;
        if (args[1] && typeof args[1] === 'object') {
          host = args[1].hostname ?? args[1].host ?? host;
          port = args[1].port ?? port;
          protocol = args[1].protocol ?? protocol;
          if (args[1].socketPath || args[1].createConnection) deny();
        }
      } else {
        host = first?.hostname ?? first?.host; port = first?.port;
        protocol = first?.protocol ?? (module === https ? 'https:' : 'http:');
        if (first?.socketPath || first?.createConnection) deny();
      }
      if (protocol !== 'http:' || !permits(host, port) || module === https) deny();
      return original.apply(this, args);
    };
  }
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const normalized = Array.isArray(args[0]) ? args[0] : args;
    const first = normalized[0];
    const host = typeof first === 'object' ? first.host : normalized[1];
    const port = typeof first === 'object' ? first.port : first;
    if (first?.path || !permits(host, port)) deny();
    return connect.apply(this, args);
  };
  for (const module of [dns, dns.promises]) for (const method of ['lookup', 'lookupService', 'resolve',
    'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs',
    'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse']) {
    const original = module[method];
    if (typeof original !== 'function') continue;
    module[method] = function (...args) {
      if (args[0] !== '127.0.0.1') deny();
      return original.apply(this, args);
    };
  }
  const fetch = globalThis.fetch;
  globalThis.fetch = async function (input, options) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.protocol !== 'http:' || !permits(url.hostname, url.port)) deny();
    return fetch(input, options);
  };
  syncBuiltinESMExports();
}
