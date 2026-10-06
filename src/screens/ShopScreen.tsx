import { GameState, SKINS, SkinDef, TowerFamily } from '../state/store';
import { TokenBadge, IsoPedestal } from '../components/Shapes';
import { PaperImage, usePaperAssets } from '../game/paperAssets';
import { buyCosmetic, equipCosmetic } from './shopCosmetics';

interface Props { state: GameState; setState: (u: any) => boolean; nav: (s: string) => void; variant?: number; onTopUp: () => void; }

const FAMILIES: { id: TowerFamily; label: string }[] = [
  { id: 'canon',  label: 'Canon'  },
  { id: 'laser',  label: 'Laser'  },
  { id: 'mortar', label: 'Mortar' },
  { id: 'glue',   label: 'Glue'   },
];

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

// A skin is "owned" if it's a free default or has been unlocked.
function isOwned(s: SkinDef, state: GameState): boolean {
  return s.price === 0 || state.unlockedSkins.includes(s.id);
}

function Swatch({ color, size = 40 }: { color: string; size?: number }) {
  return (
    <div style={{
      width:size, height:size, borderRadius:'50%', background:color,
      border:'1.4px solid #2b2b2b', boxShadow:'inset 0 -3px 6px rgba(0,0,0,0.18)',
    }}/>
  );
}

function SkinCard({ s, state, setState, onTopUp }: { s: SkinDef; state: GameState; setState: (u: any) => boolean; onTopUp: () => void }) {
  const paperStatus = usePaperAssets();
  const owned = isOwned(s, state);
  const equipped = state.equippedSkins[s.family] === s.id;
  const canAfford = state.tokens >= s.price;

  function buy() {
    if (!canAfford) { onTopUp(); return; }
    setState((prev: GameState) => buyCosmetic(prev, s.id));
  }
  function equip() {
    setState((prev: GameState) => equipCosmetic(prev, s.id));
  }

  return (
    <div className="sketch-card" style={{padding:10, display:'flex', flexDirection:'column', alignItems:'center', gap:4}}>
      {paperStatus === 'ready' ? <div style={{ position: 'relative', width: 84, height: 84 }}>
        <PaperImage path="ui/illustrations/armory_pedestal.png" label="Armory pedestal" width={84} />
        <div style={{ position: 'absolute', top: 0, left: 12 }}><PaperImage path={`towers/${{ canon: 'canon', laser: 'simpleLaser', mortar: 'mortar', glue: 'glueTower' }[s.family]}/preview.png`} label={s.name} width={60} height={60} skinColor={s.price === 0 ? undefined : s.color} /></div>
        <span style={{ position: 'absolute', bottom: 0, right: 0, width: 12, height: 12, background: s.color }} title={s.name} />
      </div> : <IsoPedestal size={84}><Swatch color={s.color} size={36}/></IsoPedestal>}
      <div className="serif" style={{fontSize:15, fontWeight:500, lineHeight:1.1, marginTop:2}}>{s.name}</div>
      <div className="hand" style={{fontSize:13, color:'var(--charcoal)', textAlign:'center', lineHeight:1.15, minHeight:30}}>{s.desc}</div>
      {!owned ? (
        <button className={`btn small ${canAfford?'primary':''}`} style={{marginTop:2}} onClick={buy} aria-label={canAfford ? `Buy ${s.name} for ${s.price} STD` : `Add STD for ${s.name}`}>
          <TokenBadge size={12}/> {canAfford ? s.price : 'Add STD'}
        </button>
      ) : equipped ? (
        <span className="chip solid" style={{marginTop:2}}>Equipped</span>
      ) : (
        <button className="btn small" style={{marginTop:2}} onClick={equip}>Equip</button>
      )}
    </div>
  );
}

export function ShopScreen({ state, setState, nav, onTopUp }: Props) {
  const paperStatus = usePaperAssets();
  const ownedCount = SKINS.filter(s => isOwned(s, state)).length;
  return (
    <div className="screen paper" style={{padding:'14px 16px 88px'}}>
      <PageHeader nav={nav} title="Armory" sub="Trade STD for tower skins"/>
      {paperStatus !== 'ready' && <div role="status" style={{ fontSize: 12, marginTop: 8 }}>{paperStatus === 'loading' ? 'Loading paper assets…' : paperStatus}</div>}
      <div style={{display:'flex', gap:6, alignItems:'center', margin:'10px 0'}}>
        <span className="chip solid"><TokenBadge size={12}/> {state.tokens.toLocaleString()}</span>
        <span className="chip">{ownedCount}/{SKINS.length} owned</span>
      </div>

      <p className="mono">Cosmetics only. Standard Continue restores 10 lives for 50 STD, once per run.</p>

      {FAMILIES.map(fam => (
        <div key={fam.id} style={{marginTop:14}}>
          <div className="eyebrow" style={{marginBottom:6}}>{fam.label} family</div>
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8}}>
            {SKINS.filter(s => s.family === fam.id).map(s => (
              <SkinCard key={s.id} s={s} state={state} setState={setState} onTopUp={onTopUp}/>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
