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

Результат guarded rollout и rollback manifest будут добавлены после проверки Linux candidate и promotion. Rollback сохраняет новые клиентские данные и дополнительные колонки; восстановление старой БД не требуется.
