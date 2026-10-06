import { strict as assert } from 'node:assert';
import { createGame, placeTower, sellTower, tick, cellToWorld } from './engine';
import { CELL_PX, TOWERS } from './data';
import type { Effect, Projectile, TowerId } from './types';

const random = Math.random;
Math.random = () => 0.5;
try {
  for (const towerId of Object.keys(TOWERS) as TowerId[]) {
    const state = createGame(14, 12);
    state.gold = 1e9;
    assert.ok(placeTower(state, towerId, { x: 5, y: 2 }));
    assert.ok(placeTower(state, towerId, { x: 7, y: 2 }));
    const towers = state.towers.map(tower => ({ ...tower }));
    const positions = [0, 0.25, 0.5].map(offset => ({
      x: cellToWorld({ x: 6, y: 2 }).x,
      y: cellToWorld({ x: 6, y: 2 }).y + offset * CELL_PX,
    }));
    for (const [index, pos] of positions.entries()) {
      state.enemies.push({
        uid: `enemy-${index}`, id: 'soldier', hp: 1e9, maxHp: 1e9, speed: 0,
        pos: { ...pos }, path: [{ ...pos }, cellToWorld(state.exit)], pathIdx: 1, pathProgress: 0,
      });
    }
    tick(state, .1);
    if (towerId === 'mineLayer' || towerId === 'rocketLauncher') {
      for (let i = 0; i < 64; i++) tick(state, 1 / 64);
    }
    if (towerId === 'glueTower') for (let i = 0; i < 52; i++) tick(state, 1 / 64);
    const emitted = [...state.projectiles, ...state.effects];
    assert.ok(emitted.length > 0, `${towerId}: no visual emissions`);
    for (const item of emitted) {
      assert.ok(towers.some(tower => tower.uid === item.sourceTowerUid), `${towerId}: missing/wrong source instance`);
      if (item.towerId !== undefined) assert.equal(item.towerId, towerId);
    }
    for (const tower of towers) {
      assert.ok(emitted.some(item => item.sourceTowerUid === tower.uid), `${towerId}: conflated identical towers`);
      const projectile = state.projectiles.find(item => item.sourceTowerUid === tower.uid);
      if (projectile) {
        const origin = { x: tower.worldX, y: tower.worldY };
        const distance = Math.hypot(projectile.from.x - origin.x, projectile.from.y - origin.y);
        assert.ok(distance <= .8 * CELL_PX + 1e-8, `${towerId}: muzzle detached from source tower`);
        if (projectile.authoritativeUid) {
          const authority = [...state.shots, ...state.mines, ...state.glueShots].find(item => item.uid === projectile.authoritativeUid);
          assert.ok(authority, 'projected emission has no authority');
          assert.deepEqual(projectile.from, authority.from);
          const angle = towerId === 'glueTower' || towerId === 'glueGun'
            ? Math.atan2(projectile.to.y - origin.y, projectile.to.x - origin.x)
            : state.towers.find(item => item.uid === tower.uid)!.aimAngle!;
          const forward = towerId === 'rocketLauncher' || towerId === 'mineLayer' ? 0
            : towerId === 'mortar' ? .6 : towerId === 'glueTower' ? .8 : .7;
          const side = towerId === 'dualCanon' ? projectile.sourceSocket === 0 ? .3 : -.3 : 0;
          const expected = {
            x: origin.x + (Math.cos(angle) * forward - Math.sin(angle) * side) * CELL_PX,
            y: origin.y + (Math.sin(angle) * forward + Math.cos(angle) * side) * CELL_PX,
          };
          assert.ok(Math.hypot(projectile.from.x - expected.x, projectile.from.y - expected.y) < 1e-8,
            `${towerId}: original muzzle offset/alternating barrel mismatch`);
        }
      }
      const chain = state.effects.find(item => item.sourceTowerUid === tower.uid
        && ['chain', 'chain_bounce', 'chain_straight'].includes(item.kind));
      if (chain) {
        const actual = state.towers.find(item => item.uid === tower.uid)!;
        const offset = chain.kind === 'chain_straight' ? .8 : .7;
        const expectedOrigin = { x: tower.worldX + Math.cos(actual.aimAngle!) * offset * CELL_PX,
          y: tower.worldY + Math.sin(actual.aimAngle!) * offset * CELL_PX };
        assert.ok(Math.hypot(chain.pts![0].x - expectedOrigin.x, chain.pts![0].y - expectedOrigin.y) < 1e-8,
          'laser origin differs from physical muzzle');
        if (chain.kind === 'chain_bounce') {
          assert.equal(chain.pts!.length, 4, 'intermediate chain nodes lost');
          assert.deepEqual(chain.pts!.slice(1), [positions[0], positions[1], positions[2]], 'nearest bounce sequence changed');
          const flashes = state.effects.filter(item => item.kind === 'laser_flash' && item.sourceTowerUid === tower.uid);
          assert.equal(flashes.length, 3, 'bounce flashes missing provenance');
          assert.deepEqual(flashes.map(item => ({ x: item.x, y: item.y })), chain.pts!.slice(1));
        }
      }
    }
    const savedSourceUids = emitted.map(item => item.sourceTowerUid);
    sellTower(state, towers[0].uid);
    assert.deepEqual(emitted.map(item => item.sourceTowerUid), savedSourceUids, 'sale rewrote existing source provenance');
  }

  const healing = createGame();
  const pos = cellToWorld(healing.entry);
  healing.enemies.push({ uid: 'healer', id: 'healer', hp: 100, maxHp: 100, speed: 0,
    pos, path: [pos, cellToWorld(healing.exit)], pathIdx: 1, healCooldown: 0 });
  tick(healing, 0);
  assert.ok(healing.effects.some(effect => effect.kind === 'heal'));
  assert.ok(healing.effects.every(effect => effect.sourceTowerUid === undefined), 'enemy-owned effect got a tower source');

  // Existing callers may still construct visuals without the optional field.
  const legacyEffect: Effect = { uid: 'legacy-effect', kind: 'ring', x: 0, y: 0, life: 1, maxLife: 1 };
  const legacyProjectile: Projectile = { uid: 'legacy-projectile', kind: 'bullet', from: pos, to: pos,
    progress: 0, speed: 1, damage: 0, damageType: 'Bullet', life: 1 };
  healing.effects.push(legacyEffect);
  healing.projectiles.push(legacyProjectile);
  tick(healing, 0);
  assert.equal(legacyEffect.sourceTowerUid, undefined);
  assert.equal(legacyProjectile.sourceTowerUid, undefined);
  console.log('visual provenance regression checks passed');
} finally {
  Math.random = random;
}
