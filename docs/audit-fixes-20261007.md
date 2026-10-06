# Audit fixes — 7 October 2026

## Scope and evidence boundary

This is the implementation/closure map for the **17 findings and five functional gaps** in the Consolidated Global Audit dated 7 October 2026, baseline revision `1b4fdc5063b4020e9a2f0f7c2b96d06441782e17`. The original `AUDIT.md` is an external working record outside the public repository; it is not bundled here or rewritten as a passed audit.

“Implemented” below means the audited source behavior has changed with named local regression coverage. It does not mean independently audited, production-ready, deployed or accepted on a physical device. Test filenames identify reproducible coverage; main-reported current automated results, including the final 72/72 root PASS, are recorded below. Historical CI/APK evidence in [readiness](hackathon/readiness.md) applies only to its recorded revisions, not automatically to this checkout.

## Findings: source remediation and targeted coverage

Paths below are repository-relative. Test descriptions distinguish specific assertions from live acceptance.

| ID | Baseline defect | Current implementation | Targeted regression evidence |
| --- | --- | --- | --- |
| F01 | Unrelated build/sell edits rewind or stall enemies | `src/game/engine.ts` preserves coherent transit and bounded traveled history; actual route changes reroute safely | `src/game/combat-audit.regression.test.ts`: free off-route build/sell at 100 and 1,000 cycles versus control; actual block/unblock, diagonal transit and oversized history cases |
| F02 | Low FPS / long frames diverge from the timer | `src/game/replayTiming.ts` and `Game.tsx` use fixed steps, bounded frame work and retained backlog; deadline uses processed combat | `src/game/frame-timing.regression.test.cjs`: real seeded outcomes at 60/10/1 FPS and a 2,400-second foreground gap; 1×/2×/4× partial deadlines; replay parity |
| F03 | First/Last compare incompatible flyer/ground progress | `src/game/engine.ts` uses comparable remaining-route progress and stable UID tie handling | `src/game/combat-audit.regression.test.ts`: mixed ground/flyer First/Last before/after rerouting and stable ties |
| F04 | Glue enhancement leaves a stale target cache | `src/game/engine.ts` / `combatStatus.ts` refresh enhancement-dependent targeting immediately | `src/game/combat-audit.regression.test.ts`: paid Glue enhancement refreshes samples and pending-volley coverage with correct gold accounting |
| F05 | Teleporting Splitter death makes children jump | `src/game/engine.ts` gives children coherent independent transit/route state | `src/game/combat-audit.regression.test.ts`: teleport phases 0/0.05/0.5/0.95, combat/external death, child route independence and wave/reward ownership |
| F06 | Charged run is lost on reload | `src/state/runs.ts`, `checkpoints.ts`, `store.ts`, `src/App.tsx` and `src/game/Game.tsx` save admission debit with full recovery state; fresh planning runs normally, recovery starts paused | `src/screens/audit-ui.regression.test.cjs`: “reload resumes the charged run and paused full checkpoint without a second debit”; `src/state/domain.regression.test.ts` covers checkpoint validation and ownership |
| F07 | Silent save failure / defaults overwrite / nondurable UI | `src/state/store.ts` validates saves/backups, requires exact readback, preserves raw recovery data and reconciles uncertain writes; App/Game hold pending transitions | `src/state/domain.regression.test.ts`: storage fault injection, backup validation and ambiguous writes; `src/screens/audit-ui.regression.test.cjs`: durable admission failure, unreadable startup and exact pending Retry |
| F08 | Malformed local state crashes consumers | `src/state/store.ts` sanitizes bounded schema fields, including `localScores: null`; invalid financial data or missing/incompatible active checkpoint enters explicit recovery | `src/state/domain.regression.test.ts`: malformed state/financial preservation; `src/screens/audit-ui.regression.test.cjs`: “legacy active run without checkpoint does not crash or auto-discard” |
| F09 | Clock rollback blocks legitimate settlement/retry | `src/state/runs.ts` uses finite calendar dates for resets, not duration authorization; idempotent Continue/settlement remains possible after rollback | `src/state/domain.regression.test.ts`; `src/game/game-checkpoint-lifecycle.regression.test.cjs`: durable settlement Retry under rollback |
| F10 | Paused/terminal Game continuously requests frames | `src/game/Game.tsx` stops continuous animation/draw/audio work while paused or terminal | `src/game/game-checkpoint-lifecycle.regression.test.cjs`: “actual Game loop has zero continuous RAF/draw/audio work when paused or terminal”; main browser pause counter recorded below |
| F11 | Hanging paper image leaves Retry loading forever | `src/game/paperAssets.ts` bounds fetch/JSON/image loading and ignores stale retry-generation callbacks | `src/game/asset-timeout.regression.test.cjs`: “never-settling Image exits loading, permits bounded Retry, ignores old onload generation”; manifest fetch/JSON deadlines |
| F12 | Paid life inventory is a dead product | `src/state/runs.ts` and `src/screens/ShopScreen.tsx` remove standalone life sales; existing lives credit Standard Continue at 5 STD/life; one Continue revives 10 lives atomically with debit | `src/state/domain.regression.test.ts`: legacy credits, max-one bound and revival/backlog; `src/game/game-checkpoint-lifecycle.regression.test.cjs`: Continue crash-window and stale defeated checkpoint Retry |
| F13 | First-use Firebase callers race anonymous UIDs | `src/firebase.ts` waits for persistence hydration and shares in-flight sign-in; coherent identity/token snapshots follow identity changes | `src/firebase.test.cjs`: installed-SDK parallel callers issue one delayed sign-up; hydrated identity reuse; replacement/failure/subscription cases. Injected boundaries, not live cloud acceptance |
| F14 | Daily/challenge claims can double-grant or use stale eligibility | `src/state/store.ts` implements atomic `claimDailyBonus` / `claimChallengeReward`; `DailyBonusScreen.tsx`, `ChallengesScreen.tsx` and `utcReset.ts` use current UTC eligibility | `src/state/domain.regression.test.ts`: repeated/stale-midnight claims and UTC resets; `src/screens/audit-ui.regression.test.cjs`: bonus UI uses the atomic helper |
| F15 | Daily display differs from grants; unsupported Day 8 promise | One `DAILY_BONUS_SCHEDULE` in `src/state/store.ts`: 50/60/70/90/120/150/240; UI shares display helper; consecutive UTC streak cycles seven rewards, missed day resets | `src/state/domain.regression.test.ts`: schedule, cumulative streak and missed-day reset; `src/screens/audit-ui.regression.test.cjs`: no Day 8 promise |
| F16 | “Consecutive wins” copy describes a total-win counter | Chosen policy is **three wins today**, not consecutive; `src/screens/ChallengesScreen.tsx` now matches `src/state/store.ts` | `src/state/domain.regression.test.ts`: daily challenge eligibility/idempotence; source policy/copy explicitly aligned, not a new consecutive-win mechanic |
| F17 | Referral hash collisions and shared guest identity | `src/state/referrals.ts` uses 32-bit multiplication correctly and crypto guest codes per saved profile; legacy codes remain; no financial referral grant | `src/state/domain.regression.test.ts`: 1,000 distinct canonical Solana-address fixtures; `src/state/referrals.regression.test.cjs`. Fixture uniqueness is not a global registry guarantee |

## Functional gaps: local closure versus remaining acceptance

| ID | Baseline gap | Local source / evidence | Remaining boundary |
| --- | --- | --- | --- |
| G01 | Extra-run purchase is absent at exhausted admission | `src/App.tsx`, `src/screens/RunSetupScreen.tsx`, `src/components/ContextualCheckout.tsx`: contextual checkout preserves setup and offers free Practice. `src/screens/audit-ui.regression.test.cjs`: zero-quota Standard/Ranked, cancel, fresh-state receipt recovery and exactly-once admission | Real checkout is disabled; no live purchase acceptance. Main browser verified zero-quota Timed 20 retention and Practice alternative |
| G02 | Continue top-up cannot return to the battle | **Partial closure.** `src/App.tsx`, `src/game/Game.tsx`, `src/components/ContextualCheckout.tsx`: retain battle/run; matching-owner grant does not auto-Continue; atomic revival/debit survives reload. `audit-ui.regression.test.cjs` and `game-checkpoint-lifecycle.regression.test.cjs` cover cancel, pending Retry and crash window | Main browser verified cancel and Continue/reload, not a real purchase. Guest-run top-up is restricted: finish or explicitly discard the guest run before wallet linking; a foreign account cannot claim its rewards or continue it. No silent guest-owner migration. Real top-up/handoff/receipt-to-Continue remains unverified |
| G03 | Claims/inventory ownership differs from balance ownership | `src/state/store.ts`, `runs.ts`, `src/services/commerce.ts`, `src/App.tsx`: scoped inventory/claim snapshots; run owner frozen; foreign switch rejected before persistence; device free quota global. `src/services/commerce-recovery.test.cjs`, `audit-integration.regression.test.ts` and `src/screens/audit-ui.regression.test.cjs` exercise scope/replay/guest guards | Local policy implemented, not accepted reinstall/rebind or guest-owner linking. No automatic guest-wallet economic merge; live ownership and durable backend recovery remain gates |
| G04 | Local ranking compares incompatible modes/Continue/access | `src/state/runs.ts`, `store.ts`, `src/screens/LeaderboardScreen.tsx`: metadata partitions config, month, seed, actual speed, engine/rules versions, owner and continuation count. Ranked fixed 1× with a common UTC-month/rules seed, not random singleton seeds | `src/state/domain.regression.test.ts` covers same-period seed equality/rollover and score segregation; `audit-ui.regression.test.cjs` covers filters/demo exclusion. Local preview only; server-verified ranking/settlement is absent |
| G05 | Action feedback, exit and mobile layout are incomplete | `src/App.tsx`, `src/game/Game.tsx`, screens and `src/styles.css`: pending/error recovery, feedback, one App-owned exit confirmation and responsive layout. `src/screens/audit-ui.regression.test.cjs` covers native Back/button exit and failed discard Retry | Main headless-browser layout evidence below; physical touch ergonomics, native process death, battery/thermal and performance acceptance are still open |

## Cross-cutting regression contracts

- `src/game/frame-timing.regression.test.cjs`: “checkpoint paused restoration preserves clocks, unique tower types, RNG, uid and backlog”. Checkpoints contain deterministic RNG and full gameplay arrays/cooldowns, not just a score summary.
- `src/game/game-checkpoint-lifecycle.regression.test.cjs`: “Continue crash-window persists revival and debit atomically before Game can resume” and “one Game Retry resolves root pending Continue before any stale defeated checkpoint can overwrite it”. A recovered authorized Continue cannot be charged twice.
- `src/screens/audit-ui.regression.test.cjs`: “ambiguous write locks new debits and Retry confirms the exact pending admission once”, “foreign account transition is rejected before persistence and cannot lock a guest battle”, and “guest/foreign checkout cannot mount impossible wallet connection or purchase; same owner can”. An uncertain write may already have spent the entry; the UI must not claim otherwise.
- `src/services/commerce-recovery.test.cjs`: receipt loss after server commit, durable acknowledgement before cache update, unknown outcomes without rebroadcast, and “confirmed history is retained; fixture-filled 256-entry acknowledged journal blocks later signing”. `src/services/audit-integration.regression.test.ts` adds bounded cross-domain storage/owner scenarios; `src/components/CommercePurchases.test.cjs` checks durable completion/cancel boundaries.
- `server/game-authority.test.mjs`, `server/game-authority-http.test.mjs` and `src/services/gameAuthority.test.ts` cover an **OFF/unwired scaffold**, not operational verified settlement or payout.

## Main-reported current automated results

| Check | Result / boundary |
| --- | --- |
| Server offline CI exact test-file list, run locally | PASS: 245 tests, 244 passed, zero failures, **one Windows POSIX-file-permission skip**. Not a zero-skip or hosted-CI claim |
| Regression runner | 3/3 PASS |
| Native Java offline compilation | `javac` PASS; this compilation check alone is not device acceptance. Assembled candidate evidence is recorded below |
| Root regression — final rerun | **72/72 suites PASS: TS 27/27, CJS 45/45**, zero failures; main execution session `10557`, exit code 0. The earlier generated host-specific Gradle dependency-junction path was restored to a portable path without JS/native-code or assertion changes; scoped `solanaRpc` checks also passed 8/8 before the complete rerun |
| Web build | PASS: TypeScript (`tsc`) and Vite, public-safe offline/devnet configuration with Firebase and commerce disabled |
| Android source/assets sync | Capacitor Android sync PASS; not APK assembly, install or device acceptance |
| New local audit-fix APK candidate | Offline `assembleDebug` PASS after sync. Public-repository build output `android/app/build/outputs/apk/debug/app-debug.apk`: 9,457,266 bytes; SHA-256 `5EF6279414E8C0B94A679C972A4C3666D1D985E7124B385962CEB53374B90945`. **518/518 dist files** match APK ZIP entries by exact SHA-256, without errors. `apksigner` validates the debug signature; certificate SHA-256 `14afcd6a1d33b66ba30d051646d4cbf1af73a8517acb19c7042759484db37658`, same as the earlier build. Offline/devnet process overrides disable Firebase and commerce; no deployment/install/public-release update or optional artifact copy. ADB has no device; physical acceptance unverified |

## Main-reported isolated browser evidence

Method boundary: local headless browser with external network blocked. These observations are main-reported integration QA, separate from regression fixtures and from earlier physical Seeker evidence. They are not real payments or actual-device performance measurements.

| Scenario | Observed result |
| --- | --- |
| Fresh Begin | Admission succeeds and fresh planning runs; recovery-only pause is not applied to fresh entry |
| Reload active run | Same run ID resumes without a new entry debit |
| Exhausted quota | Timed 20 setup remains selected; free Practice alternative is available |
| STD top-up cancellation | Same battle/run retained, fixture gold 400 and one tower retained; no automatic Continue |
| Standard Continue | Fixture 75 STD becomes 25, 10 lives, defeat cleared, continuation count one; same run ID and two remaining free entries |
| Reload after Continue | Resume retains 25 STD / 10 lives without errors or another debit |
| Pause work | RAF counter remains 23 → 23 over 800 ms |

Responsive layout checks found document dimensions matching each viewport and no offscreen buttons:

| Viewport (CSS px) | Canvas (CSS px) |
| --- | --- |
| 360 × 780 | 325 × 569 |
| 375 × 812 | 343 × 601 |
| 412 × 915 | 402 × 704 |
| 768 × 1024 | 412 × 721 |
| 1280 × 900 | 394 × 689 |

## Rules retained by this closure

New profiles start at 100 STD, zero legacy lives and streak; existing balances/inventory are not reset. Standard and Ranked share three device-global UTC daily entries, then extra-run credits. Standard allows **one Continue per run**, restoring **10 lives for 50 STD minus legacy-life credit at 5 STD/life**. Practice admission/Continue are unlimited and free, without progression rewards. Ranked has no Continue, runs at fixed **1×**, and uses the same deterministic seed for its UTC month and rules version. Standard/Practice retain random seeds. These local rules do not establish verified rank or payout eligibility.

## Remaining live gates — not closed by local fixes

1. **Authority OFF/unwired:** `server/game-authority*.mjs` is disabled/unmounted; the client transport is not wired into App. No verified end-to-end gameplay settlement, reward entitlement, trusted rank or payout. Guarded admission/debit scaffolding is not run verification.
2. **Commerce acceptance:** no deployed checkout or verified physical-wallet ownership signature / SOL/SKR payment / receipt-to-grant flow. SKR remains unconfigured; Spark retained. Real timeout, account-change and receipt recovery require controlled acceptance before enablement.
3. **Ownership/recovery:** reinstall, rebind and guest-owner linking are not verified features. G02 remains partial: finish or explicitly discard a guest run before wallet linking/top-up; a foreign account cannot claim its rewards or continue it. A selected wallet cannot silently migrate guest balances or a recoverable run. Browser reload is not native process-death/reinstall acceptance.
4. **Journal capacity:** acknowledged payment history is retained. At 256 entries, new signing stops safely; reviewed compaction/support is not supplied by this closure. Do not delete receipts, silently truncate replay guards or rebroadcast an unknown transaction to escape the hold.
5. **Rewards/release:** SOL-to-SKR conversion, verified monthly settlement and payout are absent. No mainnet/funds/API/cloud-deployment operation is claimed. The new local APK candidate built successfully from the local web/native source, but is not an accepted CLOCK IN paid release, device validation or publication. The older public release/hash is unchanged. Physical performance/ergonomics, security review and final human release/submission approval remain separate gates.

See [economy](economy.md), [architecture](architecture.md), [readiness](hackathon/readiness.md) and [pitch Q&A](hackathon/qa.md). This record closes local implementation work only within the stated evidence boundary; it does not claim complete production readiness.
