import { GameState, CHALLENGES, applyChallengeReset } from '../state/store';
import { TokenBadge } from '../components/Shapes';

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

export function ChallengesScreen({ state, setState, nav }: Props) {
  // Ensure daily reset applied when screen opens
  const s = applyChallengeReset(state);

  return (
    <div className="screen paper" style={{padding:'14px 16px 88px'}}>
      <PageHeader nav={nav} title="Daily challenges" sub="Resets daily"/>
      <div style={{display:'grid', gap:10, marginTop:12}}>
        {CHALLENGES.map((c, i) => {
          const progress = Math.min(c.goal, s.challengeProgress[c.id] ?? 0);
          const claimed = s.challengeClaimed[c.id] ?? false;
          const ready = progress >= c.goal && !claimed;

          return (
            <div key={c.id} className="sketch-card" style={{padding:14}}>
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start'}}>
                <div style={{flex:1}}>
                  <div className="eyebrow">{String(i+1).padStart(2,'0')} / 03</div>
                  <div className="serif" style={{fontSize:20, fontWeight:500, marginTop:2}}>{c.title}</div>
                </div>
                <span className="chip solid"><TokenBadge size={12}/>+{c.reward}</span>
              </div>
              <div style={{display:'flex', gap:8, alignItems:'center', marginTop:10}}>
                <div className="track" style={{flex:1}}>
                  <span style={{width: `${(progress/c.goal)*100}%`}}/>
                </div>
                <span className="mono" style={{fontSize:11, fontWeight:700, minWidth:40, textAlign:'right'}}>{progress}/{c.goal}</span>
              </div>
              {claimed ? (
                <div className="mono" style={{fontSize:12, color:'var(--charcoal)', marginTop:8}}>Claimed ✓</div>
              ) : ready ? (
                <button className="btn small primary block" style={{marginTop:10}}
                  onClick={()=>setState((prev: GameState) => {
                    const ps = applyChallengeReset(prev);
                    return {
                      ...ps,
                      tokens: ps.tokens + c.reward,
                      challengeClaimed: { ...ps.challengeClaimed, [c.id]: true },
                    };
                  })}>
                  Claim +{c.reward} STD
                </button>
              ) : (
                <div className="hand" style={{fontSize:16, color:'var(--charcoal)', marginTop:8}}>
                  {c.id==='win_3' && 'Win 3 full games in a row — hold the base each time.'}
                  {c.id==='no_leak' && 'Clear any wave without letting anything through.'}
                  {c.id==='use_4' && 'Deploy 4 different tower types in one match.'}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
