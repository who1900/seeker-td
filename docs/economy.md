# Economy — pilot design, not live payments

Snapshot: 7 October 2026, audit-fix source checkout. The published Android preview predates these fixes and is unchanged; its parity with current source is not claimed. A separate local payments-disabled candidate built successfully, with details in [readiness](hackathon/readiness.md); it is not installed, published or physically accepted. A devnet SOL/SKR purchase path exists in locally tested source; checkout is not deployed or payment-accepted. Earlier physical Seeker Wallet account selection/connect and read-only test SOL balance loading are not cryptographic ownership proof. Ownership signing/payments remain unverified and SKR unconfigured. Firebase stays on Spark with no Cloud Functions deployment; purchases remain disabled. No verified real payment, mainnet checkout, payout or approved commercial price is claimed.

## Currency boundaries

SOL or SKR is intended to buy extra runs and STD packs. STD is a closed in-game balance used for Standard Continue and tower skins, not an issued blockchain token. It has no promised redemption, cash-out or investment return. There is no standalone life-inventory sale. Local progression and balances are not proof of server-authorized financial entitlement.

## Current local rules

| Access | Admission | Continue | Progress and comparison |
| --- | --- | --- | --- |
| Practice | Unlimited, free, wallet-free | Unlimited, free; does not consume legacy lives | No STD rewards, scores or challenge progress |
| Standard | Shares three free daily entries with Ranked; then consumes one extra-run credit | At most once per run; restores 10 lives for 50 STD before legacy credit | Local progression; results partitioned by run rules and continuation count |
| Ranked — local preview | Same shared daily quota / extra-run credit | None | Fixed 1×; deterministic seed shared for the UTC month and rules version; not server-verified ranking or prize eligibility |

Existing life inventory is retained. A Standard Continue consumes up to 10 legacy lives as credit at 5 STD per life, then charges only the remainder of 50 STD. For example, five legacy lives plus 25 STD restore 10 lives. An authorized retry cannot consume either resource twice. Debit, inventory consumption, continuation count and revived battle checkpoint are one durable transition; the saved checkpoint includes clocks and timer backlog.

Fresh profiles explicitly start with 100 STD, zero life inventory and streak, zero SOL/prize-pool/rank values, and no wallet address. These defaults do not reset existing balances or inventory. Standard/Ranked quota is device-global, not replenished by account switching. UTC dates govern daily resets, not elapsed combat time; a clock rollback does not permanently prevent a legitimate Continue or settlement.

## Daily and challenge rewards

Daily grants and display share one seven-day schedule: **50, 60, 70, 90, 120, 150, 240 STD**. Consecutive UTC-day claims advance the streak and cycle the schedule; a missed day restarts at day one. There is no unsupported Day 8 reward promise. Claims recheck current eligibility inside the state transition, so repeat clicks and eligibility carried across midnight cannot double-grant.

The daily win challenge means **win three games today**, not three consecutive wins. Other daily challenges retain their configured goals. Practice does not progress these challenges. Referral codes are local attribution only: existing codes remain valid, new guest profiles have separate random codes, and no financial referral grant is implemented. See [audit-fix evidence](audit-fixes-20261007.md) for the named regression coverage.

## Persistence and account ownership

Admission saves both the entry debit and an initial recoverable battle checkpoint before entering Game. Fresh admission starts planning normally; restored battles start paused. Continue revival is recoverable without another debit. Corrupt/unreadable saves and legacy active runs without a usable checkpoint enter explicit recovery, never a fresh-profile overwrite or automatic refund. Backup restoration and lost-run discard require explicit actions; discard preserves balances and does not refund an unknowable battle outcome.

A write whose readback fails has an **unknown durable outcome**: the new state may already exist. The UI pauses economic actions and reconciles the exact pending state rather than saying nothing was spent. A backup must be validated and cannot silently replace a valid newer economic state.

Runs freeze their commerce-account owner at admission. Account-scoped inventory and claim state follow that owner; a recoverable battle blocks a foreign account switch before persistence. A wallet top-up cannot silently acquire or merge a guest-owned battle/balance. Finish or explicitly discard the guest run before wallet linking/top-up; a foreign account cannot claim its rewards or continue it. G02 is therefore only partially closed: matching-owner return/cancel flow is covered, not guest top-up or migration. Guest-to-wallet ownership linking, reinstall recovery and rebind are not accepted live features.

The commerce receipt journal retains acknowledged history and safely holds at **256 entries**, blocking new signing rather than dropping replay protection. Timeouts remain unknown outcomes, not automatic refunds or permission to rebroadcast. Reviewed compaction/support and live recovery acceptance remain gates.

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
