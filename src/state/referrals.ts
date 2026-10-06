import type { GameState } from './store';

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
