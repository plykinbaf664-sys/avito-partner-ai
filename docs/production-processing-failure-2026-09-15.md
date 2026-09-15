# Диагностика production processing_failed — 15.09.2026

Production исследован только на чтение: SSH, journalctl, SQLite `mode=ro`, свойства конфигурации и диагностические запросы Anthropic без записи событий и без отправки клиентам. Deploy, изменение env/БД, миграции, остановка/перезапуск сервисов и изменение Caddy не выполнялись.

## Причина и доказательства

- Production и локальный исходный код: commit `c64ea90`. Рабочее дерево production чистое. SHA-256 `package-lock.json`, extractor и Anthropic adapter совпадают. На сервере Node 24.21.0, SDK 0.123.0, Zod 4.5.4.
- Production SDK получает **HTTP 403**, `error.type=forbidden`, `Request not allowed`, `server=cloudflare` от `api.anthropic.com` на `models.retrieve` и `messages.create`. Request ID не предоставлен. HTTP proxy в диагностическом окружении не задан.
- Ключи локально и на сервере совпадают (сравнение хешей без вывода ключей/хешей). Ключ имеет ожидаемый префикс и не содержит пробельных символов. Локально этот ключ, та же модель `claude-haiku-4-5-20251001` и реальный extractor успешно работают. Генерация JSON Schema проходит и на сервере.
- Это отказ доступа из production-окружения. Конкретное правило блокировки IP/региона/провайдера по ответу 403 установить нельзя: для этого нужна проверка у Anthropic/хостинга. Замена модели, увеличение timeout и бесконечный retry не устранят этот отказ. Нельзя утверждать, что программная правка восстановила доступ к LLM.

Два затронутых события:

| Event ID | Avito message ID | Состояние |
|---|---|---|
| `856b8d36-8d91-4559-9bf0-6c91143d521a` | `5bde92da35a227bc95809ddbf3b1f76b` | FAILED, attempts=1, retryable=0, error=Error |
| `16335320-998f-45db-b9ce-81921dd31b35` | `59ea5d24cadb6e18ecc996fb607a3765` | FAILED, attempts=1, retryable=0, error=Error |

Входящие сообщения и лиды сохранены. Лиды — QUALIFYING, диалоги — DISCOVERY, nextInboundSequence=1, lastAppliedInboundSequence=0. Outbound-сообщений и manager notifications для них нет: выполнение остановилось на extraction. SQLite `quick_check=ok`.

В journal есть ровно два `extraction.started`/`extraction.failed`, длительность 86 и 75 мс. Затем повторяются `event.retry_rejected` и `avito.poll.processing_failed`, без новых LLM-вызовов. В одном диагностическом срезе: 1 907 отказов retry. SDK оставлял name=Error; лог extraction ошибочно показывал retryable=true, хотя БД хранила false.

Polling охватывает весь аккаунт 439666639: `chatId=null`, параметр `--chat-id` и env `AVITO_POLL_CHAT_ID` отсутствуют; item_id-фильтров и отдельных сценариев нет. Срез: 92 чата, historyErrors=0. Граница активации `2026-09-15T16:17:13Z` сохранена. Cursor застрял на `16:23:27.342Z`: уже терминальные события снова попадали из истории Messenger, вызывали отказ обработки и не позволяли завершить sweep.

Telegram отправляется существующим workflow после финального handoff. Отдельный процесс/unit существующей очереди `notify:telegram` в production не найден. Это не причина текущего extraction failure, но без такого процесса отложенный retry карточек автоматически не обслуживается.

## Локальная правка

- `src/integrations/anthropic/anthropic-llm-provider.ts`: HTTP ошибки получают безопасный код `ANTHROPIC_HTTP_<status>`, status и корректную retry-классификацию; тело ответа/секреты не попадают в сообщение ошибки.
- `src/application/workflows/process-incoming-event.ts`: лог extraction использует ту же retry-классификацию, что запись в БД, и содержит errorCode.
- `src/application/workflows/poll-avito-messages.ts`: FAILED с запретом retry или исчерпанными попытками не отправляются повторно в processor; сохраняются FAILED, учитываются как terminalSkipped, логируются с event ID. Остальные чаты и cursor продолжают работу. Начальная временная граница, дедупликация и бизнес-правила сохранены.
- `scripts/poll-avito.ts`: выводит terminalSkipped отдельно от новых ошибок.
- Два связанных test-файла: реальные SDK error responses 400/401/403/404/429/500/529, воспроизведение 403 через extractor→SQLite→polling, другой чат продолжает получать ответ, retry прекращается после трёх попыток, старые terminal Error остаются FAILED, новые сообщения того же чата обрабатываются.

Миграция схемы и изменение `.env.local` для этой правки не нужны. Восстановление двух событий ниже — отдельная адресная операция с данными после восстановления доступа, не миграция.

Проверки локального исправления: `npm run typecheck` — PASS; `npm test` — 294/294 PASS (31 файл); `npm run build` — PASS; дополнительно `npm run lint` — PASS. До исправления новые регрессионные проверки падали: 10 FAIL. Реальный локальный extraction с настроенным ключом и моделью также PASS; production extraction остаётся заблокирован внешним HTTP 403.

## План деплоя — НЕ выполнен

Уточнение от 16.09.2026: российский VPS не обновлять и его сервисы не менять. План ниже сохранён как результат диагностики; развёртывание будет отдельно согласовано для нового европейского VPS.

1. Сначала восстановить разрешённый доступ production-сервера к Anthropic: передать поддержке адрес сервера 200.169.177.129, время диагностики, endpoint, HTTP 403 `Request not allowed`, отсутствие Request ID, факт успешного локального вызова с тем же ключом. Проверить допустимость региона/исходящего адреса у провайдера; при необходимости согласовать перенос на поддерживаемую площадку. Критерий — успешный реальный extractor с безопасным тестовым текстом непосредственно из production-окружения, без создания Lead. Секреты не пересылать.
2. После отдельного разрешения на deploy остановить polling и приложение, сделать согласованную резервную копию SQLite и текущего релиза. Сохранить `.env.local` и `data/` вне заменяемых файлов. Не удалять `polling_states`, историю и dedup-записи.
3. Доставить конкретный проверенный commit с локальной правкой. В `/opt/avito-partner-ai` выполнить `npm ci`, `npm run typecheck`, `npm test`, `npm run build`. Здесь команды приведены только как план; production не обновлялся.
4. После повторной проверки текущего состояния разрешить повтор только двум сохранённым событиям, если они по-прежнему не обработаны и в их диалогах не появилось более новых обработанных событий. Не сбрасывать processing_attempts и не менять cursor. Выполнить в одной транзакции:

   ```sql
   BEGIN IMMEDIATE;
   UPDATE incoming_events
   SET processing_retryable = 1
   WHERE source = 'AVITO'
     AND id IN ('856b8d36-8d91-4559-9bf0-6c91143d521a',
                '16335320-998f-45db-b9ce-81921dd31b35')
     AND status = 'FAILED' AND processing_attempts = 1
     AND processing_retryable = 0 AND error = 'Error'
     AND NOT EXISTS (
       SELECT 1 FROM messages m
       WHERE m.deduplication_key = 'event-response:' || incoming_events.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM incoming_events newer
       WHERE newer.source = incoming_events.source
         AND newer.external_lead_id = incoming_events.external_lead_id
         AND newer.received_at > incoming_events.received_at
         AND newer.status = 'PROCESSED'
     );
   SELECT changes();
   COMMIT;
   ```

   Ожидаемые две строки нужно перепроверить по актуальной БД; если состояние изменилось, не расширять UPDATE. Существующий recovery подхватит именно эти сохранённые входящие, даже когда cursor уйдёт вперёд.
5. Запустить `avito-partner-ai.service`, затем `avito-polling.service`. Убедиться, что текущий cursor продвигается, начальная граница остаётся прежней, processing_attempts ограничены, а терминальные записи не маскируются под PROCESSED.
6. Для автоматического Telegram retry запустить существующую команду `npm run notify:telegram -- --continuous --interval-ms 10000` отдельным systemd-unit с WorkingDirectory=/opt/avito-partner-ai, тем же env/БД и Restart=on-failure. Этот шаг не требует изменения архитектуры и не выполнялся во время диагностики.

## Проверка реального пути после деплоя

1. Отправить новое сообщение из контролируемого Avito-чата. В логах: `avito.poll.new_message` → `event.accepted` → `extraction.success` → `event.processed`, успешный Avito outbound с provider message ID. Проверить сам ответ в Avito.
2. Проверить в CRM город/капитал/сегмент и сохранение следующих ответов. До подтверждённого телефона не должно быть финального handoff.
3. После прохождения квалификации передать свой действительный телефон. Проверить `Lead.phoneNumber`, handoffAt, одну manager notification и Telegram-карточку с тем же номером и externalConversationId у активных менеджеров.
4. Подождать несколько poll-циклов и после рестарта polling проверить отсутствие повторного ответа/карточки. Существующие тесты также проверяют Telegram retry только неуспешному получателю и повторные inbound IDs.
5. Проверить новый входящий из другого объявления тем же сценарием: без item_id-маршрутизации и без сброса временной границы. Старые сообщения раньше startedAt не должны массово приниматься. Отдельно наблюдать terminalSkipped и FAILED в БД: PASS sweep не означает, что ранее отклонённые события обработаны.
