# Commerce: Firebase + DEVNET, интеграционный checkpoint

Код подготовлен и проверяется локально; это не работающий cloud-сервис и не production-аудит.
Никаких deploy, cloud resources, mainnet расходов, swap, payout или отправки транзакций backend не выполняет.
`src`, существующие identity/runAdmission и исходные Firestore rules не изменены.

## Каталог и пилотные цены

Без env сервер показывает все шесть SKU без prices и с `enabled: false`.
Цены — гипотезы для пилота, не доказанный спрос. Один товар даёт только runs ИЛИ STD.
STD — внутренний счётчик для будущих lives/skins; не SPL token и не валюта API оплаты.
Текущие 50 STD continue / 5 за wave / 50 daily не изменяются этим backend и здесь не начисляются.

`COMMERCE_CATALOG_JSON` — неизменяемый server-env snapshot при старте runtime:

```json
[
  {"id":"runs-1","usdCents":25,"runs":1,"std":0,"enabled":false},
  {"id":"runs-3","usdCents":65,"runs":3,"std":0,"enabled":false},
  {"id":"runs-10","usdCents":195,"runs":10,"std":0,"enabled":false},
  {"id":"std-500","usdCents":99,"runs":0,"std":500,"enabled":false},
  {"id":"std-1500","usdCents":249,"runs":0,"std":1500,"enabled":false},
  {"id":"std-4000","usdCents":599,"runs":0,"std":4000,"enabled":false}
]
```

Для включения используйте [commerce-env.example](commerce-env.example): SKU enabled=true, но без остальных
настроек покупка всё равно закрыта. Реальные ключи не нужны backend; signing key никогда не принимается.
Секреты — только в приватной `.env` / управляемой runtime environment, не в Git.

## Настройка отдельно от интеграции

Firebase runtime требует `COMMERCE_FIREBASE_PROJECT_ID` существующего проекта и `COMMERCE_IDENTITY_ORIGIN`.
Firebase Admin использует ADC, `verifyIdToken(token, true)` проверяет revocation, project/aud/iss/sub/uid.
Для Android origin = `https://localhost`; CORS и canonical identity challenge используют один и тот же origin.
Для browser deployment задайте фактический HTTPS origin. Клиент не может менять audience/origin/cluster.

Оплата дополнительно требует:

- `COMMERCE_CLUSTER=devnet` — единственное допустимое значение, mainnet заблокирован без env bypass.
- `COMMERCE_GENESIS_HASH=EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` — только полный точный hash.
- `COMMERCE_RPC_URL` — операторский trusted HTTPS endpoint DEVNET; POST only, timeout 8 s, redirect запрещён.
- `COMMERCE_RECIPIENT` — merchant public wallet; ни default wallet, ни placeholder pubkey в API нет.
- `COMMERCE_SKR_MINT` и `COMMERCE_SKR_DECIMALS` — классический SPL **custom test mint на DEVNET**.
- `COMMERCE_RATES_JSON` — положительные integer-string numerator/denominator, timestamp Unix ms и TTL ms.
- `COMMERCE_QUOTE_TTL_MS` — default 300000, допустимо 1000..600000 ms.

Формат rates: `{ "SOL": { "numerator": "...", "denominator": "...", "timestamp": 0, "ttlMilliseconds": 900000 }, "SKR": { ... } }`.
Значения `...` нужно заменить операторскими целыми числами, timestamp — свежим; это схема, не рабочий курс.
Единица курса: **base units за один USD cent** = numerator / denominator.
Цена `ceil(BigInt(usdCents) * numerator / denominator)`, uint64 decimal string; без floats, client FX или oracle.
TTL курса 1 s..1 h, рекомендуемый pilot snapshot 15 min. Будущий/stale snapshot закрывает новые quotes.
Quote expiresAt = min(now + quote TTL, FX expiry). Уже выданный quote не переоценивается при новом env snapshot.
Для обновления env требуется перезапуск runtime; автоматического FX feed/renewal здесь нет.

DEVNET API возвращает `currency: SOL|SKR`, но UI обязан явно писать **test SOL / test SKR**, не real SKR.
Официальный mainnet CA `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3` приведён только как справка из
[Solana Mobile](https://solanamobile.com/skr), не используется как DEVNET mint/default.

Merchant destination ATA должен быть заранее подготовлен отдельным авторизованным действием.
Catalog/SKR quote проверяют mint и этот canonical ATA: Token Program owner, mint, merchant owner,
decimals, initialized/non-native account; mint initialized, classic 82-byte, freezeAuthority=null.
Если ATA отсутствует/невалиден, SKR prices исчезают, SKR quote закрывается. SOL остаётся доступным при валидной сети/FX.
Клиент **не создаёт merchant ATA** и не платит его rent в purchase transaction.

## HTTP контракт для main / Bernoulli

`GET /commerce/catalog` публичный, no-store:

```json
{
  "enabled": false,
  "reason": "COMMERCE_NOT_CONFIGURED_OR_RATE_STALE",
  "cluster": "devnet",
  "genesisHash": null,
  "recipient": null,
  "products": [{"id":"runs-1","title":"1 extra run","runs":1,"std":0,"usdCents":25,"prices":[]}]
}
```

Здесь показан один product для компактности; default response содержит все шесть.
Enabled price: `{currency: "SOL"|"SKR", amount: string, decimals: number, mint: string|null}`.
`reason=null` при enabled=true. Nullable genesis/recipient разрешены клиентом **только при enabled=false**.
Catalog проверяет RPC genesis и доступность SKR ATA; quote проверяет снова.

Все POST: `Authorization: Bearer <Firebase ID token>`, `Content-Type: application/json`, exact schema:

- `/identity/challenge` `{wallet}` → `{challengeId,message,expiresAt}`.
- `/identity/complete` `{challengeId,signature}` → `{uid,wallet,cluster}`; signature здесь Ed25519 **base64** message proof.
- `/commerce/quote` `{productId,currency,payer}` → quote ниже; UID→wallet и wallet→UID проверяются внутри transaction.
- `/commerce/receipt` `{quoteId,signature}` → receipt; signature здесь canonical **base58** 64-byte transaction signature.

Quote exact fields:
`{id,productId,currency,amount,decimals,mint,recipient,payer,cluster,genesisHash,expiresAt,runs,std,memo}`.
`id` — 32 lowercase hex; `memo = SEEKER:TD/commerce/v1/${id}`.
Receipt — все quote fields плюс `{quoteId,signature,status:"confirmed"}`; `id=quoteId`.
Существующий identity service/SDK bridge переиспользованы, proof не ослаблен. Native requests могут не иметь Origin.

При недоступности RPC/store ответ 503; при повторе receipt отправлять **тот же quoteId/signature**.
Operation timeout не означает откат SDK commit: receipt можно безопасно запросить повторно.
Не обновлять quote и не платить повторно после неоднозначного сетевого ответа.

## Верификация и позднее подтверждение

Принимаются legacy и v0 **без ALT/loaded addresses**, source=transaction, один payer/signer и одна подпись.
В транзакции ровно один native System transfer ИЛИ SPL `TransferChecked`, один точный quoted memo;
до двух разных canonical compute budget instructions допустимы.
Сопоставляются amount, mint, decimals, owner, authority/signer, fee payer, canonical source/destination ATA.
Проверяются finalized status, slot, on-chain meta.err=null, genesis до/после RPC чтения.
Сверяются все native balance deltas с payment+fee и оба исторических token balance deltas/owners/mint/program.
CPI/inner instructions, extra/ambiguous transfers, ATA create/rent, nonce/account close, Token-2022, swaps запрещены.
Это намеренно узкий платёжный профиль, не общий transaction verifier.
Протокол TransferChecked описан в [Solana token docs](https://solana.com/docs/tokens/basics/transfer-tokens).

Время платежа: `floor(issuedAt/1000) <= blockTime` и `blockTime*1000 < expiresAt`.
Начало округляется к секунде из-за RPC blockTime resolution; непредсказуемый memo nonce предотвращает оплату старым tx.
Receipt можно подать после quote/FX expiry, если платёж в этом окне; null blockTime не принимается.
Receipt использует **исторические** pre/post token metadata и не читает текущее состояние ATA.
Позднее закрытие source или merchant ATA не лишает уже оплаченного права. Требуется RPC history retention.
Повтор сохранённого receipt не требует RPC и не начисляет повторно, но owner binding снова проверяется.

## Firestore: единый server credit source

Новые приватные collections: `commerceQuotes`, `commerceReceipts`, `commerceSignatures`, `commerceBalances`,
`commerceLedger`, `commercePools`. UID IDs — canonical UTF-8 hex; quote/receipt/ledger IDs — quote hex;
signature claim ID — SHA-256(signature), глобальный внутри этого backend, с UID/quote/signature в record.
Баланс `{runs:string,std:string}` — uint64 decimal counters, без client/local/mock начислений.
Receipt+global signature claim+оба counters+ledger+pool фиксируются **одним Firestore SDK transaction**.
Все reads до writes; quote/bindings повторно читаются после RPC; retries не удваивают credit.
SDK bridge ограничивает paths, records, privilege/project, escaped handles и swallowed failures.
Покупки не пишут `players`, shadow entitlements или runAdmission.

Только run purchases: 10% в исходной currency. Ledger хранит точный numerator/10.
Pool агрегирует eligiblePurchaseBaseUnits, poolBaseUnits=floor(total/10), remainderTenths=total%10,
поэтому rounding dust не теряется при нескольких покупках. STD packs contribution=0.
SOL pool status=`pending_SOL_conversion`; SKR=`SKR_reward_pool`. SOL не выдаётся как SKR без будущей conversion.
Reward payouts, conversion и STD spending не реализованы. Это ledger, не payout authorization.

`commerce.firestore.rules` — локальная копия исходной политики: players read, все client writes и приватные reads запрещены.
Она нужна потому, что Firebase CLI не разрешает rules вне project directory `server`.
Исходный `../firestore.rules` не редактировался; при будущих policy changes обе копии нужно согласовать.

## Standalone Node HTTP: Spark without Cloud Functions

Start from `server` after configuring the private runtime environment:

```sh
npm run start:commerce
```

The `commerce-node.mjs` entry reuses `createCommerceFirebaseRuntime` and `createCommerceHttpHandler`.
It never imports `index.mjs`, calls `createFirebaseCommerceFunction`, or registers Functions.
Importing the entry does not access ADC, initialize Firebase SDK, contact RPC/network, or open a listener;
only direct CLI execution starts the runtime. Handler injection is for offline transport unit tests only.
The executable always uses the real factory, without a mock auth/store/verifier fallback.
Existing `firebase-functions` dependencies and the Functions entry remain unchanged.

This is an external Node process, not free Firebase-managed compute. Spark stays unchanged:
no Functions deploy or Blaze upgrade is required, and Auth/Firestore remain subject to project quotas.
Quota exhaustion or IAM failures can disable purchases; there is no automatic billing upgrade.
See [Firebase pricing plans](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans).

Prerequisites:

- Dedicated **Node 22** and existing locked server dependencies; preserve the host's shared Node runtime.
  The standalone entry rejects Node <22. POSIX file-privacy checks require Linux deployment;
  Windows ACL privacy is not assumed.
- An existing Firebase project on Spark with Auth and Firestore configured, identified by `COMMERCE_FIREBASE_PROJECT_ID`.
- Trusted ADC for that project, with the required existing Admin auth/store permissions, outside the repository.
  Set `GOOGLE_APPLICATION_CREDENTIALS` explicitly to `/etc/seeker-td/credentials/firebase-admin.env`
  (or another absolute private `.env` path). The file contains service-account **JSON**, not shell assignments;
  ADC is extension-agnostic. The launcher checks an owned file ≤64 KiB in a trusted directory,
  rejects symlinks/other-read/group-write, and requires an RSA key ≥2048 bits.
  Both `project_id` and the client-email project must match `COMMERCE_FIREBASE_PROJECT_ID`.
  Authorized-user/external-account credentials are not accepted here. Metadata detection is forced to `none`
  **before** SDK import; no managed-ADC fallback. The shared Functions factory is unchanged.
  These checks do not prove live credentials/IAM; see [Firebase Admin setup](https://firebase.google.com/docs/admin/setup).
- `COMMERCE_IDENTITY_ORIGIN`: the exact HTTPS client origin (`https://localhost` for Capacitor Android).
- Quotes/payments additionally require enabled SKUs and the full trusted **DEVNET** SOL/SKR configuration above:
  genesis, HTTPS RPC, recipient, fresh rates; SKR also needs a test mint/decimals and a prepared merchant ATA.
  Without these, the catalog can remain disabled; successful `/ready` does not enable purchases.

The Admin SDK uses the existing privileged IAM/store bridge, not client Security Rules.
Project/identity binding, revoked-token verification, the verifier, and transaction invariants are preserved;
Firestore rules and client permissions are unchanged. No mainnet, transfers, or bypass flags are introduced.

Transport:

- Bind **only `127.0.0.1`**, default `8787`; public, IPv6, and DNS bind addresses are rejected.
  `COMMERCE_NODE_PORT` allows 1..65535. Do not expose the loopback port through a firewall.
- Exact paths/methods and Host `127.0.0.1:<port>` are enforced. Raw duplicate headers (including Authorization/Origin),
  cookies/proxy auth, compression, Expect/Upgrade, and declared/actual trailers are rejected.
- Headers ≤20 KiB and ≤128 fields. Raw JSON body ≤**4096 bytes** before the parsed handler, including chunked bodies:
  oversize 413; malformed JSON, invalid UTF-8, BOM, or invalid schema 400. Native Origin may be absent;
  when present it must match the configured origin. OPTIONS requires route-specific CORS preflight validation.
- Default concurrency **16** (`COMMERCE_NODE_CONCURRENCY`, 1..16), including body reads.
  Timeout/disconnect **do not release** admission until the handler/service promise settles; new operations receive 503.
  An HTTP timeout cannot cancel an SDK commit: retry the same receipt, never pay again because of an unknown outcome.
- Absolute body deadline 5 s (`COMMERCE_NODE_BODY_MS`, ≤10 s), headers 5 s
  (`COMMERCE_NODE_HEADERS_MS`, ≤10 s), operation 45 s (`COMMERCE_NODE_OPERATION_MS`, ≤45 s).
  Slow bodies receive 408 or a connection reset; drip traffic does not extend the deadline.
  HTTP parser/request/socket timeouts, 64 sockets, and one request per socket supplement admission.
- `GET /ready`: private constructed-runtime/admission readiness (200 or 503), **not chain/payment/live-ADC readiness**.
  It does not contact cloud/RPC, reveal environment/configuration, or belong on the public nginx endpoint.
- SIGINT/SIGTERM stop new traffic and drain active work for up to 55 s
  (`COMMERCE_NODE_SHUTDOWN_MS`, ≤60 s); after the deadline sockets close and the CLI exits with code 1.
  No rollback or known-commit-outcome guarantee. Emulator environment variables are rejected at startup and admission,
  including Auth/Firestore/Storage/Database/Hub/PubSub.

Templates only, no deployment: [ops/commerce/README](../ops/commerce/README.md),
`seeker-td-commerce.service.example`, `nginx-commerce.conf.example`, `commerce.env.example`.
They require an isolated system user, dedicated absolute Node 22 path, private env/ADC outside Git,
Certbot TLS for the confirmed domain, and **`sudo nginx -t` before every reload**.
Production Node/systemd/nginx were not changed here; Linux validation and proxy probes remain pre-deployment work.

Offline checks from `server`:

```sh
npm run test:commerce-node
npm run test:commerce
```

Tests make real loopback HTTP/socket requests for routes/parsing/limits, duplicate auth/origin/framing,
CORS/methods, slow body/headers, admission after timeout/disconnect, aborted bodies/trailers/BOM,
stop/drain/deadlines, startup preflight, and side-effect-free import in a separate process.
Auth/Firestore/RPC fixtures are test-only, not live Firebase/DEVNET acceptance.
The offline CI list includes `commerce-node.test.mjs` and the separate worker's `devnet-assets.test.mjs`.

## Package / локальная проверка

`index.mjs` экспортирует Firebase v2 HTTPS function `commerce`; import только регистрирует function,
не инициализирует Admin и не вызывает cloud/RPC. Runtime lazy, production factory отвергает Firebase emulators.
`package.json` содержит runtime deps firebase-admin, firebase-functions, web3 (только PublicKey/PDA);
все RPC calls — собственный bounded raw JSON POST. `package-lock.json` обновлён.
`firebase.json` — package source `.` / codebase commerce / nodejs22, без deploy execution.
Firebase deployment требует отдельного разрешения owner и проверки project/Blaze/cost.
Entry/runtime разделение соответствует [Firebase dependency docs](https://firebase.google.com/docs/functions/handle-dependencies).

При будущей function URL `https://<region>-<project>.cloudfunctions.net/commerce` клиентский API base — эта URL.
Handler suffix сохраняется: `/commerce/catalog`, `/commerce/quote`, `/commerce/receipt`, `/identity/...`.
Итого function URL для catalog будет `.../commerce/commerce/catalog`; hosting rewrite может позднее убрать внешний prefix.

В папке `server`: `npm run test:commerce` — offline fixtures/security/dry import, emulator test default SKIP.
Локальный demo test запускается только с explicit opt-in, без ADC и external network:

```powershell
$env:GCLOUD_PROJECT='demo-seeker-td'
$env:COMMERCE_EMULATOR_TEST='1'
$env:METADATA_SERVER_DETECTION='none'
Remove-Item Env:GOOGLE_APPLICATION_CREDENTIALS -ErrorAction SilentlyContinue
firebase emulators:exec --project demo-seeker-td --only auth,firestore --config firebase.json "node --test commerce-emulator.test.mjs"
```

Test harness отдельно инжектирует локальные demo SDK и RPC fixtures; production никогда его не импортирует.
Он использует реальный Auth emulator wallet challenge/proof и реальные Firestore SDK commits/retries между instances;
Solana fixtures не являются доказательством live DEVNET payment. Cleanup удаляет только созданные этим тестом demo records/users.

## Осталось до production

- Настроить и возобновлять trusted FX snapshots, историю RPC и реальные DEVNET test assets/merchant ATA.
- Определить recovery/linking anonymous Firebase UID: текущая wallet binding immutable; автоматический перенос не добавлен.
- Интегрировать commerce counters в реальные server admissions/STD debits. Существующий runAdmission shadow-only;
  покупка **не открывает commercial ranked/reward eligibility**.
- Проектировать отдельно verified gameplay rewards, SOL→SKR conversion и payout authorization/security audit.
- Получить разрешение на cloud configuration/deploy и cost review; mainnet требует нового аудита/изменения кода, не env флага.
- Dependency review: `npm audit --omit=dev` сообщает 5 moderate, 0 high/critical (web3/jayson/stream-json/uuid/gaxios).
  Автоматический major upgrade web3 не выполнялся. Backend не использует web3 Connection/jayson RPC либо uuid v3/v5/v6;
  это ограничение reachability, не утверждение об отсутствии риска. Проверить/устранить advisories до production:
  [stream-json](https://github.com/advisories/GHSA-mjw6-4jj6-33hc),
  [uuid](https://github.com/advisories/GHSA-w5hq-g745-h8pq).

## Финальный manifest

The following manifest describes the earlier checkpoint. Standalone changes are described above;
this stage changes scripts only, not dependency or lock versions.

19 новых файлов внутри `server`:
`commerce-common.mjs`, `commerce-config.mjs`, `commerce-firestore.mjs`, `commerce-functions.mjs`,
`commerce-http.mjs`, `commerce-rpc.mjs`, `commerce-verifier.mjs`, `commerce.mjs`,
`commerce.test-support.mjs`, `commerce.test.mjs`, `commerce-verifier.test.mjs`,
`commerce-integration.test.mjs`, `commerce-emulator.test-support.mjs`, `commerce-emulator.test.mjs`,
`commerce-README.md`, `commerce-env.example`, `commerce.firestore.rules`, `index.mjs`, `firebase.json`.

Изменены только `server/package.json` и сгенерированный `server/package-lock.json`.
Локальные `server/node_modules` установлены для проверки, не являются source deliverable.
Проверки checkpoint: 88 commerce tests PASS (emulator opt-in отдельно), 1 реальный Auth/Firestore emulator PASS,
58 существующих backend regression tests PASS. Live DEVNET payment/cloud deployment не проверялись и не выполнялись.
