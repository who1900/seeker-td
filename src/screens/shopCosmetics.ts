import { SKINS } from '../state/store';
import type { GameState } from '../state/store';

export function buyCosmetic(state: GameState, skinId: string): GameState {
  const skin = SKINS.find(candidate => candidate.id === skinId);
  if (!skin || !Number.isFinite(skin.price) || skin.price <= 0
    || !Array.isArray(state.unlockedSkins) || state.unlockedSkins.includes(skin.id)
    || !Number.isFinite(state.tokens) || state.tokens < skin.price) return state;
  return { ...state, tokens: state.tokens - skin.price, unlockedSkins: [...state.unlockedSkins, skin.id] };
}

export function equipCosmetic(state: GameState, skinId: string): GameState {
  const skin = SKINS.find(candidate => candidate.id === skinId);
  if (!skin || (skin.price !== 0 && (!Array.isArray(state.unlockedSkins) || !state.unlockedSkins.includes(skin.id)))
    || state.equippedSkins[skin.family] === skin.id) return state;
  return { ...state, equippedSkins: { ...state.equippedSkins, [skin.family]: skin.id } };
}
