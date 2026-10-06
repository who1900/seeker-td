import { createPrivateKey } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

const fail = code => { throw new Error(code); };

export function requireCommerceNodeVersion(version = process.versions.node) {
  if (typeof version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)
    || Number(version.split('.')[0]) < 22) fail('COMMERCE_NODE_VERSION');
}

export function validateCommerceServiceAccount(record, projectId) {
  try {
    if (!record || Object.getPrototypeOf(record) !== Object.prototype || record.type !== 'service_account'
      || typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)
      || record.project_id !== projectId || typeof record.client_email !== 'string'
      || !/^[a-z0-9.-]+$/.test(record.client_email.split('@')[0])
      || record.client_email !== `${record.client_email.split('@')[0]}@${projectId}.iam.gserviceaccount.com`
      || typeof record.private_key !== 'string' || record.private_key.length > 16384
      || !record.private_key.startsWith('-----BEGIN PRIVATE KEY-----\n')) fail('COMMERCE_NODE_ADC');
    const key = createPrivateKey(record.private_key);
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) fail('COMMERCE_NODE_ADC');
  } catch { fail('COMMERCE_NODE_ADC'); }
}

export async function validateCommerceNodeAdc(env = process.env) {
  let file;
  try {
    const path = env.GOOGLE_APPLICATION_CREDENTIALS;
    if (typeof path !== 'string' || !isAbsolute(path) || !path.endsWith('.env')
      || /[\u0000-\u001f\u007f]/.test(path)) fail('COMMERCE_NODE_ADC');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 65536) fail('COMMERCE_NODE_ADC');
    // Off-GCP deployment is POSIX. Windows mode bits cannot prove a private Windows ACL.
    if (process.platform === 'win32') fail('COMMERCE_NODE_ADC');
    const uid = process.getuid();
    const trustedOwner = stat => stat.uid === 0 || stat.uid === uid;
    const parent = await lstat(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink() || !trustedOwner(parent) || (parent.mode & 0o022)) fail('COMMERCE_NODE_ADC');
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || !trustedOwner(stat) || (stat.mode & 0o137) || stat.size < 1 || stat.size > 65536) fail('COMMERCE_NODE_ADC');
    const bytes = Buffer.alloc(65537); let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > 65536) fail('COMMERCE_NODE_ADC');
    const record = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size)));
    validateCommerceServiceAccount(record, env.COMMERCE_FIREBASE_PROJECT_ID);
  } catch { fail('COMMERCE_NODE_ADC'); }
  finally {
    if (file) { try { await file.close(); } catch { fail('COMMERCE_NODE_ADC'); } }
  }
}
