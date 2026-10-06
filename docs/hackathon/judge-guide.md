# Judge guide — start with wallet-free practice

## Fastest route

1. Open the [preview release](https://github.com/who1900/seeker-td/releases/tag/clock-in-preview), download the [debug APK](https://github.com/who1900/seeker-td/releases/download/clock-in-preview/seekdef-clockin-device-debug.apk), or watch the [physical Seeker gameplay recording](https://github.com/who1900/seeker-td/releases/download/clock-in-preview/SEEKER_TD_CLOCK_IN_Seeker_gameplay.mp4).
2. Install only if you accept a sideloaded debug preview. Preserve existing app data; do not uninstall or clear storage to bypass a signing mismatch. Use a separate test profile/device if necessary.
3. Choose Play, Practice and an available mode. No wallet, Firebase credentials, token balance or payment is required for practice.
4. Place towers on the board and watch the route change. Keep a valid route between IN and OUT. Start the next wave; inspect/upgrade a tower and compare damage/control choices.
5. Try pause/resume and restart. Practice grants no STD, ranked score or challenge progress. Local ranked scores are not verified for prizes.

The released APK/video are earlier gameplay-preview evidence. They do not demonstrate ongoing SOL/SKR source integration or prove that the latest source equals the APK.

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

Open [HTML deck](pitch.html): Left/Right arrows or buttons navigate; N toggles presenter notes; Print prints all slides. [Submission draft](submission.html) provides selectable field text and copy buttons. Download/open the repository locally if GitHub renders the HTML as source; no hosted website is claimed.

## Wallet / paid-product boundary

Do not send real SOL/SKR to test this preview. Devnet checkout is implemented in source, but deployment and current commerce device validation are pending. Checkout must remain unavailable until a trusted server, fresh currency quotes, verified mint/cluster, durable receipts and explicit testing/release approval exist. Rewards and SOL-to-SKR conversion are planned, not live.
