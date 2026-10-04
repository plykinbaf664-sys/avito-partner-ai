import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { statusPeriods, type BotStatusReadRepository, type BotStatusSnapshot,
  type StatusPeriodKey } from "@/application/analytics/bot-status";
import type * as schema from "./schema";

interface StatusRow {
  period: StatusPeriodKey;
  since: number;
  started: number;
  active: number;
  answered: number;
  transferred: number;
  converted: number;
  awaiting_phone: number;
  pending_handoffs: number;
  failed_handoffs: number;
  pending_inbound: number;
  failed_inbound: number;
}

export class DrizzleBotStatusReadRepository implements BotStatusReadRepository {
  constructor(private readonly database: Pick<LibSQLDatabase<typeof schema>, "all">) {}

  async snapshot(asOf: Date): Promise<BotStatusSnapshot> {
    const periods = statusPeriods(asOf);
    const until = asOf.getTime();
    // One statement = one SQLite snapshot. Aggregate in SQL; never load
    // customer text, phone numbers, names, or the full CRM into the bot.
    const rows = await this.database.all<StatusRow>(sql`
      WITH avito_leads AS (
        SELECT id, phone_confirmed, phone_number, qualification_reason
        FROM leads WHERE upper(source) = 'AVITO' AND created_at <= ${until}
      ), inbound AS (
        SELECT m.lead_id, m.created_at FROM messages m
        JOIN avito_leads l ON l.id = m.lead_id
        WHERE m.direction = 'INBOUND' AND m.actor = 'USER' AND m.created_at <= ${until}
      ), activity AS (
        SELECT lead_id, min(created_at) AS first_at, max(created_at) AS last_at
        FROM inbound GROUP BY lead_id
      ), ai_replies AS (
        SELECT m.lead_id, m.sent_at FROM messages m
        JOIN avito_leads l ON l.id = m.lead_id
        WHERE m.direction = 'OUTBOUND' AND m.actor = 'AI'
          AND m.delivery_status = 'SENT' AND m.sent_at <= ${until}
      ), handoffs AS (
        SELECT n.lead_id, min(d.sent_at) AS first_sent_at
        FROM telegram_manager_deliveries d
        JOIN manager_notifications n ON n.id = d.manager_notification_id
        JOIN avito_leads l ON l.id = n.lead_id
        WHERE d.delivery_status = 'SENT' AND d.sent_at <= ${until}
        GROUP BY n.lead_id
      ), periods(period, since) AS (VALUES
        (${periods[0].key}, ${periods[0].since.getTime()}),
        (${periods[1].key}, ${periods[1].since.getTime()}),
        (${periods[2].key}, ${periods[2].since.getTime()})
      )
      SELECT p.period, p.since,
        (SELECT count(*) FROM activity WHERE first_at >= p.since) AS started,
        (SELECT count(*) FROM activity WHERE last_at >= p.since) AS active,
        (SELECT count(DISTINCT lead_id) FROM ai_replies WHERE sent_at >= p.since) AS answered,
        (SELECT count(*) FROM handoffs WHERE first_sent_at >= p.since) AS transferred,
        (SELECT count(*) FROM activity a JOIN handoffs h ON h.lead_id = a.lead_id
          WHERE a.first_at >= p.since) AS converted,
        (SELECT count(*) FROM avito_leads l JOIN activity a ON a.lead_id = l.id
          WHERE l.qualification_reason = 'PHONE_UNKNOWN'
            AND (l.phone_number IS NULL OR l.phone_number = '' OR l.phone_confirmed = 0)
            AND NOT EXISTS (SELECT 1 FROM handoffs h WHERE h.lead_id = l.id)) AS awaiting_phone,
        (SELECT count(DISTINCT n.lead_id) FROM manager_notifications n
          JOIN avito_leads l ON l.id = n.lead_id
          WHERE n.delivery_status = 'PENDING' AND n.created_at <= ${until}) AS pending_handoffs,
        (SELECT count(DISTINCT n.lead_id) FROM manager_notifications n
          JOIN avito_leads l ON l.id = n.lead_id
          WHERE n.delivery_status = 'FAILED' AND n.created_at <= ${until}) AS failed_handoffs,
        (SELECT count(*) FROM incoming_events WHERE upper(source) = 'AVITO'
          AND received_at <= ${until} AND status IN ('RECEIVED', 'PROCESSING')) AS pending_inbound,
        (SELECT count(*) FROM incoming_events WHERE upper(source) = 'AVITO'
          AND received_at <= ${until} AND status = 'FAILED') AS failed_inbound
      FROM periods p
    `);
    const totals = rows[0];
    return {
      generatedAt: new Date(until),
      periods: periods.map(({ key, since }) => {
        const row = rows.find((item) => item.period === key)!;
        return { key, since, startedDialogs: row.started, activeDialogs: row.active,
          aiAnsweredDialogs: row.answered, transferredLeads: row.transferred,
          transferredNewDialogs: row.converted };
      }),
      awaitingPhone: totals.awaiting_phone, pendingHandoffs: totals.pending_handoffs,
      failedHandoffs: totals.failed_handoffs, pendingInboundEvents: totals.pending_inbound,
      failedInboundEvents: totals.failed_inbound,
    };
  }
}
