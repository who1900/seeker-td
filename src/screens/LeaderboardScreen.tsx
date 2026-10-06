import { useState, useEffect } from 'react';
import { GameState } from '../state/store';
import { isFirebaseEnabled } from '../firebase';
import { fetchTopScores, type LbEntry } from '../services/leaderboard';
import { displayName } from '../services/skr';

// TODO backend: real cross-user leaderboard

interface Props { state: GameState; setState?: (u: any) => void; nav: (s: string) => void; variant?: number; }

// Seed bots — stable fake players to make the board feel alive (local fallback)
const SEED_BOTS = [
  { name:'0xSer_kit',   wave:45, addr:'7h…Kq' },
  { name:'seeker_fan',  wave:42, addr:'ax…wn' },
  { name:'ledgerbear',  wave:38, addr:'2m…rL' },
  { name:'ren.sol',     wave:35, addr:'e4…p8' },
  { name:'nocturne',    wave:31, addr:'99…c1' },
  { name:'halftone',    wave:28, addr:'b3…vv' },
  { name:'foxwell',     wave:25, addr:'k1…qe' },
  { name:'mink',        wave:22, addr:'x7…gd' },
  { name:'bismuth',     wave:20, addr:'hh…mm' },
  { name:'plume',       wave:18, addr:'d9…sk' },
  { name:'0xTurret',    wave:14, addr:'ff…22' },
  { name:'ghostwave',   wave:10, addr:'aa…rr' },
  { name:'ser_8bit',    wave:8,  addr:'zt…11' },
];

interface BoardEntry {
  name: string;
  wave: number;
  addr: string;
  isPlayer: boolean;
}

function buildLocalBoard(state: GameState): { entries: BoardEntry[]; playerRank: number } {
  const playerWave = state.bestWave ?? 0;
  const playerEntry: BoardEntry = {
    name: 'YOU',
    wave: playerWave,
    addr: state.walletAddr || '—',
    isPlayer: true,
  };
  const bots: BoardEntry[] = SEED_BOTS.map(b => ({ ...b, isPlayer: false }));
  const all = [...bots, playerEntry].sort((a, b) => b.wave - a.wave);
  const playerRank = all.findIndex(e => e.isPlayer) + 1;
  return { entries: all, playerRank };
}

function buildLiveBoard(
  lbEntries: LbEntry[],
  state: GameState,
): { entries: BoardEntry[]; playerRank: number } {
  const playerWallet = state.walletAddr || '';
  const entries: BoardEntry[] = lbEntries.map(e => ({
    name: displayName(e.skrName, e.walletAddr),
    wave: e.bestWave,
    addr: displayName(null, e.walletAddr),
    isPlayer: !!playerWallet && e.walletAddr === playerWallet,
  }));
  entries.sort((a, b) => b.wave - a.wave);

  // If player not in list, inject at correct position
  const playerInList = entries.some(e => e.isPlayer);
  if (!playerInList && state.bestWave > 0 && playerWallet) {
    const playerEntry: BoardEntry = {
      name: 'YOU',
      wave: state.bestWave,
      addr: displayName(null, playerWallet),
      isPlayer: true,
    };
    entries.push(playerEntry);
    entries.sort((a, b) => b.wave - a.wave);
  }

  const playerRank = entries.findIndex(e => e.isPlayer) + 1;
  return { entries, playerRank: playerRank > 0 ? playerRank : entries.length + 1 };
}

type DataSource = 'loading' | 'live' | 'local';

function PageHeader({ nav, sub }: { nav: (s: string) => void; sub: string }) {
  return (
    <div style={{display:'flex', gap:10, alignItems:'flex-start'}}>
      <button aria-label="Back to home" onClick={()=>nav('home')} style={{minWidth:48, minHeight:48, background:'none', border:'1.3px solid #2b2b2b', padding:'6px 10px', cursor:'pointer', fontFamily:'var(--mono)', fontSize:14, borderRadius:2}}>←</button>
      <div style={{flex:1}}>
        <div className="eyebrow">{sub}</div>
        <h1 className="serif" style={{fontSize:28, margin:'2px 0', fontWeight:500, lineHeight:1}}>Leaderboard</h1>
      </div>
    </div>
  );
}

function SourceBadge({ source }: { source: DataSource }) {
  if (source === 'loading') return null;
  const isLive = source === 'live';
  return (
    <span style={{
      display:'inline-block', padding:'2px 6px',
      fontFamily:'var(--mono)', fontSize:9, letterSpacing:'0.08em',
      textTransform:'uppercase', fontWeight:700,
      background: isLive ? '#2b2b2b' : 'transparent',
      color: isLive ? '#f6f5f0' : 'inherit',
      border: isLive ? 'none' : '1px solid currentColor',
      marginLeft:8, verticalAlign:'middle',
    }}>
      {isLive ? 'live scores' : 'local demo'}
    </span>
  );
}

function PrizePolicy({ source }: { source: DataSource }) {
  return (
    <div className="mono" style={{fontSize:11, lineHeight:1.5, margin:'12px 0'}}>
      <div>Future prizes: top 5, funded by 10% of purchased runs only.</div>
      <div>Eligibility rules and prize shares are not approved. No real payouts yet.</div>
      <div>Both tabs show the same best-wave preview, not monthly standings.</div>
      <div>{source === 'live'
        ? 'Live scores do not verify prize eligibility; local scores may appear as YOU.'
        : source === 'loading'
          ? 'Loading live scores. Showing local demo entries — no payout.'
          : 'Local demo: sample players and local scores — no payout.'}</div>
    </div>
  );
}

function rankStatus(rank: number, source: DataSource) {
  return source === 'live' ? rank <= 5 ? 'Future top 5' : 'Unverified' : 'Demo';
}

export function LeaderboardScreen({ state, setState, nav, variant = 0 }: Props) {
  const [tab, setTab] = useState('month');
  const [source, setSource] = useState<DataSource>('loading');
  const [liveEntries, setLiveEntries] = useState<LbEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!isFirebaseEnabled) {
      setSource('local');
      return;
    }
    setSource('loading');
    fetchTopScores(20)
      .then(data => {
        if (cancelled) return;
        if (data.length > 0) {
          setLiveEntries(data);
          setSource('live');
        } else {
          setSource('local');
        }
      })
      .catch(() => {
        if (!cancelled) setSource('local');
      });
    return () => { cancelled = true; };
  }, []);

  const { entries, playerRank } =
    source === 'live'
      ? buildLiveBoard(liveEntries, state)
      : buildLocalBoard(state);

  // Sync monthlyRank to state if it changed (silent, no flash)
  useEffect(() => {
    if (!setState || source === 'loading' || state.monthlyRank === playerRank) return;
    setState((s: GameState) => s.monthlyRank === playerRank ? s : { ...s, monthlyRank: playerRank });
  }, [setState, source, playerRank, state.monthlyRank]);

  if (variant === 1) return <LeaderboardPodium state={state} nav={nav} tab={tab} setTab={setTab} entries={entries} playerRank={playerRank} source={source}/>;
  return <LeaderboardList state={state} nav={nav} tab={tab} setTab={setTab} entries={entries} playerRank={playerRank} source={source}/>;
}

function LeaderboardList({ nav, tab, setTab, entries, playerRank, source }: {
  state: GameState; nav: (s: string) => void; tab: string; setTab: (t: string) => void;
  entries: BoardEntry[]; playerRank: number; source: DataSource;
}) {
  const playerEntry = entries.find(e => e.isPlayer)!;
  return (
    <div className="screen paper" style={{padding:'14px 16px 88px'}}>
      <PageHeader nav={nav} sub="Scores · future top 5 prizes"/>
      <div style={{display:'flex', flexWrap:'wrap', gap:6, margin:'10px 0', alignItems:'center'}}>
        {['month','all-time'].map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{
            minWidth:48, minHeight:48, padding:'6px 14px', border:'1.3px solid #2b2b2b',
            background: tab===t?'#2b2b2b':'#f6f5f0',
            color: tab===t?'#f6f5f0':'#2b2b2b',
            fontFamily:'var(--mono)', fontSize:11, letterSpacing:'0.06em',
            textTransform:'uppercase', cursor:'pointer',
          }}>{t==='month'?'This month':'All time'}</button>
        ))}
        <SourceBadge source={source} />
      </div>
      <PrizePolicy source={source} />
      {source === 'loading' && (
        <div className="mono" style={{fontSize:11, color:'#595959', padding:'12px 0'}}>Loading…</div>
      )}
      <div className="sketch-card" style={{padding:0}}>
        <div style={{
          display:'grid', gridTemplateColumns:'30px minmax(0, 1fr) 44px 72px',
          gap:8, padding:'8px 12px', borderBottom:'1.2px solid #2b2b2b',
          background:'var(--cream-2)',
        }}>
          {['#','Player','Wave','Status'].map(h => <div key={h} className="eyebrow">{h}</div>)}
        </div>
        {entries.slice(0, 15).map((r, i) => {
          const rank = i + 1;
          return (
            <div key={r.addr + i} style={{
              display:'grid', gridTemplateColumns:'30px minmax(0, 1fr) 44px 72px',
              gap:8, padding:'10px 12px', borderBottom:'1px solid var(--line)',
              alignItems:'center',
              background: r.isPlayer ? '#2b2b2b' : rank <= 5 ? 'rgba(165,138,74,0.08)' : 'transparent',
              color: r.isPlayer ? '#f6f5f0' : 'inherit',
            }}>
              <span className="serif" style={{fontSize:18, fontWeight:500}}>{rank}</span>
              <div>
                <div style={{fontSize:14, fontWeight:600}}>{r.isPlayer ? 'YOU' : r.name}</div>
                <div className="mono" style={{fontSize:10, opacity:0.7}}>{r.addr}</div>
              </div>
              <span className="mono" style={{fontWeight:700}}>W{r.wave}</span>
              <span className="mono" style={{fontSize:10, fontWeight:700}}>{rankStatus(rank, source)}</span>
            </div>
          );
        })}
        {/* Player row if not in top 15 */}
        {playerEntry && playerRank > 15 && (
          <div style={{
            display:'grid', gridTemplateColumns:'30px minmax(0, 1fr) 44px 72px',
            gap:8, padding:'12px', background:'#2b2b2b', color:'#f6f5f0',
            alignItems:'center',
          }}>
            <span className="serif" style={{fontSize:18, fontWeight:500}}>{playerRank}</span>
            <div>
              <div style={{fontSize:14, fontWeight:600}}>YOU</div>
              <div className="mono" style={{fontSize:10, opacity:0.7}}>{playerEntry.addr}</div>
            </div>
            <span className="mono" style={{fontWeight:700}}>W{playerEntry.wave}</span>
            <span className="mono" style={{fontSize:10, fontWeight:700}}>{rankStatus(playerRank, source)}</span>
          </div>
        )}
      </div>
      <div style={{marginTop:12, padding:'10px 12px', border:'1.2px dashed #2b2b2b', fontFamily:'var(--mono)', fontSize:11, lineHeight:1.5}}>
        <span className="eyebrow" style={{display:'block', marginBottom:4}}>Future prize ranks</span>
        Ranks 1–5 are planned prize positions, not confirmed recipients. No payout date announced.
      </div>
    </div>
  );
}

function LeaderboardPodium({ nav, tab, setTab, entries, playerRank, source }: {
  state: GameState; nav: (s: string) => void; tab: string; setTab: (t: string) => void;
  entries: BoardEntry[]; playerRank: number; source: DataSource;
}) {
  const top3 = entries.slice(0, 3);
  const rest = entries.slice(3, 15);
  const playerEntry = entries.find(e => e.isPlayer);

  return (
    <div className="screen" style={{padding:0}}>
      <div style={{background:'#2b2b2b', color:'#f6f5f0', padding:'14px 16px'}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
          <button aria-label="Back to home" onClick={()=>nav('home')} style={{minWidth:48, minHeight:48, background:'none', border:'none', color:'#f6f5f0', fontSize:18, cursor:'pointer'}}>←</button>
          <div style={{display:'flex', gap:6, alignItems:'center'}}>
            {['month','all-time'].map(t=>(
              <button key={t} onClick={()=>setTab(t)} style={{
                minWidth:48, minHeight:48, padding:'4px 10px', border:'1.3px solid #f6f5f0',
                background: tab===t?'#f6f5f0':'transparent',
                color: tab===t?'#2b2b2b':'#f6f5f0',
                fontFamily:'var(--mono)', fontSize:10, letterSpacing:'0.06em',
                textTransform:'uppercase', cursor:'pointer', borderRadius:100,
              }}>{t}</button>
            ))}
            <SourceBadge source={source} />
          </div>
        </div>
        <h1 className="serif" style={{fontSize:30, margin:'8px 0 4px', fontWeight:500}}>Leaderboard</h1>
        <div className="hand" style={{fontSize:18, marginTop:4}}>Future prize ranks: 1–5</div>
        <PrizePolicy source={source} />
        <div className="mono" style={{fontSize:11, opacity:0.6, marginTop:4}}>Your rank: #{playerRank}</div>

        <div style={{display:'flex', alignItems:'flex-end', justifyContent:'center', gap:10, marginTop:22, height:160}}>
          {/* podium order: 2nd, 1st, 3rd */}
          {[top3[1], top3[0], top3[2]].filter(Boolean).map((p) => {
            const rank = entries.indexOf(p) + 1;
            const h = rank===1?140:rank===2?110:90;
            return (
              <div key={p.addr + rank} style={{display:'flex', flexDirection:'column', alignItems:'center', flex:1}}>
                <div style={{
                  width:44, height:44, borderRadius:'50%', border:'1.5px solid #f6f5f0',
                  display:'flex', alignItems:'center', justifyContent:'center',
                  fontFamily:'var(--serif)', fontSize:18, marginBottom:6,
                  background:rank===1?'var(--gold)':'transparent',
                  color:rank===1?'#2b2b2b':'#f6f5f0',
                }}>
                  {p.isPlayer ? 'Y' : p.name[0].toUpperCase()}
                </div>
                <div style={{fontSize:12, fontWeight:600, textAlign:'center'}}>{p.isPlayer ? 'YOU' : p.name}</div>
                <div className="mono" style={{fontSize:10, opacity:0.7}}>W{p.wave}</div>
                <div style={{
                  marginTop:6, width:'100%', height:h,
                  background:'#f6f5f0', color:'#2b2b2b',
                  border:'1.5px solid #f6f5f0',
                  display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'flex-start',
                  paddingTop:8,
                }}>
                  <span className="serif" style={{fontSize:30, fontWeight:500, lineHeight:1}}>{rank}</span>
                  <span className="mono" style={{fontSize:10, marginTop:2, fontWeight:700}}>{rankStatus(rank, source)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{padding:'14px 16px 88px', background:'var(--cream)'}}>
        <div className="eyebrow" style={{marginBottom:8}}>Rank 4 — {Math.min(entries.length, 15)}</div>
        <div className="sketch-card" style={{padding:0}}>
          {rest.map((r, i) => {
            const rank = i + 4;
            return (
              <div key={r.addr + i} style={{
                display:'grid', gridTemplateColumns:'30px 1fr 60px',
                gap:8, padding:'10px 12px', borderBottom:'1px solid var(--line)',
                alignItems:'center',
                background: r.isPlayer ? 'rgba(43,43,43,0.1)' : 'transparent',
                fontWeight: r.isPlayer ? 700 : 400,
              }}>
                <span className="serif" style={{fontSize:16, fontWeight:500}}>{rank}</span>
                <div>
                  <div style={{fontSize:14, fontWeight: r.isPlayer ? 700 : 600}}>{r.isPlayer ? 'YOU' : r.name}</div>
                  <div className="mono" style={{fontSize:10, color:'var(--charcoal)'}}>{r.addr}</div>
                  {rank <= 5 && <div className="mono" style={{fontSize:10}}>Future prize rank · {source === 'live' ? 'eligibility unverified' : 'demo — no payout'}</div>}
                </div>
                <span className="mono" style={{fontWeight:700}}>W{r.wave}</span>
              </div>
            );
          })}
          {/* Player row if outside top 15 */}
          {playerEntry && playerRank > 15 && (
            <div style={{
              display:'grid', gridTemplateColumns:'30px 1fr 60px',
              gap:8, padding:'10px 12px',
              alignItems:'center', background:'rgba(43,43,43,0.1)',
            }}>
              <span className="serif" style={{fontSize:16, fontWeight:500}}>{playerRank}</span>
              <div>
                <div style={{fontSize:14, fontWeight:700}}>YOU</div>
                <div className="mono" style={{fontSize:10, color:'var(--charcoal)'}}>{playerEntry.addr}</div>
              </div>
              <span className="mono" style={{fontWeight:700}}>W{playerEntry.wave}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
