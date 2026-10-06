import { Component, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { GameEx } from '../game/Game';
import type { GameFrameSnapshot } from '../game/Game';
import { TOWERS, ENEMIES } from '../game/data';
import type { BattleState, TowerId, EnemyId } from '../game/types';
import { usePaperAssets } from '../game/paperAssets';
import { DEFAULT_STATE } from '../state/store';
import type { GameState } from '../state/store';
import type { RunSession } from '../state/runs';
import { buildVisualQaFixture, QA_TOWER_IDS, QA_ENEMY_IDS, QA_FIXTURE_DESCRIPTION } from '../game/visualQaFixtures';
import type { QaDensity } from '../game/visualQaFixtures';
import './visualQa.css';
import MobMotionReview from './MobMotionReview';
import TowerStageComparison from './TowerStageComparison';

type Selection = { towerId: TowerId; enemyId: EnemyId; level: number; density: QaDensity };
const defaults: Selection = { towerId: 'canon', enemyId: 'soldier', level: 0, density: 'spaced' };
const homeHref = import.meta.env.BASE_URL;
const run: RunSession = { id: 'dev-visual-qa', startedAt: 0, debit: 'none',
  config: { access: 'practice', mode: 'endless', waveLimit: 10, durationMinutes: 5 } };

export function createVisualQaAppState(): GameState {
  return { ...structuredClone(DEFAULT_STATE), tokens: 0, sol: 0, paidRuns: 0, dailyFreeLeft: 0,
    prizePool: 0, monthlyRank: 0, walletConnected: false, walletAddr: '', soundEnabled: false,
    activeRun: null, runLedger: {}, localScores: [], challengeProgress: {}, challengeClaimed: {} };
}

function readSelection(): Selection {
  const params = new URLSearchParams(window.location.search);
  const towerId = params.get('qaTower');
  const enemyId = params.get('qaEnemy');
  const level = Number(params.get('qaLevel') ?? 0);
  const tower = QA_TOWER_IDS.includes(towerId as TowerId) ? towerId as TowerId : defaults.towerId;
  const maxLevel = TOWERS[tower].maxLevel;
  return { towerId: tower, enemyId: QA_ENEMY_IDS.includes(enemyId as EnemyId) ? enemyId as EnemyId : defaults.enemyId,
    level: Number.isInteger(level) && level >= 0 && level < maxLevel ? level : 0,
    density: params.get('qaDensity') === 'cluster' ? 'cluster' : 'spaced' };
}

class SceneBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <section className="visual-qa-setup" role="alert">
      <h1>Could not render this scene</h1><p>Reset the local fixture and try again.</p>
      <button type="button" onClick={this.props.onRetry}>Retry scene</button><a href={homeHref}>Home</a>
    </section> : this.props.children;
  }
}

export default function VisualQa() {
  const paperStatus = usePaperAssets();
  const [selection, setSelection] = useState(readSelection);
  const [appState, setAppState] = useState(createVisualQaAppState);
  const [scene, setScene] = useState<BattleState | null>(null);
  const [sceneKey, setSceneKey] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  const [empty, setEmpty] = useState(false);
  const [allowFallback, setAllowFallback] = useState(false);
  const [mobReviewOpen, setMobReviewOpen] = useState(false);
  const [towerStageOpen, setTowerStageOpen] = useState(false);
  const snapshot = useRef<GameFrameSnapshot | null>(null);
  const maxLevel = TOWERS[selection.towerId].maxLevel;
  const choicesEmpty = QA_TOWER_IDS.length === 0 || QA_ENEMY_IDS.length === 0;
  const assetsLoading = paperStatus === 'loading';
  const assetsFailed = !assetsLoading && paperStatus !== 'ready';

  function openScene() {
    setError(''); setEmpty(false);
    try {
      const next = buildVisualQaFixture(selection.towerId, selection.level, selection.enemyId, selection.density);
      if (!next.towers.length || !next.enemies.length) { setEmpty(true); return; }
      if (next.gridW !== 12 || next.gridH !== 21) throw new Error('Fixture dimensions do not match the game renderer');
      setScene(next); setSceneKey(key => key + 1); setAppState(createVisualQaAppState());
      snapshot.current = null; setPlaying(true);
      const url = new URL(window.location.href);
      url.searchParams.set('qaTower', selection.towerId); url.searchParams.set('qaEnemy', selection.enemyId);
      url.searchParams.set('qaLevel', String(selection.level));
      url.searchParams.set('qaDensity', selection.density);
      window.history.replaceState(null, '', url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create this local fixture');
      setPlaying(false);
    }
  }

  function reset() {
    setSelection({ ...defaults }); setScene(null); setPlaying(false); setError(''); setEmpty(false);
    setAppState(createVisualQaAppState()); snapshot.current = null;
    const url = new URL(window.location.href);
    for (const key of ['qaTower', 'qaEnemy', 'qaLevel', 'qaDensity']) url.searchParams.delete(key);
    window.history.replaceState(null, '', url);
  }

  return <div className="app-preview visual-qa"><main className="app-shell">
    {playing && scene ? <div className="app-content app-content-game">
      <SceneBoundary key={sceneKey} onRetry={openScene}>
        <GameEx run={run} state={appState} setState={setAppState} initialGameFactory={() => structuredClone(scene)}
          onFrameSnapshot={frame => { snapshot.current = frame; }} onRestart={openScene} onContinue={() => true}
          onExit={() => setPlaying(false)} />
      </SceneBoundary>
    </div> : <section className="visual-qa-setup">
      <header><p className="mono">DEV ONLY · VISUAL QA</p><h1>Real game scenes</h1>
        <p>Ephemeral Practice. No wallet, saved results or rewards. Select a scene, then use the normal game controls and inspector. Exit returns here.</p>
        <p>Fixtures use local test gold and inflated enemy HP to sustain real attacks.</p>
        <details><summary>Fixture adaptations</summary><p>{QA_FIXTURE_DESCRIPTION}</p></details></header>
      <form onSubmit={event => { event.preventDefault(); openScene(); }}>
        <fieldset><legend>Scene settings</legend>
          <label htmlFor="qa-tower">Tower</label>
          <select id="qa-tower" value={selection.towerId} onChange={event => setSelection(s => ({ ...s, towerId: event.target.value as TowerId, level: 0 }))}>
            {QA_TOWER_IDS.map(id => <option key={id} value={id}>{TOWERS[id].name}</option>)}
          </select>
          <label htmlFor="qa-enemy">Enemy</label>
          <select id="qa-enemy" value={selection.enemyId} onChange={event => setSelection(s => ({ ...s, enemyId: event.target.value as EnemyId }))}>
            {QA_ENEMY_IDS.map(id => <option key={id} value={id}>{ENEMIES[id].name}</option>)}
          </select>
          <label htmlFor="qa-level">Tower level</label>
          <select id="qa-level" value={selection.level} onChange={event => setSelection(s => ({ ...s, level: Number(event.target.value) }))}>
            {Array.from({ length: maxLevel }, (_, level) => <option key={level} value={level}>Level {level + 1} / {maxLevel}</option>)}
          </select>
          <label htmlFor="qa-density">Density</label>
          <select id="qa-density" value={selection.density} onChange={event => setSelection(s => ({ ...s, density: event.target.value as Selection['density'] }))}>
            <option value="spaced">Spaced · model review</option>
            <option value="cluster">Cluster · chain/splash review</option>
          </select>
        </fieldset>
        {assetsLoading && <div aria-busy="true"><p role="status">Loading paper assets…</p><div className="visual-qa-loading" aria-hidden="true" /></div>}
        {assetsFailed && <section role="alert"><h2>Paper assets unavailable</h2>
          <p>The real game fallback renderer is available. Reload to retry the paper asset loader.</p>
          <div className="visual-qa-actions"><button type="button" onClick={() => window.location.reload()}>Retry assets</button>
            <button type="button" onClick={() => setAllowFallback(true)} disabled={allowFallback}>Use fallback</button></div>
          <details><summary>Asset error details</summary><p>{paperStatus}</p></details></section>}
        {paperStatus === 'ready' && <p role="status">Paper assets ready. Scenes use the actual GameEx renderer.</p>}
        {error && <section role="alert"><h2>Could not create scene</h2><p>{error}</p><button type="button" onClick={openScene}>Retry scene</button></section>}
        {empty && <section role="status"><h2>No scene objects</h2><p>This fixture has no towers or enemies. Reset settings or select another scene.</p></section>}
        {choicesEmpty && <p role="status">No fixture choices available. Reload to retry the DEV fixture module.</p>}
        <button type="submit" className="visual-qa-primary" disabled={choicesEmpty || assetsLoading || assetsFailed && !allowFallback}>Open scene</button>
      </form>
      <details onToggle={event => setMobReviewOpen(event.currentTarget.open)}><summary>Mob motion review · all 11 models</summary>
        <MobMotionReview expanded={mobReviewOpen} />
      </details>
      <details onToggle={event => setTowerStageOpen(event.currentTarget.open)}><summary>RocketLauncher late-stage comparison · PoC</summary>
        <TowerStageComparison expanded={towerStageOpen} />
      </details>
      {snapshot.current && <section><h2>Last rendered frame</h2><output className="mono">
        {snapshot.current.towers} towers · {snapshot.current.enemies} enemies · {snapshot.current.projectiles} projectiles · {snapshot.current.effects} effects<br />
        {snapshot.current.shots} shots · {snapshot.current.mines} mines · {snapshot.current.gluePatches} glue patches<br />
        Canvas {snapshot.current.canvasWidth.toFixed(2)} × {snapshot.current.canvasHeight.toFixed(2)} · {snapshot.current.time.toFixed(2)}s · {snapshot.current.paused ? 'paused' : 'running'}<br />
        Paper loader: {snapshot.current.paperStatus === 'ready' ? 'ready' : snapshot.current.paperStatus === 'loading' ? 'loading' : 'fallback active'}
      </output></section>}
      <nav className="visual-qa-actions" aria-label="Visual QA toolbar"><button type="button" onClick={reset}>Reset</button><a href={homeHref}>Home</a></nav>
    </section>}
  </main></div>;
}
