# SEEKER: TD

**Build the maze. Defend the paper world.**

A mobile-first tower-defense prototype for Solana Seeker, where your tower placements shape the enemy's route.

Playable local prototype. A locally tested devnet SOL/SKR quote-to-receipt purchase path is implemented in source, not deployed or payment-accepted. Seeker Wallet account selection/connect and read-only test SOL balance loading were observed on device; ownership signing and payments are not verified, and SKR is unconfigured. Purchases and payouts remain disabled. STD is an internal in-game balance, not an on-chain token. Local ranked results are not verified prize competition.

## Presentation and gameplay

Prepared for CLOCK IN: the Solana Mobile Hackathon. This is draft preparation, not a submitted application or store listing.

[HTML pitch — 10 slides, arrows / N notes / print](docs/hackathon/pitch.html) · [Copy-paste submission draft](docs/hackathon/submission.html) · [Judge guide](docs/hackathon/judge-guide.md) · [Readiness and risks](docs/hackathon/readiness.md) · [Sources checked](docs/hackathon/source-checks.md)

The existing [CLOCK IN PDF](docs/pitch/SEEKER_TD_CLOCK_IN.pdf) is retained unchanged; it is not proof of later integration work.

The images below show the playable prototype captured in a mobile-sized browser, not phone mockups. Concept artwork in the HTML pitch is labelled separately.

| Build your route | Defend against the wave |
| --- | --- |
| ![Practice maze with player-placed towers](docs/media/gameplay-maze.jpg) | ![Wave 2 combat in the paper world](docs/media/gameplay-combat.jpg) |

## The game

Every placement changes the space enemies must cross. Extend their route while preserving useful firing positions, then combine tower effects as the waves grow.

- Place, upgrade and promote towers on an open grid.
- Combine damage and control effects across 12 tower models.
- Face 10 enemy types and a boss, with different movement and combat roles.
- Play endless, timed or wave-target modes.
- Learn the maze in unlimited practice without a wallet or entry debit.

### Tower roster

| Family | Towers |
| --- | --- |
| Bullet | Canon, Dual Canon, Machine Gun |
| Laser | Simple Laser, Bouncing Laser, Straight Laser |
| Explosive | Mortar, Mine Layer, Rocket Launcher |
| Control | Glue Tower, Glue Gun, Teleporter |

## Why Seeker and Solana

Seeker is the intended mobile audience. Touch controls support tower placement, inspection and wave management, while the paper figures give the board a distinctive visual identity.

Gameplay runs locally. Android uses Solana Mobile Wallet Adapter, separate from combat and practice. Seeker Wallet account selection/connect completed on physical Seeker Android 16 after human approval; read-only test SOL balance loading succeeded. Account selection and a public balance query are not cryptographic ownership proof. Ownership signing and payments remain unverified; SKR is unconfigured. Purchases and payouts remain disabled. The Solana dApp Store is a future distribution goal; this game has no announced listing.

## Economy: devnet source path, checkout disabled by default

The source purchase path supports SOL or configured SKR for extra runs and STD packs, subject to server configuration and validation. It has not been deployed or physically wallet-tested. STD is a closed, internal game balance for lives and skins, not an issued on-chain token or a redeemable currency. Pilot USD-cent catalog references are documented in [economy](docs/economy.md); these are not approved live prices or market quotes.

Future monthly top-5 SKR payouts would use a pool funded by 10% of run purchases only. STD-pack purchases would not contribute to that pool. This is a design proposal: payout settlement and the prize pool are not live; SOL-to-SKR conversion is not implemented. Local ranked scores are not verified payout eligibility, and no real payments are claimed.

## Technology

The prototype uses React, TypeScript and Canvas rendering, packaged for Android through Capacitor. Wallet integration uses Solana Mobile Wallet Adapter. Separate local server experiments explore admission and deterministic replay; they are not a deployed game backend.

```text
Tower placement --> pathfinding --> rerouted enemies --> local combat / progress
React + Canvas --> existing Capacitor wrapper --> Android gameplay preview

IN PROGRESS: SOL/SKR --> trusted server receipt --> extra runs / closed STD
PLANNED: 10% of run purchases only --> monthly top-5 SKR rewards
```

See [architecture and trust boundaries](docs/architecture.md). Wallet signing, fresh server quotes and durable receipt-to-grant verification must be tested before checkout is enabled.

## Founder

**Daniyar Gabdullin, Solo Founder & Engineer.** Independently builds mobile and Web3 products since 2019; previously shipped Seeker Vault and X-Booster for Solana Seeker.

[Portfolio](https://portfolio.whoim.space) · [LinkedIn](https://www.linkedin.com/in/daniyar-gabdullin-11312b252/)

## Roadmap

1. Build on validated gameplay on a physical Seeker; complete manual ergonomics and performance testing.
2. Run a small gameplay pilot focused on route decisions and tower balance.
3. Complete backend verification and release preparation before any paid competition.
4. Prepare a Solana dApp Store submission.

## Source publication and preview release

Repository: [who1900/seeker-td](https://github.com/who1900/seeker-td). Core implementation is public at [f2f95c9](https://github.com/who1900/seeker-td/commit/f2f95c9); documentation, PDF and version-preserving lock repair are public at [c2f1330](https://github.com/who1900/seeker-td/commit/c2f1330b5ad7abd095787a386fdf002dccdf6de8). This does not mean the payment backend is deployed. The commands below use the repository source tree and lockfile.

[`clock-in-preview`](https://github.com/who1900/seeker-td/releases/tag/clock-in-preview): [Android debug APK](https://github.com/who1900/seeker-td/releases/download/clock-in-preview/seekdef-clockin-device-debug.apk) · [Real Seeker gameplay demo](https://github.com/who1900/seeker-td/releases/download/clock-in-preview/SEEKER_TD_CLOCK_IN_Seeker_gameplay.mp4). The debug APK is not a production-signed store release.

Current prerelease: [`clock-in-devnet-preview`](https://github.com/who1900/seeker-td/releases/tag/clock-in-devnet-preview), with [Android debug APK](https://github.com/who1900/seeker-td/releases/download/clock-in-devnet-preview/seeker-td-clockin-devnet-debug.apk) and [10-slide PDF](https://github.com/who1900/seeker-td/releases/download/clock-in-devnet-preview/SEEKER_TD_CLOCK_IN_DEVNET.pdf), targeting c2f1330. Anonymous public downloads and SHA-256 parity passed on 7 October; GitHub API digests also match. The earlier release remains unchanged. Published checkout source is not a deployed payment service.

Local presentation: [HTML source](docs/hackathon/pitch.html) and new [10-slide PDF](docs/hackathon/SEEKER_TD_CLOCK_IN_DEVNET.pdf). Older presentation PDF/PPTX assets are preserved.

## Run, build and test

Requirements: Node.js 22+ and npm. Run from the repository root:

```sh
npm ci
npm run dev -- --host 127.0.0.1
```

```sh
npm run test:regression
npm run test:regression:runner
npm run build
npm run preview -- --host 127.0.0.1
```

The build runs TypeScript checking and Vite. [CI](.github/workflows/ci.yml) runs `npm ci`, runner tests, game regressions, an explicit offline server-unit set including commerce, and the web build, with read-only repository permissions and no Firebase deployment. Emulator suites are excluded until separately configured. [Hosted CI run 37519383624](https://github.com/who1900/seeker-td/actions/runs/37519383624) passed on Ubuntu / Node 22 at c2f1330; recorded local/device results and evidence limits are in [readiness](docs/hackathon/readiness.md).

Without `.env` Firebase configuration, Firebase is disabled and the game uses local/offline mode. Configure optional integrations in a private `.env` using `.env.example`. Never place privileged secrets in `VITE_*` variables: they are bundled into the client. Wallet/RPC features still require network access.

### Android

Install a compatible JDK and Android SDK for the existing Gradle project, then build and sync:

```sh
npm run build
npm run cap:sync
npm run cap:android
```

`cap:android` opens the existing project in Android Studio. Alternatively, from PowerShell:

```powershell
Set-Location android
.\gradlew.bat assembleDebug
```

With cached Gradle dependencies, add `--offline`. Output: `android/app/build/outputs/apk/debug/app-debug.apk`. Configure SDK paths locally; do not commit `local.properties` or signing keys. Before updating an existing installation, verify compatible signing certificates; do not uninstall or clear user data to bypass a mismatch.

The recorded TypeScript/Vite build (284 modules) and Capacitor sync passed. Final compact Wallet/Home asset copy (not an additional sync), offline Android assembly (23 seconds) and compatible-certificate `adb install -r` passed on 7 October, preserving app data; native code unchanged. Both screens fit the tested Seeker viewport with a shortened wallet label; cached selection/read-only test SOL refresh work. **Physical account selection/connect completed on 6 October; the 7 October check is not fresh signing.** Ownership signing/payments remain unverified; SKR unconfigured. No private address, amount or screenshot is published. Released APK hash/size and CI status are in [readiness](docs/hackathon/readiness.md). Purchases remain disabled.

## Submission checks

The [official announcement](https://solanamobile.com/blog/clock-in-the-solana-mobile-hackathon), checked 6 October 2026, asks for an Android APK, source repository, app-in-use video and short presentation. It lists 8 October as the closing date and SKR as an optional bonus integration. The founder reports a form showing 12 October; that conflict needs confirmation, not an assumed extension. Required funding/start-date details remain unknown until founder confirmation. See [demo script](docs/hackathon/demo-script.md) and [pitch Q&A](docs/hackathon/qa.md).

The reported application form accepts video hosted on YouTube, Loom or public Google Drive. The GitHub video asset is a public preview reference, not a ready form URL: **Needs accepted host** before submission.

### Local server experiments

Identity, admission, replay and commerce modules live in `server/`. The devnet commerce client is integrated in source, but its backend is not deployed. Admission/replay remain local shadow paths, not authoritative production enforcement. With root dependencies installed:

```sh
node --test server/replayFingerprint.test.mjs server/replayRuntime.test.mjs
node --test server/runAdmission.test.mjs
```

These are local tests, not deployment commands. Final compact Wallet/Home root checks passed **61/61 suites** (TS 23, CJS 38, zero failures); the post-UI source checkout web build passed. Recorded checks also passed 146/146 non-emulator server tests (rerun 7 October), 3/3 runner, 24/24 focused profile/wallet/commerce/focus, 3/3 Home-copy and 28/28 branding checks. Core includes the Firestore policy source guard. One separate local Auth/Firestore emulator integration test passed using an injected chain verifier, not real-chain payment evidence. See [readiness](docs/hackathon/readiness.md) for methods and limits. Passing tests does not establish real payment verification or reward authority.

Historical first hosted [CI run 37518257767](https://github.com/who1900/seeker-td/actions/runs/37518257767) failed at `npm ci`. The published lock-only repair adds four missing nested entries without changing any of 831 existing entries/versions; isolated Node 22.15.1 / npm 10.9.4 `npm ci --ignore-scripts` passed (785 packages). Subsequent hosted [branch run 37519383624](https://github.com/who1900/seeker-td/actions/runs/37519383624) completed successfully at c2f1330 on Ubuntu / Node 22: root `npm ci`, server `npm ci --ignore-scripts`, runner tests, 61 game regressions, 146 offline server tests and TypeScript/Vite build all passed. This verifies code-quality checks, not ownership signing, payments or backend deployment.

Firebase CLI is authenticated against the existing ACTIVE `seekdef` project; read-only checks confirm default Firestore NATIVE in `eur3` and anonymous Auth enabled. Billing is disabled (Spark), and the owner explicitly chose to retain the free plan: no Blaze upgrade or Cloud Functions deployment in this scope. A hosted commerce backend remains a future, separately scoped prerequisite; payments stay disabled. No new project or cloud deployment was created. `functions:list` failed and does not prove existing Functions are absent; existing cloud configuration is not proof of in-app payment acceptance.

## Third-party notices

Preserve dependency and bundled-font licenses and notices when distributing source or builds. This README does not assign a project-wide license.
