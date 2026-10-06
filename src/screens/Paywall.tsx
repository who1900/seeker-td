import { useRef, useState } from 'react';
import { GameState } from '../state/store';
import { SolBadge } from '../components/Shapes';
import { payWithSol, getReceivingWallet, getPurchaseAvailability } from '../wallet';
import { applyPaymentReceipt } from '../services/payments';
import type { PaidRunLedger } from '../services/payments';

interface Props { state?: GameState; setState: (u: any) => void; nav: (s: string) => void; }

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

export function Paywall({ state, setState, nav }: Props) {
  const [processingIdx, setProcessingIdx] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const purchases = getPurchaseAvailability();
  const purchaseBusy = useRef(false);

  async function handleBuy(o: {runs: number; price: number}, idx: number) {
    if (purchaseBusy.current) return;
    purchaseBusy.current = true;
    setErrorMsg('');
    setSuccessMsg('');
    setProcessingIdx(idx);
    try {
      if (!purchases.enabled) throw new Error(purchases.reason);
      if (!state?.walletConnected || !state.walletAddr) throw new Error('Connect a wallet explicitly from the Wallet screen first.');
      const toAddress = getReceivingWallet();
      const { signature, receipt } = await payWithSol({ lamports: Math.round(o.price * 1_000_000_000),
        toAddress, payer: state.walletAddr, runs: o.runs });
      setState((s: GameState) => applyPaymentReceipt(s as GameState & PaidRunLedger, receipt));
      setSuccessMsg(`Server verified. Receipt ${receipt.id}; sig: ${signature.slice(0, 8)}…`);
      setTimeout(() => nav('home'), 1200);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg);
    } finally {
      purchaseBusy.current = false;
      setProcessingIdx(null);
    }
  }

  return (
    <div className="screen paper" style={{padding:'14px 16px 88px'}}>
      <PageHeader nav={nav} title="Run credits" sub="Free and paid reward runs"/>
      <div style={{textAlign:'center', padding:'24px 0 12px'}}>
        <div className="serif" style={{fontSize:26, fontWeight:500, lineHeight:1.1}}>Free runs: {state?.dailyFreeLeft ?? '—'} / {state?.dailyFreeMax ?? '—'}</div>
        <div className="mono" style={{marginTop:8}}>Paid runs: {state?.paidRuns ?? '—'}</div>
        <div className="hand" style={{fontSize:18, color:'var(--charcoal)', marginTop:6}}>Free runs reset at 00:00 UTC.</div>
        <p className="mono">Practice is unlimited and does not use run credits.</p>
        <button type="button" className="btn" onClick={()=>nav('game')}>Choose mode</button>
      </div>

      {errorMsg && <div style={{color:'#c0392b', fontFamily:'var(--mono)', fontSize:12, marginBottom:8, padding:'8px', background:'#fde8e8', borderRadius:4}}>{errorMsg}</div>}
      {successMsg && <div style={{color:'#2a6e2a', fontFamily:'var(--mono)', fontSize:12, marginBottom:8, padding:'8px', background:'#e8f4e8', borderRadius:4}}>{successMsg}</div>}
      {!purchases.enabled && <p className="mono" role="status">{purchases.reason}</p>}

      <div style={{display:'grid', gap:8}}>
        {[
          {runs:1, price:0.01},
          {runs:3, price:0.05, best:true},
          {runs:10, price:0.14},
        ].map((o,i)=>(
          <div key={i} className="sketch-card" style={{padding:12, display:'flex', justifyContent:'space-between', alignItems:'center'}}>
            <div>
              <div className="serif" style={{fontSize:18, fontWeight:500}}>{o.runs} {o.runs===1?'run':'runs'}</div>
              <div className="mono" style={{fontSize:10, color:'var(--charcoal)'}}>10% of purchased runs only → pool (server accounting)</div>
            </div>
            <div style={{display:'flex', gap:6, alignItems:'center'}}>
              {(o as any).best && <span className="chip solid">Best</span>}
              <button className="btn small primary"
                disabled={!purchases.enabled || !state?.walletConnected || processingIdx !== null}
                onClick={()=>handleBuy(o, i)}>
                {processingIdx === i
                  ? <span style={{fontFamily:'var(--mono)', fontSize:11}}>Processing…</span>
                  : <><SolBadge size={14}/>{o.price}</>
                }
              </button>
            </div>
          </div>
        ))}
      </div>

      <div style={{marginTop:14, padding:'10px 12px', border:'1.2px dashed #2b2b2b', fontFamily:'var(--mono)', fontSize:11, lineHeight:1.5}}>
        <span className="eyebrow" style={{display:'block', marginBottom:4}}>Where your SOL goes</span>
        10% of purchased-run lamports → prize pool, rounded down.<br/>
        Free runs and Practice contribute nothing. Top-five distribution is not approved.<br/>
        STD is a closed in-game balance, not a live token. Other allocations are not approved.
      </div>
    </div>
  );
}
