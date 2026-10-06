import type { Effect, Vec2 } from './types';

export function capturePaperLaserOriginals(effects: readonly Effect[], originals: Map<string, Vec2[]>) {
  if (effects.length > 2048) { originals.clear(); return; }
  const beams = effects.filter(effect => ['chain', 'chain_bounce', 'chain_straight'].includes(effect.kind));
  if (beams.length > 256) { originals.clear(); return; }
  const live = new Set(beams.map(beam => beam.uid));
  for (const uid of originals.keys()) if (!live.has(uid)) originals.delete(uid);
  for (const beam of beams) if (!originals.has(beam.uid) && paperLaserRecipe(beam, true)) originals.set(beam.uid, beam.pts!.map(point => ({ ...point })));
}

export function paperLaserRecipe(effect: Effect, reducedMotion = false) {
  if (!['chain', 'chain_bounce', 'chain_straight'].includes(effect.kind) || !effect.pts || effect.pts.length < 2 || effect.pts.length > 65
    || ![effect.life, effect.maxLife].every(Number.isFinite) || effect.maxLife <= 0 || effect.life <= 0 || effect.life > effect.maxLife
    || effect.pts.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  const age = effect.maxLife - effect.life, alpha = effect.life / effect.maxLife;
  const progress = Math.min(1, age / .12), pulse = age < .12 ? Math.sin(Math.PI * progress) ** 2 : 0;
  const count = effect.pts.length - 1;
  const segments: { from: Vec2; to: Vec2; node: number; arrived: boolean }[] = [];
  for (let index = 0; index < count; index++) {
    const amount = reducedMotion || effect.kind !== 'chain_bounce' ? 1 : Math.max(0, Math.min(1, progress * count - index));
    if (amount <= 0) continue;
    const from = effect.pts[index], end = effect.pts[index + 1];
    segments.push({ from, to: amount === 1 ? end : { x: from.x + (end.x - from.x) * amount, y: from.y + (end.y - from.y) * amount }, node: index + 1, arrived: amount === 1 });
  }
  return { age, alpha, segments, thickness: !reducedMotion && effect.kind === 'chain' ? 1 + .35 * pulse : 1,
    contactSize: reducedMotion ? 12 : 12 + 3 * pulse,
    sweep: !reducedMotion && effect.kind === 'chain_straight' && age < .12
      ? [Math.max(0, progress - .12), Math.min(1, progress + .12)] as [number, number] : undefined };
}

export function paperLaserFlashOwner(flash: Effect, beams: readonly Effect[]) {
  if (flash.kind !== 'laser_flash' || !flash.sourceTowerUid || !['simpleLaser', 'bouncingLaser'].includes(flash.towerId ?? '')
    || ![flash.x, flash.y, flash.life, flash.maxLife].every(Number.isFinite) || flash.maxLife <= 0 || flash.life <= 0 || flash.life > flash.maxLife || beams.length > 256) return null;
  const candidates: { uid: string; node: number }[] = [];
  const age = flash.maxLife - flash.life;
  for (const beam of beams) {
    if (beam.sourceTowerUid !== flash.sourceTowerUid || beam.towerId !== flash.towerId
      || beam.kind !== (flash.towerId === 'simpleLaser' ? 'chain' : 'chain_bounce') || !paperLaserRecipe(beam, true)
      || Math.abs(beam.maxLife - beam.life - age) > 1e-7) continue;
    for (let node = 1; node < beam.pts!.length; node++) {
      const point = beam.pts![node];
      if (Math.hypot(point.x - flash.x, point.y - flash.y) < 1e-7) candidates.push({ uid: beam.uid, node });
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}
