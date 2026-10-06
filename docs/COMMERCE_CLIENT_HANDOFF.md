# Commerce client handoff — DEVNET pilot only

## Реализовано

- Новый путь `commerce.ts` / `commerceWallet.ts` / `commerceRuntime.ts`; старый `payments.ts` не изменён.
- Paywall, Wallet и Shop используют серверный каталог и SOL/SKR selector. Клиент не задаёт atomic prices и не конвертирует USD.
- `VITE_COMMERCE_URL` обязателен: HTTPS, без credentials/query/hash; redirects запрещены. Firebase ID token передаётся только как Bearer.
- Единственное дополнение Firebase: `getFirebaseIdToken()`. UID из token используется только для разделения локального кэша, не как доказательство авторизации.
- Shared wallet API: `getWalletCapabilities({signal})`, затем `signWalletTransaction(unsigned.serialize(), payer, signal)`. Общая wallet mutex/reauthorization не обходится.
- DEVNET genesis, funded system payer, test SKR mint/classic Token Program owner/decimals, source и merchant ATA ownership/mint/state/balance, fee и simulation проверяются до signing.
- Merchant ATA должен быть предварительно создан. Checkout не создаёт ATA и не добавляет rent instructions. Только transfer + signer nonce memo; native/SPL суммы — bigint.
- Legacy/v0 выбираются по capabilities. Signed message/signature проверяются, signature сохраняется до единственного `sendRawTransaction(..., {maxRetries: 0, skipPreflight: false})`.
- Receipt reconciliation не вызывает signing/broadcast. Подтверждённые receipt/quote/signature применяются один раз к display cache; бесплатные runs и pool не меняются.
- Кэш STD/paidRuns/receipt IDs разделяется по Firebase UID + payer. Новый scope начинает с нулевых приобретённых кредитов; guest scope хранится отдельно.

## Backend contracts

- `GET /commerce/catalog`: `{enabled, reason: string|null, cluster:'devnet', genesisHash:string|null, recipient:string|null, products:[{id,title,runs,std,usdCents,prices:[{currency,amount:string,decimals,mint}]}]}`. Null recipient/genesis допускаются только в locked catalog.
- `POST /commerce/quote`: `{productId,currency,payer}`. Ответ: исходные 14 полей quote; ID — 32 hex, memo — `SEEKER:TD/commerce/v1/${id}`, окно signing ≤10 минут.
- `POST /commerce/receipt`: `{quoteId,signature}`. Подтверждение включает `{id,quoteId,signature,payer,runs,std,status:'confirmed'}`; backend может echo остальные quote fields. Временные ошибки оставляют journal pending.
- `POST /identity/challenge`: `{wallet}` → `{challengeId,message,expiresAt}`.
- `POST /identity/complete`: `{challengeId,signature}` → `{uid,wallet,cluster}`.
- Signing proof проверяет точный canonical JSON и strict fields, purpose `SEEKER:TD/wallet-identity/v1`, trusted Firebase project audience, `window.location.origin`, UID/payer/DEVNET/nonce и fixed 5-minute issuedAt→expiresAt.
- Для Capacitor origin ожидается `https://localhost`. Backend должен быть настроен на этот origin; проверить CORS/OPTIONS реальной HTTP integration. Custom origin не должен обходить signed proof policy.

## Риски pending/cancel и следующие задачи

- Cancel/timeout до завершения sign-only подавляет поздний broadcast. После начала HTTP/RPC broadcast отмена не доказывает, что сеть не приняла транзакцию: нужен Check receipts.
- Crash между durable journal и broadcast также оставляет unknown outcome. Приложение не resends и блокирует новый checkout при pending entries данного scope.
- Journal `seekdef_commerce_pending_v1` сейчас сохраняет все записи, включая подтверждённые; предел 256 fail-closed. Нужен reviewed server terminal-status/tombstone/compaction протокол. Не удалять неподтверждённые записи по таймеру, quote expiry или пользовательскому Cancel.
- Возможна длительная блокировка scope при отказе RPC/receipt или транзакции, которая фактически не была отправлена. Для recovery нужна серверная проверка terminal failure/expired blockhash, не кнопка повторного send.
- Локальный GameState остаётся изменяемым display/gameplay cache, не authoritative purchased entitlement ledger. Reset/reinstall cache и интеграция admission/STD spending с серверным balance требуют отдельной acceptance.
- Физический Seeker/MWA app-switch, отказ/Cancel, background/restart recovery, funded DEVNET SOL и custom test SKR, preprovisioned merchant ATA, Firebase Function+CORS реального URL не проверены.
- Responsive browser/physical device visual proof не выполнен; component SSR/hook harness не является browser proof.
- Mainnet и настоящие SKR payments заблокированы. Никаких funds, airdrops, deployment, commit/push или APK сборки в этой подзадаче.

## Проверки

Фокусные проверки: commerce 12 tests, wallet transport 5 tests, component SSR/state machine 3 tests; old payment safety 90 assertions сохранены. TypeScript и отдельная Vite build прошли. Все payment tests — локальные mocks; сеть запрещена regression runner.

## Источники

- [Official TransferChecked documentation](https://solana.com/docs/tokens/basics/transfer-tokens)
- [Classic SPL Token instruction/account layouts](https://github.com/solana-program/token/tree/main/interface/src)
- [Official associated token accounts](https://www.solana-program.com/docs/associated-token-account)
- [Official SKR information — не разрешение mainnet](https://solanamobile.com/skr)
