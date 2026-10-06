import { useEffect, useRef, useState } from 'react';
import { drawPaperTower, usePaperAssets } from '../game/paperAssets';
import type { PlacedTower } from '../game/types';
import './towerStageComparison.css';

const levels = [5, 9, 10, 14];
const cells = [28, 34];
const size = 64;

export default function TowerStageComparison({ expanded }: { expanded: boolean }) {
  const status = usePaperAssets();
  const [angle, setAngle] = useState(0), [age, setAge] = useState(-1);
  const [revision, setRevision] = useState(0), [error, setError] = useState('');
  const canvases = useRef(new Map<string, HTMLCanvasElement>());
  useEffect(() => {
    if (!expanded || status !== 'ready') return;
    try {
      for (const cell of cells) for (const level of levels) {
        const canvas = canvases.current.get(`${cell}-${level}`), ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) throw new Error('Canvas unavailable. Retry comparison.');
        const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
        canvas.width = canvas.height = Math.round(size * dpr);
        ctx.setTransform(canvas.width / size, 0, 0, canvas.height / size, 0, 0);
        ctx.clearRect(0, 0, size, size);
        const tower: PlacedTower = { uid: `stage-${level}`, towerId: 'rocketLauncher', level,
          worldX: size / 2, worldY: size / 2, cell: { x: 0, y: 0 }, value: 0, targetingMode: 'first', cooldown: 0 };
        if (!drawPaperTower(ctx, tower, angle * Math.PI / 180, age, cell, undefined, true)) throw new Error('Missing paper layers. Retry assets first.');
      }
      setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not render comparison.'); }
  }, [expanded, status, angle, age, revision]);
  return <section className="tower-stage-comparison">
    <p>RocketLauncher PoC · internal levels 5/9/10/14. Natural scale: 1 CSS px per world unit. Same angle, skin and recoil; static, no engine or saved state. Visual acceptance pending.</p>
    <div className="tower-stage-controls">
      <label htmlFor="tower-stage-angle">Aim angle<select id="tower-stage-angle" value={angle} onChange={e => setAngle(Number(e.target.value))}>
        {[0, 90, 180, 270].map(value => <option key={value} value={value}>{value}°</option>)}
      </select></label>
      <label htmlFor="tower-stage-age">Shot age<select id="tower-stage-age" value={age} onChange={e => setAge(Number(e.target.value))}>
        {[-1, 0, .04, .08, .12, .16].map(value => <option key={value} value={value}>{value < 0 ? 'Rest' : `${value}s`}</option>)}
      </select></label>
      <button type="button" disabled={status !== 'ready'} onClick={() => setRevision(value => value + 1)}>Retry comparison</button>
    </div>
    {status === 'loading' && <p role="status" aria-busy="true">Loading paper layers…</p>}
    {status !== 'ready' && status !== 'loading' && <p role="alert">Paper assets unavailable. Use Retry assets above.</p>}
    {error && <p role="alert">{error}</p>}
    {cells.map(cell => <div key={cell}><h3 className="mono">cell {cell}</h3>
      <div className="tower-stage-row">{levels.map(level => <figure key={level}>
        <canvas width={size} height={size} aria-label={`RocketLauncher internal level ${level}, cell ${cell}`} ref={node => {
          if (node) canvases.current.set(`${cell}-${level}`, node); else canvases.current.delete(`${cell}-${level}`);
        }} /><figcaption className="mono">level {level}</figcaption>
      </figure>)}</div>
    </div>)}
  </section>;
}
