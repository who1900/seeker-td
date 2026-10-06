import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCommerceNodeServer, readCommerceNodeConfig, rejectCommerceNodeEmulators } from './commerce-node-http.mjs';
import { requireCommerceNodeVersion, validateCommerceNodeAdc } from './commerce-node-startup.mjs';

export async function startCommerceNode() {
  requireCommerceNodeVersion();
  const config = readCommerceNodeConfig();
  await validateCommerceNodeAdc();
  process.env.METADATA_SERVER_DETECTION = 'none';
  const [{ createCommerceFirebaseRuntime }, { createCommerceHttpHandler }] = await Promise.all([
    import('./commerce-functions.mjs'), import('./commerce-http.mjs'),
  ]);
  const runtime = await createCommerceFirebaseRuntime();
  rejectCommerceNodeEmulators();
  const handler = createCommerceHttpHandler({ commerce: runtime.commerce, identity: runtime.identity,
    origin: config.origin, operationMilliseconds: config.operationMilliseconds });
  const listener = createCommerceNodeServer({ handler, config });
  await listener.listen();
  return listener;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let listener, stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (!listener) return;
    const result = await listener.stop();
    process.exit(result.drained ? 0 : 1);
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    listener = await startCommerceNode();
    if (stopping) { const result = await listener.stop(); process.exit(result.drained ? 0 : 1); }
    console.info('COMMERCE_NODE_LISTENING_LOOPBACK');
  } catch {
    console.error('COMMERCE_NODE_START_FAILED'); process.exitCode = 1;
  }
}
