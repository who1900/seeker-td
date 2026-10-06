import type { BattleState, CombatRandomState } from './types';

const uint32 = (value: unknown): value is number => typeof value === 'number'
  && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
function deny(): never { throw new Error('COMBAT_RANDOM_INVALID'); }
const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);

export function createGameplayRandom(seed: number): CombatRandomState {
  if (!uint32(seed)) deny();
  return { algorithm: 'mulberry32', version: 1, state: seed, cursor: 0 };
}

// Mulberry32 v1: uint32 wrap/imul, output divided by 2^32; deterministic, not cryptographic.
export function gameplayRandom(game: Pick<BattleState, 'combatRandom'>): number {
  if (!('combatRandom' in game)) return Math.random();
  if (!own(game, 'combatRandom')) deny();
  const holder = Object.getOwnPropertyDescriptor(game, 'combatRandom')!;
  if (!own(holder, 'value')) deny();
  const record = holder.value as CombatRandomState | undefined;
  const keys = ['algorithm', 'version', 'state', 'cursor'];
  if (!record || Object.getPrototypeOf(record) !== Object.prototype || Reflect.ownKeys(record).length !== keys.length
    || keys.some(key => !own(record, key) || !own(Object.getOwnPropertyDescriptor(record, key)!, 'value'))
    || record.algorithm !== 'mulberry32' || record.version !== 1 || !uint32(record.state)
    || !uint32(record.cursor) || record.cursor === 0xffffffff
    || !Object.getOwnPropertyDescriptor(record, 'state')!.writable || !Object.getOwnPropertyDescriptor(record, 'cursor')!.writable) deny();
  const next = (record.state + 0x6d2b79f5) >>> 0;
  let mixed = Math.imul(next ^ next >>> 15, next | 1);
  mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61);
  const uniform = ((mixed ^ mixed >>> 14) >>> 0) / 0x100000000;
  record.state = next;
  record.cursor++;
  return uniform;
}
