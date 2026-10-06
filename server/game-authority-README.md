# Game authority v1 — bounded source contract, NOT enabled

This separate ledger shares the **same Firestore project and `commerceBalances/{hex(uid)}`** as commerce grants.
It is not shadow admission and never reads `shadowEntitlements`, client save data, score, summary or rank.
Both service and HTTP adapter default to disabled. No existing listener/function/export imports this adapter.
No deployment, billing change, treasury key, signer, mainnet transaction or external provisioning is included.
Keep billing Spark. Local gameplay remains Practice/alpha until a separately reviewed end-to-end authority integration exists.

## Dependency-injected provision seam

`createGameAuthorityFirebaseAdapters({ projectId, firebaseAuth, firestore })` accepts an already initialized real
Firebase Admin app's Auth/Firestore. It delegates to existing revoked-ID-token verification (audience, issuer,
subject and project checked), rejects emulator routing, and wraps real `runTransaction` through the existing
bounded copy/path/poisoned-callback adapter. Never substitute browser SDK or in-memory storage in deployment.
The mocks are test-only. The authority adapter opt-in adds three allowed collections; default commerce paths
remain unchanged. Identity documents stay read-only through the transaction adapter.

Create `createGameAuthorityService({ ...adapters, policy, enabled: false })`. Policy is mandatory and copied:

```js
{ version: 'reviewed-policy-1', freeRunsPerUtcDay: 3, stdCosts: {} }
```

`stdCosts` is a privileged allowlist of exact positive u64 decimal costs keyed by action ID (max 32 actions).
No STD action is enabled by default. Tests use a synthetic `bounded-upgrade` cost, not a deployed item.
A STD debit records spending only; it does not unlock an item or award an entitlement. Those fulfillment rules
must be integrated atomically under a reviewed contract before any real STD action is exposed to users.
The free-run policy is per UTC epoch day, enforced on **both uid and wallet**, with no credits to commerceBalances.
It assumes the existing one-uid/one-wallet identity binding; no rebinding/deletion/reset is authorized here.
All replicas must share the same privileged store and policy. Change policy version for any policy change;
receipt records also pin a canonical policy hash and fail closed on policy mismatch.

## HTTP contract (unmounted)

`createGameAuthorityHttpHandler({ authority, origin, enabled: false })` is a parsed-body HTTPS adapter, not a raw
listener. Host integration must apply TLS, a bounded JSON/body parser (4096 bytes), trusted HTTPS request
protocol (never trust arbitrary forwarded headers), exact route mounting, and bearer auth. No cookies/CORS
cross-origin transport. All routes use POST, `Authorization: Bearer <Firebase ID token>`, JSON, no-store.

| Path | Exact JSON request |
| --- | --- |
| `/api/game-authority/v1/balance` | `{version:1, uid, payer}` |
| `/api/game-authority/v1/debit` | `{version:1, uid, payer, requestId, policyVersion, action, amount}` |
| `/api/game-authority/v1/settle` | Always 503 `AUTHORITY_SETTLEMENT_DISABLED` |
| `/api/game-authority/v1/payout` | Always 503 `AUTHORITY_PAYOUT_DISABLED` |

`uid` must equal authenticated Firebase uid. `payer` must match **both** identityUids and identityWallets in the
same transaction, including retries. `requestId` is globally unique lowercase 32-hex, supplied and durably
retained by the caller before submitting. Same ID + changed request/account/policy is rejected, not recharged.
No automatic retries, request-ID regeneration, timeout refund, pruning, deletion or expiry of receipt records.
`amount` is canonical decimal u64 string: `paid-run` requires exactly `'1'`; `free-run` exactly `'0'`;
STD actions require the allowlisted exact cost. No numbers, fractions, exponent, negative or padded amounts.

Balance returns exactly:

```js
{ version: 1, uid, payer, balances: { runs: '0', std: '0' },
  free: { day: 0, remaining: 3 }, settlementEnabled: false, payoutEnabled: false }
```

Debit returns the above fields plus `requestId`, `policyVersion`, `action`, `amount`, `committedAt` (server ms).
Balance debit + receipt or both quota counters + receipt commit atomically; all reads precede writes. Receipt
is an immutable historical balance snapshot, not a current snapshot and **not a gameplay authorization**.
Call balance for current amounts. Same request retry after response loss/restart returns the identical receipt.
403 denies identity/replay; 409 denies insufficient funds/quota; 503 means disabled/unavailable or timeout.
Timeout can occur after commit: retain the original request and retry only that exact request after identity check.

`src/services/gameAuthority.ts` is transport-only: HTTPS canonical same origin, coherent session uid/payer/token,
abortable whole-operation timeout, no redirect/cookie, bounded strict JSON/uint64 responses, post-response
account recheck. It is **not imported by the app** and does not mutate local state or grant any gameplay access.
In particular this is **not runnable remote authority for Capacitor**: an app at `https://localhost` cannot use
a different HTTPS backend origin with this client. Same-origin hosting/routing or a separately reviewed native
transport/security policy and actual client wiring are still required; no cross-origin exception was added.

## Commerce pending compatibility

Missing/not-indexed transaction or status, unavailable history, nonfinalized or inconsistent evidence produces
`COMMERCE_PENDING`; HTTP 202 exact body `{status:'pending', error:'COMMERCE_PENDING'}`. No grant/ledger/receipt
is written until successful verification. Later finalized matching evidence can grant once.
Without a server-persisted original signed-message journal, even failed/ineligible evidence does not prove that
it is safe to release the client hold. Terminal rejection/hold clearing is deliberately not implemented.
Invalid auth/request/quote ownership remains denied. Network configuration mismatch remains unavailable.
No proof of unbroadcast transaction, journal auto-clear, recovery compaction or rebroadcast is added.

## Still-closed enablement gates (Main review required)

1. Host/TLS route mounting, shared real Admin provisioning, production policy/rate limits and database-rule audit.
2. Durable client request journal and account-scoped wiring; no local commerce grant copies as authoritative money.
   The unimported same-origin transport still cannot connect Capacitor `https://localhost` to a remote backend.
3. Debit-to-authoritative-gameplay admission binding, one-use run lifecycle/seed/config and replay upload protocol.
4. Actual complete replay verification tied to captured runtime fingerprint and server-owned session. Current replay
   runtime source alone is NOT verified settlement. The replay work-budget/continuation defect is **closed**, not
   an outstanding enablement gate: shared `replayChunk.ts` enforces actual work/chunk ceilings before execution
   through C-owned timing's trusted allowance, and the server executes that captured source directly. The remaining
   gate is authenticated admission/evidence binding and verified economic settlement, not replay work accounting.
5. Atomic verified rewards/STD grants, score/rank publication, run completion and STD entitlement fulfillment.
6. Payout policy/accounting and signing — entirely absent and disabled, including on devnet. No treasury keys.
7. Safe failed-payment resolution tied to exact signed message + signature + uid + quote and durable journal evidence.

Settlement/payout methods unconditionally throw, even when debit is enabled or a caller sends `replayVerified:true`.
No verified rank is synthesized and no production authority/client wiring is claimed.

## Offline selected tests

Use the provided Node runtime; do not run npm ci (root node_modules is a junction). From server:

```text
node --test game-authority.test.mjs game-authority-http.test.mjs commerce-pending.test.mjs commerce.test.mjs commerce-verifier.test.mjs commerce-integration.test.mjs replayBudget.test.mjs replayRuntime.test.mjs replayFingerprint.test.mjs
```

From app root, use existing isolated TS regression runner:

```text
node scripts/regression-child.cjs src/services/gameAuthority.test.ts
node scripts/regression-child.cjs src/game/replay-chunk.regression.test.cjs
node scripts/regression-child.cjs src/game/frame-timing.regression.test.cjs
```

All fixtures are local mocked Admin transactions/RPC/HTTP responses, no emulator or network.

## Source-level bounded replay integration — budget defect closed

The shared processor no longer uses `frames * 4` / `workTicks + 4` estimates or relies on a server wrapper.
Before each timing invocation it computes a trusted allowance from the minimum of remaining per-call work ticks,
remaining actual chunk ticks, and remaining ticks in the current client frame (`MAX_FRAME_TICKS`, currently 480).
C's `timing.frame(delta, trustedMaxTicks)` validates that allowance and checks it before executing each engine tick.
Uploaded events remain exactly `{type:'frame', delta}`: tick counts, budgets and frame-cost claims are rejected.
Zero delta cannot hide retained backlog. Zero-budget probes detect eligible work without executing another tick.

Delta is accumulated once per event; later slices use zero delta. The processor retains event cursor/frame tick
count across pending yields and does not execute the following action until the frame reaches its normal 480-tick
cap or exhausts eligible work (including terminal/paused/deadline cases). Default `workTicks=128` remains unchanged
and makes progress: a 300-tick frame finishes 128 -> 256 -> 300; a 480-tick frame can span four work calls.
No budget was raised and there is no infinite-pending wait for an indivisible 480-tick reservation.

`maxChunkTicks` limits actual engine ticks, not frame count. A cheap 256-frame chunk can be valid; an expensive
chunk that needs tick 1025 under the default ceiling 1024 is aborted BEFORE that tick executes. Its draft may
have executed bounded work, but no checkpoint/hash/index/UID changes commit; the entire draft is discarded and
`resourceLimited` is returned. Whole/split chunks preserve gameplay hashes; different work-yield patterns for the
same chunk preserve both gameplay and chunk hashes. All existing byte/event/state/work hard ceilings remain.

Optional trusted config `speedLimit:1` is copied, hashed and enforced in shared and captured processors; uploaded
speedCycle cannot bypass it. C's local Ranked Game config now uses that shared restriction. Real ranked server
admission is still **not wired**: shadow admission remains shadow-only and must not be treated as a ranked or
economic proof. Admission-to-replay mapping must eventually pin the same trusted speedLimit before enablement.

The server loads the same fixed replayChunk/timing source snapshot it fingerprints. Missing/invalid frame ceiling
exports fail closed. Source changes intentionally change the captured runtime fingerprint; old source identities
must not be advertised as equivalent. No cross-platform proof, settlement, reward, score publication or payout
authorization is implied by a local `historyValid` result.

CI's existing offline server step now explicitly includes `game-authority.test.mjs`, `game-authority-http.test.mjs`,
`commerce-pending.test.mjs` and `replayBudget.test.mjs` alongside existing runtime/fingerprint tests. The new transport
test remains discovered by the existing game regression runner. No CI run, cloud deployment or billing change is claimed.

C implemented the optional timing API and deadline normalization in its owned file; BackendF implemented the
source processor's resumable budget accounting. Coordination completed through the authorized C chat. The bounded
replay fix is complete; production authority enablement still requires Main's contract/integration review and the
remaining gates above. Local validation or a successful web build does not enable production authority.

Verified locally after the source-level fix:

- Combined server command above: **132/132**, including actual chunk ceilings, backlog, captured source exports,
  ranked speed restriction, identity/debits, disabled settlement and commerce pending.
- Shared `replay-chunk.regression.test.cjs`: **9/9**, including instrumented real tick calls bounded before execution,
  exact chunk-limit rollback, whole/split hash parity, default128 progress, and 128 -> 256 -> 300 frame completion.
- C's `frame-timing.regression.test.cjs`: **7/7**, including per-event client/processor parity and near-deadline probes.
- Isolated `gameAuthority.test.ts`: **7/7**. Strict no-emit ES2020 typecheck of `replayChunk.ts`, `gameAuthority.ts`
  and its test passed with their imported dependencies.

Main's latest integration handoff reports these additional results (not rerun by BackendF during this docs-only close):

- Full server suite: **245 tests, 244 passed, 1 Windows/POSIX skip**.
- Web build: **PASS**. Final root replay regression: **9/9**.
- Source is frozen and agent A is copying it. A new APK build is **in progress**, not a verified build result or deployment.

This close changes documentation only; no production source, frozen gameplay source or CI list was changed, and no
tests were rerun. The CI list already includes the budget regressions. BackendF's validation used no cloud, emulator,
external network, local npm install/ci, deployment, signing, funds or billing operation. `replayBudget.mjs` (the obsolete
server-only conservative wrapper) was removed earlier; its regression filename is retained in CI and now tests the
captured fixed source directly. Settlement/payout remain unconditionally disabled; billing remains Spark.

## BackendF final file manifest

New files:

- `server/game-authority.mjs`
- `server/game-authority-firebase.mjs`
- `server/game-authority-http.mjs`
- `server/game-authority.test.mjs`
- `server/game-authority-http.test.mjs`
- `server/game-authority-README.md`
- `server/commerce-pending.test.mjs`
- `server/replayBudget.test.mjs`
- `src/services/gameAuthority.ts`
- `src/services/gameAuthority.test.ts`

Modified files:

- `server/commerce-firestore.mjs`
- `server/commerce-verifier.mjs`
- `server/commerce-http.mjs`
- `server/replayRuntime.mjs`
- `server/replayRuntime.test.mjs`
- `src/game/replayChunk.ts`
- `src/game/replay-chunk.regression.test.cjs`
- `.github/workflows/ci.yml`

Removed earlier: `server/replayBudget.mjs`, superseded by the bounded shared source processor.
C-owned timing/gameplay changes and other agents' integration files are not BackendF edits.
