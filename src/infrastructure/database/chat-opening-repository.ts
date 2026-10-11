import { and, asc, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type { ChatOpening, ChatOpeningRepository } from "@/application/ports/chat-openings";
import * as schema from "./schema";

export class DrizzleChatOpeningRepository implements ChatOpeningRepository {
  constructor(private readonly database: Pick<LibSQLDatabase<typeof schema>, "insert" | "select" | "update">) {}
  async insertIfAbsent(job: ChatOpening) {
    return (await this.database.insert(schema.chatOpenings).values(job).onConflictDoNothing().returning()).length === 1;
  }
  async find(conversationId: string) {
    return (await this.database.select().from(schema.chatOpenings).where(eq(schema.chatOpenings.conversationId, conversationId)))[0] ?? null;
  }
  async listDue(now: Date, limit: number) {
    const t = schema.chatOpenings;
    return this.database.select().from(t).where(and(ne(t.status, "DONE"), lte(t.eligibleAt, now),
      or(isNull(t.leaseUntil), lte(t.leaseUntil, now)))).orderBy(asc(t.eligibleAt)).limit(limit);
  }
  async claim(conversationId: string, owner: string, now: Date, until: Date) {
    const t = schema.chatOpenings;
    return (await this.database.update(t).set({ status: "PROCESSING", leaseOwner: owner,
      leaseUntil: until, attempts: sql`${t.attempts} + 1` }).where(and(eq(t.conversationId, conversationId),
      ne(t.status, "DONE"), lte(t.eligibleAt, now), or(isNull(t.leaseUntil), lte(t.leaseUntil, now))))
      .returning())[0] ?? null;
  }
  async updateOwned(job: ChatOpening, owner: string) {
    return (await this.database.update(schema.chatOpenings).set(job).where(and(
      eq(schema.chatOpenings.conversationId, job.conversationId), eq(schema.chatOpenings.leaseOwner, owner)))
      .returning()).length === 1;
  }
}
