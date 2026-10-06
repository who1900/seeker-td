# Judge guide — start with wallet-free practice

## Fastest route

1. Open the [current devnet prerelease](https://github.com/who1900/seeker-td/releases/tag/clock-in-devnet-preview) and download the [current debug APK](https://github.com/who1900/seeker-td/releases/download/clock-in-devnet-preview/seeker-td-clockin-devnet-debug.apk). For earlier gameplay footage, watch the preserved [physical Seeker recording](https://github.com/who1900/seeker-td/releases/download/clock-in-preview/SEEKER_TD_CLOCK_IN_Seeker_gameplay.mp4).
2. Install only if you accept a sideloaded debug preview. Preserve existing app data; do not uninstall or clear storage to bypass a signing mismatch. Use a separate test profile/device if necessary.
3. Choose Play, Practice and an available mode. No wallet, Firebase credentials, token balance or payment is required for practice.
4. Place towers on the board and watch the route change. Keep a valid route between IN and OUT. Start the next wave; inspect/upgrade a tower and compare damage/control choices.
5. Try pause/resume and restart. Practice grants no STD, ranked score or challenge progress. Local ranked scores are not verified for prizes.

Current APK: 9,664,267 bytes, SHA-256 `05545E715CC5485350CF34B2277BBC801839D7C949313068D4D6D90698139133`; anonymous public download/hash and GitHub API digest matched on 7 October. The new prerelease targets c2f1330; the older APK/video remain unchanged. The video is earlier gameplay evidence, not current commerce/payment proof, and still needs an accepted YouTube/Loom/public Drive host for the reported application form.

## Run source locally

Requirements: Node.js 22+, npm, and network access for a fresh install. From the repository root:

```sh
npm ci
npm run dev -- --host 127.0.0.1
```

Open the localhost URL printed by Vite. Leave Firebase unset for offline/local mode. Practice can be tested without wallet features; first-time browser loading and wallet/RPC calls still need their respective resources/network. Do not infer offline cold-start acceptance from this command.

```sh
npm run test:regression:runner
npm run test:regression
npm run build
```

Regression tests exercise the local game/client, not deployed backend durability or real transfers. Broader server/emulator suites have separate dependencies; see `server/README.md`, not an automatic cloud deployment.

## Presentation

Open the [published 10-slide PDF](https://github.com/who1900/seeker-td/releases/download/clock-in-devnet-preview/SEEKER_TD_CLOCK_IN_DEVNET.pdf), whose anonymous download/hash was verified. The [HTML deck](pitch.html) supports arrows/buttons, N presenter notes and Print. [Submission draft](submission.html) provides selectable field text/copy buttons. Open HTML locally if GitHub renders source; no hosted website is claimed.

## Wallet / paid-product boundary

Do not send real SOL/SKR to test this preview. Physical Seeker account selection/connect and read-only test SOL balance loading worked; these are not cryptographic ownership proof. Ownership signing and payments remain unverified; SKR unconfigured. Checkout is implemented in source but not deployed; purchases stay disabled. Firebase stays on the free plan with no Cloud Functions deployment. Rewards and SOL conversion are planned, not live. [Hosted branch CI passed](https://github.com/who1900/seeker-td/actions/runs/37519383624) at c2f1330 on Ubuntu / Node 22; this does not establish payment acceptance or final submission.
