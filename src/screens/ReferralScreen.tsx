import { useState, useEffect, useRef } from 'react';
import { GameState, ensureReferralCode } from '../state/store';
import { applyLocalReferral, referralError } from '../state/referrals';

interface Props { state: GameState; setState?: (u: any) => boolean; nav: (s: string) => void; }

export function ReferralScreen({ state, setState, nav }: Props) {
  const [inputCode, setInputCode] = useState('');
  const [error, setError] = useState('');
  const [shareStatus, setShareStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const sharingRef = useRef(false);

  useEffect(() => {
    if (!state.referralCode && setState) setState((s: GameState) => ensureReferralCode(s));
  }, [state.referralCode, setState]);

  const code = state.referralCode;
  const shareText = `Play SEEKER: TD — local demo code ${code}. Invites are not verified; no rewards are credited.`;

  async function handleShare(copy: boolean) {
    if (!code || sharingRef.current) return;
    sharingRef.current = true;
    setBusy(true);
    setShareStatus('');
    try {
      if (copy) {
        if (!navigator.clipboard?.writeText) {
          setShareStatus('Copy unavailable. Select and copy the code manually.');
          return;
        }
        await navigator.clipboard.writeText(code);
        setShareStatus('Code copied.');
      } else {
        if (!navigator.share) {
          setShareStatus('Sharing unavailable. Use Copy to send the demo code.');
          return;
        }
        await navigator.share({ title: 'SEEKER: TD', text: shareText });
        setShareStatus('Share action completed; no invite is verified.');
      }
    } catch (cause) {
      setShareStatus(!copy && cause instanceof Error && cause.name === 'AbortError'
        ? 'Sharing cancelled.' : copy ? 'Copy failed. Try again or copy manually.' : 'Sharing failed. Try again or use Copy.');
    } finally {
      sharingRef.current = false;
      setBusy(false);
    }
  }

  function handleApply(event: React.FormEvent) {
    event.preventDefault();
    const problem = !setState ? 'Saving is unavailable in this preview.' : referralError(state, inputCode);
    if (problem) {
      setError(problem);
      inputRef.current?.focus();
      return;
    }
    setError('');
    if (!setState!((s: GameState) => applyLocalReferral(s, inputCode))) setError('Save not confirmed. Retry saving.');
  }

  return (
    <div className="screen paper referral-demo" style={{padding:'14px 16px 88px'}}>
      <style>{`.referral-demo :is(button, input):focus-visible { outline: 2px solid var(--charcoal, #2b2b2b); outline-offset: 3px; }`}</style>
      <div style={{display:'flex', gap:10, alignItems:'flex-start'}}>
        <button aria-label="Back to home" onClick={()=>nav('home')} style={{minWidth:48, minHeight:48, background:'none', border:'1.3px solid #2b2b2b', cursor:'pointer'}}>←</button>
        <div>
          <div className="eyebrow">Local referral demo</div>
          <h1 className="serif" style={{fontSize:28, margin:'2px 0', fontWeight:500}}>Invite</h1>
        </div>
      </div>
      <p className="mono" style={{fontSize:12, lineHeight:1.5}}>Local codes · unverified invites. No referral rewards are credited.</p>
      <div className="sketch-card" style={{padding:14}}>
        <div className="eyebrow">Your local code</div>
        <div style={{display:'flex', flexWrap:'wrap', alignItems:'center', gap:8, marginTop:8}}>
          <span className="mono" style={{fontSize:22, fontWeight:700, letterSpacing:'0.10em'}}>{code || 'Not ready'}</span>
          <button className="btn primary" style={{minWidth:48, minHeight:48}} disabled={!code || busy} aria-busy={busy} onClick={()=>handleShare(true)}>Copy</button>
          <button className="btn" style={{minWidth:48, minHeight:48}} disabled={!code || busy} aria-busy={busy} onClick={()=>handleShare(false)}>Share</button>
        </div>
        <div role="status" className="mono" style={{fontSize:12, marginTop:8}}>{shareStatus}</div>
        <div className="mono" style={{fontSize:12, marginTop:8}}>Stored invite count (unverified): {state.referralsCount ?? 0}</div>
      </div>
      <div className="sketch-card" style={{padding:14, marginTop:16}}>
        {state.referredBy ? (
          <div role="status" className="mono" style={{fontSize:13}}>Saved locally (unverified): {state.referredBy}. No new rewards credited.</div>
        ) : (
          <form onSubmit={handleApply} noValidate>
            <label htmlFor="referral-code" className="eyebrow">Friend's demo code (required)</label>
            <div style={{display:'flex', gap:8, marginTop:8}}>
              <input id="referral-code" ref={inputRef} type="text" autoComplete="off" autoCapitalize="characters" spellCheck={false}
                value={inputCode} onChange={event=>{ setInputCode(event.target.value); setError(''); }}
                aria-invalid={!!error} aria-describedby="referral-hint referral-error" placeholder="ABC234"
                style={{minWidth:0, minHeight:48, flex:1, fontFamily:'var(--mono)', fontSize:16, border:'1.3px solid #2b2b2b', padding:'8px 10px', background:'#f6f5f0'}} />
              <button type="submit" className="btn primary" style={{minWidth:48, minHeight:48}}>Apply</button>
            </div>
            <div id="referral-hint" className="mono" style={{fontSize:12, marginTop:8}}>6 letters or digits, excluding I, O, 0 and 1. Saved only on this device.</div>
            <div id="referral-error" role="alert" className="mono" style={{fontSize:12, marginTop:8}}>{error}</div>
          </form>
        )}
      </div>
      <h3 className="serif" style={{fontSize:20, margin:'16px 0 8px', fontWeight:500}}>Future verified referrals</h3>
      <p className="mono" style={{fontSize:12, lineHeight:1.5}}>Verified referrals are not live. Local codes do not establish reward eligibility.</p>
    </div>
  );
}
