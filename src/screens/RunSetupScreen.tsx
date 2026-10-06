import { useState } from 'react';
import type { RunConfig } from '../state/runs';

export const DEFAULT_WAVE_LIMITS = [10, 20, 40];
export const DEFAULT_TIMED_MINUTES = [5, 10, 20, 40];

interface Props {
  onBegin: (config: RunConfig) => void;
  onBack: () => void;
  error?: string;
  waveLimits?: number[];
  timedMinutes?: number[];
}

export function RunSetupScreen({ onBegin, onBack, error, waveLimits = DEFAULT_WAVE_LIMITS, timedMinutes = DEFAULT_TIMED_MINUTES }: Props) {
  const [mode, setMode] = useState<'waves' | 'timed' | 'endless'>('waves');
  const [access, setAccess] = useState<'practice' | 'standard' | 'ranked'>('practice');
  const [waves, setWaves] = useState(waveLimits[0] ?? 10);
  const [minutes, setMinutes] = useState<RunConfig['durationMinutes']>(5);
  const choice = (label: string, selected: boolean, action: () => void) => <button type="button" className={`btn ${selected ? 'primary' : ''}`} aria-pressed={selected} onClick={action} style={{ width: '100%', minHeight: 48, borderRadius: 0, padding: '10px 12px' }}>{label}</button>;
  return <div className="screen paper" style={{ padding: '16px 16px 32px' }}>
    <button className="btn" style={{ minHeight: 48 }} onClick={onBack}>← Back</button>
    <div className="eyebrow" style={{ marginTop: 20 }}>Configure your defense</div>
    <h1 style={{ margin: '6px 0 20px' }}>Run setup</h1>
    <h2 style={{ fontSize: 18 }}>Format</h2>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
      {(['waves', 'timed', 'endless'] as const).map(value => <span key={value}>{choice(value === 'waves' ? 'Waves' : value === 'timed' ? 'Timed' : 'Endless', mode === value, () => setMode(value))}</span>)}
    </div>
    {mode === 'waves' && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>{waveLimits.map(value => <span key={value}>{choice(`${value} waves`, waves === value, () => setWaves(value))}</span>)}</div>}
    {mode === 'timed' && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>{timedMinutes.filter(value => [5, 10, 20, 40].includes(value)).map(value => <span key={value}>{choice(`${value} min`, minutes === value, () => setMinutes(value as RunConfig['durationMinutes']))}</span>)}</div>}
    <p style={{ fontSize: 13, lineHeight: 1.5 }}>{mode === 'waves' ? 'Clear the selected number of waves. These limits are provisional defaults.' : mode === 'timed' ? 'Survive the active real-time duration. Clock starts with the first wave, includes planning, excludes pause/background. Next wave starts after 3 seconds of planning.' : 'Survive as long as possible. Ends only in defeat.'}</p>
    <h2 style={{ fontSize: 18 }}>Access</h2>
    <div style={{ display: 'grid', gap: 8 }}>{(['practice', 'standard', 'ranked'] as const).map(value => <span key={value}>{choice(value === 'practice' ? 'Practice · unlimited, free' : value === 'standard' ? 'Standard' : 'Ranked · local only', access === value, () => setAccess(value))}</span>)}</div>
    <p style={{ fontSize: 13, lineHeight: 1.5 }}>{access === 'practice' ? 'No run limits, STD rewards, scores or challenge progress. Free Continue and restart.' : access === 'ranked' ? 'Local ranked results only. No Continue. Not verified for prizes; no cloud submission.' : 'Local rewards and progress. Continue costs STD. Restart requires a new admission.'}</p>
    {error && <p role="alert" style={{ color: '#8a4a4a' }}>{error}</p>}
    <button className="btn primary block" style={{ minHeight: 56, marginTop: 20 }} onClick={() => onBegin({ mode, access, waveLimit: waves, durationMinutes: minutes })}>Begin {access}</button>
  </div>;
}
