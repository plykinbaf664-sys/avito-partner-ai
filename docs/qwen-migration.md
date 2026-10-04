# Qwen3.8-Flash: архитектура, проверки и выпуск

## Архитектура

`LLM_PROVIDER` выбирает один provider через `src/integrations/llm/runtime-provider.ts`.
Webhook, Avito polling, dev inbound, Test Chat Lab и live eval используют эту фабрику.
Anthropic остаётся доступен через конфигурацию, автоматического перехода к нему нет.
При выборе Qwen extraction, generation, repair и semantic review используют `qwen3.8-flash`.
Квалификация, экономика, сохранение, телефон, handoff, idempotency и доставка остаются кодом.

Qwen использует OpenAI-compatible Chat Completions через защищённый Singapore
workspace host. Провайдер проверяет HTTPS/host, запрещает redirects, проверяет реально
возвращённую модель и не делает внутренних HTTP retries. Bounded application retries
и fallback фиксируются отдельно; ошибка модели не теряет сохранённый inbound.

## Контекст и structured output

- Компактный production contract сохраняет Current Intent First, referential understanding,
  semantic anti-repetition, UNKNOWN != ASK, различие фактов и conversational memory,
  границы бизнес-фактов, экономику и продолжение после handoff. Eval trajectories в него не входят.
- Extraction возвращает разреженную delta фактов. Неизвестные поля восстанавливаются
  кодом и проходят полную прежнюю Zod schema. Их отсутствие не становится нулём,
  отказом или обязательным вопросом. Семантические сигналы определяет LLM.
- Extraction получает каталог KB IDs/categories. Полная утверждённая KB и результаты
  калькулятора доступны conversation brain и reviewer; extraction не выносит business verdict.
- Общие instructions и approved knowledge вынесены в стабильный prefix.
  Точно одинаковые копии economics заменяются ссылками. В Qwen ближайшие реплики
  exchange/history остаются буквальными: live eval выявил потерю referent при
  pointer-shaped conversational fields. Экономия этих небольших дублей не оправдала
  риск качества. Авторы, порядок и доступный conversational context сохраняются.
- Conversation output содержит решение модели об ответе и необязательном следующем
  шаге. Дублирующие execution metadata кодирует приложение; прежние строгие Zod
  ограничения сохраняются. Нет дополнительной генерации внутренних обоснований.
- Requested calculation scale доступен согласованно во всех economics блоках и
  отличается от выбранного startingUnits. Уточнение входного параметра незавершённого
  расчёта сохраняет его предмет через семантическую extraction, без regex intent routing.
- Production mode — явный `json_object`: schema находится в стабильном контексте,
  результат полностью проверяется приложением. `json_schema` оставлен как конфигурация
  для исследования, но не как скрытый fallback. На синтетическом сравнении одинакового
  city/capital input сложный JSON Schema payload дал неверный intent/факты; JSON Object
  правильно извлёк их. Успешный простой network schema probe не доказывает качество
  обработки всего application schema. Это результат наших проверок, не утверждение
  о невозможности использовать JSON Schema в других проектах.
- Лимит Qwen generation позволяет завершить JSON envelope; неиспользованные output
  tokens не оплачиваются. Поля причин/памяти требуют краткого результата, не рассуждений.
- Для production выбран `QWEN_THINKING_MODE=bounded`, budget 2048 и timeout 120 секунд.
  Точечный прогон без thinking выявил ложное отклонение полезного ответа reviewer:
  предыдущий AI-вопрос о сроках был принят за текущий запрос пользователя.
  Reviewer теперь получает отдельную последнюю USER-реплику и явные границы ролей.
  Thinking включается явно через конфигурацию;
  режим и бюджет присутствуют в metadata. Reasoning content не сохраняется и не логируется.

## Observability и цена

Additive migration `0012` создаёт `llm_calls`. Каждый сетевой вызов имеет STARTED и
окончательный SUCCESS/ERROR: provider/model, workflow IDs, stage, attempt, hashes,
release, latency, stop reason, schema/cache/thinking modes, input/output/cache tokens,
validation и workflow outcome. Нет prompt content, текста клиента, ключей или reasoning.
Платный, но отклонённый ответ сохраняет usage. При неизвестном usage цена не выдумывается.
Ledger settlement отличает USED/FALLBACK/SUPPRESSED/NO_REPLY/FAILED.

Qwen `prompt_tokens` включает cache read/write. Поэтому uncached input = total input
minus cache reads minus cache creation; эти значения не оплачиваются дважды.
Singapore standard USD/1M: input 0.15, output 0.47, explicit cache creation 0.2,
cache read 0.016. Это тарифная оценка, не счёт/промо-цена аккаунта.

Explicit cache: последний стабильный system text block с ephemeral marker,
TTL 5 минут; Anthropic 1h TTL не копируется. Hits измеряются, не предполагаются.
Успешный исходный server probe: input 4524, output 33; first cache write 4503,
second cache read 4503; latency 2350/2009 ms. Это synthetic probe, не статистика клиентов.

Источники: [model/pricing](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-flash),
[caching](https://www.alibabacloud.com/help/en/model-studio/context-cache),
[structured output](https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output),
[bounded thinking](https://www.alibabacloud.com/help/en/model-studio/deep-thinking),
[workspace API](https://www.alibabacloud.com/help/en/model-studio/model-calling-in-sub-workspace).

## Дополнительные регрессии

При миграции обнаружено, что follow-up workflow отправлял пустой outbound после
LLM NO_REPLY. Новый тест сначала воспроизвёл bug; теперь episode закрывается без
фиктивной отправки. Новый inbound во время генерации сохраняет собственный episode.

Отдельный RED-first test зафиксировал unlinked optional qualification question:
он отправлялся даже с nextInformationNeed=null. Теперь отдельный недопустимый
optional component исключается, полезный ответ сохраняется и проходит все проверки.
Текст человека не разбирается production regex для выбора intent или следующего шага.

Рекомендация на текущий запрос сохраняется самостоятельным ответом: отдельный
optional CRM-вопрос откладывается на следующий уместный turn. Семантический тип
определяет LLM; код не распознаёт конкретные пользовательские фразы. Новый тест
сначала упал на прежней отправке дополнительного вопроса и затем прошёл.

RED-first проверки также выявили два дефекта policy/context: денежное число рядом
с «объект» ошибочно считалось количеством объектов; упоминание неизвестного условия
ошибочно считалось бизнес-обещанием. Денежные величины отделены от units в числовом
guard. Для segmented responses смысл бизнес-утверждения проверяет обязательный
source-aware reviewer, поэтому honest unknown не блокируется простым наличием слова.
Финансовые ограничения и отказ от unsupported promises остаются обязательными.

Добавлены sparse delta/provider/usage/privacy/config tests и live Test Chat Lab
траектории HUMAN+AI, phone early, handoff exactly once, post-handoff, correction,
unknown units, complaint, follow-up, CRM visibility и duplicate inbound без повторного LLM.
Старые behavioral assertions не удаляются и не ослабляются.

## Env и rollback

Секреты вводятся интерактивно через `scripts/configure-qwen-credentials.py` на сервере:
`QWEN_API_KEY`, `QWEN_API_HOST`. Файл вне репозитория, mode 0600.
Настройки: `LLM_PROVIDER=qwen`, `QWEN_MODEL=qwen3.8-flash`,
`QWEN_CACHE_MODE=explicit`, `QWEN_STRUCTURED_OUTPUT=json_object`,
`QWEN_TIMEOUT_MS=120000`, `QWEN_THINKING_MODE=bounded`, `QWEN_THINKING_BUDGET=2048`.

Provider rollback без изменения кода (на production сервере):

```sh
cd /opt/avito-partner-ai
python3 scripts/select-production-provider.py anthropic
systemctl restart avito-partner-ai.service avito-polling.service
curl --fail http://127.0.0.1:3000/api/health
curl --fail http://127.0.0.1:3000/api/readiness
```

Anthropic ключи и модели сохраняются. Для реальных ответов Claude требуется рабочий
API баланс Anthropic: последняя прежняя production проверка остановилась из-за billing.
Health/readiness сами по себе не проверяют баланс или качество ответов LLM.
AWG/Anthropic networking не меняется.

## Статус

2026-10-04: software suite PASS — 42 files / 528 tests, typecheck, lint и build,
включая финальную Linux-сборку. Точечная реальная траектория
operations-after-capital-correction PASS с bounded 2048: исправление капитала
снимает NO_FIT, составной вопрос получает объяснение, практический вопрос — первый шаг.
В turn исправления факта использован безопасный deterministic fallback из-за
нескольких вопросов в draft; это наблюдаемое остаточное ограничение, не скрытая
смена модели. Расширенный agent-eval отложен по указанию владельца.

Свежий server preflight PASS: uncached input 28/28, output 38/56,
cache write/read 2043/2043, latency 2300/1729 ms. Production rollout и один
controlled E2E завершены успешно.

## Production rollout 2026-10-04

Код выпуска: `5c27d54a24c79f716c957bfb7cae47d8c9eed58b`.
Перед переключением Linux-кандидат побайтно сверен с Git commit для source,
migrations и build configuration. Backup:
`/opt/avito-partner-ai-backups/qwen-migration-20261004-064935`, прежняя ревизия
`d6c3fdc4e56ebb0018a88cfc05117b682131d4ca`, SQLite integrity `ok`.
Сохранены env, consistent DB copy и прежняя `.next`; production DB не заменялась.
Добавочная миграция выполнена, сборка переключена, оба сервиса перезапущены.
Health/readiness PASS, app/polling active, 19 polling cycles завершились без ошибок
в первом наблюдении. AWG/Anthropic networking сохранено.

Два реальных вызова из production runtime (`workload=PRODUCTION`, ledger `llm_calls`)
вернули provider `qwen`, model `qwen3.8-flash`, SUCCESS. Uncached input 28/28,
output 64/63, cache read 2043/2043, cache creation 0/0 (прогретый prefix),
latency 3761/2655 ms, тарифная оценка USD 0.000067/0.000066. Это synthetic smoke,
не статистика реальных клиентов. Anthropic LLM calls в этой проверке отсутствуют.

Один controlled E2E из production checkout/config: `phone-handoff-continuation`
PASS, 4 inbound, 3 delivery, один handoff. Phone early не квалифицирует;
после достаточных данных телефон не спрашивается повторно, после handoff
вопрос получает ответ, благодарность допускает NO_REPLY, duplicate не делает
повторного LLM/outbound. Для безопасности использованы isolated in-memory SQLite
и fake external delivery/notification; реальным клиентам/Telegram тест не отправлялся.
Все модельные calls реальные Qwen: 12 calls включая eval judge, 0 transport errors,
uncached input 13961, output 7371, cache creation 7610, cache read 33112,
USD 0.007610 с judge; latency median 12359.5 ms, p90 20826.2 ms на call.

Остаточное ограничение: 3 drafts отклонены guardrails; первый phone-only turn
использовал deterministic fallback после multiple-questions violation.
Обработка фактов/handoff прошла, но repair/fallback и bounded reasoning добавляют
стоимость и latency. Расширенная оценка естественности и долгосрочная статистика
production usage остаются последующей работой; идеальное качество не заявляется.
