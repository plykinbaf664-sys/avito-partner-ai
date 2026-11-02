# Avito webhook recovery and follow-up worker

The Avito webhook remains the primary path for new messages. The worker is a
separate, continuously supervised process that recovers durable inbound events
after a webhook request was interrupted, retries manager notifications, and
executes due contextual follow-ups. It uses the same Conversation Engine,
knowledge, deterministic qualification rules, Avito sender and shared database
as webhook processing.

Run it beside the web app with the same production environment and the exact
same `DATABASE_URL`:

```sh
node --env-file-if-exists=.env.local --import tsx scripts/run-avito-worker.ts --interval-ms 60000
```

The systemd unit template is `ops/avito-follow-up-worker.service`. Install it
as `/etc/systemd/system/avito-follow-up-worker.service`, then enable and start
it. Install the matching drop-ins from
`ops/avito-follow-up-worker.service.d/` under
`/etc/systemd/system/avito-follow-up-worker.service.d/`. It is separate from
`avito-polling.service`; do not enable account-wide
polling as part of this webhook worker rollout. Run one supervised instance. If an accidental duplicate is
started, event claims and follow-up idempotency prevent duplicate processing or
delivery. The process performs one sequential tick at a time; pending inbound
recovery runs before follow-ups so a new customer reply cancels a stale reminder.

On its first start, the worker persists an activation timestamp in
`polling_states`. Recovery only considers Avito events received at or after that
timestamp, so the pre-existing backlog is left untouched across restarts. Do not
delete or reset this row to avoid turning historical events into new work.

Follow-up timing is anchored to the team's last delivered reply: first reminder
at 24 hours, second at 48 hours, and `MISSED` engagement status at 72 hours
without a customer reply. There is no third reminder. A delayed delivered
reminder gets a full 24-hour response window before the next stage. Failed
delivery does not count as a delivered reminder. Any new inbound is handled
before the follow-up tick and cancels the prior silence episode.

Operational checks:

- `AVITO_WORKER=STARTED` confirms that the process initialized its durable
  recovery boundary.
- `AVITO_WORKER=PASS` reports recovered/failed inbound counts and follow-up
  delivery counts for each tick.
- A durable `AVITO_WORKER` health heartbeat keeps readiness aligned with
  webhook mode. Readiness filters pre-activation inbound backlog while still
  reporting new pending events and failed deliveries.
- `avito.worker.tick_failed` reports a sanitized error code, without message
  content or provider response bodies.
- The webhook and worker must share storage. Separate SQLite files break
  idempotency and recovery guarantees.
- A worker PASS is not proof that Avito outbound access is enabled; delivery
  errors remain visible through the existing outbound and operational-health
  records.
