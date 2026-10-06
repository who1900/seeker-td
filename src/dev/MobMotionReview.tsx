import { useEffect, useRef, useState } from 'react';
import { ENEMIES, CELL_PX } from '../game/data';
import type { Enemy, EnemyId } from '../game/types';
import { createPaperEnemyFrame, drawPaperEnemy, getPaperEnemyVisibleBounds, usePaperAssets } from '../game/paperAssets';
import { QA_ENEMY_IDS } from '../game/visualQaFixtures';
import './mobMotionReview.css';

export const REVIEW_SIZE = 64;
export const REVIEW_CELLS = [28, 34] as const;
export function reviewDpr(value: number) { return Number.isFinite(value) ? Math.max(1, Math.min(3, value)) : 1; }
export function reviewMotion(system: boolean, manual: boolean, frozen: boolean) {
  return { reduced: system || manual, moving: !system && !manual && !frozen };
}
export function startReviewClock(clock: { phase: number }, request: (callback: FrameRequestCallback) => number,
  cancel: (id: number) => void, draw: () => boolean) {
  let previous: number | undefined, handle: number, stopped = false;
  const tick: FrameRequestCallback = now => {
    if (stopped) return;
    if (previous !== undefined) clock.phase += Math.max(0, Math.min(.1, (now - previous) / 1000));
    previous = now;
    if (!draw()) { stopped = true; return; }
    handle = request(tick);
  };
  handle = request(tick);
  return () => { stopped = true; cancel(handle); };
}

export function renderReviewPose(ctx: CanvasRenderingContext2D, id: EnemyId, cell: number, phase: number,
  palette: number, back: boolean, system: boolean, manual: boolean, frozen: boolean) {
  const spec = ENEMIES[id], motion = reviewMotion(system, manual, frozen);
  const enemy = { id, uid: `review-${id}`, pos: { x: REVIEW_SIZE / 2, y: REVIEW_SIZE / 2 },
    speed: spec.speed * CELL_PX, paletteVariant: palette,
    visualScale: Math.max(.6, Math.min(1.35, spec.visualScale ?? 1)), hp: spec.hp, maxHp: spec.hp } as Enemy;
  const heading = id === 'soldier' && back ? -Math.PI / 2 : Math.PI / 2;
  const frame = createPaperEnemyFrame();
  ctx.clearRect(0, 0, REVIEW_SIZE, REVIEW_SIZE);
  const drawn = drawPaperEnemy(ctx, enemy, phase, heading, motion.moving, cell, frame, motion.reduced);
  const visible = getPaperEnemyVisibleBounds(enemy, phase, heading, motion.moving, cell, frame, motion.reduced);
  return drawn && visible !== null;
}

export default function MobMotionReview({ expanded }: { expanded: boolean }) {
  const status = usePaperAssets();
  const [palette, setPalette] = useState(0), [back, setBack] = useState(false);
  const [playing, setPlaying] = useState(false), [manual, setManual] = useState(false), [frozen, setFrozen] = useState(false);
  const [system, setSystem] = useState(true), [visible, setVisible] = useState(false);
  const [revision, setRevision] = useState(0), [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null), output = useRef<HTMLOutputElement>(null);
  const canvases = useRef(new Map<string, HTMLCanvasElement>());
  const clock = useRef({ phase: 0 });
  useEffect(() => {
    const preference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const update = () => setSystem(preference?.matches ?? true);
    update(); preference?.addEventListener('change', update);
    return () => preference?.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    let intersects = false;
    const update = () => setVisible(intersects && document.visibilityState === 'visible');
    const observer = new IntersectionObserver(entries => { intersects = entries.some(entry => entry.isIntersecting); update(); });
    if (root.current) observer.observe(root.current);
    document.addEventListener('visibilitychange', update);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update); };
  }, []);
  useEffect(() => {
    if (!expanded || !visible || status !== 'ready') return;
    const draw = () => {
      try {
        for (const id of QA_ENEMY_IDS) for (const cell of REVIEW_CELLS) {
          const canvas = canvases.current.get(`${id}-${cell}`), ctx = canvas?.getContext('2d');
          if (!canvas || !ctx) throw new Error('Canvas unavailable. Reopen the review.');
          const dpr = reviewDpr(window.devicePixelRatio);
          const pixels = Math.round(REVIEW_SIZE * dpr);
          if (canvas.width !== pixels || canvas.height !== pixels) {
            canvas.width = pixels; canvas.height = pixels;
          }
          ctx.setTransform(canvas.width / REVIEW_SIZE, 0, 0, canvas.height / REVIEW_SIZE, 0, 0);
          if (!renderReviewPose(ctx, id, cell, clock.current.phase, palette, back, system, manual, frozen)) {
            throw new Error(`Missing paper pose: ${id}. Retry after assets are ready.`);
          }
        }
        if (output.current) output.current.textContent = `Phase ${clock.current.phase.toFixed(3)}s · ${system || manual ? 'reduced motion' : frozen ? 'stationary' : 'moving'}`;
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not render paper poses.'); setPlaying(false); return false;
      }
    };
    if (!draw()) return;
    if (playing && !system && !manual && !frozen) return startReviewClock(clock.current, requestAnimationFrame, cancelAnimationFrame, draw);
  }, [expanded, visible, status, palette, back, playing, system, manual, frozen, revision]);
  const ready = status === 'ready' && QA_ENEMY_IDS.length > 0;
  return <div ref={root} className="mob-motion-review">
    <p>Actual paper layers at cell28/34, 1 CSS px per world unit. No engine, wallet or saved state.</p>
    <div className="mob-review-controls">
      <label htmlFor="mob-review-palette">Palette<select id="mob-review-palette" value={palette} onChange={e => setPalette(Number(e.target.value))}>
        {[0, 1, 2, 3].map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>
      <label htmlFor="mob-review-heading">Soldier view<select id="mob-review-heading" value={back ? 'back' : 'front'} onChange={e => setBack(e.target.value === 'back')}>
        <option value="front">Front (+π/2)</option><option value="back">Back (−π/2)</option>
      </select></label>
      <label className="mob-review-check"><input type="checkbox" checked={manual} onChange={e => setManual(e.target.checked)} />Reduced motion</label>
      <label className="mob-review-check"><input type="checkbox" checked={frozen} onChange={e => setFrozen(e.target.checked)} />Stationary / stunned pose</label>
      <button type="button" disabled={!ready || system || manual || frozen || !!error} onClick={() => setPlaying(value => !value)}>{playing ? 'Pause' : 'Play'}</button>
      <button type="button" disabled={!ready || playing || !!error} onClick={() => { clock.current.phase += 1 / 12; setRevision(value => value + 1); }}>Step 1/12s</button>
      <button type="button" onClick={() => { setPlaying(false); clock.current.phase = 0; setError(''); setRevision(value => value + 1); }}>Reset phase</button>
    </div>
    {system && <p>System reduced-motion preference is active; motion cannot be forced on.</p>}
    <output ref={output} className="mono">Phase 0.000s</output>
    {status === 'loading' && <p role="status" aria-busy="true">Loading paper layers…</p>}
    {status !== 'loading' && status !== 'ready' && <p role="alert">Paper assets unavailable. Use Retry assets in scene settings.</p>}
    {!QA_ENEMY_IDS.length && <p role="status">No mob models available. Reload the dev review.</p>}
    {error && <p role="alert">{error} Use Reset phase to retry.</p>}
    <div className="mob-review-grid">{QA_ENEMY_IDS.map(id => <div key={id} className="mob-review-model">
      <h3>{ENEMIES[id].name}</h3><div className="mob-review-pair">{REVIEW_CELLS.map(cell => <figure key={cell}>
        <canvas width={REVIEW_SIZE} height={REVIEW_SIZE} aria-label={`${ENEMIES[id].name}, cell ${cell}`} ref={node => {
          if (node) canvases.current.set(`${id}-${cell}`, node); else canvases.current.delete(`${id}-${cell}`);
        }} /><figcaption className="mono">cell {cell}</figcaption>
      </figure>)}</div>
    </div>)}</div>
  </div>;
}
