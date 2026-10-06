# Pitch Q&A

**Why blockchain if the game works offline?**
The strategy game does work without blockchain. Solana is intended for optional external-wallet purchases and later SKR settlement; those features must prove their added value and safety rather than being presented as necessary for combat.

**What actually works today?**
The playable prototype and earlier published Android preview exist. Physical Seeker Android 16 account selection/connect completed after human approval on 6 October. Final compact Wallet/Home build/install and screen QA passed on 7 October: both fit the tested viewport, wallet labeling is short and cached selection/read-only test SOL refresh work. Devnet checkout remains source-only, not deployed; purchases are disabled and SKR unconfigured. No fresh ownership signing or payment proof is claimed. Final APK identity is in [readiness](readiness.md); prerelease publication remains pending.

**Did the wallet connect or a payment succeed?**
Seeker Wallet account selection/connect completed on physical Seeker Android 16 after human approval. Read-only test SOL balance loading also succeeded. These observations do not prove cryptographic ownership: no ownership signature, transaction signature, SOL/SKR payment or receipt-to-grant device flow has been verified. A selected/cached account and its public balance must not be treated as ownership proof. SKR is unconfigured; no private address, amount or screenshot is published.

**What is the cloud deployment prerequisite?**
CLI authentication succeeded against the existing `seekdef` project. Read-only checks confirm ACTIVE status, default Firestore NATIVE in `eur3`, anonymous Auth enabled and authorized domains `localhost`, `seekdef.firebaseapp.com`, `seekdef.web.app`. Billing is disabled (Spark), and the owner chose to retain the free plan. No Blaze upgrade or Cloud Functions deployment is included in this scope, and no new project was created. A hosted commerce backend is a future, separately scoped prerequisite; payments stay disabled. `functions:list` failed; this is not evidence that existing Functions are absent. In-app cloud acceptance remains unverified.

**What do the automated tests prove?**
Final root checks passed 61/61 suites (TS 23, CJS 38, zero failures), including latest Home UX coverage. Recorded checks passed 146/146 offline server tests (rerun 7 October), 3/3 runner, 24/24 profile/wallet/commerce/focus, 3/3 Home-copy and 28/28 branding checks. Post-UI web build, final asset copy and offline Android assembly passed. A separate local Auth/Firestore emulator test passed with fixture chain verification, not real Solana transactions. See [readiness](readiness.md) for methods. None demonstrates revenue, retention or live payment acceptance.

**Is STD a token, and can players cash it out?**
No. STD is a closed in-game balance for lives and skins; no on-chain issuance, redemption or investment return is promised.

**Are rewards live?**
No. Monthly top-five SKR rewards are proposed using 10% of run purchases only, excluding STD packs; ranking authority, settlement and SOL-to-SKR conversion are unresolved.

**How do you differ from existing games?**
The prototype combines route-shaping tower placement, a paper-world visual identity and wallet-free practice. Slimecoin, Mattle.fun and Billiards Clash are adjacent games competing for Seeker attention, not direct tower-defense competitors; the [publisher comparison source](https://solanamobile.com/blog/introducing-dapp-spotlight-in-the-solana-dapp-store) supports their described loops, not a “first,” “only,” superiority or market-leader claim for this game.

**Does the gameplay video prove product-market fit?**
No. It supports gameplay feasibility on the stated device; retention, willingness to pay and acquisition remain unmeasured. The next proposed test is a small wallet-free comprehension pilot.

**Are you raising or already funded?**
Funding history and any fundraising amount/instrument need founder confirmation. No amount, zero-funding claim, investor or funding date is invented in this draft.

**What are you asking judges to do?**
Try the wallet-free preview and assess the route-building interaction. Submission eligibility and final integration evidence will be confirmed by the owner; the draft is not an already submitted application.
