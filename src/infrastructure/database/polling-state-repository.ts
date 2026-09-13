import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import type { PollingStateRepository } from "@/application/ports/polling-state";
import * as schema from "./schema";

export class DrizzlePollingStateRepository implements PollingStateRepository {
  constructor(private readonly database: LibSQLDatabase<typeof schema>) {}

  async initialize(key: string, startedAt: Date) {
    await this.database.insert(schema.pollingStates).values({ key, startedAt })
      .onConflictDoNothing();
    const [state] = await this.database.select().from(schema.pollingStates)
      .where(eq(schema.pollingStates.key, key));
    if (!state) throw new Error("POLLING_STATE_MISSING");
    return state;
  }

  async acquire(key: string, owner: string, now: Date, until: Date) {
    const rows = await this.database.update(schema.pollingStates)
      .set({ leaseOwner: owner, leaseUntil: until })
      .where(and(eq(schema.pollingStates.key, key), or(
        isNull(schema.pollingStates.leaseOwner), lte(schema.pollingStates.leaseUntil, now),
      ))).returning({ key: schema.pollingStates.key });
    return rows.length === 1;
  }

  async renew(key: string, owner: string, now: Date, until: Date) {
    const rows = await this.database.update(schema.pollingStates)
      .set({ leaseUntil: until }).where(and(
        eq(schema.pollingStates.key, key), eq(schema.pollingStates.leaseOwner, owner),
        gt(schema.pollingStates.leaseUntil, now),
      )).returning({ key: schema.pollingStates.key });
    return rows.length === 1;
  }

  async complete(key: string, owner: string, now: Date, through: Date) {
    const rows = await this.database.update(schema.pollingStates)
      .set({ lastCompletedAt: through }).where(and(
        eq(schema.pollingStates.key, key), eq(schema.pollingStates.leaseOwner, owner),
        gt(schema.pollingStates.leaseUntil, now),
      )).returning({ key: schema.pollingStates.key });
    return rows.length === 1;
  }

  async release(key: string, owner: string) {
    await this.database.update(schema.pollingStates)
      .set({ leaseOwner: null, leaseUntil: null }).where(and(
        eq(schema.pollingStates.key, key), eq(schema.pollingStates.leaseOwner, owner),
      ));
  }
}
