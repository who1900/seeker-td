// Firebase initialization with graceful fallback.
// App works fully without a configured firebaseConfig (all functions are no-ops).

import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { getAuth, signInAnonymously, type Auth } from 'firebase/auth';
import { FIREBASE_CONFIG } from './firebase.config';

const cfg = FIREBASE_CONFIG;

const apiKey = cfg.apiKey;
const projectId = cfg.projectId;

/** True only when both required keys are non-empty strings. */
export const isFirebaseEnabled: boolean =
  typeof apiKey === 'string' && apiKey.trim() !== '' &&
  typeof projectId === 'string' && projectId.trim() !== '';

let _app: FirebaseApp | null = null;
let _db: Firestore | null = null;
let _auth: Auth | null = null;
let _cachedUid: string | null = null;

if (isFirebaseEnabled) {
  try {
    _app = initializeApp(cfg);
    _db = getFirestore(_app);
    _auth = getAuth(_app);
  } catch (e) {
    console.warn('[firebase] init error', e);
  }
}

export function getDb(): Firestore | null {
  return _db;
}

/**
 * Signs in anonymously (once) and returns the Firebase uid.
 * Returns null if Firebase is disabled or auth fails.
 */
export async function ensureAuth(): Promise<string | null> {
  if (!isFirebaseEnabled || !_auth) return null;
  if (_cachedUid) return _cachedUid;
  try {
    const cred = await signInAnonymously(_auth);
    _cachedUid = cred.user.uid;
    return _cachedUid;
  } catch (e) {
    console.warn('[firebase] signInAnonymously error', e);
    return null;
  }
}
