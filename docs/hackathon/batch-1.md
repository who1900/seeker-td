# Batch 1 checkpoint — 7 October 2026

This is a bounded source/test checkpoint, not deployment, live-payment acceptance, current APK parity or mainnet security signoff. Earlier release and device evidence remains unchanged.

## Implemented in source

- Firebase Spark is retained. Standalone Node commerce source and configuration templates are implemented, **not deployed**; no Blaze upgrade or Firebase Functions deployment.
- The repeated-payment guard blocks a new quote for the same UID/payer while an earlier outcome is unknown, before signing and again at the durable journal boundary. A previously signed quote cannot be signed again, even after confirmation; other UID/payer scopes remain isolated.
- A validated server receipt is durably acknowledged before local cache application. Confirmed history remains available for crash recovery; receipt reconciliation never automatically resends a transaction. Acknowledgements do not authorize server entitlements.
- Journal history is not pruned. Old entries without acknowledgement remain unknown; the storage-wide 256-entry cap remains fail-closed. No terminal-failure/expired-blockhash release is implemented.
- Four offline fixture combinations exercise existing client and real transaction builders: runs/SOL, STD packs/SOL, runs/custom test SKR and STD packs/custom test SKR. Custom devnet test SKR is not official mainnet SKR. Injected Auth/HTTP/RPC/Firestore fixtures are **not real-devnet payment evidence**.
- The devnet asset CLI was **not executed**. No test assets, funds, deployment or live configuration are claimed from its source implementation.

## Main-reported verification

- Web build: **PASS** after the test-only actual `Response` typing fix.
- Explicit CI server test selection executed on Windows: **210 PASS + 1 POSIX-only SKIP = 211 tests**. This is a selection/execution result, not a new hosted CI success claim.
- Linux Node 22 node-listener + asset selection: **65/65 PASS**. Do not infer other suites, asset provisioning or deployment from this result.
- Final root regression: **62/62 suites PASS (TS 23, CJS 39)**, as observed by main.
- Regression runner: **3/3 PASS**; final web build: **PASS**, as observed by main.
- Verified [hosted CI run 37535565143](https://github.com/who1900/seeker-td/actions/runs/37535565143): **SUCCESS** on Ubuntu / Node 22 for exact source commit `24ed7f73c0873a58eec26c7c5d698755ff87a2d8`, confirmed by main from filtered actual logs.
- Hosted results: **62/62 root suites (TS 23, CJS 39; zero failures)**, **runner 3/3 PASS**, **server 211 tests / 211 PASS / 0 skipped**, and **web build PASS (2.79 seconds)**; all job steps passed.
- This CI result applies only to that source commit, not later docs-only commits, an APK rebuild or service deployment. The historical hosted CI and debug APK records at `c2f1330` remain unchanged.

## Release and physical evidence boundaries

- The existing debug APK prerelease targeting `c2f1330` remains unchanged. This batch performs no new installation, native changes or movement of funds; source changes do not establish APK/source parity.
- Physical account connection was observed on 6 October; read-only SOL and Wallet/Home physical checks were observed on 7 October. These observations do not prove ownership signing, transaction signing or payment acceptance.
- Physical commerce checkout/payment UI and live quote→sign→receipt acceptance remain unverified. Seeker is currently absent from USB/ADB; earlier device observations are not revoked by that snapshot.
- No live rewards, SOL→SKR conversion, payouts or mainnet readiness are claimed.

## Next gates

1. Choose the HTTPS hostname/deployment target and establish DNS. The standalone source/templates do not constitute an available endpoint.
2. Restore Seeker USB access for the separately authorized physical checkout checks.
3. After the deployment choice, agents can handle ADC and controlled test-asset configuration in separately authorized work. The owner is not required to hand-edit keys; privileged credentials remain server-side, never public `VITE_*` values.

## Batch 2 remains separately scoped

- Server-authoritative gameplay admissions and purchased run/STD spending: current receipts feed mutable local gameplay counters; those spends do not debit `commerceBalances`.
- Reviewed terminal-pending recovery and safe retained-history/256-cap handling; never clear unknown outcomes by client timeout, quote expiry or Cancel.
- Anonymous UID/reinstall identity linking and lost cache/journal recovery without client-authorized balance transfers.
- Cross-tab/process coordination beyond the tested single-runtime journal boundary.
- Verified gameplay reward eligibility, conversion and payout authorization, only under separate review and release authority.

See [commerce client handoff](../COMMERCE_CLIENT_HANDOFF.md), [bounded review](../commerce-review.html) and [readiness evidence](readiness.md). Main owns final integration, test results and any later commit; this checkpoint does not rewrite historical CI or release records.
