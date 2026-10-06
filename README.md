# SEEKER: TD

**Build the maze. Defend the paper world.**

A mobile-first tower-defense prototype for Solana Seeker, where your tower placements shape the enemy's route.

![SEEKER: TD paper-world concept illustration](docs/media/cover.png)

Local prototype. Purchases and payouts are disabled. STD is an internal in-game balance, not an on-chain token. Local ranked results are not verified prize competition.

## Presentation and gameplay

Prepared for the CLOCK IN source publication.

[View the CLOCK IN pitch (PDF)](docs/pitch/SEEKER_TD_CLOCK_IN.pdf)

The cover is promotional concept artwork. The images below show the current playable prototype captured in a mobile-sized browser.

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

Gameplay runs locally. The Android wallet connection code uses Solana Mobile Wallet Adapter, separate from combat and practice; device wallet acceptance remains unverified. Purchases and payouts require trusted backend verification and remain disabled. The Solana dApp Store is a future distribution goal; this game has no announced listing.

## Economy: planned and disabled

The planned model lets players use SOL or SKR to buy extra runs or STD packs. STD is a closed, internal game balance for lives and skins, not an issued on-chain token or a redeemable currency.

Future top-5 SKR payouts would use a pool funded by 10% of run purchases only. STD-pack purchases would not contribute to that pool. This is a design proposal: purchases, payout settlement and the prize pool are not live. Local ranked scores are not verified payout eligibility, and no real payments are claimed.

## Technology

The prototype uses React, TypeScript and Canvas rendering, packaged for Android through Capacitor. Wallet integration uses Solana Mobile Wallet Adapter. Separate local server experiments explore admission and deterministic replay; they are not a deployed game backend.

## Founder

**Daniyar Gabdullin, Solo Founder & Engineer.** Independently builds mobile and Web3 products since 2019; previously shipped Seeker Vault and X-Booster for Solana Seeker.

[Portfolio](https://portfolio.whoim.space) · [LinkedIn](https://www.linkedin.com/in/daniyar-gabdullin-11312b252/)

## Roadmap

1. Build on validated gameplay on a physical Seeker; complete manual ergonomics and performance testing.
2. Run a small gameplay pilot focused on route decisions and tower balance.
3. Complete backend verification and release preparation before any paid competition.
4. Prepare a Solana dApp Store submission.

## Source publication and preview release

Repository: [who1900/seeker-td](https://github.com/who1900/seeker-td). This source publication includes the React/TypeScript/Canvas game, its existing Capacitor Android wrapper, local server experiments and the CLOCK IN pitch. The commands below use the source tree and lockfile at the repository root.

[`clock-in-preview`](https://github.com/who1900/seeker-td/releases/tag/clock-in-preview): [Android debug APK](https://github.com/who1900/seeker-td/releases/download/clock-in-preview/seekdef-clockin-device-debug.apk) · [Real Seeker gameplay demo](https://github.com/who1900/seeker-td/releases/download/clock-in-preview/SEEKER_TD_CLOCK_IN_Seeker_gameplay.mp4). The debug APK is not a production-signed store release.

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

The build runs TypeScript checking and Vite. Local preparation passed 52/52 game regression suites and 3/3 runner tests using existing dependencies; a fresh network-based `npm ci` install was not tested.

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

Production web build, Capacitor sync and offline debug APK assembly passed during local preparation. Gameplay was recorded on a real Seeker running Android 16. Wallet authorization, audio, offline/cold startup, long background recovery, manual finger ergonomics and performance benchmarks remain unverified.

### Local server experiments

Standalone identity, admission and replay modules live in `server/`; they are not a deployed or app-integrated authoritative payment backend. With root dependencies installed:

```sh
node --test server/replayFingerprint.test.mjs server/replayRuntime.test.mjs
node --test server/runAdmission.test.mjs
```

These are local tests, not deployment commands. Broader SDK/emulator suites need additional setup. Historical preparation passed 58/58 backend core/loopback checks and 7/8 safety guards. The emulator-rules-path portability issue was subsequently corrected; those results predate the fix, which has not been retested here. Passing tests does not establish payment verification or reward authority.

## Third-party notices

Preserve dependency and bundled-font licenses and notices when distributing source or builds. This README does not assign a project-wide license.
