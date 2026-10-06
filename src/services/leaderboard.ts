// Firestore leaderboard service.
// All functions are safe no-ops when Firebase is disabled.
// TODO Blaze: server-side anti-cheat (validate score via signed run summary)

import {
  collection,
  doc,
  getDoc,
  setDoc,
  query,
  orderBy,
  limit,
  getDocs,
  serverTimestamp,
} from 'firebase/firestore';
import { isFirebaseEnabled, ensureAuth, getDb } from '../firebase';
import { withNetworkDeadline } from './networkDeadline';

export interface LbEntry {
  uid: string;
  walletAddr: string;
  skrName: string | null;
  bestWave: number;
  updatedAt: number;
}

/**
 * Upserts the player's score in Firestore (only if bestWave improved).
 * Safe no-op if Firebase is disabled or request fails.
 */
export async function submitScore(p: {
  walletAddr: string;
  skrName: string | null;
  bestWave: number;
  totalRuns: number;
}): Promise<void> {
  if (!isFirebaseEnabled) return;

  const db = getDb();
  if (!db) return;

  const uid = await ensureAuth();
  if (!uid) return;

  try {
    const ref = doc(db, 'players', uid);
    const snap = await getDoc(ref);
    const existingBest: number = snap.exists() ? (snap.data().bestWave ?? 0) : 0;

    if (p.bestWave <= existingBest) return; // no improvement, skip write

    await setDoc(
      ref,
      {
        uid,
        walletAddr: p.walletAddr,
        skrName: p.skrName ?? null,
        bestWave: p.bestWave,
        totalRuns: p.totalRuns,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  } catch (e) {
    console.warn('[leaderboard] submitScore error', e);
  }
}

/**
 * Fetches top N players ordered by bestWave descending.
 * Returns [] as an unavailable-data fallback if disabled, failed, or timed out.
 */
export async function fetchTopScores(limitN = 20): Promise<LbEntry[]> {
  if (!isFirebaseEnabled) return [];

  const db = getDb();
  if (!db) return [];

  try {
    const q = query(
      collection(db, 'players'),
      orderBy('bestWave', 'desc'),
      limit(limitN),
    );
    const snap = await withNetworkDeadline(getDocs(q), 5000);
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        uid: data.uid ?? d.id,
        walletAddr: data.walletAddr ?? '',
        skrName: data.skrName ?? null,
        bestWave: data.bestWave ?? 0,
        updatedAt:
          data.updatedAt != null && typeof data.updatedAt.toMillis === 'function'
            ? data.updatedAt.toMillis()
            : Date.now(),
      } satisfies LbEntry;
    });
  } catch (e) {
    console.warn('[leaderboard] fetchTopScores error', e);
    return [];
  }
}
