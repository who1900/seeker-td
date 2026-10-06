import type { BattleState, TowerId, TargetingMode } from './types';
import type { ReplayTimingCommand, ReplayTimingSnapshot } from './replayTiming';
import { BASE_TOWER_ORDER, TOWERS, UPGRADE_GRAPH } from './data';
import { placeTower, enhanceTower, promoteTower, sellTower, getEnhanceCost, setTargeting, setTargetLock } from './engine';

export type ReplayAction = { type: 'place'; towerId: TowerId; cell: { x: number; y: number } }
  | { type: 'enhance' | 'promote' | 'sell' | 'cycleTarget' | 'toggleLock'; uid: string };

const modes: TargetingMode[] = ['first', 'last', 'strongest', 'weakest', 'closest'];
const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
function deny(): never { throw new Error('REPLAY_COMMAND_INVALID'); }
function exact(value: unknown, keys: string[]): boolean {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) return false;
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && own(descriptor, 'value');
  });
}

// Dependencies and continuation are server-owned; events cannot replace either state.
// Any rejected event invalidates its whole history chunk; callers must not skip it.
export function createReplayCommands(dependencies: {
  getState: () => BattleState;
  timing: { snapshot: () => ReplayTimingSnapshot; command: (input: ReplayTimingCommand) => void };
}) {
  if (!exact(dependencies, ['getState', 'timing']) || typeof dependencies.getState !== 'function'
    || typeof dependencies.timing?.snapshot !== 'function' || typeof dependencies.timing?.command !== 'function') deny();
  let failed = false;
  function state() {
    if (failed) deny();
    let gs: BattleState;
    try { gs = dependencies.getState(); }
    catch (error) { failed = true; throw error; }
    const random = gs && Object.getOwnPropertyDescriptor(gs, 'combatRandom');
    const record = random && own(random, 'value') ? random.value : undefined;
    if (!gs || !exact(record, ['algorithm', 'version', 'state', 'cursor']) || record.algorithm !== 'mulberry32' || record.version !== 1
      || !Number.isInteger(record.state) || record.state < 0 || record.state > 0xffffffff
      || !Number.isInteger(record.cursor) || record.cursor < 0 || record.cursor >= 0xffffffff
      || !Number.isFinite(gs.gold) || gs.gold < 0 || !Array.isArray(gs.towers)) deny();
    return gs;
  }
  state();
  return Object.freeze({
    timingCommand(input: ReplayTimingCommand) {
      state();
      try { dependencies.timing.command(input); }
      catch (error) { failed = true; throw error; }
    },
    action(input: ReplayAction) {
      const descriptor = input && Object.getOwnPropertyDescriptor(input, 'type');
      const type = descriptor && own(descriptor, 'value') ? descriptor.value : undefined;
      if (!exact(input, type === 'place' ? ['type', 'towerId', 'cell'] : ['type', 'uid'])
        || !['place', 'enhance', 'promote', 'sell', 'cycleTarget', 'toggleLock'].includes(type)) deny();
      const gs = state();
      let timing: ReplayTimingSnapshot;
      try { timing = dependencies.timing.snapshot(); }
      catch (error) { failed = true; throw error; }
      if (gs.paused || gs.gameOver || gs.victory || timing.hidden) deny();
      if (input.type === 'place') {
        if (!BASE_TOWER_ORDER.includes(input.towerId) || !exact(input.cell, ['x', 'y'])
          || !Number.isSafeInteger(input.cell.x) || !Number.isSafeInteger(input.cell.y)
          || input.cell.x < 0 || input.cell.y < 0 || input.cell.x >= gs.gridW || input.cell.y >= gs.gridH) deny();
        let accepted: boolean;
        try { accepted = placeTower(gs, input.towerId, input.cell); }
        catch (error) { failed = true; throw error; }
        if (!accepted) deny();
        return { gold: gs.gold, uid: gs.towers[gs.towers.length - 1].uid };
      }
      if (typeof input.uid !== 'string' || !input.uid.length || input.uid.length > 128 || /[\u0000-\u001f\u007f]/.test(input.uid)) deny();
      const tower = gs.towers.find(item => item.uid === input.uid);
      if (!tower || !own(TOWERS, tower.towerId)) deny();
      const spec = TOWERS[tower.towerId];
      if (input.type === 'enhance') {
        const cost = getEnhanceCost(tower);
        if (tower.level >= spec.maxLevel - 1 || !Number.isFinite(cost) || cost < 0 || gs.gold < cost) deny();
      } else if (input.type === 'promote') {
        if (!UPGRADE_GRAPH[tower.towerId] || spec.upgradeCostToNext == null || gs.gold < spec.upgradeCostToNext) deny();
      } else if (input.type === 'cycleTarget' || input.type === 'toggleLock') {
        if (tower.towerId === 'glueTower' || tower.towerId === 'mineLayer' || !modes.includes(tower.targetingMode)) deny();
      }
      try {
        if (input.type === 'enhance') { if (!enhanceTower(gs, input.uid)) deny(); }
        else if (input.type === 'promote') { if (!promoteTower(gs, input.uid)) deny(); }
        else if (input.type === 'sell') sellTower(gs, input.uid);
        else if (input.type === 'cycleTarget') setTargeting(gs, input.uid, modes[(modes.indexOf(tower.targetingMode) + 1) % modes.length]);
        else setTargetLock(gs, input.uid, tower.targetLock === false);
      } catch (error) { failed = true; throw error; }
      return { gold: gs.gold, uid: input.uid };
    },
  });
}
