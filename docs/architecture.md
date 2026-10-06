# Architecture

Snapshot: 7 October 2026, audit-fix source checkout. This is a trust-boundary overview, not a deployment specification or security certification. Historical APK/device evidence does not establish current source parity. See the [22-item audit-fix map](audit-fixes-20261007.md) for implementation and regression evidence.

## Playable core

```text
Touch / mouse
      |
React screens --> local run admission --> Canvas game / wave manager
                                               |
                              tower placement --> pathfinding --> rerouted enemies
                                               |
                                      local state / progress

React + TypeScript + Vite --> existing Capacitor wrapper --> Android debug APK
```

`src/game/Game.tsx` owns the playable board; `engine.ts`, `waveManager.ts` and `pathfinding.ts` implement combat, waves and routes. `replayTiming.ts` uses fixed simulation steps with bounded per-frame work and retained backlog; timed results use processed combat, not unprocessed wall time. Route edits preserve enemy transit; target ordering, Glue cache refresh and Splitter teleport inheritance have targeted regression fixtures.

`src/state/runs.ts` separates Practice, Standard and local Ranked admission. Practice is unlimited and free, with no STD reward, score or challenge progress. Standard and Ranked share three device-global daily entries before extra-run credits. Standard permits one Continue per run: 10 lives for 50 STD less legacy-life credit at 5 STD/life. Practice Continue is unlimited/free; Ranked has none. Ranked is a local preview with fixed 1× and a common deterministic seed for the UTC month and rules version. Score partitions retain mode/configuration, period, seed, actual speed, engine/rules versions, owner and continuation count; none is server-verified prize eligibility.

## Durable local transitions

`src/state/store.ts` validates a versioned schema and preserves valid legacy balances/inventory. `saveState` reports durable success only after exact readback; `loadState` creates defaults only for genuinely missing state. Unreadable/corrupt state, an incompatible checkpoint or a legacy active run without a checkpoint enters explicit recovery without overwriting the raw save. Validated backup restore and lost-run discard are explicit actions, not automatic rollback/refund.

`src/state/checkpoints.ts` stores the full battle, deterministic RNG cursor, gameplay arrays/cooldowns, clocks, speed, placed tower types and timer backlog. Recovery validates finite bounded runtime data and restores paused. Admission atomically saves the debit, frozen run owner and initial checkpoint; fresh Game starts without the recovery prop so planning runs normally. Continue atomically saves entitlement debit and the revived checkpoint before Game resumes. A stale defeated snapshot cannot overwrite an authorized revival.

App advances its state reference/navigation only after durable success. A write followed by failed or mismatched readback may already have committed; it pauses further economic actions. Retry reconciles the exact pending state and refuses a conflicting durable snapshot. Failed checkpoint/settlement persistence stays recoverable; terminal/paused Game has no continuous animation loop. Paper assets have bounded loading deadlines and generation-safe retries.

The local store is not a trusted financial ledger. `src/state/referrals.ts` provides attribution codes, not authoritative referral rewards. Daily/challenge transitions recheck UTC eligibility atomically. Commerce-account snapshots include balances, inventory and claim progression; device free quota stays global. A recoverable run freezes account ownership, and a foreign switch is rejected before saving rather than creating an invalid pending state. Guest balance/battle ownership is not silently migrated to a selected wallet. Finish or explicitly discard the guest run before wallet linking/top-up; a foreign account cannot claim its rewards or continue it. G02 remains partial, not accepted guest-run top-up or ownership linking.

Optional Firebase configuration is separate from the offline core. Its presence does not make local scores authoritative. No Firebase cloud deployment is included in this preparation.

## Commerce integration: local evidence, live acceptance pending

```text
SOL / configured SKR
         |
authenticated server quote --> external wallet signature --> Solana RPC
         |                                                   |
         +-------------- verified server receipt <------------+
                                  |
                      atomic entitlement / replay guard
                         /                    \
                    extra runs          closed STD balance
                                              |
                                       skins / Continue

PLANNED ONLY: eligible run purchases --> 10% allocation --> monthly top-5 SKR rewards
             STD packs excluded; SOL-to-SKR conversion not implemented
```

This diagram describes the source trust boundary, not an observed real payment. `src/wallet.ts` contains MWA authorization and transaction plumbing. `src/services/payments.ts` contains legacy quote/receipt validation and purchase gates. The devnet commerce path exists in `src/services/commerce.ts`, `commerceRuntime.ts`, `commerceWallet.ts` and `server/commerce*.mjs`, with server-owned catalog, quotes, transfer verification and receipt-to-grant logic. Physical Seeker account selection/connect and read-only test SOL balance loading succeeded, not cryptographic ownership proof; ownership signing/payments remain unverified and SKR unconfigured. Firebase stays free with no Cloud Functions deployment; purchases remain disabled. Source/test evidence does not prove production storage or real payment.

`src/firebase.ts` serializes first-use anonymous authentication after persistence hydration and keeps UID/token snapshots coherent through identity changes. Injected SDK-boundary tests do not establish live cloud acceptance. Commerce receipt recovery binds UID and payer and grants once only after durable acknowledgement. The retained journal has a 256-entry safe hold: it blocks new signing when full, including acknowledged history, rather than pruning replay protection. Unknown broadcast/receipt outcomes are recovered without automatic rebroadcast. Compaction/support, reinstall recovery, rebind and guest-owner linking need separate reviewed acceptance.

## Game authority scaffold: OFF and unwired

`server/game-authority.mjs`, `game-authority-http.mjs` and `game-authority-firebase.mjs` are a disabled scaffold, not the App's run authority. No listener/function is mounted by this work; `src/services/gameAuthority.ts` is a transport surface not wired into App. Its guarded admission/debit fixtures do not authorize client gameplay or turn local scores into trusted ranks. Settlement and payout remain fail-closed even when scaffold admission is enabled; there is no verified end-to-end run settlement, reward entitlement or payout flow.

Deployment requires a reviewed host/auth/store policy, durable request recovery, binding admission to an authoritative session/seed/replay, verified settlement and entitlement updates, and separate payout authority. These are gates, not activation instructions. Local unit/emulator evidence does not establish production authentication, operational security or a deployed verifier. The published APK/video prove an earlier preview, not this checkout.

## Before payment enablement

- Trusted server identity/session binding; never trust client-supplied UID, price or entitlement.
- Server-owned product catalog and fresh conversion rates; quote binds product, currency, payer, recipient, cluster/genesis and expiry.
- External wallet signing only; verify the expected signer, exact transfer, amount and recipient. For SKR, verify token program, mint, decimals and token-account ownership.
- Atomic signature/receipt consumption and durable entitlement credit across instances; retries must not double-credit. Timeout means unknown outcome, not permission to resend automatically.
- Wrong cluster/mint, stale quote/rate, failed transaction, replay, cancellation and verifier outage must fail closed.
- Physical Seeker MWA tests, security audit and explicit release approval. Mainnet remains locked; rewards require separate score validation and settlement review.

No private keys, privileged Firebase credentials or private RPC tokens belong in `VITE_*`: Vite exposes them to clients. See [economy](economy.md), [judge guide](hackathon/judge-guide.md) and [readiness](hackathon/readiness.md).
