import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type { HealthComponent, HealthObservation, OperationalHealthRepository } from "@/application/health/operational-health";
import { generateId } from "@/shared/id";
import * as schema from "./schema";

export class DrizzleOperationalHealthRepository implements OperationalHealthRepository {
  constructor(private readonly database: LibSQLDatabase<typeof schema>) {}
  async observe(component: HealthComponent, state: HealthObservation["state"], code: string | null, at: Date) {
    const safeCode = code === null ? null : /^[A-Z0-9_]{1,100}$/u.test(code) ? code : "EXTERNAL_ERROR";
    await this.database.run(sql`INSERT INTO operational_health(component,state,error_code,checked_at,last_success_at,consecutive_failures)
      VALUES(${component},${state},${safeCode},${at.getTime()},${state === "OK" ? at.getTime() : null},${state === "OK" ? 0 : 1})
      ON CONFLICT(component) DO UPDATE SET state=excluded.state,error_code=excluded.error_code,checked_at=excluded.checked_at,
      last_success_at=CASE WHEN excluded.state='OK' THEN excluded.checked_at ELSE operational_health.last_success_at END,
      consecutive_failures=CASE WHEN excluded.state='OK' THEN 0 ELSE operational_health.consecutive_failures+1 END
      WHERE excluded.checked_at>=operational_health.checked_at`);
  }
  async list(): Promise<HealthObservation[]> {
    const rows = await this.database.select().from(schema.operationalHealth);
    return rows.map(({ component, state, errorCode, checkedAt, lastSuccessAt, consecutiveFailures }) =>
      ({ component, state, errorCode, checkedAt, lastSuccessAt, consecutiveFailures }));
  }
  async claimAlert(component: HealthComponent, fingerprint: string, at: Date, options: { recovery?: boolean } = {}): Promise<string | null> {
    const owner = generateId();
    const rows = await this.database.all(sql`UPDATE operational_health SET alert_lease_owner=${owner},
      alert_lease_until=${at.getTime() + 120_000},last_alert_attempt_at=${at.getTime()}
      WHERE component=${component} AND (alert_lease_until IS NULL OR alert_lease_until<=${at.getTime()})
      AND (last_alert_attempt_at IS NULL OR last_alert_attempt_at<=${at.getTime() - 30_000})
      AND (${!options.recovery} OR last_alert_at IS NOT NULL)
      AND (alert_fingerprint IS NULL OR alert_fingerprint!=${fingerprint} OR
        (${!options.recovery} AND last_alert_at<=${at.getTime() - 30 * 60_000}))
      RETURNING component`);
    return rows.length ? owner : null;
  }
  async finishAlert(component: HealthComponent, owner: string, fingerprint: string, sent: boolean, at: Date) {
    await this.database.run(sql`UPDATE operational_health SET alert_lease_owner=NULL,alert_lease_until=NULL,
      alert_fingerprint=CASE WHEN ${sent} THEN ${fingerprint} ELSE alert_fingerprint END,
      last_alert_at=CASE WHEN ${sent} THEN ${at.getTime()} ELSE last_alert_at END
      WHERE component=${component} AND alert_lease_owner=${owner}`);
  }
  async backlog(at: Date) {
    const [row] = await this.database.all<{pendingInbound:number;oldestPendingAt:number|null;failedInbound:number;failedOutbound:number;unresolvedOutbound:number}>(sql`
      SELECT
      (SELECT count(*) FROM incoming_events WHERE upper(source)='AVITO' AND status IN ('RECEIVED','PROCESSING')) AS pendingInbound,
      (SELECT min(received_at) FROM incoming_events WHERE upper(source)='AVITO' AND status IN ('RECEIVED','PROCESSING')) AS oldestPendingAt,
      (SELECT count(*) FROM incoming_events WHERE upper(source)='AVITO' AND status='FAILED' AND received_at>=${at.getTime()-86_400_000}) AS failedInbound,
      (SELECT count(*) FROM messages m JOIN leads l ON l.id=m.lead_id WHERE upper(l.source)='AVITO'
        AND m.direction='OUTBOUND' AND m.actor='AI' AND m.delivery_status='FAILED' AND m.created_at>=${at.getTime()-86_400_000}) AS failedOutbound,
      (SELECT count(*) FROM messages m JOIN leads l ON l.id=m.lead_id WHERE upper(l.source)='AVITO'
        AND m.direction='OUTBOUND' AND m.actor='AI' AND m.delivery_status IN ('FAILED','PENDING')
        AND (m.last_delivery_error_code IS NULL OR m.last_delivery_error_code NOT LIKE 'CANCELLED_%')
        AND m.created_at<=${at.getTime()-60_000} AND m.created_at>=${at.getTime()-86_400_000}
        AND NOT EXISTS (SELECT 1 FROM messages later WHERE later.lead_id=m.lead_id AND later.direction='OUTBOUND'
          AND later.created_at>m.created_at AND (later.actor='MANAGER' OR later.delivery_status='SENT'))) AS unresolvedOutbound`);
    return row;
  }
}
