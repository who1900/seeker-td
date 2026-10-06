# Architecture

Snapshot: 6 October 2026. Read-only overview, not a deployment specification or security certification.

## Playable core

```text
Touch / mouse
      |
React screens --> local run admission --> Canvas game / wave manager
                                               |
                              tower placement --> pathfinding --> rerouted enemies
                                               |
                                      local state / progress

React + TypeScript + Vite --> existing Capacitor wrapper --> Android debug APK
```

`src/game/Game.tsx` owns the playable board; `engine.ts`, `waveManager.ts` and `pathfinding.ts` implement combat, waves and routes. `src/state/runs.ts` separates practice, standard and local ranked admission. Practice is unlimited, has no entry debit, and grants no STD, score or challenge progress. Standard progression is local; local ranked results do not establish prize eligibility. `src/state/store.ts` persists client state, which is not a trusted financial ledger.

Optional Firebase configuration is separate from the offline core. Its presence does not make local scores authoritative. No Firebase cloud deployment is included in this preparation.

## Commerce integration: devnet source path, merged validation pending

```text
SOL / configured SKR
         |
authenticated server quote --> external wallet signature --> Solana RPC
         |                                                   |
         +-------------- verified server receipt <------------+
                                  |
                      atomic entitlement / replay guard
                         /                    \
                    extra runs          closed STD balance
                                              |
                                         skins / lives

PLANNED ONLY: eligible run purchases --> 10% allocation --> monthly top-5 SKR rewards
             STD packs excluded; SOL-to-SKR conversion not implemented
```

This diagram describes the source trust boundary, not an observed real payment. `src/wallet.ts` contains MWA authorization and transaction plumbing. `src/services/payments.ts` contains legacy quote/receipt validation and purchase gates. The devnet commerce path exists in `src/services/commerce.ts`, `commerceRuntime.ts`, `commerceWallet.ts` and `server/commerce*.mjs`, with server-owned catalog, quotes, transfer verification and receipt-to-grant logic. Physical Seeker account selection/connect and read-only test SOL balance loading succeeded, not cryptographic ownership proof; ownership signing/payments remain unverified and SKR unconfigured. Firebase stays free with no Cloud Functions deployment; purchases remain disabled. Source/test evidence does not prove production storage or real payment.

`server/` contains isolated identity, admission, Firestore adapter and deterministic replay experiments. Local unit or emulator evidence does not establish production authentication, durable commerce storage, operational security or a deployed verifier. The published `clock-in-preview` APK/video prove an earlier gameplay preview, not the current source bundle or new commerce work.

## Before payment enablement

- Trusted server identity/session binding; never trust client-supplied UID, price or entitlement.
- Server-owned product catalog and fresh conversion rates; quote binds product, currency, payer, recipient, cluster/genesis and expiry.
- External wallet signing only; verify the expected signer, exact transfer, amount and recipient. For SKR, verify token program, mint, decimals and token-account ownership.
- Atomic signature/receipt consumption and durable entitlement credit across instances; retries must not double-credit. Timeout means unknown outcome, not permission to resend automatically.
- Wrong cluster/mint, stale quote/rate, failed transaction, replay, cancellation and verifier outage must fail closed.
- Physical Seeker MWA tests, security audit and explicit release approval. Mainnet remains locked; rewards require separate score validation and settlement review.

No private keys, privileged Firebase credentials or private RPC tokens belong in `VITE_*`: Vite exposes them to clients. See [economy](economy.md), [judge guide](hackathon/judge-guide.md) and [readiness](hackathon/readiness.md).
