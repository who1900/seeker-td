import { useState, useEffect } from 'react';
import { GameState, canClaimBonus, DAILY_BONUS_AMOUNT, BONUS_COOLDOWN_MS } from '../state/store';

interface Props { state: GameState; setState: (u: any) => void; nav: (s: string) => void; }

function PageHeader({ nav, title, sub }: { nav: (s: string) => void; title: string; sub: string }) {
  return (
    <div style={{display:'flex', gap:10, alignItems:'flex-start'}}>
      <button onClick={()=>nav('home')} style={{background:'none', border:'1.3px solid #2b2b2b', padding:'6px 10px', cursor:'pointer', fontFamily:'var(--mono)', fontSize:14, borderRadius:2}}>←</button>
      <div style={{flex:1}}>
        <div className="eyebrow">{sub}</div>
        <h1 className="serif" style={{fontSize:28, margin:'2px 0', fontWeight:500, lineHeight:1}}>{title}</h1>
      </div>
    </div>
  );
}

function useCountdown(targetMs: number | null): string {
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (targetMs == null) { setLabel(''); return; }
    const update = () => {
      const diff = targetMs - Date.now();
      if (diff <= 0) { setLabel('Ready'); return; }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setLabel(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`);
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [targetMs]);
  return label;
}

export function DailyBonusScreen({ state, setState, nav }: Props) {
  const days = [50, 60, 70, 90, 120, 150, 240];
  const streak = state.streak;
  const claimable = canClaimBonus(state);
  const nextClaimMs = state.lastBonusClaim != null ? state.lastBonusClaim + BONUS_COOLDOWN_MS : null;
  const countdown = useCountdown(claimable ? null : nextClaimMs);

  return (
    <div className="screen paper" style={{padding:'14px 16px 88px'}}>
      <PageHeader nav={nav} title="Daily login" sub={`Streak · ${streak} days`}/>
      <div style={{display:'grid', gridTemplateColumns:'repeat(7, 1fr)', gap:6, marginTop:14}}>
        {days.map((v,i) => {
          const claimed = i < streak;
          const today = i === streak;
          return (
            <div key={i} className="sketch-card" style={{
              padding:'10px 4px', textAlign:'center',
              background: claimed ? 'var(--lightgray)' : today ? '#2b2b2b' : 'var(--cream)',
              color: today ? '#f6f5f0' : 'inherit',
              position:'relative',
            }}>
              <div className="eyebrow" style={{opacity:0.7}}>D{i+1}</div>
              <div className="serif" style={{fontSize:16, fontWeight:500, margin:'2px 0'}}>{v}</div>
              <div style={{fontFamily:'var(--mono)', fontSize:8, opacity:0.7}}>STD</div>
              {claimed && <span style={{position:'absolute', top:4, right:4, fontFamily:'var(--mono)', fontSize:9}}>✓</span>}
            </div>
          );
        })}
      </div>

      <div className="sketch-card" style={{padding:16, marginTop:16, textAlign:'center'}}>
        <div className="eyebrow">Today's bonus</div>
        <div className="serif" style={{fontSize:48, fontWeight:500, lineHeight:1, margin:'4px 0'}}>
          +{DAILY_BONUS_AMOUNT}
        </div>
        <div className="hand" style={{fontSize:18, color:'var(--charcoal)'}}>STD deposited to your balance</div>
        {!claimable && countdown && (
          <div style={{fontFamily:'var(--mono)', fontSize:13, color:'var(--charcoal)', marginTop:8}}>
            Next claim in {countdown}
          </div>
        )}
        <button className="btn primary"
          style={{marginTop:12}}
          disabled={!claimable}
          onClick={()=>setState((s: GameState)=>({...s,
            loginClaimedToday: true,
            lastBonusClaim: Date.now(),
            streak: Math.min(s.streak+1, days.length),
            tokens: s.tokens + DAILY_BONUS_AMOUNT,
          }))}>
          {claimable ? 'Claim reward' : 'Claimed · come back later'}
        </button>
      </div>

      <h3 className="serif" style={{fontSize:18, margin:'16px 0 8px', fontWeight:500}}>Next week</h3>
      <div className="hand" style={{fontSize:16, color:'var(--charcoal)'}}>
        Day 8 unlocks an exclusive skin token &amp; a 2× multiplier for one match.
      </div>
    </div>
  );
}
