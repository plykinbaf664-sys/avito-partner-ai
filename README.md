# AI Partner Qualification

Локальный foundation системы первичной обработки и квалификации входящих
партнёров для бизнеса посуточной аренды.

## Требования

- Node.js 24
- npm

## Запуск

```bash
npm install
npm run db:migrate
npm run dev
```

Локальная SQLite-база по умолчанию создаётся в `data/local.db`. Путь можно
переопределить через `DATABASE_URL`; список переменных находится в
`.env.example`.

## Проверки

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## База данных

```bash
npm run db:generate  # создать миграцию после изменения schema.ts
npm run db:migrate   # применить миграции
npm run db:studio    # открыть локальный Drizzle Studio
```

## Архитектура

- `src/domain` — модели, состояния и детерминированная qualification policy;
- `src/application` — порты и workflow обработки входящего события;
- `src/infrastructure` — SQLite/Drizzle schema и repository adapters;
- `src/integrations` — изолированные Anthropic и Fake LLM adapters;
- `src/shared` — общие технические примитивы;
- `drizzle` — версионируемые SQL-миграции.

Domain не импортирует SQLite, Drizzle, Anthropic или каналы доставки. Avito,
Telegram, production database, authentication, CRM и полноценный AI-диалог в
текущий этап не входят.

## Локальная проверка inbound extraction

1. Скопируйте `.env.example` в `.env.local` и задайте `ANTHROPIC_API_KEY` и
   `ANTHROPIC_MODEL`.
2. Примените миграции и запустите приложение:

```bash
npm run db:migrate
npm run dev
```

3. Отправьте channel-neutral запрос:

```bash
curl -X POST http://localhost:3000/api/inbound \
  -H "Content-Type: application/json" \
  -d '{"source":"mock","externalEventId":"event-123","externalLeadId":"lead-123","messageId":"message-123","text":"Я из Волгограда, есть 500 тысяч, могу начать через месяц"}'
```

Endpoint возвращает extraction, qualification, serviceability, состояние
диалога, известные/недостающие факты и минимальные latency/idempotency metrics.
Повторный `source + externalEventId` не создаёт второе сообщение и не вызывает
LLM повторно. При временной недоступности Anthropic endpoint отвечает `503`, а
incoming event и message остаются сохранёнными для retry.
