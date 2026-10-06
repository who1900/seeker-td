import { createGame, placeTower, sellTower, tick, cellToWorld } from './engine';
import { CELL_PX } from './data';
import type { BattleState, Enemy, Vec2 } from './types';

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function mob(state: BattleState, cell: Vec2, flyer = false): Enemy {
  const enemy: Enemy = {
    uid: `test-${state.enemies.length}`, id: flyer ? 'flyer' : 'soldier',
    hp: 10000, maxHp: 10000, speed: CELL_PX, pos: cellToWorld(cell),
    ...(flyer ? { flyProgress: cell.y / (state.gridH - 1) } : {
      path: [cellToWorld(cell), cellToWorld({ x: cell.x, y: cell.y + 1 }), cellToWorld(state.exit)],
      pathIdx: 1, pathProgress: 0,
    }),
  };
  state.enemies.push(enemy);
  return enemy;
}
function movedAtMost(enemy: Enemy, before: Vec2, distance: number) {
  check(Math.hypot(enemy.pos.x - before.x, enemy.pos.y - before.y) <= distance + 1e-8, 'unintentional jump');
}

const random = Math.random;
Math.random = () => 0.5;
try {
  const state = createGame(7, 9);
  state.gold = 100000;
  const enemy = mob(state, { x: 1, y: 3 });
  tick(state, 0.37);
  for (let i = 0; i < 3; i++) {
    const before = { ...enemy.pos };
    check(placeTower(state, 'canon', { x: 3, y: 4 }), 'valid placement rejected');
    state.towers[0].cooldown = 100;
    movedAtMost(enemy, before, 0);
    tick(state, 0.001);
    movedAtMost(enemy, before, enemy.speed * 0.001);
    const beforeSell = { ...enemy.pos };
    sellTower(state, state.towers[0].uid);
    movedAtMost(enemy, beforeSell, 0);
    tick(state, 0.001);
    movedAtMost(enemy, beforeSell, enemy.speed * 0.001);
  }
  check(enemy.path && enemy.path.length > 1, 'missing personal path');

  const occupied = createGame(7, 9);
  occupied.gold = 100000;
  mob(occupied, { x: 1, y: 3 });
  for (const cell of [{ x: 1, y: 3 }, { x: 1, y: 4 }]) {
    const before = JSON.stringify(occupied);
    check(!placeTower(occupied, 'canon', cell), 'occupied/transit placement accepted');
    check(JSON.stringify(occupied) === before, 'rejection mutated state');
  }
  const diagonal = occupied.enemies[0];
  diagonal.path![1] = cellToWorld({ x: 2, y: 4 });
  check(!placeTower(occupied, 'canon', { x: 2, y: 3 }), 'diagonal clearance blocked');

  const blocked = createGame(3, 5);
  blocked.gold = 100000;
  blocked.grid[2][0] = blocked.grid[2][2] = true;
  check(!placeTower(blocked, 'canon', { x: 1, y: 2 }), 'global no-route accepted');
  const trapped = createGame(7, 9);
  trapped.gold = 100000;
  const prisoner = mob(trapped, { x: 0, y: 3 });
  prisoner.path = [prisoner.pos, cellToWorld({ x: 0, y: 2 })];
  trapped.grid[2][0] = trapped.grid[2][1] = trapped.grid[3][1] = trapped.grid[4][1] = true;
  check(!placeTower(trapped, 'canon', { x: 0, y: 4 }), 'enemy no-route accepted');

  const flying = createGame(7, 9);
  flying.gold = 100000;
  const flyer = mob(flying, { x: 3, y: 3 }, true);
  check(placeTower(flying, 'canon', { x: 3, y: 3 }), 'flyer blocked placement');
  flying.towers[0].cooldown = 100;
  const beforeFly = { ...flyer.pos };
  tick(flying, 0.01);
  movedAtMost(flyer, beforeFly, flyer.speed * 0.01);
  check(flyer.path === undefined, 'flyer assigned ground path');

  const teleport = createGame(7, 9);
  teleport.gold = 100000;
  check(placeTower(teleport, 'teleporter', { x: 2, y: 3 }), 'teleporter placement rejected');
  const target = mob(teleport, teleport.entry);
  target.path = teleport.currentPath!.map(cellToWorld);
  target.pathIdx = 4;
  target.pathProgress = 0.5;
  target.pos = { x: cellToWorld(teleport.entry).x, y: CELL_PX * 4 };
  const targetSpeed = target.speed;
  target.speed = 0;
  tick(teleport, .125);
  check(teleport.soundQueue.includes('sfx_teleport'), 'teleporter did not fire');
  check(teleport.towers[0].lastFireTime === .125
    && Math.abs(teleport.towers[0].aimAngle! - Math.atan2(0.5, 1)) < 1e-8,
    'presentation fields do not describe the actual pre-teleport target');
  tick(teleport, 1);
  check(target.pos.y === cellToWorld(teleport.entry).y && target.wasTeleported === true,
    'teleporter failed to rewind/clamp to entry after phase');
  target.speed = targetSpeed;
  tick(teleport, 0.01);
  check(target.pos.y > cellToWorld(teleport.entry).y, 'teleported enemy stopped');

  const leak = createGame(7, 9);
  const leaker = mob(leak, { x: 3, y: 7 });
  const lives = leak.lives;
  tick(leak, 2);
  check(!leak.enemies.includes(leaker) && leak.lives === lives - 1, 'exit did not leak exactly once');
  console.log('engine regression checks passed');
} finally {
  Math.random = random;
}
