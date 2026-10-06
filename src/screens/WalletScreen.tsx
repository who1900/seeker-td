import { useEffect, useRef, useState } from 'react';
import type { GameState } from '../state/store';
import { connectWallet, disconnectWallet, getSkrBalance, getSolBalance, getWalletCluster, signWalletMessage } from '../wallet';
import { CommerceAddress, CommercePurchases, commerceErrorMessage } from '../components/CommercePurchases';
import { commerceFirebaseUid, commerceRuntimeAvailability, getCommerceClient } from '../services/commerceRuntime';
import { switchCommerceAccount } from '../services/commerce';

interface Props { state: GameState; setState: (u: any) => void; nav: (s: string) => void; }
export function compactWalletBalance(value: string | null): string {
  if (value === null) return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return '—';
  if (amount > 0 && amount < 0.0001) return '<0.0001';
  return amount.toLocaleString('en-US', { useGrouping: false, notation: amount >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: amount >= 100 ? 2 : 4 });
}
export function WalletScreen({ state, setState, nav }: Props) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [proof, setProof] = useState('');
  const [sol, setSol] = useState<string | null>(null), [skr, setSkr] = useState<string | null>(null);
  const [balanceState, setBalanceState] = useState('');
  const operation = useRef<AbortController | null>(null), generation = useRef(0);
  let cluster = 'unconfigured';
  try { cluster = getWalletCluster(); } catch { /* Display configuration errors when an action is requested. */ }
  const availability = commerceRuntimeAvailability();
  useEffect(() => {
    generation.current++; operation.current?.abort(); setProof(''); setSol(null); setSkr(null);
    return () => { generation.current++; operation.current?.abort(); };
  }, [state.walletAddr, state.walletConnected]);
  async function act(task: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError('');
    try { await task(controller.signal); }
    catch (e) { if (!controller.signal.aborted) setError(commerceErrorMessage(e, 'wallet')); }
    finally { if (operation.current === controller) operation.current = null; setBusy(false); }
  }
  async function connect() {
    await act(async signal => {
      const uid = await commerceFirebaseUid();
      const selected = await connectWallet({ signal });
      if (signal.aborted) return;
      setState((s: GameState) => ({ ...switchCommerceAccount(s, uid, selected.address), walletConnected: true, walletAddr: selected.address }));
    });
  }
  async function verify() {
    await act(async signal => {
      await getCommerceClient().bindWallet(state.walletAddr,
        (message, payer) => signWalletMessage(message, payer, { signal }), signal);
      if (!signal.aborted) setProof('Wallet verified');
    });
  }
  async function balances(signal: AbortSignal) {
    const version = generation.current;
    setBalanceState('');
    const result = await Promise.allSettled([getSolBalance(state.walletAddr), getSkrBalance(state.walletAddr)]);
    if (signal.aborted || version !== generation.current) return;
    setSol(result[0].status === 'fulfilled' ? String(result[0].value) : null);
    setSkr(result[1].status === 'fulfilled' ? result[1].value.decimal : null);
    setBalanceState(result.every(r => r.status === 'fulfilled') ? '' : 'Some balances unavailable. Refresh again.');
  }
  async function disconnect() {
    operation.current?.abort(); generation.current++;
    setState((s: GameState) => ({ ...switchCommerceAccount(s, null, null), walletConnected: false, walletAddr: '', sol: 0 }));
    setProof(''); setSol(null); setSkr(null);
    try { await disconnectWallet(); } catch { setError('Reconnect your wallet.'); }
  }
  return <div className="screen commerce-screen">
    <header className="commerce-header"><button type="button" className="commerce-button" onClick={() => nav('home')} aria-label="Back to home">←</button>
      <h1>Wallet</h1><span className="commerce-network">{cluster === 'devnet' ? 'Devnet' : cluster === 'testnet' ? 'Testnet' : cluster === 'mainnet-beta' ? 'Mainnet' : 'Offline'}</span></header>
    <section className="commerce-summary wallet-summary">
      {error && <p role="alert" className="commerce-error">{error}</p>}
      {proof && <p role="status">{proof}</p>}
      {state.walletConnected && state.walletAddr ? <>
        <CommerceAddress key={state.walletAddr} address={state.walletAddr} label="Wallet address" />
        <dl className="wallet-balances" aria-label="Balances">
          <div><dt>SOL</dt><dd title={sol === null ? 'Balance unavailable' : `${sol} SOL`} aria-label={sol === null ? 'SOL balance unavailable' : `${sol} SOL`}>{compactWalletBalance(sol)}</dd></div>
          <div><dt>SKR</dt><dd title={skr === null ? 'Balance unavailable' : `${skr} SKR`} aria-label={skr === null ? 'SKR balance unavailable' : `${skr} SKR`}>{compactWalletBalance(skr)}</dd></div>
          <div><dt>STD</dt><dd title={`${state.tokens} STD`} aria-label={`${state.tokens} STD`}>{compactWalletBalance(String(state.tokens))}</dd></div>
        </dl>
        {balanceState && <p role="status">{balanceState}</p>}
        <div className="commerce-actions">
          <button type="button" className="commerce-button" disabled={busy} onClick={() => void act(balances)}><span aria-hidden="true">↻</span> Refresh</button>
          <button type="button" className="commerce-button" onClick={() => void disconnect()}>Disconnect</button>
          {availability.enabled && <button type="button" className="commerce-button" disabled={busy} onClick={() => void verify()}>Verify wallet</button>}
        </div>
      </> : <button type="button" className="commerce-button commerce-primary" disabled={busy} onClick={() => void connect()}>Connect wallet</button>}
      {busy && <><p role="status">Waiting for wallet…</p><button type="button" className="commerce-button" onClick={() => { operation.current?.abort(); setProof('Cancelled'); }}>Cancel</button></>}
    </section>
    <CommercePurchases state={state} setState={setState} kind="runs" showNetwork={false} />
    <CommercePurchases state={state} setState={setState} kind="std" showNetwork={false} />
    <button type="button" className="commerce-button" onClick={() => nav('shop')}>Shop</button>
  </div>;
}
