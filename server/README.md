# Identity core — NOT a deployed backend

Node 22 built-in crypto core and thin injected Admin SDK-compatible adapters. No HTTP listener, client/app imports,
production memory store, grants, scores, referrals, payments or mainnet support.

## Batch32 stage2 — LOCAL SDK HTTP integration PASS, not production clearance

- Main41617/b3ac40 terminal exit0:10/10 PASS,9419.2931ms; actual SDK HTTP parent7966.54ms. SDK token → loopback HTTP challenge/Ed25519 complete → cross-instance Firestore reads; concurrent consume commits once, wrong token/UID/signature/replay and TTL/rate failures leave bindings absent as tested.
- Stage1 strict DTO retained; main pure guard6/6 PASS. Test-only explicit opt-in permits exactly127.0.0.1:18089 in addition to unchanged8089/9099; repeated default runtime guard installs neither revoke nor widen it. Listener binds127.0.0.1, bounded headers/timeouts, closes in finally; production factory still rejects emulators.
- Node diagnostics blocked0/metadataWarnings0; run-owned fixture cleanup and CLI emulator shutdown complete (standard Firestore SIGKILL shutdown warning). Demo-only, no ADC/production credentials; Node guard is not OS isolation. Main rerun script: `npm --prefix server run test:identity-http-emulator` inside the existing guarded Java21/CLI emulator command.
- Production listener/client integration, score admission/gameplay replay verification/payment/security clearance remain PENDING. Verified DEBUG APK31 unchanged. Evidence main; docs-only update, no rerun.

## Batch32 stage1 — injected transport only

`createIdentityTransport({ service, expectedHost, limits? })` returns `{ handler, active, close }`;
no import-time listener or SDK initialization. Exact POST challenge/complete routes, bounded
headers/body/deadlines/admission, strict output DTO; timeout/disconnect retains operation slot
until actual settlement, with unknown outcome and no automatic retry. Main a6547f exit0:28/28
combined unit PASS; source review2e7d69 narrowly accepted. Worker f60ccd30/30 additionally
includes2 source-policy guards:11 transport +10 identity +7 adapters +2 policy. Tests use real
Node loopback HTTP/Ed25519 core and test-only memory, not Firebase transport integration.
Stage2 LOCAL SDK HTTP evidence is above; no production HTTP listener/client or payment enablement.
Existing batch28 SDK evidence and current verified DEBUG APK31 are unchanged; security gates OPEN.

Run locally from project root:

```powershell
node --test server/identity.test.mjs
node --test server/firebaseAdapters.test.mjs
node --check server/identity.mjs
node --check server/firebaseAdapters.mjs
```

`createIdentityService({ authenticateToken, store, config, now? })` requires trusted
server configuration `{ audience, origin, cluster }`: a canonical HTTPS origin,
an explicit audience and **devnet/testnet only**. Purpose is fixed by the core.
UID comes exclusively from `authenticateToken(token).uid`, never request fields.
Issue schema is exactly `{ wallet }`; complete schema exactly
`{ challengeId, signature }`. Sign the returned UTF-8 message exactly; signature
must be canonical padded base64 of 64 bytes. Wallet must be canonical base58 of
32 bytes, at most 44 characters. Challenges use crypto.randomBytes(32), TTL5min,
and an atomic sliding limit5/min per UID. Consuming the challenge and writing
UID→wallet / wallet→UID are one transaction; existing ownership cannot change.

## Missing runtime prerequisites / trust boundary

Batch28 adds shared `firebaseSdkBridge.mjs` with a mandatory synchronous privileged
guard, checked at construction, each operation/retry and after awaited SDK work.
Production `createFirebaseAdapters` still rejects both emulator env variables, even empty.
`emulatorIdentityRuntime.test-support.mjs` is test-only; never import it into the app/runtime.
Its owner credential is an emulator marker, not ADC/service-account authentication.
Firestore uses the official SDK class exported by firebase-admin/firestore with
explicit demo project/loopback host; getFirestore(app) rejects custom credentials.
Final LOCAL SDK integration main18866/terminal0ada97 exit0:11/11 PASS,15.176sec;
real SDK cross-instance persistence/concurrency/TTL/rate/rollback and network negatives.
Node diagnostics:blocked0/metadataWarnings0; run-owned cleanup and shutdown complete.
This is demo emulator proof, not production Auth/IAM/OS-network/payment clearance. Rerun:

```powershell
npm --prefix server install --ignore-scripts --no-audit --no-fund
firebase emulators:exec --only firestore,auth --project demo-seeker-td --config server/emulator.firebase.json "npm --prefix server run test:identity-emulator"
```

Requires exact demo project/loopback Firestore8089/Auth9099, known Java21/cache settings,
no GOOGLE_APPLICATION_CREDENTIALS. Optional CLI FIREBASE_CONFIG must be inline plain JSON
of at most1024 chars with exactly3 own fields: exact demo projectId, canonical demo appspot bucket/firebaseio URL;
unknown keys, file paths and other projects rejected. Diagnostics expose field names only.
Pin firebase-admin14.5.0 is dev-only.
Server-only Firebase12.19.0/rules-unit-testing5.0.2/Admin14.5.0 installed by main;
updated audit still7 issues (2 moderate/5 high), release gate OPEN; no major overrides.
The test uses real client sign-in/Admin verifyIdToken(true), ephemeral Ed25519 keys and
actual SDK transactions; timeout120s, SDK default bounded retries. It tracks exact
run-owned document paths/user UIDs for cleanup: no clearFirestore/database/account wipe.
SDK-emulator persistence across instances is not production durability/IAM/Auth proof;
unsigned emulator tokens must never be accepted by production construction.
First main emulator run39105/0ce311:9/9 PASS, cleanup/shutdown complete, but metadata
lookup warnings mean no-ADC/no-outbound proof was NOT accepted. Test-only guard now sets
supported METADATA_SERVER_DETECTION=none before SDK imports and rejects other values;
HTTP/TCP/fetch default permits only127.0.0.1:8089/9099; stage2 test-only explicit initial opt-in also permits exact18089. External DNS attempts fail sticky at exit.
This is Node instrumentation, not an OS network sandbox. Final rerun evidence is above;
prior39105/0ce311 is historical, not the accepted no-metadata result.
Main updated server audit still7 issues (5 high/2 moderate), security gate OPEN;
no Firebase downgrade or unsafe major uuid/gaxios/grpc override applied.

The injected auth function is privileged infrastructure, NOT a JWT decoder or
client-claims callback. The thin injected Firebase Admin adapter uses
`verifyIdToken(token, true)` under the correct configured Firebase project,
including revocation/disabled-user checks. Credentials must remain server-side.
SDK-boundary mocks and separate test-only real SDK emulator integration are tested.
Production credentials/Auth and durable production persistence have NOT been exercised.
Separate local Firestore rules emulator tests passed in batch22 (below).
The adapter itself does not install, initialize or import an Admin SDK.

`createFirebaseAdapters({ projectId, firebaseAuth, firestore })` returns
`{ authenticateToken, store }` for injection into `createIdentityService`.
Both injected SDK objects must belong to the trusted project; verified `uid/sub`,
`aud` and exact Firebase `iss` must match. `verifyIdToken(token, true)` checks
revoked/disabled sessions through the real Admin SDK when wired in future runtime.
No JWT decoding or standalone client claims are accepted.
Factory and runtime guards reject FIREBASE_AUTH_EMULATOR_HOST and
FIRESTORE_EMULATOR_HOST whenever defined (even empty); there is no emulator opt-in.
Auth emulator unsigned tokens must never be mistaken for production verification.
Injected object's true Admin SDK provenance cannot be established by duck typing;
trusted host wiring remains mandatory. Production boundary tests use mocks; the separate
test-only constructor exercises Admin Auth/Firestore SDKs against demo emulators only.

Keys are strictly canonical encoded hex identifiers under challenges/rates/uids/wallets,
mapped only to private identityChallenges/identityRates/identityUids/identityWallets
collections. Reads use SDK transaction.get(db.doc(path)); writes use only
SDK transaction.set. The adapter returns runTransaction's result after commit,
recreates wrapper state for each conflict retry, and forbids reads after writes.

`store.transaction(callback)` must provide `tx.get(key)` (missing = undefined/null)
and `tx.set(key, value)` with durable serializable isolation across all instances.
All reads precede writes. Commit all writes together ONLY after callback success;
throw/rejection must roll back every write. Return callback output only after
successful commit. Conflict retries must rerun the callback against fresh data;
expiry is checked on each completion attempt and again after all binding reads,
immediately before the writes (including store delays across TTL). Nonce is generated outside the
retriable callback. UID paths are hex encoded. Challenge/rate/binding collections
are server-only: clients must never write them. Store rollback/commit semantics
are prerequisites, not something this core can enforce on a malicious adapter.

The thin Firestore adapter is implemented but real durable/production behavior
remains unverified. SDK initialization/credentials, IAM/rules, transport authentication,
origin enforcement, logging without tokens/signatures, operational rate limits,
cleanup/retention and deploy review remain future work. The in-memory adapter is
defined **only in tests**, with no app import. Offline tests do not establish
Firestore behavior, production persistence or deployed backend readiness.

## Local semantic rules emulator — batch22 PASS, not a deployed backend

Main batch21 identity+adapter+source-policy tests:19/19 PASS, terminal exit0 bae836;
syntax checks ab4244 PASS. Main installed86 server test packages, exit0; safety
7fce57 2/2 PASS. Actual `firebase emulators:exec` session63706/terminal1877c9 exit0:
6 tests PASS/0 FAIL, Firestore1.21.0, project `demo-seeker-td`, `127.0.0.1:8089`.
Unauthenticated/owner/other UID attempts exercised public players get/list,
denied players/identity/private writes and private reads; fixture preservation
passed in all3 contexts. Emulator shutdown completed.

Workspace JAR size138093843 bytes, SHA256
`C3D3680A89D946A90A027365EA14C26C6472A162BCF37F099BBB1EBD66D25E8E`.
`emulator.firebase.json` uses loopback Firestore/websocket/hub/logging and disables UI;
its rules path is relative to this config: `../firestore.rules`.
`emulatorSafety.mjs` rejects non-demo project/non-exact loopback endpoint before SDK
initialization and before clearing demo fixtures. The test bypass is used only for
fixture setup/inspection; it is not a client permission or identity adapter opt-in.

Rerun from project root with known Java21/workspace emulator-cache environment:

```powershell
firebase emulators:exec --only firestore --project demo-seeker-td --config server/emulator.firebase.json "npm --prefix server run test:emulator"
```

Batch22 proves local rules semantics only; batch28 LOCAL SDK integration evidence is above.
Production Firebase Auth/durability, credentials/IAM, listener/client registration and
deploy remain PENDING. No cloud/deploy/mainnet action; latest native DEBUG APK is batch33,
9,539,282 bytes, SHA256 `38DCF11F1B7483E04F0150C4A5B08D598150DB09A3E71774F92DC38E70B59DF5`.
Main syncbeb5d2 PASS1.028sec; assemble0391de PASS2sec,82 tasks/23 executed; verifye5deff: signature PASS
(37 standard metadata warnings),517 current dist files byte-equal APK PASS. Current
dist/native/APK33 match; APK31 historical/superseded. Node Admin SDK is not in app/native; server SDK remains batch28.
This is debug packaging, not production/device/full-visual acceptance. Batch30
3EE6A997…97CFC3 and batch29
8DA86AB7…FFDD8 is superseded; batch28
64C234A9…22FE1 and batch27 7D9CB11E…2DECB are superseded; F309… remains historical batch19.
Full graphics/readability/device/release/security/backend gates remain OPEN.

Official reference contracts verified by main (not fetched by this offline worker):
[Node 22 crypto.verify](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptoverifyalgorithm-data-key-signature-callback),
[Firebase verify ID tokens](https://firebase.google.com/docs/auth/admin/verify-id-tokens),
[Firebase manage sessions/revocation](https://firebase.google.com/docs/auth/admin/manage-sessions),
[Firestore transactions](https://firebase.google.com/docs/firestore/manage-data/transactions),
[Firebase Auth emulator connection](https://firebase.google.com/docs/emulator-suite/connect_auth).
Local installed Node crypto type documentation and real Ed25519 tests were used;
Main verified verify-id-tokens/manage-sessions/transactions/connect_auth documentation;
production Firebase integration remains pending. Binding proves only
authenticated UID control of a signing key, not identity uniqueness, humanhood,
trusted scores, reward eligibility or payment entitlement.

## Batch34 stage2: LOCAL actual SDK shadow admission PASS

- Main emulator71246/420bd0 exit0:ALL12 PASS,14028.313ms (actual parent12594.1797ms). Two real SDK instances +client Auth token/real Ed25519 binding:6 same-key requests debit once (3904.98ms); different-key one-active/UID isolation/no entitlement (3298.45ms); expired/corrupt state (438.09ms), wrong binding (99.68ms), actual SDK precommit callback rollback (427.86ms). Mock commit failures remain unit-only evidence.
- Node diagnostics blocked0/metadataWarnings0; tracked fixture cleanup and CLI shutdown complete (standard Firestore SIGKILL warning). Main e1712b confirms no8089/9099 listeners. NOT HTTP admission, production Auth/IAM, replay, payment or security clearance.
- Main commands079f02:8/8 PASS,47 actions/12 models, no UI integration; these new tests are outside8834 ALL48 inventory. Source frozen; native/APK33 remains previous verified artifact, open gates retained.
- Latest main12968/9596ce exit0:ALL49 PASS (TS22+CJS27), includes frozen commands+timing, predates new chunk-task files: NO chunk coverage claim. Build22490/7be291 exit0 PASS:275 modules, App654.91kB/169.25kB gzip,7.53sec. No new native build; APK33 remains previous verified artifact.

## Batch34 stage1: shadow admission core + isolated SDK store (unit evidence)

- Main c942e7:9/9 PASS; combined4dbc36:37/37 PASS. Injected verified-UID mock and test-only atomic memory cover idempotency, one active run, rollback, binding and clock/TTL guards; expired active stays blocked.
- Isolated privileged SDK transaction store implemented; identity paths read-only, writes only four shadow namespaces, bounded records/operations and poisoned transactions. Main d746aa exit0:17/17 PASS (mock SDK8+core9), sourcecc390f reviewed; NOT actual SDK/emulator admission integration evidence.
- Main8834/251096 exit0:ALL48 PASS (TS22+CJS26), timing4/4 on1296 frames, timing source frozen; new command tasks outside this inventory. Build36234/d56241 exit0 PASS:275 modules, App654.91kB/169.25kB gzip,8.85sec.
- Replay/server modules not runtime UI; main823df6 primary App/native `4DC76308…AD130` equal is a narrow comparison, NOT full APK parity rerun. No new sync/assemble; APK33 remains the previous verified artifact. Shadow protocol placeholder is not replay; HTTP admission/real entitlement/payment/deploy gates remain open.
