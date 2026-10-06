# Подключение Firebase (Spark / бесплатный план)

## Шаг 1 — Создать проект Firebase

1. Открой [console.firebase.google.com](https://console.firebase.google.com)
2. Нажми **Add project** → введи имя (например, `seekdef-app`) → Continue
3. Google Analytics — по желанию (для лидерборда не нужно)
4. Дождись создания проекта

## Шаг 2 — Firestore Database

1. Слева: **Build → Firestore Database**
2. Нажми **Create database**
3. Выбери режим **Production mode** (правила уже подготовлены)
4. Выбери регион (europe-west1 или us-central1 — ближайший)
5. Нажми **Done**

## Шаг 3 — Anonymous Authentication

1. Слева: **Build → Authentication**
2. Нажми **Get started**
3. Вкладка **Sign-in method** → найди **Anonymous** → **Enable** → Save

## Шаг 4 — Получить конфиг веб-приложения

1. В Project Overview (шестерёнка вверху) → **Project settings**
2. Листай вниз до раздела **Your apps**
3. Нажми иконку **</>** (Web app)
4. Введи имя (например, `seekdef-web`) → **Register app**
5. Скопируй объект `firebaseConfig`:

```js
const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};
```

## Шаг 5 — Вписать ключи в .env

Создай локальный `.env` по `.env.example` в корне проекта и заполни:

```
VITE_FIREBASE_API_KEY=AIzaSy...
VITE_FIREBASE_AUTH_DOMAIN=your-project-id.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project-id.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789
VITE_FIREBASE_APP_ID=1:123456789:web:abcdef
```

> **Важно:** `firebaseConfig`-ключи считаются публичными (Firebase защищает доступ через Security Rules, а не секретностью ключей).
> Тем не менее `.env` не коммитим — он уже в `.gitignore`.

Встроенного конфига проекта нет: Firebase использует только `VITE_FIREBASE_*` из окружения сборки. Без непустых `VITE_FIREBASE_API_KEY` и `VITE_FIREBASE_PROJECT_ID` инициализация отключена, лидерборд остаётся локальным. После изменения окружения перезапусти dev-сервер или пересобери приложение.

## Шаг 6 — Задеплоить Security Rules

### Вариант А — через Firebase CLI (рекомендуется)

```bash
npm install -g firebase-tools
firebase login
firebase use --add   # выбери свой проект
firebase deploy --only firestore:rules
```

### Вариант Б — вручную через консоль

1. **Build → Firestore Database → Rules**
2. Скопируй содержимое файла `firestore.rules`
3. Вставь в редактор правил → **Publish**

## Шаг 7 — Перезапустить dev-сервер

```bash
npm run dev
```

После заполнения `.env` лидерборд переключится с `local` (seed-боты) на `live` (реальные игроки).
Бейдж `live` / `local` в правом верхнем углу таба показывает текущий источник данных.

---

## Что осталось под Blaze (платный план)

- `// TODO Blaze: server-side anti-cheat` — проверка скора через Cloud Functions
- `// TODO Blaze: secure referrer credit / daily` — начисление бонусов рефереру через Functions

На Spark всё это отсутствует. Структурная проверка (тип, диапазон 0–10000, длина walletAddr ≤ 64) выполняется через Security Rules.
