# Первый контакт в новых чатах без сообщения клиента

## Подтверждённая причина

В двух указанных владельцем переписках до ручного ответа была только служебная запись Avito (`author_id=0`, `type=system`). Клиентского сообщения не было. Polling правильно исключал такую запись из USER history, но отдельного workflow первого контакта не существовало. API показывает `last_message` и в таких чатах: проверять только его отсутствие недостаточно.

## Решение

- `AvitoApiClient.listChats` сохраняет проверенные `created`, владельца объявления и участников. Неизвестная metadata не ломает обычный inbound, но запрещает proactive contact. Подтверждение структуры получено из authenticated production API, без вывода клиентских текстов/идентификаторов.
- `process-chat-openings.ts`: отдельная durable задача `chat_openings`, уникальная по лиду/Avito chat. CRM создаётся сразу; фиктивного incoming event, USER message, извлечённых фактов и `lastInboundAt` нет.
- При первом включении сохраняется activation boundary. Только чаты, созданные после неё, по объявлениям нашего аккаунта. Личные чаты, чужие объявления, уже обработанные/исторические переписки не получают приветствие.
- Пауза две минуты после обнаружения. До генерации, после неё и непосредственно перед POST проверяется authoritative history. Любая человеческая активность, включая media и сообщения старше draft, отменяет первый контакт. Неизвестная/неполная история — fail closed. Большой набор service notices также не обрезается до потенциально вводящего в заблуждение подмножества: такой чат пропускается.
- `CHAT_OPENED` — отдельный trigger conversation brain. Service observations передаются отдельно от пустой истории клиента. Qwen семантически выбирает SEND_REPLY/NO_REPLY; служебный текст не сопоставляется с phrase lists. Одна approved KB entry, без extraction, анкеты, экономики и пустого профиля в generation context. Ответ проходит существующие business guards и обязательный semantic review.
- NO_REPLY завершается без повторного LLM на каждом polling. Ошибка не порождает техническое приветствие. До трёх workflow attempts с паузой пять минут; задача истекает через сутки. Retry delivery переиспользует сохранённый текст. CAS lease, уникальность и SENT reconciliation защищают restart/concurrency.
- После доставленного первого контакта используется обычный эпизод молчания: 24/48 часов, MISSED через 72 часа. Первый настоящий inbound продолжает ту же conversation с AI history, а не начинает заново.
- `/status`: отдельная строка «Первый контакт от AI». Приветствие не увеличивает started/active/answered customer dialogs.

## Дополнительная ошибка, найденная focused evaluation

Правильное перечисление `180 000: аренда 50 000 + залог 50 000 + подготовка 30 000 + услуга 50 000` отвергалось как DOUBLE_COUNTED_LAUNCH_FEE. Старая проверка видела знак `+` и сумму, равную комиссии, рядом с полным итогом; она не отличала составляющие итога от начисления сверх него. После двух отклонений pipeline выдавал длинный KB fallback без запрошенного расчёта.

Добавлен RED regression. Для segmented substantive answer эта языковая эвристика заменена обязательной semantic проверкой по детерминированному калькулятору: итог уже включает комиссию, компоненты внутри итога допустимы, комиссия сверх итога запрещена. Сам калькулятор и allowed monetary values остаются deterministic. Legacy unsegmented guard сохранён. Положительный regression на breakdown и отрицательный на реальное повторное начисление проходят.

## Проверки

- Постоянные workflow regressions: service-only discovery; отсутствие фиктивного inbound; delay; once-only; restart activation; HUMAN/USER/media; intervention during generation; retries without regeneration; cancellation before retry; concurrent claims; history failure/incompleteness; semantic NO_REPLY; bounded model errors; continuation through actual polling/inbound pipeline.
- Transport integration: непосредственно перед отправкой первое сообщение блокируется при любой HUMAN/USER media в истории, включая timestamp до draft; empty authoritative history разрешает отправку.
- Generation regression: service metadata отделена от USER history; initial contact обязательно review; одна KB entry. Analytics regression: opener отдельно от customer dialogs.
- Один focused live Qwen trajectory через isolated workflow + Test Chat Lab, fake Avito/Telegram. Первый прогон выявил economics false positive; повтор после исправления прошёл manual review. Финальный прогон: 8 LLM calls, estimated $0.006393; первый контакт 2 calls (generation + review), 2 314 uncached input tokens, 757 output tokens, 15 345 ms суммарной API latency, estimated $0.001134. Следующие вопросы используют обычный conversation context; cache hits зафиксированы.
- Полные software checks и Linux release checks фиксируются при выпуске ниже. Старые live trajectories повторяются из записанных ответов без платных model calls.

## Ограничения

Обнаружение возможно только после появления чата в Avito API. Пауза считается от обнаружения, а не от открытия интерфейса клиентом. Existing Avito API не даёт общей атомарной транзакции «прочитать историю + отправить»: ручное сообщение, появившееся уже после последней проверки и во время POST, нельзя гарантированно отозвать. Проведены три проверки и local fences, но абсолютное исключение такой внешней гонки было бы недостоверным обещанием.

Добавляется только таблица `chat_openings` (migration 0015); существующие бизнес-данные, networking и provider configuration не меняются. При rollback старая версия игнорирует новую таблицу, production DB не откатывается и новые сообщения не теряются.
