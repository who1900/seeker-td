import assert from 'node:assert/strict';
import { buyCosmetic, equipCosmetic } from './shopCosmetics';
import { DEFAULT_STATE, SKINS } from '../state/store';
import type { GameState } from '../state/store';

const fresh = (tokens = 1000): GameState => ({ ...DEFAULT_STATE, tokens,
  unlockedSkins: [], equippedSkins: { ...DEFAULT_STATE.equippedSkins } });
let checks = 0;
for (const skin of SKINS) {
  const state = fresh(10000);
  const before = JSON.stringify(state);
  const purchased = buyCosmetic(state, skin.id);
  if (skin.price === 0) {
    assert.strictEqual(purchased, state); checks++;
  } else {
    assert.equal(purchased.tokens, state.tokens - skin.price);
    assert.deepEqual(purchased.unlockedSkins, [skin.id]);
    assert.strictEqual(buyCosmetic(purchased, skin.id), purchased);
    assert.strictEqual(equipCosmetic(state, skin.id), state);
    const equipped = equipCosmetic(purchased, skin.id);
    assert.equal(equipped.equippedSkins[skin.family], skin.id);
    assert.equal(equipped.tokens, purchased.tokens);
    assert.strictEqual(equipCosmetic(equipped, skin.id), equipped);
    checks += 7;
  }
  assert.equal(JSON.stringify(state), before); checks++;
}
for (const tokens of [NaN, Infinity, -Infinity, -1, 399]) {
  const state = fresh(tokens);
  assert.strictEqual(buyCosmetic(state, 'canon-steel'), state); checks++;
}
const exact = fresh(400);
assert.equal(buyCosmetic(exact, 'canon-steel').tokens, 0); checks++;
const state = fresh();
for (const id of ['unknown', '', '__proto__']) {
  assert.strictEqual(buyCosmetic(state, id), state);
  assert.strictEqual(equipCosmetic(state, id), state); checks += 2;
}
const once = buyCosmetic(state, 'canon-steel');
const twice = buyCosmetic(once, 'canon-steel');
assert.equal(twice.tokens, 600); assert.equal(twice.unlockedSkins.length, 1); checks += 2;
const stale = fresh(200);
assert.strictEqual(buyCosmetic(stale, 'canon-steel'), stale); checks++;
const equipped = equipCosmetic(once, 'canon-steel');
const defaultEquipped = equipCosmetic(equipped, 'canon-default');
assert.equal(defaultEquipped.equippedSkins.canon, 'canon-default');
assert.equal(defaultEquipped.tokens, equipped.tokens);
assert.strictEqual(defaultEquipped.unlockedSkins, equipped.unlockedSkins); checks += 3;
for (const key of ['dailyFreeLeft', 'dailyFreeMax', 'paidRuns', 'prizePool', 'lives', 'runLedger'] as const) {
  assert.strictEqual(once[key], state[key]); checks++;
}
console.log(`Cosmetic ledger: ${checks} assertions PASS (canonical prices, atomic buy/equip, no rewards changes)`);
