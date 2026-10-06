// Firebase initialization with graceful fallback.
// App works fully without a configured firebaseConfig (all functions are no-ops).

import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { getAuth, signInAnonymously, type Auth, type User } from 'firebase/auth';
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
let _pendingUser: Promise<User | null> | null = null;

if (isFirebaseEnabled) {
  try {
    _app = initializeApp(cfg);
    _db = getFirestore(_app);
    _auth = getAuth(_app);
  } catch {
    console.warn('[firebase] init failed');
  }
}

export function getDb(): Firestore | null {
  return _db;
}

export async function getFirebaseIdToken(): Promise<string | null> {
  return (await getFirebaseAuthSnapshot())?.token ?? null;
}

async function ensureUser(): Promise<User | null> {
  const auth = _auth;
  if (!isFirebaseEnabled || !auth) return null;
  if (!_pendingUser) {
    const pending = (async () => {
      try {
        await auth.authStateReady();
        if (auth.currentUser) return auth.currentUser;
        const credential = await signInAnonymously(auth);
        return auth.currentUser === credential.user ? credential.user : null;
      } catch {
        console.warn('[firebase] authentication unavailable');
        return null;
      }
    })();
    _pendingUser = pending;
    void pending.finally(() => { if (_pendingUser === pending) _pendingUser = null; });
  }
  const user = await _pendingUser;
  return auth.currentUser === user ? user : null;
}

export function currentFirebaseUid(): string | null {
  return _auth?.currentUser?.uid ?? null;
}

export function subscribeFirebaseIdentity(listener: () => void): () => void {
  if (!_auth) return () => {};
  let previous = currentFirebaseUid();
  return _auth.onAuthStateChanged(user => {
    const uid = user?.uid ?? null;
    if (uid !== previous) { previous = uid; listener(); }
  });
}

export async function getFirebaseAuthSnapshot(): Promise<{ uid: string; token: string } | null> {
  try {
    const user = await ensureUser();
    if (!user) return null;
    const token = await user.getIdToken();
    if (_auth?.currentUser !== user || !token) return null;
    return { uid: user.uid, token };
  } catch {
    return null;
  }
}

/**
 * Signs in anonymously (once) and returns the Firebase uid.
 * Returns null if Firebase is disabled or auth fails.
 */
export async function ensureAuth(): Promise<string | null> {
  return (await ensureUser())?.uid ?? null;
}
