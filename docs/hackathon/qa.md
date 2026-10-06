# Pitch Q&A

**Why blockchain if the game works offline?**
The strategy game does work without blockchain. Solana is intended for optional external-wallet purchases and later SKR settlement; those features must prove their added value and safety rather than being presented as necessary for combat.

**What actually works today?**
The playable prototype and published Android preview exist. Earlier physical Seeker account selection/connect and compact Wallet/Home checks are recorded in [readiness](readiness.md); they do not certify later audit-fix source. Current isolated headless-browser checks cover fresh admission, reload without a second debit, contextual checkout cancellation, durable Continue recovery and five responsive layouts. A new local payments-disabled APK candidate built from local web/native source; its hash is recorded in readiness, but it was not installed or published and physical acceptance is unverified. The older public release is unchanged. These are not device-performance or live-payment tests. Devnet checkout remains source-only, purchases disabled and SKR unconfigured.

**Did the wallet connect or a payment succeed?**
Seeker Wallet account selection/connect completed on physical Seeker Android 16 after human approval. Read-only test SOL balance loading also succeeded. These observations do not prove cryptographic ownership: no ownership signature, transaction signature, SOL/SKR payment or receipt-to-grant device flow has been verified. A selected/cached account and its public balance must not be treated as ownership proof. SKR is unconfigured; no private address, amount or screenshot is published.

**What is the cloud deployment prerequisite?**
CLI authentication succeeded against the existing `seekdef` project. Read-only checks confirm ACTIVE status, default Firestore NATIVE in `eur3`, anonymous Auth enabled and authorized domains `localhost`, `seekdef.firebaseapp.com`, `seekdef.web.app`. Billing is disabled (Spark), and the owner chose to retain the free plan. No Blaze upgrade or Cloud Functions deployment is included in this scope, and no new project was created. A hosted commerce backend is a future, separately scoped prerequisite; payments stay disabled. `functions:list` failed; this is not evidence that existing Functions are absent. In-app cloud acceptance remains unverified.

**What do the automated tests prove?**
The [audit-fix map](../audit-fixes-20261007.md) names implementation/regression evidence for all 17 findings and five gaps. Main reports final root **72/72 suites PASS (TS 27/27, CJS 45/45; exit 0)**; local offline server list: **245 tests, 244 passed, zero failures and one Windows POSIX-file-permission skip**. Runner 3/3, offline native `javac`, TypeScript/Vite web build, Capacitor Android sync and offline APK assembly PASS. The generated Gradle-path issue was repaired without JS/native-code or assertion changes before the successful full rerun. **518/518** dist files match the candidate APK ZIP by exact SHA-256; its debug signature validates. The payments-disabled candidate is not installed or published and does not update the public release. Earlier counts/artifacts in [readiness](readiness.md) apply only to their recorded snapshots. Mock/emulator verification is not a real Solana payment, verified rank, revenue or retention result.

**Is STD a token, and can players cash it out?**
No. STD is a closed in-game balance for Standard Continue and skins; no on-chain issuance, redemption or investment return is promised. Standalone life sales are removed; existing life inventory remains usable as Continue credit.

**What are the current entry and Continue rules?**
Standard and local Ranked share three device-global free entries per UTC day, then use extra-run credits. Standard allows one Continue: 10 lives for 50 STD, reduced by 5 STD per consumed legacy life, up to 10. Practice admission and Continue are unlimited/free; Practice grants no STD, scores or challenges. Ranked has no Continue, runs at fixed 1× and uses the same deterministic seed for comparable rules in each UTC month. It is a local preview, not verified competition.

**Can reload or failed saving spend twice?**
Admission saves its debit with a full checkpoint; Continue saves its debit with revival. Recovery starts paused. A failed readback can mean the write already committed, so the UI holds further economic actions and reconciles the exact pending state. Corrupt saves are not replaced by defaults. Validated backup restore or lost-run discard requires an explicit action; discard preserves balances and does not promise a refund.

**Does a wallet top-up take over a guest battle?**
No. A run freezes its account owner at admission. Finish or explicitly discard the guest run before wallet linking/top-up; a foreign account cannot claim its rewards or continue it. A foreign account switch is blocked while that battle remains recoverable, and the UI does not offer an impossible guest-to-wallet purchase. Cancellation keeps the same battle; a matching-owner grant does not auto-Continue. **G02 remains partially closed**, not a fully working guest top-up. Guest-owner linking, reinstall recovery and rebind are not verified live features.

**What happens when payment recovery cannot finish?**
An unknown outcome stays pending, without automatic rebroadcast or duplicate grant. The durable receipt journal retains history and blocks new signing at 256 entries. Reviewed compaction/support and real-device receipt recovery remain gates; fixture success is not live payment acceptance.

**Are rewards live?**
No. Monthly top-five SKR rewards are proposed using 10% of run purchases only, excluding STD packs; ranking authority, settlement and SOL-to-SKR conversion are unresolved. The game-authority scaffold is OFF/unmounted and its client transport is not wired into App. Verified settlement and payout are not implemented acceptance flows.

**How do you differ from existing games?**
The prototype combines route-shaping tower placement, a paper-world visual identity and wallet-free practice. Slimecoin, Mattle.fun and Billiards Clash are adjacent games competing for Seeker attention, not direct tower-defense competitors; the [publisher comparison source](https://solanamobile.com/blog/introducing-dapp-spotlight-in-the-solana-dapp-store) supports their described loops, not a “first,” “only,” superiority or market-leader claim for this game.

**Does the gameplay video prove product-market fit?**
No. It supports gameplay feasibility on the stated device; retention, willingness to pay and acquisition remain unmeasured. The next proposed test is a small wallet-free comprehension pilot.

**Are you raising or already funded?**
Funding history and any fundraising amount/instrument need founder confirmation. No amount, zero-funding claim, investor or funding date is invented in this draft.

**What are you asking judges to do?**
Try the wallet-free preview and assess the route-building interaction. Submission eligibility and final integration evidence will be confirmed by the owner; the draft is not an already submitted application.
