import type { GameState } from './store';

export function generateReferralCode(seed?: string): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let value: number;
  if (seed) {
    value = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) value = Math.imul(value ^ seed.charCodeAt(i), 0x01000193) >>> 0;
    value ^= value >>> 16;
    value = Math.imul(value, 0x7feb352d);
    value ^= value >>> 15;
    value = Math.imul(value, 0x846ca68b);
    value = (value ^ value >>> 16) >>> 0;
  } else {
    if (!globalThis.crypto?.getRandomValues) throw new Error('SECURE_PROFILE_RANDOM_UNAVAILABLE');
    value = globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
  }
  let code = '';
  for (let i = 0; i < 6; i++) { code += alphabet[value & 31]; value >>>= 5; }
  return code;
}

export function normalizeReferralCode(value: string): string {
  return value.trim().toUpperCase();
}

export function referralError(state: GameState, value: string): string | null {
  const code = normalizeReferralCode(value);
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code)) return 'Use 6 letters or digits, excluding I, O, 0 and 1.';
  if (code === normalizeReferralCode(state.referralCode || '')) return 'That is your own code.';
  if (state.referredBy) return 'A code is already saved locally.';
  return null;
}

export function applyLocalReferral(state: GameState, value: string): GameState {
  if (referralError(state, value)) return state;
  return { ...state, referredBy: normalizeReferralCode(value) };
}
