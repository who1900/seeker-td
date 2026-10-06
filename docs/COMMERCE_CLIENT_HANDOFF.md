# Commerce client handoff — DEVNET pilot only

## Implemented

- New path: `commerce.ts` / `commerceWallet.ts` / `commerceRuntime.ts`; legacy `payments.ts` is unchanged.
- Paywall, Wallet and Shop use the server catalog and SOL/SKR selector. The client neither sets atomic prices nor converts USD.
- `VITE_COMMERCE_URL` is required: HTTPS without credentials/query/hash; redirects are denied. Firebase ID tokens are sent only as Bearer authorization.
- The only Firebase addition is `getFirebaseIdToken()`. The token UID separates local cache scopes; it is not proof of authorization.
- Shared wallet API: `getWalletCapabilities({signal})`, then `signWalletTransaction(unsigned.serialize(), payer, signal)`. The shared wallet mutex/reauthorization is not bypassed.
- DEVNET genesis, funded system payer, test SKR mint/classic Token Program owner/decimals, source and merchant ATA ownership/mint/state/balance, fee and simulation are checked before signing.
- The merchant ATA must be provisioned in advance. Checkout neither creates an ATA nor adds rent instructions. Only transfer + signer nonce memo; native/SPL amounts use bigint.
- Legacy/v0 selection follows wallet capabilities. The signed message/signature are verified; the signature is persisted before the single `sendRawTransaction(..., {maxRetries: 0, skipPreflight: false})`.
- Receipt reconciliation never signs or broadcasts. Confirmed receipt/quote/signature identities are applied once to the display cache; free runs and the pool are unchanged.
- STD/paidRuns/receipt ID caches are separated by Firebase UID + payer. A new scope starts with zero purchased credits; the guest scope is retained separately.
- `purchase()` checks the journal before calling the signing transport and again in synchronous `beforeBroadcast`, before the durable signature write. An unknown entry for the same UID + payer blocks a new quote; this scope guard does not block other UID/payer scopes. The same quote cannot be signed again, even after confirmation.
- Optional `confirmedReceipt` in an existing v1 entry is a durable acknowledgement of a validated server receipt. Only `{id,quoteId,signature,payer,runs,std,status}` is stored; the closed shape and every field are validated against the original quote/signature. `reconcile()` writes the acknowledgement after server validation, verifies the complete journal readback and only then returns the receipt for cache application.
- An acknowledgement permits the next new intent, not entitlement authorization. `pending()` retains both unknown and confirmed history; `reconcile()` still requests the server even when an acknowledgement exists. A crash after acknowledgement but before React cache application recovers through receipt reconciliation and an idempotent cache grant. Old v1 entries without acknowledgement remain unknown until successfully reconciled.

## Backend contracts

- The backend runs as standalone Node (`server/commerce-node.mjs`) on loopback behind a separately configured HTTPS proxy. Firebase Spark is retained; this path uses neither Blaze nor Firebase Functions deployment. Admin Auth/Firestore use host-managed ADC, without embedded credentials or emulator fallback. Creating these files does not prove that a live backend is configured.
- `GET /commerce/catalog`: `{enabled, reason: string|null, cluster:'devnet', genesisHash:string|null, recipient:string|null, products:[{id,title,runs,std,usdCents,prices:[{currency,amount:string,decimals,mint}]}]}`. Null recipient/genesis are allowed only in a locked catalog.
- `POST /commerce/quote`: `{productId,currency,payer}`. Response: the original 14 quote fields; ID is 32 hex characters, memo is `SEEKER:TD/commerce/v1/${id}`, and the signing window is at most 10 minutes.
- `POST /commerce/receipt`: `{quoteId,signature}`. Confirmation includes `{id,quoteId,signature,payer,runs,std,status:'confirmed'}`; the backend may echo other quote fields. Temporary errors leave the journal pending.
- `POST /identity/challenge`: `{wallet}` → `{challengeId,message,expiresAt}`.
- `POST /identity/complete`: `{challengeId,signature}` → `{uid,wallet,cluster}`.
- Signing proof validates exact canonical JSON and strict fields, purpose `SEEKER:TD/wallet-identity/v1`, the trusted Firebase project audience, `window.location.origin`, UID/payer/DEVNET/nonce and a fixed five-minute issuedAt→expiresAt interval.
- Capacitor is expected to use origin `https://localhost`. The backend must be configured for that origin; verify CORS/OPTIONS through actual HTTP integration. A custom origin must not bypass the signed proof policy.

## Pending/cancel risks and next steps

- Cancel/timeout before sign-only completes suppresses a late broadcast. Once HTTP/RPC broadcast has started, cancellation does not prove that the network rejected the transaction: check its receipt.
- A crash between the durable journal write and broadcast also leaves an unknown outcome. The client never resends: recovery uses receipt reconciliation only. The service guard, not just the UI, blocks a new payment for that UID/payer while the outcome is unknown; concurrent prepared quotes are checked again before the durable journal write. This was tested in one JS runtime sharing storage; atomic multi-tab/process locking is neither implemented nor claimed.
- Failed/dropped acknowledgement storage writes or failed readback do not return a receipt for display application; the unknown entry retains its block. Recovery requests the same receipt without new signing/broadcast. An acknowledgement neither deletes history nor creates a new server grant by itself.
- Journal `seekdef_commerce_pending_v1` retains every entry, including confirmed entries; the storage-wide limit of 256 remains fail-closed and is now also checked before signing. A separately reviewed terminal-status/tombstone/compaction protocol is required. Do not delete unknown or confirmed history based on a timer, quote expiry or user Cancel. This fix implements neither compaction nor terminal release.
- RPC/receipt failures, or a transaction that was never actually broadcast, may block a scope for a long time. Recovery needs server verification of terminal failure/expired blockhash, not another send button.
- Local GameState remains a mutable display/gameplay cache, not an authoritative purchased entitlement ledger. Receipts do populate local `paidRuns`/`tokens`; `src/state/runs.ts` spends local counters. Server `commerceBalances` are not decremented by those spends; server receipts/ledger are not integrated with authoritative gameplay admission/STD debits. Cache reset/reinstall require separate acceptance.
- An anonymous Firebase UID may change after reinstall; immutable UID/wallet binding is not migrated automatically. Reviewed account linking/recovery is required, not binding deletion or balance transfer based on a client UID.
- As reported by main, physical account connection was observed on 6 October 2026 and SOL reading on 7 October 2026. These observations do not verify sign-only, ownership proof completion or payment. Physical signing/payments, MWA app-switch, Cancel/background/restart payment recovery, custom test SKR, merchant ATA and live HTTPS+CORS end-to-end remain unverified. Main's preflight also reported missing live configuration and no Seeker detected by ADB; that snapshot does not negate the earlier physical-device observations.
- Missing/unfinalized transaction history can currently produce `403 COMMERCE_DENIED`, not `pending`. The client retains the unknown journal and never resends; fixing the server status contract is outside this client fix.
- Gameplay rewards, SOL→SKR conversion and payouts are not live; this ledger is not payout authorization.
- Wallet and Home were tested on a physical device on 7 October 2026, as reported by main. Visual verification remains outstanding specifically for the commerce checkout/payment UI, including live checkout and responsive-browser checkout evidence; this is not a claim that the entire app lacks physical visual testing. Component SSR/injected-hook tests are not browser or physical checkout evidence.
- Mainnet and actual SKR payments remain locked. This subtask performed no movement of funds, airdrops, deployment, commit/push or APK build.

## Checks

This subtask's focused run: commerce 15/15, wallet transport 6/6, commerce recovery 22/22, component 4/4; legacy payments integration script PASS. Scoped TypeScript checking of `commerce.ts` and tracked-diff whitespace checking passed. Main separately reports 32 actual focused tests passed, including new-quote blocking, durable acknowledgement, cache-crash recovery and concurrency; that is a separate test selection, not an additional aggregate total. The new recovery suite executes the existing client, real legacy/v0 SOL/TransferChecked builders, fixture Ed25519 proof, production HTTP handler/verifier/service and fixture Firestore bridge. Four combinations: runs-3/SOL, runs-3/SKR, std-500/SOL, std-500/SKR. All Auth/HTTP/RPC/Firestore boundaries are injected/offline; these are not real-devnet payments. `scripts/regression-child.cjs` blocks external networking.

Verified: acknowledgement-before-cache crash/reload, receipt/signature/quote deduplication, same-quote refusal, new-quote blocking while unknown, a new intent after durable acknowledgement, concurrent pre-sign races with a repeated journal-boundary check, thrown/dropped acknowledgement writes, closed acknowledgement validation, UID/payer isolation and component unmount before/after broadcast. The new fix changes neither UI nor server code. Main owns final integration/build/commit; this client fix alone is not full build/live/mainnet signoff.

## Exact configuration names (no secret values)

- Client SOL/commerce: `VITE_COMMERCE_URL`, `VITE_SOLANA_CLUSTER=devnet`, `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_PROJECT_ID`. Public RPC override: `VITE_SOLANA_RPC_URL`; wallet options: `VITE_WALLET_TIMEOUT_MS`, `VITE_SOLANA_IDENTITY_NAME`, `VITE_SOLANA_IDENTITY_URI`, `VITE_SOLANA_IDENTITY_ICON`.
- Client Firebase app configuration as needed: `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`. `VITE_*` values are public; never put private RPC keys or Admin credentials there.
- Client test SKR: `VITE_SKR_MINT`, `VITE_SKR_DECIMALS`, `VITE_SKR_CLUSTER=devnet`; these match the server's classic SPL test mint, not official mainnet SKR.
- Server: `COMMERCE_FIREBASE_PROJECT_ID`, `COMMERCE_IDENTITY_ORIGIN=https://localhost`, `COMMERCE_CLUSTER=devnet`, `COMMERCE_GENESIS_HASH=EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`, `COMMERCE_RPC_URL`, `COMMERCE_RECIPIENT`, `COMMERCE_CATALOG_JSON`, `COMMERCE_RATES_JSON`, `COMMERCE_QUOTE_TTL_MS`; SKR: `COMMERCE_SKR_MINT`, `COMMERCE_SKR_DECIMALS`.
- FX snapshots: `SOL`/`SKR` → `{numerator:string,denominator:string,timestamp:UnixMilliseconds,ttlMilliseconds:number}`. Approved fresh rates, enabled products and provisioned test assets/merchant ATA are required. Quote TTL does not release an unknown entry.
- Standalone defaults: `COMMERCE_NODE_HOST=127.0.0.1`, `COMMERCE_NODE_PORT=8787`, `COMMERCE_NODE_CONCURRENCY=16`, `COMMERCE_NODE_BODY_MS=5000`, `COMMERCE_NODE_HEADERS_MS=5000`, `COMMERCE_NODE_OPERATION_MS=45000`, `COMMERCE_NODE_SHUTDOWN_MS=55000`. Do not expose the host directly; main verifies the HTTPS proxy/CORS.
- ADC: host-managed credentials; with file-based ADC, server-only `GOOGLE_APPLICATION_CREDENTIALS` points to a private credential file. Do not publish credentials. The production runtime rejects emulator environment variables.

## Semantic change checklist for QA

1. The v1 journal key and all old entries are retained; only optional validated `confirmedReceipt` is added.
2. An unknown outcome for the same UID/payer blocks before signing and again before journal write; the same quote always blocks; scope isolation is retained.
3. A durable acknowledgement releases only the unknown-intent guard, not server entitlement checks; pending/reconcile history remains available.
4. Acknowledgement failures are fail-closed; replay/recovery never signs or broadcasts; local application remains idempotent.
5. Capacity remains 256; an early pre-sign check is added. No pruning, terminal failure/expired-blockhash release, UI edits, deployment or transfer.

## References

- [Official TransferChecked documentation](https://solana.com/docs/tokens/basics/transfer-tokens)
- [Classic SPL Token instruction/account layouts](https://github.com/solana-program/token/tree/main/interface/src)
- [Official associated token accounts](https://www.solana-program.com/docs/associated-token-account)
- [Official SKR information — not mainnet authorization](https://solanamobile.com/skr)
