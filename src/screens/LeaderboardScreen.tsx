import { useState } from 'react';
import type { GameState, LocalScore } from '../state/store';
import { useUTCClock } from './utcReset';

interface Props { state: GameState; setState?: (u: any) => void; nav: (s: string) => void; variant?: number; }

const SEED_BOTS = [
  { name:'0xSer_kit', wave:45, addr:'7h…Kq' },
  { name:'seeker_fan', wave:42, addr:'ax…wn' },
  { name:'ledgerbear', wave:38, addr:'2m…rL' },
  { name:'ren.sol', wave:35, addr:'e4…p8' },
  { name:'nocturne', wave:31, addr:'99…c1' },
  { name:'halftone', wave:28, addr:'b3…vv' },
  { name:'foxwell', wave:25, addr:'k1…qe' },
  { name:'mink', wave:22, addr:'x7…gd' },
  { name:'bismuth', wave:20, addr:'hh…mm' },
  { name:'plume', wave:18, addr:'d9…sk' },
  { name:'0xTurret', wave:14, addr:'ff…22' },
  { name:'ghostwave', wave:10, addr:'aa…rr' },
  { name:'ser_8bit', wave:8, addr:'zt…11' },
];

export function rankedRulesKey(score: LocalScore): string | null {
  const config = score.config;
  if (!config || config.access !== 'ranked' || score.continuedCount !== 0
    || !score.runId || !Number.isSafeInteger(score.wave) || score.wave <= 0
    || !Number.isFinite(score.ts) || score.ts < 0
    || !score.engineVersion || ![1, 2, 4].includes(score.speed ?? 0)
    || !Number.isSafeInteger(score.seed)) return null;
  return JSON.stringify([config.mode, config.mode === 'waves' ? config.waveLimit : config.mode === 'timed' ? config.durationMinutes : null,
    score.seed, score.speed, score.engineVersion, score.partition ?? null]);
}

export function selectLocalRankedScores(state: GameState, period: string, rules: string, now = Date.now()): LocalScore[] {
  const date = new Date(now);
  const month = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  return state.localScores.filter(score => rankedRulesKey(score) === rules
    && (score.accountScope || 'guest') === (state.commerceAccount || 'guest')
    && score.ts <= now && (period !== 'month' || score.ts >= month))
    .sort((a, b) => b.wave - a.wave || a.ts - b.ts || (a.runId ?? '').localeCompare(b.runId ?? ''));
}

function rulesLabel(score: LocalScore): string {
  const config = score.config!;
  const format = config.mode === 'waves' ? `${config.waveLimit} waves` : config.mode === 'timed' ? `${config.durationMinutes} min` : 'Endless';
  const period = score.period && /^\d{4}-\d{2}$/.test(score.period)
    ? new Date(`${score.period}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : `${score.speed}×`;
  return `${format} · ${period}`;
}

export function LeaderboardScreen({ state, nav, variant = 1 }: Props) {
  const [period, setPeriod] = useState('month');
  const [selection, setSelection] = useState('');
  const now = useUTCClock();
  const date = new Date(now), month = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const partitions = new Map<string, LocalScore>();
  for (const score of state.localScores) {
    const key = rankedRulesKey(score);
    if (key && (score.accountScope || 'guest') === (state.commerceAccount || 'guest')
      && score.ts <= now && (period !== 'month' || score.ts >= month)) partitions.set(key, score);
  }
  const rules = partitions.has(selection) ? selection : [...partitions.keys()][0] ?? '';
  const entries = rules ? selectLocalRankedScores(state, period, rules, now) : [];
  return <div className="screen board-screen">
    <header className="board-hero">
      <div className="context-header"><button type="button" className="btn" aria-label="Back to home" onClick={() => nav('home')}>←</button>
        <div className="board-periods" role="group" aria-label="Period">
          {['month', 'all-time'].map(value => <button type="button" key={value} className="btn" aria-pressed={period === value} onClick={() => setPeriod(value)}>{value === 'month' ? 'This month' : 'All time'}</button>)}
        </div></div>
      <h1 className="serif">Leaderboard</h1>
      <p className="mono">Preview · no prizes</p>
      <details className="board-info"><summary>Info</summary>
        <p>Local Ranked runs only. Compare the same format, seed, speed and rules version. Standard and continued runs are excluded.</p>
        <p>Planned: monthly top 5 SKR rewards funded by 10% of run purchases only. Not live; eligibility and payouts are unapproved.</p>
        {rules && <p className="mono">Seed {partitions.get(rules)?.seed} · {partitions.get(rules)?.engineVersion}</p>}
      </details>
      {variant === 1 && <section aria-label="Demo podium" className="demo-podium">
        {[SEED_BOTS[1], SEED_BOTS[0], SEED_BOTS[2]].map((entry, index) => <div className={`demo-place demo-place-${index}`} key={entry.name}>
          <span className="demo-avatar" aria-hidden="true">{entry.name[0].toUpperCase()}</span>
          <span>{entry.name}</span><span className="mono">W{entry.wave}</span>
          <div className="demo-pedestal"><span className="serif">{[2, 1, 3][index]}</span><span className="mono">Demo</span></div>
        </div>)}
      </section>}
    </header>
    <div className="board-content">
      <h2 className="serif">Your local Ranked runs</h2>
      {partitions.size > 0 && <label className="board-filter">Comparable rules
        <select value={rules} onChange={event => setSelection(event.target.value)}>
          {[...partitions].map(([key, score]) => <option value={key} key={key}>{rulesLabel(score)}</option>)}
        </select></label>}
      {entries.length === 0 ? <p role="status">No matching Ranked results {period === 'month' ? 'this month' : 'yet'}.</p> :
        <ol className="ranked-runs" aria-label="Local Ranked results">{entries.map((score, index) => <li key={score.runId} className="board-row">
          <span className="serif">#{index + 1}</span><span>YOU · {score.runId}<small className="mono">{new Date(score.ts).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })} UTC</small></span>
          <span className="mono">W{score.wave}</span>
        </li>)}</ol>}
      <section className="demo-board" aria-label="Demo players, not local rankings">
        <h2 className="serif">Demo players</h2><p className="mono">Illustration only · separate from your results</p>
        {SEED_BOTS.slice(variant === 1 ? 3 : 0).map(entry => <div className="board-row" key={entry.name}>
          <span className="mono">Demo</span><span>{entry.name}<small className="mono">{entry.addr}</small></span><span className="mono">W{entry.wave}</span>
        </div>)}
      </section>
    </div>
  </div>;
}
