# Operator-only devnet test assets

`server/devnet-assets.mjs` prepares a **custom classic SPL test token, NOT official SKR**.
It has no real value, does not create SKR branding/metadata and only accepts devnet.
This separate CLI is not imported by the application or commerce API. It never takes
custody of end-user wallets. Merchant ATA provisioning is setup, **not part of purchase**.

## Prerequisites and private storage

The operator may be an authorized person **or an agent acting on explicit operator
authorization**. Signing requires separately supplied, dedicated devnet-only keys.
No secret generation or real setup was performed as part of this implementation.

- Supply four distinct on-curve public keys: dedicated fee-payer/mint-authority operator,
  dedicated new mint keypair, merchant test wallet, and independently controlled test payer.
  Never reuse production, treasury or end-user keys. CLI does not need or accept merchant
  or test-payer secrets; purchases use the test payer's normal wallet signing flow.
- Operator and test payer must already have test SOL. The tool fails closed if either
  is insufficient; it does not fund these wallets and never requests an airdrop.
- Place `server/devnet-assets.env.example` **outside every Git repository** as an
  absolute-path `private.env`, e.g. `C:\Users\User\seeker-devnet-private\private.env`.
  Fill public addresses and explicit integer supply/decimals. Dry-run allows empty secrets.
  For execute, privately supply existing 64-byte Solana JSON secret arrays for operator and,
  only when creating a new mint, mint. Never put secrets in CLI args, stdout, repo,
  chat/issues, application runtime env, or a synced/shared directory.
- POSIX: operator ownership, parent permissions 0700 and file 0600. Windows: current-user
  owner, protected ACL/inheritance disabled on parent **and** file, Allow only current SID
  and SYSTEM. Read-only permission checks reject broad access; CLI does not repair ACLs.
  File symlinks and all Git repository locations, including worktrees, are rejected.
- Only this private file supplies configuration. The strict parser rejects unknown/duplicate
  variables, shell syntax and multiline values; no shell expansion or `process.env` merge.
  No mainnet/env/genesis override exists. **No guaranteed zeroization**: JavaScript strings
  and SDK internals may retain secret copies despite best-effort buffer clearing. This is a
  transient operator CLI, not a long-running secret service. Protect the host and process.

## Dry-run and explicitly authorized execution

From the project root, using existing Node and `@solana/web3.js` (no new dependencies):

```powershell
node server/devnet-assets.mjs --private-env 'C:\Users\User\seeker-devnet-private\private.env'
```

Default dry-run makes **read-only** RPC calls, verifies state and prints public addresses,
actions, rent, fee and bounded funding amounts. It never signs, sends, simulates or writes
a submission receipt. Review those before explicitly authorizing execution:

```powershell
node server/devnet-assets.mjs --private-env 'C:\Users\User\seeker-devnet-private\private.env' --execute
```

The flag enables one atomic setup transaction. A fresh mint receives create-account,
InitializeMint2, missing canonical ATAs and MintToChecked to the dedicated test payer ATA.
Mint authority is retained by the operator for the pilot; freeze authority is absent.
Existing mints are **never minted again**: authority, decimals and total supply must exactly
match the initial target, otherwise execution refuses. ATA balances may change after tests.
Creation prevents double supply even if stale RPC reports an existing mint as absent:
the competing create-account instruction fails the entire transaction atomically.

Native SOL recipient is the merchant **system wallet**, not its ATA. A new/underfunded
merchant is preprovisioned before purchases: a separate transfer instruction adds only
the deficit to `max(DEVNET_ASSETS_MERCHANT_MIN_LAMPORTS, rent(0))`, default 0.001 test SOL,
target cap 0.01 test SOL, within the same atomic transaction/total spend cap.
Already funded merchants receive no extra SOL. No mainnet assets are transferred.

## Guards, limits and ambiguous results

- Operator-supplied HTTPS RPC only; redirects forbidden. Credentials/URL and RPC error
  bodies are never logged. RPC must be trusted: genesis checking cannot detect a malicious
  provider fabricating all responses.
- Exact devnet genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` is checked
  before state reads and again immediately before loading secrets/signing. No bypass.
- Classic Token Program only: mint 82 bytes, initialized, exact authority/decimals/supply,
  no freeze authority. Canonical ATAs 165 bytes: verify program owner, embedded wallet owner,
  mint, Initialized (not Frozen), no delegate/native/close authority and rent exemption.
  Merchant system account and test-payer SOL balance are checked separately.
- Decimals 0..9, initial supply 1 base unit through 1,000,000 test tokens, integer BigInt.
  Total setup spend cap at most 0.1 test SOL. Operator reserve at least 0.001 test SOL;
  test-payer minimum default 0.01 test SOL. Exact unsigned-message fee must be available.
- RPC timeout 1..15 s, response cap 1 MiB. Read calls get at most two attempts;
  send gets **one** attempt with `maxRetries: 0`, `skipPreflight: false`. No rebroadcast.
  Finalization uses at most 20 bounded status/height polls, then account verification.
  Total runtime can exceed one request timeout; every attempt/poll is bounded.

Before broadcast, exclusive immutable `private.env.devnet-assets.receipt.json` is saved
beside the private env, **outside Git**. Only public signature/config binding, never keys
or a signed transaction. File fsync precedes sending; POSIX also fsyncs the parent.
Windows uses file fsync; durability depends on preserving the local disk/receipt.
This is a submission guard, **not a coordinator, scheduler or retry queue**.

If a receipt exists and more instructions are needed, execute refuses even when finalized
state still shows no mint. Exclusive claim also prevents two sends using one private-env path.
Do not delete receipts/change paths to bypass the guard. Failure after claim but before send
intentionally requires investigation. Fully prepared existing state is a read-only no-op;
dry-run remains available for inspection.

For unknown/expired/send-error/post-verification results, retain the public signature printed
before send. An explicitly authorized operator/agent can inspect signature and devnet
mint/ATAs through trusted read-only tools, then dry-run. **Do not blindly retry execute**.
No global coordination exists across copied env files, deleted receipts or different hosts.
Later minting, merchant top-up or ATA repair requires a separately reviewed operator workflow.

## Public handoff

Outputs contain public asset information and costs/signature, never raw secrets or signed
transactions. Useful existing inputs are `COMMERCE_RECIPIENT` (merchant wallet, **not ATA**),
`COMMERCE_SKR_MINT` and `COMMERCE_SKR_DECIMALS`. Set cluster/genesis to devnet in a separate
authorized handoff. Despite the existing field name, this is **not real or official SKR**.
RPC credentials remain private; rates/catalog/backend/app settings are separate work.
The CLI does not modify application `.env`, `src`, `ops`, package/lock files, perform purchases,
deploy anything or execute mainnet operations.

## Offline focused tests and official references

```powershell
node --test server/devnet-assets.test.mjs
```

Fixtures/mock RPC only: no live calls, keys generated for real identities, funding or emulator
integration. Covers wire formats, actual JSON key loading/signature verification, canonical
accounts, wrong genesis/HTTPS/owners/decimals/status/supply, insufficient SOL, dry-run/no signing,
single send/ambiguity guard, safe logs and import without network side effects.
Live chain integration, host ACL behavior and persistent receipt durability require later
explicitly authorized operator verification.

- [Official Token interface instruction.rs](https://github.com/solana-program/token/blob/main/interface/src/instruction.rs):
  InitializeMint2 tag 20: `[tag u8, decimals u8, authority 32 bytes, None u8=0]`, 35 bytes.
  MintToChecked tag 14: `[tag u8, amount u64 LE, decimals u8]`, 10 bytes.
  Instruction COption uses u8; account-state COption uses u32 LE.
- [Official Token interface state.rs](https://github.com/solana-program/token/blob/main/interface/src/state.rs):
  mint 82 bytes; authority 0, supply 36, decimals 44, initialized 45, freeze 46.
  Token account 165 bytes; mint 0, wallet owner 32, amount 64, Initialized state 108.
- [Official ATA interface instruction.rs](https://github.com/solana-program/associated-token-account/blob/main/interface/src/instruction.rs)
  and [address.rs](https://github.com/solana-program/associated-token-account/blob/main/interface/src/address.rs):
  CreateIdempotent `[1]`, metas: funder signer/writable, ATA writable, wallet, mint,
  System Program, classic Token Program; PDA seeds `[wallet, token program, mint]`.

Verified against official source interfaces during implementation. Links reference mutable
`main`; tests pin verified bytes/layouts locally without fetching code or adding deps.
