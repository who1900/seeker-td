import { GameState } from '../state/store';
import { TokenBadge, SolBadge, LifeHeart, SketchRule } from '../components/Shapes';
import { PaperImage, usePaperAssets } from '../game/paperAssets';

interface Props { state: GameState; setState: (u: any) => void; nav: (s: string) => void; variant?: number; }

function shortWalletAddress(address: string) {
  return address.length > 11 ? `${address.slice(0, 4)}...${address.slice(-4)}` : address;
}

export function HomeScreen({ state, setState, nav, variant = 0 }: Props) {
  if (variant === 1) return <HomeHero state={state} setState={setState} nav={nav}/>;
  if (variant === 2) return <HomeList state={state} nav={nav}/>;
  return <HomeMosaic state={state} setState={setState} nav={nav}/>;
}

function HomeMosaic({ state, nav }: Props) {
  const free = state.dailyFreeLeft;
  return (
    <div className="screen paper" style={{padding:'12px 14px 88px'}}>
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start'}}>
        <div>
          <div className="eyebrow">SEEKER: TD · vol.01</div>
          <h1 className="serif" style={{fontSize:34, margin:'4px 0 0', lineHeight:1, letterSpacing:'-0.01em'}}>
            Hold the<br/><span className="ink-underline">line.</span>
          </h1>
        </div>
        <button onClick={()=>nav('wallet')} className="chip" style={{cursor:'pointer'}}
          title={state.walletConnected ? state.walletAddr : undefined}
          aria-label={state.walletConnected ? `Wallet address: ${state.walletAddr}` : 'Connect wallet'}>
          {state.walletConnected ? shortWalletAddress(state.walletAddr) : 'Connect'}
        </button>
      </div>

      <SketchRule w={310}/>
      <PaperHero />

      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8, margin:'12px 0'}}>
        <StatTile label="STD" value={state.tokens} icon={<TokenBadge size={18}/>} big/>
        <StatTile label="Best wave" value={state.bestWave ?? 0} icon={<LifeHeart size={14}/>}/>
        <StatTile label="SOL" value={state.sol.toFixed(2)} icon={<SolBadge size={18}/>}/>
      </div>

      <div className="sketch-card" style={{padding:14, marginBottom:12}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start'}}>
          <div>
            <div className="eyebrow">Your next defense</div>
            <h2 className="serif" style={{fontSize:22, margin:'2px 0 4px', fontWeight:500}}>Choose your mode</h2>
            <div className="hand" style={{fontSize:18, color:'var(--charcoal)'}}>Waves · Timed · Endless</div>
          </div>
          <MiniMap/>
        </div>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:10}}>
          <div style={{display:'flex', gap:6, alignItems:'center'}}>
            <span className="chip ghost">
              {free > 0 ? `${free}/${state.dailyFreeMax} free` : 'free runs used'}
            </span>
            <span className="chip">Practice unlimited</span>
          </div>
          <button className="btn primary" onClick={() => nav('game')}>
            Choose mode
          </button>
        </div>
      </div>

      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8}}>
        <QuickCard label="Daily login" value={`+${50 + state.streak*10}`} sub={`${state.streak}-day streak`}
          claimed={state.loginClaimedToday} onClick={()=>nav('bonus')}/>
        <QuickCard label="Challenges" value={`${state.challengesDone.filter(Boolean).length}/3`} sub="Resets in 09:14"
          onClick={()=>nav('challenges')}/>
        <QuickCard label="Prize pool" value={`${state.prizePool.toLocaleString()} STD`} sub="Ends April 30"
          onClick={()=>nav('leaderboard')}/>
        <QuickCard label="Armory" value="34 skins" sub="9 unlocked" onClick={()=>nav('shop')}/>
      </div>

      <div onClick={()=>nav('referral')} style={{
        marginTop:12, padding:'12px 14px', display:'flex', justifyContent:'space-between',
        alignItems:'center', background:'#2b2b2b', color:'#f6f5f0', border:'1.5px solid #2b2b2b',
        borderRadius:2, cursor:'pointer'
      }}>
        <div>
          <div style={{fontFamily:'var(--mono)', fontSize:10, letterSpacing:'0.18em', textTransform:'uppercase', opacity:0.7}}>Invite · tier II</div>
          <div className="serif" style={{fontSize:20}}>Local demo · referrals unverified</div>
        </div>
        <span style={{fontFamily:'var(--mono)', fontSize:18}}>→</span>
      </div>
    </div>
  );
}

function HomeHero({ state, nav }: Props) {
  const free = state.dailyFreeLeft;
  const paperStatus = usePaperAssets();
  return (
    <div className="screen" style={{padding:0}}>
      <div style={{
        background: 'var(--lightgray)',
        borderBottom:'1.5px solid #2b2b2b',
        padding:'14px 14px 0',
        position:'relative', overflow:'hidden'
      }}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
          <div className="home-wordmark">
            {paperStatus === 'ready'
              ? <PaperImage path="branding/wordmark.png" label="SEEKER: TD" width={164} height={32} />
              : <span className="eyebrow">SEEKER: TD</span>}
          </div>
          <button onClick={()=>nav('wallet')} className="chip" style={{cursor:'pointer'}}
            title={state.walletConnected ? state.walletAddr : undefined}
            aria-label={state.walletConnected ? `Wallet address: ${state.walletAddr}` : 'Connect wallet'}>
            {state.walletConnected ? shortWalletAddress(state.walletAddr) : 'Connect'}
          </button>
        </div>
        <h1 className="serif" style={{fontSize:56, lineHeight:0.95, margin:'14px 0 0', fontWeight:500, letterSpacing:'-0.03em'}}>
          Defend the <em>inkwell.</em>
        </h1>
        <div className="hand" style={{fontSize:18, color:'var(--charcoal)', margin:'8px 0 4px'}}>Waves · Timed · Endless</div>
        <div style={{fontFamily:'var(--mono)', fontSize:11, color:'var(--charcoal)', marginBottom:14, letterSpacing:'0.02em'}}>Build your maze. Defend the paper world.</div>
        <PaperHero />
      </div>

      <div style={{padding:'14px 14px 88px'}}>
        <div style={{display:'flex', gap:8, marginBottom:12}}>
          <div className="sketch-card" style={{flex:1, padding:10}}>
            <div className="eyebrow">Runs today</div>
            <div className="serif" style={{fontSize:26}}>{free}<span style={{fontSize:14, color:'var(--charcoal)'}}> / {state.dailyFreeMax}</span></div>
            <div className="mono" style={{fontSize:11}}>{state.paidRuns} paid</div>
          </div>
          <div className="sketch-card" style={{flex:1, padding:10}}>
            <div className="eyebrow">Best wave</div>
            <div className="serif" style={{fontSize:26}}>{state.bestWave ?? 0}</div>
          </div>
          <div className="sketch-card" style={{flex:1, padding:10}}>
            <div className="eyebrow">STD</div>
            <div className="serif" style={{fontSize:26}}>{state.tokens}</div>
          </div>
        </div>

        <button className="btn primary block" style={{height:56, fontSize:16}}
          onClick={()=>nav('game')}>
          Play
        </button>
        <div className="mono" style={{fontSize:12, color:'var(--charcoal)', marginTop:6}}>Practice unlimited</div>
        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginTop:8}}>
          <button className="btn block" onClick={()=>nav('challenges')}>Challenges</button>
          <button className="btn block" onClick={()=>nav('shop')}>Armory</button>
          <button className="btn block" onClick={()=>nav('leaderboard')}>Leaderboard</button>
          <button className="btn block" onClick={()=>nav('referral')}>Referral</button>
          <button className="btn block" onClick={()=>nav('bonus')}>Daily Bonus</button>
          <button className="btn block" onClick={()=>nav('paywall')}>Buy Runs</button>
        </div>
      </div>
    </div>
  );
}

function HomeList({ state, nav }: { state: GameState; nav: (s: string) => void }) {
  const free = state.dailyFreeLeft;
  const rows = [
    { label:'Choose mode',   sub:`${free} free · ${state.paidRuns} paid runs · Practice unlimited`, action:()=>nav('game'), emph:true },
    { label:'Daily login',   sub:`+${50+state.streak*10} STD · streak ${state.streak}`, action:()=>nav('bonus') },
    { label:'Challenges',    sub:`${state.challengesDone.filter(Boolean).length} of 3 complete`, action:()=>nav('challenges') },
    { label:'Leaderboard',   sub:`Monthly rank #${state.monthlyRank}`, action:()=>nav('leaderboard') },
    { label:'Armory',        sub:'34 skins · 9 unlocked', action:()=>nav('shop') },
    { label:'Invite friends',sub:'Local demo · referrals unverified', action:()=>nav('referral') },
    { label:'Wallet',        sub: state.walletConnected ? shortWalletAddress(state.walletAddr) : 'Not connected', action:()=>nav('wallet') },
  ];
  return (
    <div className="screen paper" style={{padding:'14px 0 88px'}}>
      <div style={{padding:'0 16px 10px'}}>
        <div className="eyebrow">Hello, commander</div>
        <h1 className="serif" style={{fontSize:32, margin:'2px 0', fontWeight:500}}>SEEKER: TD</h1>
        <div className="hand" style={{fontSize:20, color:'var(--charcoal)'}}>index</div>
      </div>
      <SketchRule w={380}/>
      <PaperHero />
      {rows.map((r, i) => (
        <div key={i} onClick={r.action} style={{
          padding:'14px 16px', borderBottom:'1px solid var(--line)',
          display:'flex', justifyContent:'space-between', alignItems:'center', cursor:'pointer',
          background: r.emph ? '#2b2b2b' : 'transparent',
          color: r.emph ? '#f6f5f0' : 'inherit',
        }}>
          <div>
            <div className="serif" style={{fontSize:20, fontWeight:500}}>{r.label}</div>
            <div style={{fontFamily:'var(--mono)', fontSize:11, opacity:0.8, letterSpacing:'0.04em', marginTop:2}}
              title={r.label === 'Wallet' && state.walletConnected ? state.walletAddr : undefined}
              aria-label={r.label === 'Wallet' && state.walletConnected ? `Wallet address: ${state.walletAddr}` : undefined}>{r.sub}</div>
          </div>
          <span style={{fontFamily:'var(--mono)', fontSize:18}}>→</span>
        </div>
      ))}
    </div>
  );
}

function StatTile({label, value, icon, big}: {label:string; value:any; icon:React.ReactNode; big?:boolean}) {
  return (
    <div className="sketch-card" style={{padding:'8px 10px'}}>
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
        <span className="eyebrow">{label}</span>
        {icon}
      </div>
      <div className="serif" style={{fontSize: big?24:20, fontWeight:500, lineHeight:1, marginTop:2}}>{value}</div>
    </div>
  );
}

function QuickCard({label, value, sub, claimed, onClick}: {label:string; value:string; sub:string; claimed?:boolean; onClick:()=>void}) {
  return (
    <div onClick={onClick} style={{
      padding:'10px 12px', border:'1.5px solid #2b2b2b', background:'var(--cream)',
      cursor:'pointer', borderRadius:2, position:'relative',
    }}>
      <div className="eyebrow">{label}</div>
      <div className="serif" style={{fontSize:18, fontWeight:500, marginTop:2}}>{value}</div>
      <div style={{fontFamily:'var(--mono)', fontSize:10, color:'var(--charcoal)', marginTop:2}}>{sub}</div>
      {claimed && <span style={{position:'absolute', top:8, right:8, fontFamily:'var(--mono)', fontSize:9}}>✓</span>}
    </div>
  );
}

function MiniMap() {
  return (
    <svg width="90" height="60" viewBox="0 0 90 60" style={{flexShrink:0}}>
      <rect x="1" y="1" width="88" height="58" fill="#f6f5f0" stroke="#2b2b2b" strokeWidth="1.2"/>
      <path d="M 2 12 L 30 12 L 30 28 L 60 28 L 60 44 L 18 44 L 18 54 L 88 54"
        stroke="#595959" strokeWidth="6" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M 2 12 L 30 12 L 30 28 L 60 28 L 60 44 L 18 44 L 18 54 L 88 54"
        stroke="#2b2b2b" strokeWidth="0.5" fill="none" strokeDasharray="2 2"/>
      <circle cx="4" cy="12" r="2" fill="#2b2b2b"/>
      <rect x="82" y="50" width="6" height="6" fill="#2b2b2b"/>
    </svg>
  );
}

function PaperHero() {
  const status = usePaperAssets();
  return <div style={{ width: '100%', minHeight: 120 }}>
    {status === 'ready' ? <PaperImage path="ui/illustrations/home_hero.png" label="Paper defense diorama" width="100%" height={170} /> : <HeroDiorama />}
    {status !== 'ready' && status !== 'loading' && <div role="status" style={{ fontSize: 12 }}>{status}</div>}
  </div>;
}

function HeroDiorama() {
  return (
    <svg width="100%" height="170" viewBox="0 0 360 170" style={{display:'block'}}>
      <polygon points="180,16 340,90 180,164 20,90" fill="#f6f5f0" stroke="#2b2b2b" strokeWidth="1.4"/>
      {[[90,58],[125,76],[160,94],[195,112],[230,94],[265,76],[300,58]].map(([x,y],i)=>(
        <polygon key={i} points={`${x},${y-10} ${x+18},${y} ${x},${y+10} ${x-18},${y}`} fill="#dcdcd4" stroke="#2b2b2b" strokeWidth="0.8"/>
      ))}
      <g transform="translate(60 88)">
        <ellipse cx="0" cy="6" rx="10" ry="3" fill="#dcdcd4" stroke="#2b2b2b" strokeWidth="1"/>
        <polygon points="0,-12 10,6 -10,6" fill="#595959" stroke="#2b2b2b" strokeWidth="1.2"/>
      </g>
      <g transform="translate(210 62)">
        <ellipse cx="0" cy="6" rx="10" ry="3" fill="#dcdcd4" stroke="#2b2b2b" strokeWidth="1"/>
        <circle cx="0" cy="-2" r="9" fill="#2b2b2b" stroke="#2b2b2b" strokeWidth="1"/>
      </g>
      <g transform="translate(290 110)">
        <ellipse cx="0" cy="6" rx="10" ry="3" fill="#dcdcd4" stroke="#2b2b2b" strokeWidth="1"/>
        <polygon points="0,-10 9,-4 9,4 0,10 -9,4 -9,-4" fill="#a58a4a" stroke="#2b2b2b" strokeWidth="1.2"/>
      </g>
      <circle cx="150" cy="100" r="5" fill="#595959" stroke="#2b2b2b"/>
      <circle cx="170" cy="104" r="5" fill="#595959" stroke="#2b2b2b"/>
      <polygon points="200,118 206,128 194,128" fill="#2b2b2b" stroke="#2b2b2b"/>
    </svg>
  );
}
