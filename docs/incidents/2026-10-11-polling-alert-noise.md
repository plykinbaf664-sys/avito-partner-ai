# Повторные эксплуатационные уведомления и polling lease

## Доказанные причины

- `DrizzleOperationalHealthRepository.claimAlert` повторно разрешал предупреждение об одном открытом сбое каждые 30 минут.
- `runProductionWatchdog` использовал fingerprint набора текущих issues. Переход от Messenger stale к Messenger + polling stale создавал новое предупреждение без восстановления между ними.
- Readiness допускает один DEGRADED результат. Watchdog ошибочно мог объявить такой результат восстановлением, хотя успешной проверки проблемного компонента ещё не было.
- Polling создавал новый lease owner на каждый цикл, а acquire не разрешал повторный захват своей действующей lease. После оставшейся блокировки даже тот же живой worker уходил в BUSY до истечения десятиминутного TTL.

По production journal 11 октября: 08:06:48 UTC `AVITO_NETWORK_ERROR`; следующий цикл 08:07:38 уже PASS. Затем после PASS в 08:09:49 началась серия BUSY, завершившаяся около 08:19:49. Worker не перезапускался, второго service worker не обнаружено. Watchdog отправил предупреждения в 08:14:04 и 08:16:19 с разным списком stale issues и восстановление в 08:20:30. В 08:15:17 был также FAILED delivery attempt.

Причина, по которой lease сохранилась после успешного цикла, по старым логам не установлена: эти логи не содержали проверяемого ownership. Сетевой timeout восстановился раньше и не объявляется доказанной причиной последующей BUSY-серии. Ранее наблюдавшийся `AVITO_POLL_LEASE_LOST` также сохранён как факт, без выдуманной первопричины.

## Исправление

- Durable alert state отражает переходы «открытый инцидент / восстановлено». Время и смена симптомов больше не создают новое предупреждение. Старые fingerprints трактуются как уже объявленный открытый инцидент; прежний healthy fingerprint сохранён, миграция не нужна.
- Восстановление отправляется только когда readiness здоров и компоненты действительно OK. Одиночный терпимый DEGRADED не закрывает инцидент. Неуспешная доставка продолжает иметь bounded cadence retries; успешно завершённая фаза не повторяется после restart.
- UUID владельца polling сохраняется на жизнь worker. Acquire идемпотентен для того же owner; другие владельцы остаются fenced до release/expiry. Локальный in-flight guard исключает параллельные циклы одного worker. Оставшаяся собственная блокировка не требует десятиминутного простоя.
- При потере lease добавлены безопасные ownership/TTL diagnostics без ключей, account IDs, текстов и клиентских данных. Чужие lease принудительно не снимаются.

## Regression

Четыре новых проверки показали RED до исправления: повторные предупреждения при changing symptoms/hours; ложное восстановление на DEGRADED; blackout после failed cleanup; non-idempotent same-owner acquire. После исправления focused suite PASS. Дополнительно защищены same-worker overlap, fencing другого owner и совместимость уже объявленного legacy incident. Старые regressions не удалены и не ослаблены.

LLM/prompts/business logic/networking/env не меняются. Новые платные поведенческие прогоны не запускались: предыдущие две реальные траектории воспроизведены на окончательном Linux candidate без API calls (17 recorded calls, 6 fake deliveries, 1 handoff).

## Выпуск

Выпущен `807a3c289a7657f0885a49678319a3d81e1d104e`. Linux: typecheck, 45 файлов / 603 tests, lint, build PASS. Avito read-only smoke PASS, включая direct chats; клиентам и менеджерам тестовые сообщения не отправлялись.

Backup/rollback manifest: `/opt/avito-partner-ai-backups/qwen-migration-20261011-090503/operational-release.json`. Env, схема и бизнес-данные не менялись. На planned shutdown проверено отсутствие живого polling worker и PROCESSING inbound; оставшихся lease не оказалось (cleared=0). Сохранён rollback на `0a08dd8fea4ac1787e39f612e258211f71e52df5` без восстановления старой БД.

После выпуска: health/readiness HTTP 200; все operational components OK; pending/failed/unresolved inbound/outbound 0; первые 7 polling cycles PASS (384–727 ms), новых ошибок нет, lease освобождается. Watchdog с production sender вернул THROTTLED при здоровом состоянии — лишних Telegram notifications не отправлено. Синтетический production Qwen smoke: 2 SUCCESS (`qwen/qwen3.8-flash`), latency 2685/1961 ms, второй вызов cache read 2043 tokens; общая тарифная оценка $0.000496, без клиентских outbound.

Независимый watchdog остаётся включённым; реальные неисправности не скрываются, подробная диагностика сохраняется в journal и `/status`. При новом настоящем инциденте после завершённого восстановления будет новое предупреждение: это требуемый переход, а не напоминание об уже открытом сбое.

```powershell
ssh -i C:\Users\User\.ssh\avito_codex root@200.169.177.129 "python3 /root/operational-release.py rollback /opt/avito-partner-ai-backups/qwen-migration-20261011-090503/operational-release.json"
```
