# Economy — pilot design, not live payments

Snapshot: 6 October 2026. The earlier published preview is a practice/gameplay prototype. A devnet SOL/SKR purchase path exists in locally tested source; checkout is not deployed or payment-accepted. Physical Seeker Wallet account selection/connect and read-only test SOL balance loading succeeded, not cryptographic ownership proof; ownership signing/payments remain unverified and SKR unconfigured. Firebase stays free with no Cloud Functions deployment; purchases remain disabled. No verified real payment, mainnet checkout, payout or approved commercial price is claimed.

## Currency boundaries

SOL or SKR is intended to buy extra runs and STD packs. STD is a closed in-game balance used for lives/Continue and tower skins. It is not an issued blockchain token, has no promised redemption, cash-out or investment return. Practice remains unlimited and wallet-free, without STD rewards, scores or challenge progress. Local progression and balances are not proof of server-authorized financial entitlement.

## Pilot launch-reference catalog

These USD-cent references are delegated product-design values, not market quotes or approved live prices. The server catalog must be the price authority; do not treat historical UI constants as launch pricing.

| SKU | Grant | USD cents | USD reference |
| --- | ---: | ---: | ---: |
| `runs-1` | 1 run | 25 | $0.25 |
| `runs-3` | 3 runs | 65 | $0.65 |
| `runs-10` | 10 runs | 195 | $1.95 |
| `std-500` | 500 STD | 99 | $0.99 |
| `std-1500` | 1,500 STD | 249 | $2.49 |
| `std-4000` | 4,000 STD | 599 | $5.99 |

All products stay disabled until their prerequisites are verified. A private server `.env` owns `COMMERCE_CATALOG_JSON`; current config expects `{id, usdCents, runs, std, enabled}`. Set exactly one positive grant, keep the other at zero, and use integer minor units. Fresh private `COMMERCE_RATES_JSON` entries bind SOL/SKR conversion to a timestamp and TTL. No token exchange rate is supplied or implied here. Display a server quote before signing, including amount, currency, expiry and fees; reject missing/stale rates rather than silently falling back to a hardcoded token amount.

## Rewards: planned only

The proposal allocates 10% of run purchases only to monthly top-5 SKR rewards. STD-pack purchases contribute nothing. This is not a live prize pool, guaranteed yield or verified competition. Do not describe the game as “Earn SOL.”

SOL-to-SKR conversion and reward settlement are not implemented. Accounting for SOL-denominated run purchases therefore does not establish SKR available for payouts. Before launching rewards, define funding/conversion, settlement timing, rounding, refund treatment, ranking verification, tie handling, anti-cheat, geographic eligibility and user disclosures. These are open decisions, not approved rules.

## Safety gates

Missing server verification, receipt persistence, approved configuration, fresh rates, trusted SKR metadata or device-wallet acceptance must disable checkout. The backend must bind receipts to payer, product, exact transfer and cluster, then consume each transaction once before granting runs or STD. No client-local balance or optimistic success banner may replace that check.

Complete a devnet/test-token pilot, failure-path testing and security review before enabling any paid product. A test mint must be labelled a test asset, not official SKR. Mainnet and rewards require separate explicit approval. See [architecture](architecture.md) and [readiness](hackathon/readiness.md).
