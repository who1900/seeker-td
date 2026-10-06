import { useState, useEffect, useRef, useCallback } from 'react';
import { loadState, saveState, retryStatePersistence, type GameState, applyDailyReset, applyChallengeReset, getRecoverableCheckpoint, persistBattleCheckpoint, restoreStateBackup, discardUnrecoverableRun } from './state/store';
import { GameEx } from './game/Game';
import { HomeScreen } from './screens/HomeScreen';
import { WalletScreen } from './screens/WalletScreen';
import { ShopScreen } from './screens/ShopScreen';
import { LeaderboardScreen } from './screens/LeaderboardScreen';
import { ChallengesScreen } from './screens/ChallengesScreen';
import { ReferralScreen } from './screens/ReferralScreen';
import { DailyBonusScreen } from './screens/DailyBonusScreen';
import { RunSetupScreen } from './screens/RunSetupScreen';
import { ContextDialog, ContextualCheckout } from './components/ContextualCheckout';
import { resetLabel, useUTCClock } from './screens/utcReset';
import { admitRun, abandonRun, continueRun, runOwnedByState } from './state/runs';
import type { RunConfig, RunSession } from './state/runs';
import type { RunCheckpoint } from './state/checkpoints';

const HOME_VARIANT = 1;
const SHOP_VARIANT = 0;
const LB_VARIANT = 1;
const HUD_VARIANT = 0;

type Screen = 'home' | 'setup' | 'game' | 'wallet' | 'shop' | 'leaderboard' | 'challenges' | 'referral' | 'bonus';
type StateUpdate = ((s: GameState) => GameState) | GameState;
type Checkout = { kind: 'runs'; config: RunConfig; replace?: RunSession } | { kind: 'std' };

function recoverCheckpoint(state: GameState): RunCheckpoint | null {
  try { return getRecoverableCheckpoint(state); } catch { return null; }
}

function Phone({ state, setState, persistenceError, onRetrySave }: { state: GameState; setState: (u: StateUpdate) => boolean; persistenceError: string; onRetrySave: () => GameState | false }) {
  const [screen, setScreen] = useState<Screen>('home');
  const [run, setRun] = useState<RunSession | null>(null);
  const [initialCheckpoint, setInitialCheckpoint] = useState<RunCheckpoint | undefined>();
  const [admissionError, setAdmissionError] = useState('');
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const checkoutRef = useRef<Checkout | null>(null);
  const [confirmation, setConfirmation] = useState<'exit' | 'discard' | 'restart' | null>(null);
  const screenRef = useRef(screen), confirmationRef = useRef(confirmation);
  screenRef.current = screen; confirmationRef.current = confirmation;
  const admittingRef = useRef(false);
  const stateRef = useRef(state);
  const now = useUTCClock();
  stateRef.current = state;
  const recoverable = recoverCheckpoint(state);
  const savedRun = recoverable ? state.runLedger[recoverable.runId]?.run : state.activeRun;

  const updateState = useCallback((updater: StateUpdate): boolean => {
    const next = typeof updater === 'function' ? updater(stateRef.current) : updater;
    if (!setState(next)) return false;
    stateRef.current = next;
    return true;
  }, [setState]);

  function closeCheckout() { checkoutRef.current = null; setCheckout(null); }
  function openCheckout(value: Checkout) { checkoutRef.current = value; setCheckout(value); }
  function retryPersistence(): GameState | false {
    const restored = onRetrySave();
    if (!restored) return false;
    stateRef.current = restored;
    if (run && restored.runLedger[run.id]?.abandoned) {
      setRun(null); setInitialCheckpoint(undefined); setConfirmation(null); setScreen('home'); setAdmissionError('');
    }
    return restored;
  }

  function startRun(config: RunConfig, replace?: RunSession): boolean {
    if (admittingRef.current) return false;
    admittingRef.current = true;
    try {
      const current = stateRef.current;
      if (!replace && (current.activeRun || recoverCheckpoint(current))) {
        setAdmissionError('Resume or discard your saved run first.'); return false;
      }
      const refreshed = applyDailyReset(current);
      if (config.access !== 'practice' && refreshed.dailyFreeLeft + refreshed.paidRuns === 0) {
        setConfirmation(null);
        openCheckout({ kind: 'runs', config: { ...config }, replace }); return false;
      }
      const base = replace ? abandonRun(current, replace) : current;
      const admitted = admitRun(base, config);
      if (!admitted.run) { setAdmissionError('Could not start this run. Check your saved run.'); return false; }
      const checkpoint = getRecoverableCheckpoint(admitted.state);
      if (!checkpoint) { setAdmissionError('Could not prepare recovery. No run spent.'); return false; }
      if (!updateState(admitted.state)) { setAdmissionError('Save not confirmed. Retry before starting.'); return false; }
      closeCheckout(); setInitialCheckpoint(undefined); setRun(admitted.run);
      setAdmissionError(''); setConfirmation(null); setScreen('game');
      return true;
    } catch { setAdmissionError('Could not prepare your run. Nothing spent. Try again.'); return false; }
    finally { queueMicrotask(() => { admittingRef.current = false; }); }
  }

  function purchaseComplete() {
    const pending = checkoutRef.current;
    if (!pending) return;
    if (pending.kind === 'std') { closeCheckout(); return; }
    const fresh = applyDailyReset(stateRef.current);
    if (fresh.dailyFreeLeft + fresh.paidRuns <= 0) return;
    checkoutRef.current = null;
    if (!startRun(pending.config, pending.replace)) checkoutRef.current = pending;
  }

  function resumeRun() {
    const checkpoint = recoverCheckpoint(stateRef.current);
    const session = checkpoint && stateRef.current.runLedger[checkpoint.runId]?.run;
    if (!checkpoint || !session) { setAdmissionError('Saved battle unavailable. Your run has not been discarded.'); return; }
    setInitialCheckpoint(checkpoint); setRun(session); setScreen('game'); setAdmissionError('');
  }

  function nav(to: string) {
    if (screen === 'game') { setConfirmation('exit'); return; }
    if (to === 'game') { setAdmissionError(''); setScreen('setup'); return; }
    setScreen(to as Screen);
  }

  const backRef = useRef(() => {});
  backRef.current = () => {
    if (checkoutRef.current) closeCheckout();
    else if (confirmation) setConfirmation(null);
    else if (screen === 'game') setConfirmation('exit');
    else setScreen('home');
  };
  useEffect(() => {
    const back = () => backRef.current();
    const nativeBack = (event: Event) => {
      if (screenRef.current !== 'home' || checkoutRef.current || confirmationRef.current) {
        event.preventDefault(); backRef.current();
      }
    };
    window.addEventListener('popstate', back);
    window.addEventListener('seekdef:back', back);
    window.addEventListener('seeker-native-back', nativeBack);
    return () => { window.removeEventListener('popstate', back); window.removeEventListener('seekdef:back', back); window.removeEventListener('seeker-native-back', nativeBack); };
  }, []);

  const common = { state, setState: updateState, nav };
  let content: React.ReactNode = null;
  if (screen === 'home') content = <HomeScreen {...common} variant={HOME_VARIANT}/>;
  else if (screen === 'setup') content = <RunSetupScreen onBegin={startRun} onBack={() => nav('home')} error={admissionError}/>;
  else if (screen === 'game' && run) content = <GameEx key={run.id} run={run} state={state} setState={updateState}
    hudVariant={HUD_VARIANT} initialCheckpoint={initialCheckpoint} suspended={!!checkout || !!confirmation}
    persistenceBlocked={!!persistenceError} onRetryPersistence={retryPersistence}
    onRestart={() => setConfirmation('restart')} onTopUp={() => openCheckout({ kind: 'std' })}
    onCheckpoint={checkpoint => {
      const next = persistBattleCheckpoint(stateRef.current, checkpoint);
      const saved = next !== stateRef.current && updateState(next);
      if (saved) setAdmissionError('');
      return saved;
    }} onPersistenceError={() => setAdmissionError('Could not save. Battle paused. Retry saving before leaving.')}
    onContinue={() => {
      const continued = continueRun(stateRef.current, run);
      if (!continued.run) return false;
      const saved = updateState(continued.state);
      if (saved) setAdmissionError('');
      return saved;
    }} onExit={() => setConfirmation('exit')}/>;
  else if (screen === 'wallet') content = <WalletScreen {...common}/>;
  else if (screen === 'shop') content = <ShopScreen {...common} variant={SHOP_VARIANT} onTopUp={() => openCheckout({ kind: 'std' })}/>;
  else if (screen === 'leaderboard') content = <LeaderboardScreen {...common} variant={LB_VARIANT}/>;
  else if (screen === 'challenges') content = <ChallengesScreen {...common}/>;
  else if (screen === 'referral') content = <ReferralScreen {...common}/>;
  else if (screen === 'bonus') content = <DailyBonusScreen {...common}/>;

  function finishExit() {
    const session = run ?? savedRun;
    if (session && !updateState(s => abandonRun(s, session))) return;
    setRun(null); setInitialCheckpoint(undefined); setConfirmation(null); setScreen('home'); setAdmissionError('');
  }
  function confirm() {
    if (confirmation === 'restart' && run) { startRun(run.config, run); return; }
    finishExit();
  }

  return <div className="app-shell">
    {persistenceError && screen !== 'game' && !checkout && !confirmation && <div role="alert" className="storage-notice">{persistenceError}
      <button type="button" className="btn" onClick={retryPersistence}>Retry saving</button></div>}
    {admissionError && screen !== 'setup' && <p role="alert" className="persistence-alert">{admissionError}</p>}
    {screen !== 'game' && savedRun && <section className="recovery-banner" aria-label="Saved run">
      <span>{recoverable ? `Saved ${savedRun.config.access} run` : 'Saved run has no compatible battle. Discard only this run to play again.'}</span>
      <button type="button" className="btn" onClick={resumeRun} disabled={!recoverable}>Resume</button>
      <button type="button" className="btn" onClick={() => setConfirmation('discard')}>Discard</button>
    </section>}
    <div key={screen} className={'app-content ' + (screen === 'game' ? 'app-content-game' : 'app-content-menu')}>{content}</div>
    {screen !== 'game' && <nav className="tabbar" aria-label="Main navigation">
      {([['home','Play'], ['challenges','Tasks'], ['shop','Armory'], ['leaderboard','Board'], ['wallet','Wallet']] as const).map(([id, label]) =>
        <button type="button" key={id} className={'tab ' + (screen === id ? 'active' : '')} aria-current={screen === id ? 'page' : undefined} onClick={() => nav(id)}><span className="dot"/><span>{label}</span></button>)}
    </nav>}
    {checkout && <ContextualCheckout {...common} kind={checkout.kind} nextReset={resetLabel(now)} onClose={closeCheckout}
      persistenceError={persistenceError} onRetrySave={retryPersistence}
      onComplete={purchaseComplete} onPractice={checkout.kind === 'runs' ? () => startRun({ ...checkout.config, access: 'practice' }, checkout.replace) : undefined}/>}
    {confirmation && <ContextDialog title={confirmation === 'restart' ? 'Restart this run?' : 'Discard this run?'} onClose={() => setConfirmation(null)}>
      <p>{confirmation === 'restart' ? 'A new Standard or Ranked run uses one admission.' : 'Your current battle will end. The admission is not refunded.'}</p>
      {persistenceError && <div role="alert"><p>{persistenceError}</p><button type="button" className="btn" onClick={retryPersistence}>Retry saving</button></div>}
      <button type="button" className="btn primary block" onClick={() => setConfirmation(null)}>Keep playing</button>
      <button type="button" className="btn block" onClick={confirm}>{confirmation === 'restart' ? 'Start another run' : 'Discard and leave'}</button>
    </ContextDialog>}
  </div>;
}

function readSavedState(): { state: GameState | null; error: string } {
  try { return { state: loadState(), error: '' }; }
  catch (error) { return { state: null, error: error instanceof Error && 'code' in error ? String(error.code) : 'STORAGE_UNREADABLE' }; }
}

export default function App() {
  const [save, setSave] = useState(readSavedState);
  const state = save.state;
  const appStateRef = useRef(state);
  const pendingSaveRef = useRef<GameState | null>(null);
  const [persistenceError, setPersistenceError] = useState('');
  const [recoveryAction, setRecoveryAction] = useState<'backup' | 'run' | null>(null);
  const [recoveryError, setRecoveryError] = useState('');
  const setState = useCallback((updater: StateUpdate): boolean => {
    if (!appStateRef.current) return false;
    if (pendingSaveRef.current) { setPersistenceError('Save not confirmed. Retry before starting.'); return false; }
    try {
      const next = typeof updater === 'function' ? updater(appStateRef.current) : updater;
      const session = next.activeRun ?? (next.battleCheckpoint ? next.runLedger[next.battleCheckpoint.runId]?.run : null);
      if (session && !runOwnedByState(next, session)) { setPersistenceError('Return to the wallet that started this run.'); return false; }
      pendingSaveRef.current = next;
      if (saveState(next) !== true) { setPersistenceError('Save not confirmed. Retry before starting.'); return false; }
      pendingSaveRef.current = null;
      appStateRef.current = next;
      setSave({ state: next, error: '' }); setPersistenceError('');
      return true;
    } catch { setPersistenceError('Save not confirmed. Retry before starting.'); return false; }
  }, []);

  useEffect(() => {
    const viewport = document.querySelector('meta[name="viewport"]');
    const previous = viewport?.getAttribute('content');
    viewport?.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover');
    return () => { if (previous != null) viewport?.setAttribute('content', previous); };
  }, []);

  const loaded = state !== null;
  useEffect(() => {
    if (loaded) setState(s => applyChallengeReset(applyDailyReset(s)));
  }, [loaded, setState]);

  function retryLoad() {
    const next = readSavedState();
    if (next.state) { appStateRef.current = next.state; setSave(next); setRecoveryError(''); }
    else { setSave(next); setRecoveryError('Still unavailable. Your existing save is unchanged.'); }
  }
  function retrySave(): GameState | false {
    const pending = pendingSaveRef.current;
    if (!pending) { setPersistenceError(''); return appStateRef.current ?? false; }
    try {
      if (retryStatePersistence(pending) !== true) return false;
      pendingSaveRef.current = null; appStateRef.current = pending;
      setSave({ state: pending, error: '' }); setPersistenceError('');
      return pending;
    } catch { setPersistenceError('Save not confirmed. Retry before starting.'); return false; }
  }
  function confirmRecovery() {
    try {
      const next = recoveryAction === 'backup' ? restoreStateBackup() : discardUnrecoverableRun();
      appStateRef.current = next; setSave({ state: next, error: '' }); setRecoveryAction(null); setRecoveryError('');
    } catch { setRecoveryError('Recovery could not be verified. Your saved profile has not been reset.'); setRecoveryAction(null); }
  }
  return <div className="app-preview">
    {state ? <Phone state={state} setState={setState} persistenceError={persistenceError} onRetrySave={retrySave}/> :
      <main className="screen recovery-screen"><h1>Save unavailable</h1><p>We could not read your progress. Your existing save has not been changed.</p>
        <button type="button" className="btn primary" onClick={retryLoad}>Retry</button>
        {save.error !== 'STORAGE_UNREADABLE' && <button type="button" className="btn" onClick={() => setRecoveryAction('backup')}>Restore validated backup</button>}
        {save.error === 'CHECKPOINT_RECOVERY_REQUIRED' && <button type="button" className="btn" onClick={() => setRecoveryAction('run')}>Discard unavailable run</button>}
        {recoveryError && <p role="alert">{recoveryError}</p>}
      </main>}
    {recoveryAction && <ContextDialog title={recoveryAction === 'backup' ? 'Restore backup?' : 'Discard unavailable run?'} onClose={() => setRecoveryAction(null)}>
      <p>{recoveryAction === 'backup' ? 'Only a validated backup can be restored. The current unreadable save is archived first.' : 'Discard only the unrecoverable battle, without refunding its admission. Keep your balances and inventory.'}</p>
      <button type="button" className="btn primary block" onClick={() => setRecoveryAction(null)}>Cancel</button>
      <button type="button" className="btn block" onClick={confirmRecovery}>Confirm recovery</button>
    </ContextDialog>}
  </div>;
}
