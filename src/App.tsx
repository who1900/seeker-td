import { useState, useEffect, useRef } from 'react';
import { loadState, saveState, GameState, applyDailyReset, applyChallengeReset } from './state/store';
import { GameEx } from './game/Game';
import { HomeScreen } from './screens/HomeScreen';
import { WalletScreen } from './screens/WalletScreen';
import { ShopScreen } from './screens/ShopScreen';
import { LeaderboardScreen } from './screens/LeaderboardScreen';
import { ChallengesScreen } from './screens/ChallengesScreen';
import { ReferralScreen } from './screens/ReferralScreen';
import { DailyBonusScreen } from './screens/DailyBonusScreen';
import { Paywall } from './screens/Paywall';
import { RunSetupScreen } from './screens/RunSetupScreen';
import { admitRun, abandonRun, continueRun } from './state/runs';
import type { RunConfig, RunSession } from './state/runs';

// Variants fixed per spec:
// homeVariant=1 (iso hero), shopVariant=0 (iso pedestal grid),
// lbVariant=1 (podium), hudVariant=0 (editorial strip)
const HOME_VARIANT = 1;
const SHOP_VARIANT = 0;
const LB_VARIANT = 1;
const HUD_VARIANT = 0;

type Screen = 'home' | 'setup' | 'game' | 'wallet' | 'shop' | 'leaderboard' | 'challenges' | 'referral' | 'bonus' | 'paywall';

function Phone({ state, setState }: { state: GameState; setState: (u: any) => void }) {
  const [screen, setScreen] = useState<Screen>('home');
  const [run, setRun] = useState<RunSession | null>(null);
  const [admissionError, setAdmissionError] = useState('');
  const admittingRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  function updateState(updater: ((s: GameState) => GameState) | GameState) {
    const next = typeof updater === 'function' ? updater(stateRef.current) : updater;
    stateRef.current = next;
    setState(next);
  }

  function startRun(config: RunConfig) {
    if (admittingRef.current) return;
    admittingRef.current = true;
    const current = stateRef.current.activeRun ? abandonRun(stateRef.current, stateRef.current.activeRun) : stateRef.current;
    const admitted = admitRun(current, config);
    stateRef.current = admitted.state;
    setState(admitted.state);
    if (admitted.run) { setRun(admitted.run); setAdmissionError(''); setScreen('game'); }
    else { setAdmissionError('Run not admitted. Practice is unlimited; Standard/Ranked require a free or paid run.'); setScreen('setup'); }
    queueMicrotask(() => { admittingRef.current = false; });
  }

  function nav(to: string) {
    if (to === 'game') { setAdmissionError(''); setScreen('setup'); return; }
    setScreen(to as Screen);
  }

  const common = { state, setState: updateState, nav };

  let content: React.ReactNode = null;
  if (screen === 'home')        content = <HomeScreen {...common} variant={HOME_VARIANT}/>;
  else if (screen === 'setup') content = <RunSetupScreen onBegin={startRun} onBack={()=>nav('home')} error={admissionError}/>;
  else if (screen === 'game' && run) content = <GameEx key={run.id} run={run} onRestart={()=>startRun(run.config)} onContinue={() => {
    const continued = continueRun(stateRef.current, run);
    updateState(continued.state);
    return continued.run !== null;
  }} state={state} setState={updateState} hudVariant={HUD_VARIANT} onExit={() => {
    updateState(s => abandonRun(s, run)); setRun(null); nav('home');
  }}/>;
  else if (screen === 'wallet') content = <WalletScreen {...common}/>;
  else if (screen === 'shop')   content = <ShopScreen {...common} variant={SHOP_VARIANT}/>;
  else if (screen === 'leaderboard') content = <LeaderboardScreen {...common} variant={LB_VARIANT}/>;
  else if (screen === 'challenges')  content = <ChallengesScreen {...common}/>;
  else if (screen === 'referral')    content = <ReferralScreen {...common}/>;
  else if (screen === 'bonus')       content = <DailyBonusScreen {...common}/>;
  else if (screen === 'paywall')     content = <Paywall {...common}/>;

  const tab = (id: Screen, label: string) => (
    <button type="button" className={`tab ${screen===id ? 'active':''}`} aria-current={screen===id ? 'page' : undefined} onClick={()=>nav(id)}>
      <span className="dot"/>
      <span>{label}</span>
    </button>
  );

  return (
    <div className="app-shell">
      <div key={screen} className={`app-content ${screen === 'game' ? 'app-content-game' : 'app-content-menu'}`}>
        {content}
      </div>
      {screen !== 'game' && (
        <nav className="tabbar" aria-label="Main navigation">
          {tab('home','Play')}
          {tab('challenges','Tasks')}
          {tab('shop','Armory')}
          {tab('leaderboard','Board')}
          {tab('wallet','Wallet')}
        </nav>
      )}
    </div>
  );
}

export default function App() {
  const [state, _setState] = useState<GameState>(() => {
    const loaded = loadState();
    return loaded.activeRun ? abandonRun(loaded, loaded.activeRun) : loaded;
  });
  const appStateRef = useRef(state);

  useEffect(() => {
    const viewport = document.querySelector('meta[name="viewport"]');
    const previous = viewport?.getAttribute('content');
    viewport?.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover');
    return () => {
      if (previous !== null && previous !== undefined) viewport?.setAttribute('content', previous);
    };
  }, []);

  const setState = (updater: ((s: GameState) => GameState) | GameState) => {
    const next = typeof updater === 'function' ? updater(appStateRef.current) : updater;
    appStateRef.current = next;
    saveState(next);
    _setState(next);
  };

  // B. Apply daily reset on mount (resets dailyFreeLeft if it's a new day)
  // Also reset challenge progress if it's a new day.
  useEffect(() => {
    setState((s: GameState) => applyChallengeReset(applyDailyReset(s)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app-preview">
      <Phone state={state} setState={setState}/>
    </div>
  );
}
