# Совместное ведение диалогов и эпизоды молчания

## Подтверждённые причины

- `record-external-message.ts` отключал follow-up после любой ручной реплики, включая историческую.
- `process-incoming-event.ts` связывал ожидание ответа с выбранным qualification field. Полезный ответ без такого поля не планировал продолжение.
- Проверки перед commit/delivery не защищали от новой ручной реплики во время генерации. Polling ждёт LLM, поэтому одной проверки локальной БД недостаточно.
- `qualificationProgressExpected` запрещал NO_REPLY после подтверждения ожидаемого действия менеджера. Возникал fallback с новым qualification-вопросом.
- Сравнение только timestamps могло подавить новый клиентский turn после MANAGER с той же меткой времени.

Каждый из этих классов зафиксирован тестами, показавшими RED до исправления. Новое требование владельца явно заменяет прежний контракт одного follow-up через два часа.

## Реализация

- LLM выбирает `awaitingUserReply` отдельно от `nextInformationNeed`; текущий вопрос, история MANAGER/AI, договорённости и anti-repetition остаются в контексте. Незаполненное поле не предписывает вопрос.
- Ручная реплика заменяет старую AI-цель, отменяет pending AI drafts и запускает новый эпизод. Старые сообщения из истории не сбрасывают живой эпизод.
- Состояния проверяются после генерации, перед delivery и после transport. Для production polling и webhook подключено одно чтение authoritative Avito history непосредственно перед отправкой. Новые клиентские события сохраняются и ставятся в обычную очередь без дополнительного LLM-вызова; новые ручные реплики отменяют устаревший ответ.
- Семантический ответ на шаг менеджера берётся из extraction; regex для распознавания телефонной просьбы менеджера удалён. NO_REPLY разрешён conversation brain в обмене с менеджером; новый содержательный вопрос по-прежнему требует ответа.
- `followUpAnchorAt` фиксирует последнюю обычную реплику команды. Два contextual follow-up через 24/48 часов имеют отдельные durable keys. Отсчёт не начинается заново от первого напоминания.
- После двух доставленных напоминаний — `missedAt` через 72 часа. Это CRM engagement outcome MISSED, независимо от qualification/NO_FIT. Переход не вызывает LLM. Новый inbound снимает MISSED, сохраняет conversation ID, память и факты.
- При задержанной доставке выдерживаются минимум сутки между напоминаниями и до MISSED: нет отправок «вдогонку».
- NO_REPLY завершает эпизод без MISSED. Сбой/пустой ответ conversation brain не создаёт proactive fallback-сообщение и не превращается в «клиент пропущен»; эпизод останавливается, ошибка остаётся в structured logs/usage. Следующее входящее обрабатывается обычным путём.
- Терминальные отказы, handoff, закрытые диалоги и pending outbound сохраняют ограничения. Ответы после handoff продолжаются; повторной карточки нет.
- CRM: фильтр MISSED, отдельная колонка активности, CSV engagement status/date, доступ к всем сохранённым лидам через «Все входящие диалоги». Прежние квалифицированные представления сохранены.
- `/status` показывает число MISSED; Test Chat Lab показывает anchor/deadline/missedAt.

## Проверки

- Локально: typecheck/lint/build PASS; полный suite 595 tests PASS, затем добавлены два transport checks (4/4 в файле PASS). Финальный Linux suite проверяется перед выпуском.
- Постоянные regressions: manual intervention при generation/pre-send; одинаковые timestamps; старый MANAGER history; 24/48/72; restart после SENT до обновления эпизода; delayed/failed delivery; сохранение нового human episode после отмены старого; пустой/ошибочный proactive generation; ожидание действия менеджера; MISSED/CSV/CRM visibility.
- Два реальных Qwen Test Chat Lab eval: `team-silence-recovery` и `team-manager-pending-action` PASS. Отдельная тестовая БД, fake Avito/Telegram, реальный application pipeline. Четыре клиентских turns, MANAGER context, два напоминания, MISSED, возврат, один handoff, economics после handoff; второй сценарий проверяет отсутствие напоминания/анкеты, когда следующий ход за менеджером.
- Первый eval: 15 API calls, 25 593 uncached input, 15 005 output, 27 147 cache creation, 29 871 cache read; тарифная оценка $0.016799.
- Второй eval: 4 calls, 4 656 uncached input, 1 423 output, 4 680 cache creation, 10 048 cache read; оценка $0.002463. Всего $0.019262, без широкого повторного исследования.
- Записи обоих успешных eval воспроизведены на окончательном локальном коде: 17 recorded calls, 6 fake deliveries, 1 handoff; 0 дополнительных API calls. Fixtures/траектории не входят в production context.

## Миграция и границы

`0014_chubby_peter_parker.sql` добавляет nullable anchor/missed fields. Недавние активные старые эпизоды переносятся на 24 часа; давно просроченные эпизоды не возрождаются массово. Старые pending follow-up отменяются при смене политики. Клиентские сообщения/факты не удаляются.

Provider/model/env и selective AWG/Anthropic networking не меняются. Qwen остаётся основным provider; дополнительных paid calls для записи MANAGER или перехода MISSED нет. Цена одного нового отправления — ещё одно чтение Avito history.

Внешние ручная отправка и API POST не образуют общей транзакции: сообщение, уже принятое Avito, отозвать этим кодом нельзя. Проверки сокращают окно гонки до промежутка между последним чтением и POST; абсолютная гарантия отсутствия внешней гонки невозможна. Новые turns/manager goal при этом не перезаписываются результатом старой доставки.

## Production

Выпущен `9ca6b031ab3de6e9d5e0e598923e8de2611dbd34`. Linux candidate: typecheck, 45 файлов / 597 tests, lint, build PASS. На окончательном Linux-коде повторены записи двух свежих успешных Qwen eval: 17 recorded calls, 0 новых API calls, 6 fake deliveries, 1 handoff. Чтение реального Avito: 154 chats, включая 2 direct chats; authoritative history PASS, без внешних сообщений.

Backup/rollback manifest: `/opt/avito-partner-ai-backups/qwen-migration-20261010-235904/operational-release.json`. Migration 0014 применена; SQLite quick_check OK. App, polling, watchdog active. После перезапуска health/readiness HTTP 200, issues пусты, pending/failed/unresolved inbound/outbound — 0; свежий успешный polling heartbeat подтверждён.

Два синтетических вызова реального production provider `qwen/qwen3.8-flash` PASS (клиентам ничего не отправляли):

| Вызов | Uncached input | Output | Cache creation | Cache read | Latency | Оценка USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 28 | 56 | 2 043 | 0 | 2 327 ms | 0.000439 |
| 2 | 28 | 50 | 0 | 2 043 | 1 947 ms | 0.000060 |

Это доступность provider/cache, а не оценка качества полноценного клиентского диалога; качество проверено двумя указанными multi-turn eval и regression suite. Полный расширенный платный eval не повторяли.

При дополнительном наблюдении после выпуска зарегистрирован один `AVITO_POLL_LEASE_LOST`, затем BUSY на оставшейся lease. Подтверждены один worker и отсутствие PROCESSING inbound. Polling остановлен, освобождена только захваченная ранее lease через owner compare-and-swap, worker запущен снова. Первые пять последующих циклов PASS (279–459 ms), новых ошибок нет, lease освобождается, operational state вернулся OK и readiness 200. События/сообщения клиентов не менялись. Причина первоначальной потери ownership не установлена: это не заявляется исправленным кодовым дефектом; приватное свидетельство сохранено в `/root/.config/avito-partner-ai/team-release-lease-observation.json`. Lease/repository код этим выпуском не менялся. Это отдельный эксплуатационный риск, который нельзя скрывать за успешными behavioral eval.

Откат на предыдущую рабочую Qwen-версию `7b898f5fe8585d002da983830b518615ce0449af`:

```powershell
ssh -i C:\Users\User\.ssh\avito_codex root@200.169.177.129 "python3 /root/operational-release.py rollback /opt/avito-partner-ai-backups/qwen-migration-20261010-235904/operational-release.json"
```

Rollback сохраняет новые клиентские данные и дополнительные колонки; восстановление старой БД не требуется. Перенос расписаний миграцией автоматически не обращается, чтобы не возродить старые напоминания массово. Документация может синхронизироваться отдельным commit без перезапуска собранного application code.
