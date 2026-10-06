import { useState, useEffect, useRef } from 'react';
import { GameState } from '../state/store';
import { SolBadge, LifeHeart } from '../components/Shapes';
import { connectWallet, getSolBalance, getReceivingWallet, payWithSol, getPurchaseAvailability, getWalletCluster } from '../wallet';
import { applyPaymentReceipt } from '../services/payments';
import type { PaidRunLedger } from '../services/payments';

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

function shortAddr(addr: string): string {
  if (!addr || addr.length < 8) return addr;
  return addr.slice(0, 4) + '…' + addr.slice(-4);
}

export function WalletScreen({ state, setState, nav }: Props) {
  const [step, setStep] = useState(state.walletConnected ? 'connected' : 'intro');
  const [error, setError] = useState('');
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [loadingBalance, setLoadingBalance] = useState(false);
  const [processingIdx, setProcessingIdx] = useState<number | null>(null);
  const [buyMsg, setBuyMsg] = useState('');
  const purchases = getPurchaseAvailability();
  const purchaseBusy = useRef(false);

  useEffect(() => {
    if (state.walletConnected && state.walletAddr) {
      setLoadingBalance(true);
      getSolBalance(state.walletAddr)
        .then(b => setSolBalance(b))
        .catch(() => setSolBalance(null))
        .finally(() => setLoadingBalance(false));
    }
  }, [state.walletConnected, state.walletAddr]);

  async function connect() {
    setStep('approving');
    setError('');
    try {
      const { address } = await connectWallet();
      setState((s: GameState) => ({
        ...s,
        walletConnected: true,
        walletAddr: address,
      }));
      setStep('connected');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setStep('intro');
    }
  }

  function disconnect() {
    setState((s: GameState) => ({...s, walletConnected: false, walletAddr: '', sol: 0}));
    setSolBalance(null);
    setStep('intro');
    setError('');
  }

  async function handleBuy(o: {runs: number; price: number}, idx: number) {
    if (purchaseBusy.current) return;
    purchaseBusy.current = true;
    setBuyMsg('');
    setError('');
    setProcessingIdx(idx);
    try {
      if (!purchases.enabled) throw new Error(purchases.reason);
      if (!state.walletConnected || !state.walletAddr) throw new Error('Connect a wallet explicitly first.');
      const toAddress = getReceivingWallet();
      const { signature, receipt } = await payWithSol({ lamports: Math.round(o.price * 1_000_000_000),
        toAddress, payer: state.walletAddr, runs: o.runs });
      setState((s: GameState) => applyPaymentReceipt(s as GameState & PaidRunLedger, receipt));
      setBuyMsg(`Server verified. Receipt ${receipt.id}; sig: ${signature.slice(0, 8)}…`);
      // refresh balance
      if (state.walletAddr) {
        getSolBalance(state.walletAddr).then(b => setSolBalance(b)).catch(() => {});
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      purchaseBusy.current = false;
      setProcessingIdx(null);
    }
  }

  return (
    <div className="screen paper" style={{padding:'14px 16px 88px'}}>
      <PageHeader nav={nav} title="Wallet" sub="Mobile Wallet Adapter"/>
      {step === 'intro' && (
        <>
          <div className="sketch-card" style={{padding:16, margin:'14px 0'}}>
            <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:8}}>
              <div className="eyebrow">Step 01</div>
              <span className="chip" style={{background:'#e8f4e8', border:'1px solid #7ab87a', color:'#2a6e2a', fontSize:10, padding:'2px 6px'}}>{getWalletCluster()}</span>
            </div>
            <div className="serif" style={{fontSize:22, margin:'2px 0 6px'}}>Connect a mobile wallet</div>
            <div className="hand" style={{fontSize:18, color:'var(--charcoal)'}}>We'll hand off to your installed wallet — no seed phrase enters SEEKER: TD.</div>
          </div>
          {error && <div style={{color:'#c0392b', fontFamily:'var(--mono)', fontSize:12, marginBottom:8, padding:'8px', background:'#fde8e8', borderRadius:4}}>{error}</div>}
          <div style={{display:'grid', gap:8}}>
            {['Mobile Wallet','Hardware dApp','Emulator / Test'].map((w,i)=>(
              <button key={i} className="btn block" style={{justifyContent:'flex-start'}} onClick={connect}>
                <span style={{
                  width:28, height:28, border:'1.3px solid #2b2b2b', borderRadius:'50%',
                  display:'inline-flex', alignItems:'center', justifyContent:'center',
                  fontFamily:'var(--mono)', fontSize:12
                }}>{['MW','HD','EM'][i]}</span>
                {w}
              </button>
            ))}
          </div>
        </>
      )}
      {step === 'approving' && (
        <div className="sketch-card" style={{padding:24, margin:'14px 0', textAlign:'center'}}>
          <div className="eyebrow">Handing off</div>
          <div style={{margin:'20px auto', width:64, height:64, border:'1.5px solid #2b2b2b', borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center'}} className="pulse">
            <span className="serif" style={{fontSize:30}}>◎</span>
          </div>
          <div className="serif" style={{fontSize:22}}>Approve in Mobile Wallet</div>
          <div className="hand" style={{fontSize:18, color:'var(--charcoal)', marginTop:4}}>Waiting for signature…</div>
        </div>
      )}
      {step === 'connected' && (
        <>
          <div className="sketch-card" style={{padding:14, margin:'14px 0'}}>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start'}}>
              <div>
                <div style={{display:'flex', alignItems:'center', gap:6}}>
                  <div className="eyebrow">Connected</div>
                  <span className="chip" style={{background:'#e8f4e8', border:'1px solid #7ab87a', color:'#2a6e2a', fontSize:10, padding:'2px 6px'}}>{getWalletCluster()}</span>
                </div>
                <div className="mono" style={{fontSize:11, color:'var(--charcoal)', marginTop:2}}>{state.walletAddr}</div>
                <div className="mono" style={{fontSize:13, fontWeight:700, marginTop:2}}>{shortAddr(state.walletAddr)}</div>
              </div>
              <span className="chip solid">Active</span>
            </div>
            <div style={{display:'flex', gap:16, marginTop:12}}>
              <div>
                <div className="eyebrow">Balance</div>
                {loadingBalance
                  ? <div className="mono" style={{fontSize:14, color:'var(--charcoal)'}}>loading…</div>
                  : <div className="serif" style={{fontSize:24, fontWeight:500}}>
                      {solBalance !== null ? solBalance.toFixed(4) : '—'} <span style={{fontSize:14}}>SOL</span>
                    </div>
                }
              </div>
              <div>
                <div className="eyebrow">STD</div>
                <div className="serif" style={{fontSize:24, fontWeight:500}}>{state.tokens.toLocaleString()}</div>
              </div>
            </div>
          </div>

          {error && <div style={{color:'#c0392b', fontFamily:'var(--mono)', fontSize:12, marginBottom:8, padding:'8px', background:'#fde8e8', borderRadius:4}}>{error}</div>}
          {buyMsg && <div style={{color:'#2a6e2a', fontFamily:'var(--mono)', fontSize:12, marginBottom:8, padding:'8px', background:'#e8f4e8', borderRadius:4}}>{buyMsg}</div>}

          <h3 className="serif" style={{fontSize:20, margin:'16px 0 8px', fontWeight:500}}>Buy extra runs</h3>
          {!purchases.enabled && <p className="mono" role="status">{purchases.reason}</p>}
          <div style={{display:'grid', gap:8}}>
            {[
              {runs:1, price:0.01, best:false},
              {runs:3, price:0.05, best:true},
              {runs:10, price:0.14, best:false},
            ].map((o,i)=>(
              <div key={i} className="sketch-card" style={{padding:12, display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                <div>
                  <div className="serif" style={{fontSize:18, fontWeight:500}}>{o.runs} extra {o.runs===1?'run':'runs'}</div>
                  <div className="mono" style={{fontSize:11, color:'var(--charcoal)'}}>10% of purchased runs only → pool (server accounting)</div>
                </div>
                <div style={{display:'flex', gap:8, alignItems:'center'}}>
                  {o.best && <span className="chip solid">Best</span>}
                  <button className="btn small primary"
                    disabled={!purchases.enabled || processingIdx !== null}
                    onClick={()=>handleBuy(o, i)}>
                    {processingIdx === i ? '…' : <><SolBadge size={14}/>{o.price}</>}
                  </button>
                </div>
              </div>
            ))}
          </div>

          <h3 className="serif" style={{fontSize:20, margin:'16px 0 8px', fontWeight:500}}>Buy lives</h3>
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8}}>
            {[{n:1,p:80},{n:3,p:200},{n:5,p:300}].map((o,i)=>(
              <button key={i} className="btn block" style={{flexDirection:'column', gap:2}}
                onClick={()=> setState((s: GameState)=>({...s, lives:s.lives+o.n, tokens:Math.max(0,s.tokens-o.p)})) }>
                <span style={{display:'flex', gap:2}}>
                  {Array.from({length:o.n}).map((_,k)=><LifeHeart key={k} size={12}/>)}
                </span>
                <span className="mono" style={{fontSize:11}}>{o.p} STD</span>
              </button>
            ))}
          </div>

          <button className="btn block ghost" style={{marginTop:20}} onClick={disconnect}>Disconnect</button>
        </>
      )}
    </div>
  );
}
