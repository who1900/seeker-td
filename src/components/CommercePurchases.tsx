import { useEffect, useRef, useState } from 'react';
import type { GameState } from '../state/store';
import { applyScopedCommerceReceipt, commerceAccountKey, formatAtomic, switchCommerceAccount, throwIfCancelled } from '../services/commerce';
import type { CommerceCatalog, CommerceClient, CommerceCurrency, CommerceQuote, CommerceReceipt, CommerceWalletTransport,
  PendingCommercePurchase, PreparedCommercePurchase } from '../services/commerce';
import { commerceFirebaseUid, commerceRuntimeAvailability, getCommerceClient, getCommerceWalletTransport, subscribeCommerceIdentity } from '../services/commerceRuntime';
import './commerce.css';

interface Props {
  state: GameState;
  setState: (update: (state: GameState) => GameState) => boolean | void;
  onComplete?: (receipt: CommerceReceipt) => void;
  kind: 'runs' | 'std';
  client?: CommerceClient;
  transport?: CommerceWalletTransport;
  getUid?: () => Promise<string | null>;
  initialCatalog?: CommerceCatalog;
  showNetwork?: boolean;
}
type Checkout = { quote: CommerceQuote; prepared: PreparedCommercePurchase; uid: string };
export function commerceErrorMessage(error: unknown, context: 'purchase' | 'wallet' = 'purchase'): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/cancel|reject|declin/i.test(message)) return 'Cancelled';
  if (/not enough|insufficient/i.test(message)) return /SKR/i.test(message) ? 'Not enough SKR.' : 'Not enough SOL.';
  if (/timeout|timed out|deadline|network|offline|fetch/i.test(message)) return context === 'purchase'
    ? 'Connection lost. Check status.' : 'Connection lost. Try again.';
  if (/expired|blockhash/i.test(message)) return context === 'purchase' ? 'Price expired. Choose a pack again.' : 'Reconnect your wallet.';
  if (/account changed|original purchase account|original wallet/i.test(message)) return 'Reconnect the purchase wallet.';
  if (/Firebase|sign in|session/i.test(message)) return 'Sign in again.';
  if (/ownership|wallet proof|challenge|expected payer/i.test(message)) return 'Verify your wallet and try again.';
  if (/wallet.*found|install|Android|iOS/i.test(message)) return 'Open a Solana wallet and reconnect.';
  if (/locked|mainnet|config|unavailable|unapproved|catalog|not provisioned/i.test(message)) return 'Purchases unavailable';
  return context === 'purchase' ? 'Could not complete purchase. Check status.' : 'Wallet unavailable. Try again.';
}
export function CommerceAddress({ address, label }: { address: string; label: string }) {
  const [copyState, setCopyState] = useState('Copy');
  async function copy() {
    try { await navigator.clipboard.writeText(address); setCopyState('Copied'); }
    catch { setCopyState('Copy failed'); }
  }
  return <div className="commerce-address-row">
    <span className="commerce-address" title={address} aria-label={`${label}: ${address}`}>{address.slice(0, 4)}...{address.slice(-4)}</span>
    <button type="button" className="commerce-button commerce-copy" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => void copy()}>{copyState}</button>
  </div>;
}
export function CommerceNetworkBadge() {
  return <span className="commerce-network">Devnet</span>;
}
export function CommerceCurrencySelector({ currency, onChange, disabled }: {
  currency: CommerceCurrency; onChange: (currency: CommerceCurrency) => void; disabled: boolean;
}) {
  return <div className="commerce-currencies" role="group" aria-label="Payment currency">
    {(['SOL', 'SKR'] as const).map(value => <button type="button" key={value} className="commerce-button"
      aria-pressed={currency === value} disabled={disabled} onClick={() => onChange(value)}>{value}</button>)}
  </div>;
}
export function CommercePurchases({ state, setState, kind, onComplete, client: suppliedClient, transport, getUid = commerceFirebaseUid, initialCatalog, showNetwork = true }: Props) {
  const availability = suppliedClient ? { enabled: true, reason: '' } : commerceRuntimeAvailability();
  const [catalog, setCatalog] = useState<CommerceCatalog | null>(initialCatalog ?? null);
  const [currency, setCurrency] = useState<CommerceCurrency>('SOL');
  const [phase, setPhase] = useState<'idle' | 'loading' | 'review' | 'signing' | 'pending' | 'success'>('idle');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [pending, setPending] = useState<PendingCommercePurchase[]>([]);
  const [scope, setScope] = useState<string | null>(null);
  const [identityVersion, setIdentityVersion] = useState(0);
  const active = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const completed = useRef(new Set<string>());
  const latest = useRef(state);
  latest.current = state;
  const client = () => suppliedClient ?? getCommerceClient();
  const busy = phase === 'loading' || phase === 'signing';
  const payer = state.walletConnected ? state.walletAddr : '';

  useEffect(() => {
    if (suppliedClient || typeof subscribeCommerceIdentity !== 'function') return;
    return subscribeCommerceIdentity(() => {
      active.current?.abort(); epoch.current++;
      setCheckout(null); setScope(null);
      setIdentityVersion(value => value + 1);
    });
  }, [suppliedClient]);

  useEffect(() => {
    const controller = new AbortController();
    const version = ++epoch.current;
    active.current?.abort();
    active.current = controller;
    setCheckout(null); setScope(null); setPending([]); setError(''); setMessage(''); setPhase('idle');
    if (!availability.enabled) { active.current = null; return () => controller.abort(); }
    void (async () => {
      try {
        const uid = await getUid();
        throwIfCancelled(controller.signal);
        if (version !== epoch.current) return;
        if (uid && payer) {
          if (setState(s => switchCommerceAccount(s, uid, payer)) === false) throw new Error('Could not persist purchase account.');
          setScope(commerceAccountKey(uid, payer));
          setPending(client().pending().filter(p => p.uid === uid && p.quote.payer === payer
            && !(latest.current.commerceAccount === commerceAccountKey(uid, payer) && latest.current.commerceQuoteIds?.includes(p.quote.id))));
        } else {
          if (setState(s => switchCommerceAccount(s, null, null)) === false) throw new Error('Could not persist guest account.');
        }
        setPhase('loading');
        const loaded = await client().catalog(controller.signal);
        throwIfCancelled(controller.signal);
        if (version === epoch.current) { setCatalog(loaded); setPhase('idle'); }
      } catch (e) {
        if (!controller.signal.aborted && version === epoch.current) {
          setError(commerceErrorMessage(e)); setPhase('idle');
        }
      } finally {
        if (active.current === controller) active.current = null;
      }
    })();
    return () => { controller.abort(); active.current?.abort(); epoch.current++; };
  }, [payer, state.commerceAccount, identityVersion, availability.enabled, suppliedClient, getUid]);

  async function run(task: (signal: AbortSignal, version: number) => Promise<void>, signing = false) {
    if (active.current) return;
    const controller = new AbortController(), version = epoch.current;
    active.current = controller;
    setError(''); setMessage(''); setPhase(signing ? 'signing' : 'loading');
    try { await task(controller.signal, version); }
    catch (e) {
      if (version === epoch.current) {
        setError(commerceErrorMessage(e));
        setCheckout(null); setPhase('idle');
      }
    } finally {
      if (active.current === controller) active.current = null;
      if (version === epoch.current && payer) {
        try {
          const uid = await getUid();
          if (version === epoch.current && uid && latest.current.walletConnected && latest.current.walletAddr === payer) setPending(client().pending().filter(p => p.uid === uid
            && p.quote.payer === payer && !(latest.current.commerceAccount === commerceAccountKey(uid, payer)
              && latest.current.commerceQuoteIds?.includes(p.quote.id))));
        } catch { /* Preserve recovery state when journal access fails. */ }
      }
    }
  }
  async function requestQuote(productId: string) {
    await run(async (signal, version) => {
      const uid = await getUid();
      throwIfCancelled(signal);
      if (!uid || !payer || commerceAccountKey(uid, payer) !== scope) throw new Error('Sign in and select the original wallet first.');
      const q = await client().quote(productId, currency, payer, signal);
      const prepared = await (transport ?? getCommerceWalletTransport()).prepare(q, signal);
      if (await getUid() !== uid || !latest.current.walletConnected || latest.current.walletAddr !== payer
        || latest.current.commerceAccount !== commerceAccountKey(uid, payer)) throw new Error('Account changed. Request a new quote.');
      throwIfCancelled(signal);
      if (version === epoch.current) { setCheckout({ quote: q, prepared, uid }); setPhase('review'); }
    });
  }
  async function applyReceipt(receipt: CommerceReceipt, uid: string, signal: AbortSignal, version: number): Promise<void> {
    if (await getUid() !== uid) throw new Error('Account changed. Check pending purchases.');
    throwIfCancelled(signal);
    const account = commerceAccountKey(uid, receipt.payer);
    if (version !== epoch.current || !latest.current.walletConnected || latest.current.walletAddr !== receipt.payer
      || latest.current.commerceAccount !== account) throw new Error('Account changed. Check pending purchases.');
    let applied: GameState | undefined;
    const persisted = setState(s => {
      applied = undefined;
      if (!s.walletConnected || s.walletAddr !== receipt.payer || s.commerceAccount !== account) return s;
      const next = applyScopedCommerceReceipt(s, receipt, uid);
      if (next.commerceReceiptIds?.includes(receipt.id) && next.commerceQuoteIds?.includes(receipt.quoteId)
        && next.commerceSignatures?.includes(receipt.signature)) applied = next;
      return next;
    });
    if (persisted === false || !applied) throw new Error('Could not persist purchase. Check pending purchases.');
    latest.current = applied;
    if (await getUid() !== uid) throw new Error('Account changed. Check pending purchases.');
    throwIfCancelled(signal);
    if (version !== epoch.current || latest.current.commerceAccount !== account || !latest.current.walletConnected
      || latest.current.walletAddr !== receipt.payer) throw new Error('Account changed. Check pending purchases.');
    const key = `${account}:${receipt.quoteId}`;
    if (!completed.current.has(key)) {
      completed.current.add(key);
      if (kind === 'runs' ? receipt.runs > 0 : receipt.std > 0) onComplete?.(receipt);
    }
  }
  async function approve() {
    if (!checkout) return;
    const selected = checkout;
    await run(async (signal, version) => {
      if (await getUid() !== selected.uid || latest.current.walletAddr !== selected.quote.payer
        || !latest.current.walletConnected) throw new Error('Account changed. Request a new quote.');
      const receipt = await client().purchase(selected.quote, selected.prepared, signal);
      throwIfCancelled(signal);
      if (version !== epoch.current) return;
      setCheckout(null);
      if (receipt) {
        await applyReceipt(receipt, selected.uid, signal, version);
        setPhase('success'); setMessage('Purchase complete');
      } else {
        setPhase('pending'); setMessage('Payment pending');
      }
    }, true);
  }
  async function checkReceipts() {
    await run(async (signal, version) => {
      const uid = await getUid();
      if (!uid || !payer || commerceAccountKey(uid, payer) !== scope) throw new Error('Sign in to the original purchase account.');
      let outstanding = false;
      let confirmed = false;
      for (const entry of client().pending().filter(p => p.uid === uid && p.quote.payer === payer)) {
        throwIfCancelled(signal);
        const receipt = await client().reconcile(entry, signal);
        if (version !== epoch.current) return;
        if (receipt) { await applyReceipt(receipt, uid, signal, version); confirmed = true; }
        else outstanding = true;
      }
      setPhase(outstanding ? 'pending' : confirmed ? 'success' : 'idle');
      setMessage(outstanding ? 'Payment pending' : confirmed ? 'Purchase complete' : '');
    });
  }
  function cancel() {
    active.current?.abort(); setCheckout(null); setPhase('idle');
    setMessage('Cancelled');
  }
  const products = catalog?.enabled ? catalog.products.filter(p => kind === 'runs' ? p.runs > 0 : p.std > 0) : [];
  const enabled = availability.enabled && catalog?.enabled === true && !!scope && scope === state.commerceAccount;
  return <section className="commerce" aria-label={kind === 'runs' ? 'Buy extra runs' : 'Buy STD packs'} aria-busy={busy}>
    <div className="commerce-section-header"><h2>{kind === 'runs' ? 'Extra runs' : 'STD packs'}</h2>{showNetwork && <CommerceNetworkBadge />}</div>
    <CommerceCurrencySelector currency={currency} disabled={busy || !!checkout} onChange={setCurrency} />
    {!error && (!availability.enabled || catalog?.enabled === false || (!catalog && !busy)) && <p role="status">Purchases unavailable</p>}
    {availability.enabled && catalog?.enabled && !payer && <p role="status">Connect wallet to buy.</p>}
    {phase === 'loading' && <p role="status">Loading…</p>}
    {error && <p role="alert" className="commerce-error">{error}</p>}
    {message && !(message === 'Payment pending' && pending.length > 0) && <p role="status">{message}</p>}
    {!products.length && catalog?.enabled && <p>No packs available.</p>}
    <div className="commerce-products">
      {products.map(product => {
        const price = product.prices.find(p => p.currency === currency);
        return <article key={product.id} className="commerce-product">
          <strong>{product.runs || product.std} {product.runs ? product.runs === 1 ? 'run' : 'runs' : 'STD'}</strong>
          <button type="button" className="commerce-button commerce-primary" disabled={!enabled || !price || busy || !!checkout || pending.length > 0}
            onClick={() => void requestQuote(product.id)}>{price ? `Buy ${formatAtomic(price.amount, price.decimals)} ${currency}` : 'Unavailable'}</button>
        </article>;
      })}
    </div>
    {checkout && <div className="commerce-review" aria-label="Review purchase">
      <div className="commerce-section-header"><h3>Confirm purchase</h3><CommerceNetworkBadge /></div>
      <dl className="commerce-costs">
        <div><dt>{checkout.quote.runs || checkout.quote.std} {checkout.quote.runs ? checkout.quote.runs === 1 ? 'run' : 'runs' : 'STD'}</dt>
          <dd>{formatAtomic(checkout.quote.amount, checkout.quote.decimals)} {checkout.quote.currency}</dd></div>
        <div><dt>Fee</dt><dd>{formatAtomic(checkout.prepared.feeLamports, 9)} SOL</dd></div>
        {BigInt(checkout.prepared.rentLamports) > 0n && <div><dt>Account rent</dt><dd>{formatAtomic(checkout.prepared.rentLamports, 9)} SOL</dd></div>}
        <div><dt>Total</dt><dd>{checkout.quote.currency === 'SKR' && `${formatAtomic(checkout.quote.amount, checkout.quote.decimals)} SKR + `}
          {formatAtomic((BigInt(checkout.prepared.feeLamports) + BigInt(checkout.prepared.rentLamports)
            + (checkout.quote.currency === 'SOL' ? BigInt(checkout.quote.amount) : 0n)).toString(), 9)} SOL</dd></div>
      </dl>
      <div className="commerce-recipient"><span>Recipient</span><CommerceAddress key={checkout.quote.recipient} address={checkout.quote.recipient} label="Recipient" /></div>
      <button type="button" className="commerce-button commerce-primary" disabled={busy} onClick={() => void approve()}>Confirm</button>
    </div>}
    {phase === 'signing' && <p role="status">Approve in wallet…</p>}
    {(busy || checkout) && <button type="button" className="commerce-button" onClick={cancel}>Cancel</button>}
    {pending.length > 0 && <div className="commerce-review"><h3>Payment pending</h3>
      {pending.map(entry => <a key={entry.quote.id} className="commerce-transaction" target="_blank" rel="noreferrer"
        href={`https://explorer.solana.com/tx/${entry.signature}?cluster=devnet`}>View transaction</a>)}
      <button type="button" className="commerce-button" disabled={busy} onClick={() => void checkReceipts()}>Check status</button>
    </div>}
    {availability.enabled && !busy && !checkout && <button type="button" className="commerce-button" onClick={() => void run(async (signal) => {
      setCatalog(await client().catalog(signal)); setPhase('idle');
    })}>Refresh</button>}
  </section>;
}
