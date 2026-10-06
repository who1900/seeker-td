import type { GameState } from '../state/store';
import { DEFAULT_STATE } from '../state/store';
import { CommerceNetworkBadge, CommercePurchases } from '../components/CommercePurchases';

interface Props { state?: GameState; setState: (u: any) => void; nav: (s: string) => void; }
export function Paywall({ state = DEFAULT_STATE, setState, nav }: Props) {
  return <div className="screen commerce-screen">
    <header className="commerce-header"><button type="button" className="commerce-button" onClick={() => nav('home')} aria-label="Back to home">←</button>
      <h1>Runs</h1><CommerceNetworkBadge /></header>
    <div className="commerce-summary">
      <dl className="commerce-run-counts"><div><dt>Free</dt><dd>{state.dailyFreeLeft} / {state.dailyFreeMax}</dd></div>
        <div><dt>Extra</dt><dd>{state.paidRuns}</dd></div></dl>
      <p>Practice unlimited</p>
      <div className="commerce-actions"><button type="button" className="commerce-button" onClick={() => nav('game')}>Play</button>
        <button type="button" className="commerce-button" onClick={() => nav('wallet')}>Wallet</button></div>
    </div>
    <CommercePurchases state={state} setState={setState} kind="runs" showNetwork={false} />
  </div>;
}
