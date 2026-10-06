import { useState } from 'react';
import { type GameState, DAILY_BONUS_SCHEDULE, claimDailyBonus, getDailyBonusDisplay } from '../state/store';
import { resetLabel, useUTCClock } from './utcReset';

interface Props { state: GameState; setState: (u: (s: GameState) => GameState) => boolean; nav: (s: string) => void; }

export function DailyBonusScreen({ state, setState, nav }: Props) {
  const now = useUTCClock();
  const display = getDailyBonusDisplay(state, now);
  const [error, setError] = useState('');
  function claim() {
    setError(setState(s => claimDailyBonus(s)) ? '' : 'Save not confirmed. Retry saving.');
  }
  return <div className="screen paper reward-screen">
    <header className="context-header"><button type="button" className="btn" aria-label="Back to home" onClick={() => nav('home')}>←</button>
      <div><div className="eyebrow">{state.streak}-day streak</div><h1 className="serif">Daily login</h1></div></header>
    <div className="bonus-calendar" aria-label="Seven-day STD reward cycle">
      {DAILY_BONUS_SCHEDULE.map((amount, index) => {
        const current = index + 1 === display.day;
        const claimed = index + 1 < display.day || (current && !display.canClaim);
        return <div key={amount} className={`sketch-card bonus-day ${current ? 'current' : ''}`} aria-current={current ? 'date' : undefined}>
          <span className="eyebrow">D{index + 1}</span><span className="serif">{amount}</span><span className="mono">STD</span>
          {claimed && <span aria-label="Claimed">✓</span>}
        </div>;
      })}
    </div>
    <section className="sketch-card bonus-reward">
      <div className="eyebrow">{display.canClaim ? "Today's bonus" : 'Claimed today'}</div>
      <div className="serif bonus-amount">+{display.amount} STD</div>
      <button type="button" className="btn primary block" disabled={!display.canClaim} onClick={claim}>{display.canClaim ? 'Claim reward' : 'Claimed'}</button>
      {error && <p role="alert">{error}</p>}
      <p className="mono">Next reset {resetLabel(now)}</p>
    </section>
    <p>Log in daily to build your streak. The seven-day reward cycle repeats; a missed day starts a new streak.</p>
  </div>;
}
