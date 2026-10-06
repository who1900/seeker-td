import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const root = document.getElementById('root');
if (!root) throw new Error('No #root element');

const reactRoot = createRoot(root);

async function mountEntry() {
  reactRoot.render(<div className="app-preview"><main className="app-shell" aria-busy="true"><p role="status">Loading application…</p></main></div>);
  try {
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('visualQa') === '1') {
      const { default: VisualQa } = await import('./dev/VisualQa');
      reactRoot.render(<StrictMode><VisualQa /></StrictMode>);
      return;
    }
    const [{ default: App }, { SolanaProvider }] = await Promise.all([import('./App'), import('./SolanaProvider')]);
    reactRoot.render(<StrictMode><SolanaProvider><App /></SolanaProvider></StrictMode>);
  } catch {
    reactRoot.render(<div className="app-preview"><main className="app-shell">
      <p role="alert">Could not load the application. Retry or reload this page.</p>
      <button type="button" onClick={() => { void mountEntry(); }} style={{ minWidth: 48, minHeight: 48 }}>Retry</button>
    </main></div>);
  }
}

void mountEntry();
