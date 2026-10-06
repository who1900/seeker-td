import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { GameState } from '../state/store';
import { CommercePurchases } from './CommercePurchases';
import { WalletScreen } from '../screens/WalletScreen';

export function ContextDialog({ title, onClose, children }: {
  title: string; onClose: () => void; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); if (trigger?.isConnected) trigger.focus(); };
  }, []);
  return <dialog ref={dialog} className="context-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="context-header"><h2 id={titleId}>{title}</h2>
      <button type="button" className="btn" onClick={onClose} aria-label="Close dialog">✕</button></header>
    {children}
  </dialog>;
}

export function ContextualCheckout({ state, setState, kind, onClose, onComplete, onPractice, nextReset, persistenceError, onRetrySave }: {
  state: GameState;
  setState: (update: (state: GameState) => GameState) => boolean;
  kind: 'runs' | 'std';
  onClose: () => void;
  onComplete: () => void;
  onPractice?: () => void;
  nextReset: string;
  persistenceError?: string;
  onRetrySave?: () => GameState | false;
}) {
  const protectedRun = state.activeRun ?? (state.battleCheckpoint ? state.runLedger?.[state.battleCheckpoint.runId]?.run : null);
  const owner = protectedRun ? protectedRun.commerceAccount || 'guest' : undefined;
  const ownerBlocked = !!owner && (owner === 'guest' || owner !== (state.commerceAccount || 'guest'));
  return <ContextDialog title={kind === 'runs' ? 'Need another run?' : 'Add STD'} onClose={onClose}>
    <p>{kind === 'runs' ? 'Your setup is saved. Choose SOL or SKR.' : 'Top up STD, then return to your game.'}</p>
    {persistenceError && <div role="alert"><p>{persistenceError}</p><button type="button" className="btn" onClick={onRetrySave}>Retry saving</button></div>}
    {ownerBlocked ? <p role="status">{owner === 'guest' ? 'Wallet top-ups are unavailable for this guest run.' : 'Return to the wallet that started this run.'}</p> : <>
      {!state.walletConnected && <WalletScreen state={state} setState={setState} nav={onClose} inline requiredAccount={owner} />}
      <CommercePurchases state={state} setState={setState} kind={kind} onComplete={onComplete} />
    </>}
    {kind === 'runs' && <>{state.dailyFreeLeft + state.paidRuns > 0 && <button type="button" className="btn primary block" onClick={onComplete}>Begin selected run</button>}
      <button type="button" className="btn block" onClick={onPractice}>Play Practice · free</button>
      <p className="mono">Free runs reset {nextReset}</p></>}
    <button type="button" className="btn block" onClick={onClose}>Return {kind === 'runs' ? 'to setup' : 'without spending'}</button>
  </ContextDialog>;
}
