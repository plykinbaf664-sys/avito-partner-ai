import { createClient, type Client } from "@libsql/client";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import type {
  ConversationRepository,
  CrmLeadListQuery,
  CrmLeadSnapshot,
  CrmReadRepository,
  IncomingEventRegistration,
  IncomingEventRepository,
  LeadRepository,
  MessageRepository,
  ManagerNotificationRepository,
  Persistence,
  ProcessedEventDetails,
  RepositoryContext,
  TelegramBotUpdateRepository,
  TelegramManagerDeliveryRepository,
  TelegramManagerRecipientRepository,
} from "@/application/ports/repositories";
import type { Conversation } from "@/domain/conversation/conversation";
import type { ConversationState } from "@/domain/conversation/conversation-state";
import type { IncomingEvent } from "@/domain/event/incoming-event";
import type { Lead } from "@/domain/lead/lead";
import type { Message } from "@/domain/message/message";
import type { ManagerNotification } from "@/domain/notification/manager-notification";
import type { TelegramManagerDelivery } from "@/domain/notification/telegram-manager-delivery";
import type { TelegramManagerRecipient } from "@/domain/notification/telegram-manager-recipient";

import * as schema from "./schema";

type Database = LibSQLDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type DatabaseExecutor = Database | Transaction;

class DrizzleLeadRepository implements LeadRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findById(id: string): Promise<Lead | null> {
    const rows = await this.database
      .select()
      .from(schema.leads)
      .where(eq(schema.leads.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async findByExternalIdentity(
    source: string,
    externalLeadId: string,
  ): Promise<Lead | null> {
    const rows = await this.database
      .select()
      .from(schema.leads)
      .where(
        and(
          eq(schema.leads.source, source),
          eq(schema.leads.externalLeadId, externalLeadId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async insert(lead: Lead): Promise<void> {
    await this.database.insert(schema.leads).values(lead);
  }

  async update(lead: Lead): Promise<void> {
    await this.database
      .update(schema.leads)
      .set(lead)
      .where(eq(schema.leads.id, lead.id));
  }
}

class DrizzleConversationRepository implements ConversationRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findById(id: string): Promise<Conversation | null> {
    const rows = await this.database
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async findOpenByLeadId(leadId: string): Promise<Conversation | null> {
    const rows = await this.database
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.leadId, leadId),
          isNull(schema.conversations.closedAt),
        ),
      )
      .orderBy(schema.conversations.createdAt)
      .limit(1);
    return rows[0] ?? null;
  }

  async insert(conversation: Conversation): Promise<void> {
    await this.database.insert(schema.conversations).values(conversation);
  }

  async listDueFollowUps(now: Date, limit: number): Promise<Conversation[]> {
    return this.database
      .select()
      .from(schema.conversations)
      .where(
        and(
          lte(schema.conversations.followUpEligibleAt, now),
          eq(schema.conversations.awaitingUserReply, true),
          eq(schema.conversations.qualificationCompleted, false),
          eq(schema.conversations.followUpCount, 0),
        ),
      )
      .orderBy(asc(schema.conversations.followUpEligibleAt))
      .limit(limit);
  }

  async update(conversation: Conversation): Promise<void> {
    await this.database
      .update(schema.conversations)
      .set(conversation)
      .where(eq(schema.conversations.id, conversation.id));
  }

  async updateState(
    id: string,
    state: ConversationState,
    updatedAt: Date,
  ): Promise<void> {
    await this.database
      .update(schema.conversations)
      .set({ state, updatedAt })
      .where(eq(schema.conversations.id, id));
  }
}

class DrizzleMessageRepository implements MessageRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findById(id: string): Promise<Message | null> {
    const rows = await this.database
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async findByDeduplicationKey(key: string): Promise<Message | null> {
    const rows = await this.database
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.deduplicationKey, key))
      .limit(1);
    return rows[0] ?? null;
  }

  async insert(message: Message): Promise<void> {
    await this.database.insert(schema.messages).values(message);
  }

  async insertIfAbsent(message: Message): Promise<boolean> {
    const rows = await this.database
      .insert(schema.messages)
      .values(message)
      .onConflictDoNothing()
      .returning({ id: schema.messages.id });
    return rows.length === 1;
  }

  async update(message: Message): Promise<void> {
    await this.database
      .update(schema.messages)
      .set(message)
      .where(eq(schema.messages.id, message.id));
  }

  async findByIncomingEventId(incomingEventId: string): Promise<Message | null> {
    const rows = await this.database
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.incomingEventId, incomingEventId))
      .limit(1);
    return rows[0] ?? null;
  }

  async listByConversationId(conversationId: string): Promise<Message[]> {
    return this.database
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .orderBy(schema.messages.createdAt);
  }

  async listRecentByConversationId(
    conversationId: string,
    limit: number,
  ): Promise<Message[]> {
    const rows = await this.database
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .orderBy(desc(schema.messages.createdAt))
      .limit(Math.max(1, Math.min(100, limit)));
    return rows.reverse();
  }
}

function crmLeadWhere(
  query: Pick<CrmLeadListQuery, "filter" | "search">,
): SQL | undefined {
  const conditions: SQL[] = [];
  if (query.search) {
    const search = `%${query.search}%`;
    const searchCondition = or(
      like(schema.leads.name, search),
      like(schema.leads.phoneNumber, search),
      like(schema.leads.city, search),
    );
    if (searchCondition) conditions.push(searchCondition);
  }
  switch (query.filter) {
    case "hot":
      conditions.push(
        inArray(schema.leads.qualificationStatus, ["HOT", "PRIORITY"]),
      );
      break;
    case "qualified":
      conditions.push(eq(schema.leads.qualificationStatus, "QUALIFIED"));
      break;
    case "handoff":
      conditions.push(isNotNull(schema.leads.handoffAt));
      break;
    case "active":
      conditions.push(
        inArray(schema.leads.qualificationStatus, [
          "NEW",
          "QUALIFYING",
          "NEEDS_MORE_INFO",
          "BORDERLINE",
          "WARM",
          "NURTURE",
        ]),
      );
      break;
    case "no_fit":
      conditions.push(
        or(
          inArray(schema.leads.qualificationStatus, ["NO_FIT", "CLOSED"]),
          eq(schema.leads.buyingIntent, "DECLINED"),
        )!,
      );
      break;
    case "all":
      break;
  }
  return conditions.length === 0 ? undefined : and(...conditions);
}

class DrizzleCrmReadRepository implements CrmReadRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  private async attachRelations(leads: Lead[]): Promise<CrmLeadSnapshot[]> {
    if (leads.length === 0) return [];
    const leadIds = leads.map((lead) => lead.id);
    const [conversationRows, notificationRows] = await Promise.all([
      this.database
        .select()
        .from(schema.conversations)
        .where(inArray(schema.conversations.leadId, leadIds))
        .orderBy(desc(schema.conversations.updatedAt)),
      this.database
        .select()
        .from(schema.managerNotifications)
        .where(inArray(schema.managerNotifications.leadId, leadIds))
        .orderBy(desc(schema.managerNotifications.createdAt)),
    ]);
    const conversationsByLead = new Map<string, Conversation>();
    for (const conversation of conversationRows) {
      if (!conversationsByLead.has(conversation.leadId)) {
        conversationsByLead.set(conversation.leadId, conversation);
      }
    }
    const notificationsByLead = new Map<string, ManagerNotification>();
    for (const notification of notificationRows) {
      if (!notificationsByLead.has(notification.leadId)) {
        notificationsByLead.set(notification.leadId, notification);
      }
    }
    return leads.map((lead) => {
      const conversation = conversationsByLead.get(lead.id) ?? null;
      const managerNotification = notificationsByLead.get(lead.id) ?? null;
      const candidates = [
        lead.updatedAt,
        conversation?.lastInboundAt,
        conversation?.lastOutboundAt,
        conversation?.updatedAt,
      ].filter((value): value is Date => value instanceof Date);
      return {
        lead,
        conversation,
        managerNotification,
        lastActivityAt: new Date(
          Math.max(...candidates.map((value) => value.getTime())),
        ),
      };
    });
  }

  async listLeadSnapshots(query: CrmLeadListQuery): Promise<CrmLeadSnapshot[]> {
    const rows = await this.database
      .select()
      .from(schema.leads)
      .where(crmLeadWhere(query))
      .orderBy(
        sql`case
          when ${schema.leads.handoffAt} is not null then 0
          when ${schema.leads.qualificationStatus} in ('HOT', 'PRIORITY', 'QUALIFIED') then 1
          when ${schema.leads.qualificationStatus} in ('NEW', 'QUALIFYING', 'NEEDS_MORE_INFO', 'BORDERLINE', 'WARM', 'NURTURE') then 2
          else 3 end`,
        desc(
          sql`coalesce(
            (select max(${schema.conversations.updatedAt})
             from ${schema.conversations}
             where ${schema.conversations.leadId} = ${schema.leads.id}),
            ${schema.leads.updatedAt}
          )`,
        ),
      )
      .limit(query.limit)
      .offset(query.offset);
    return this.attachRelations(rows);
  }

  async countLeadSnapshots(
    query: Pick<CrmLeadListQuery, "filter" | "search">,
  ): Promise<number> {
    const rows = await this.database
      .select({ total: count() })
      .from(schema.leads)
      .where(crmLeadWhere(query));
    return rows[0]?.total ?? 0;
  }

  async findLeadSnapshot(leadId: string): Promise<CrmLeadSnapshot | null> {
    const rows = await this.database
      .select()
      .from(schema.leads)
      .where(eq(schema.leads.id, leadId))
      .limit(1);
    if (!rows[0]) return null;
    return (await this.attachRelations([rows[0]]))[0] ?? null;
  }
}

class DrizzleManagerNotificationRepository
  implements ManagerNotificationRepository
{
  constructor(private readonly database: DatabaseExecutor) {}

  async findById(id: string): Promise<ManagerNotification | null> {
    const rows = await this.database
      .select()
      .from(schema.managerNotifications)
      .where(eq(schema.managerNotifications.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async findByIdempotencyKey(key: string): Promise<ManagerNotification | null> {
    const rows = await this.database
      .select()
      .from(schema.managerNotifications)
      .where(eq(schema.managerNotifications.idempotencyKey, key))
      .limit(1);
    return rows[0] ?? null;
  }

  async insertIfAbsent(notification: ManagerNotification): Promise<boolean> {
    const rows = await this.database
      .insert(schema.managerNotifications)
      .values(notification)
      .onConflictDoNothing()
      .returning({ id: schema.managerNotifications.id });
    return rows.length === 1;
  }

  async update(notification: ManagerNotification): Promise<void> {
    await this.database
      .update(schema.managerNotifications)
      .set(notification)
      .where(eq(schema.managerNotifications.id, notification.id));
  }

  async listDeliverable(limit: number): Promise<ManagerNotification[]> {
    return this.database
      .select()
      .from(schema.managerNotifications)
      .where(
        or(
          eq(schema.managerNotifications.deliveryStatus, "PENDING"),
          and(
            eq(schema.managerNotifications.deliveryStatus, "FAILED"),
            eq(schema.managerNotifications.deliveryRetryable, true),
          ),
        ),
      )
      .orderBy(asc(schema.managerNotifications.createdAt))
      .limit(limit);
  }
}

class DrizzleTelegramManagerRecipientRepository
  implements TelegramManagerRecipientRepository
{
  constructor(private readonly database: DatabaseExecutor) {}

  async findByChatId(chatId: string): Promise<TelegramManagerRecipient | null> {
    const rows = await this.database
      .select()
      .from(schema.telegramManagerRecipients)
      .where(eq(schema.telegramManagerRecipients.telegramChatId, chatId))
      .limit(1);
    return rows[0] ?? null;
  }

  async listActive(): Promise<TelegramManagerRecipient[]> {
    return this.database
      .select()
      .from(schema.telegramManagerRecipients)
      .where(eq(schema.telegramManagerRecipients.isActive, true))
      .orderBy(asc(schema.telegramManagerRecipients.createdAt));
  }

  async upsertAuthorized(recipient: TelegramManagerRecipient): Promise<void> {
    await this.database
      .insert(schema.telegramManagerRecipients)
      .values(recipient)
      .onConflictDoUpdate({
        target: schema.telegramManagerRecipients.telegramChatId,
        set: {
          telegramUserId: recipient.telegramUserId,
          username: recipient.username,
          firstName: recipient.firstName,
          isActive: true,
          authorizedAt: recipient.authorizedAt,
          updatedAt: recipient.updatedAt,
        },
      });
  }

  async deactivate(chatId: string, updatedAt: Date): Promise<boolean> {
    const rows = await this.database
      .update(schema.telegramManagerRecipients)
      .set({ isActive: false, updatedAt })
      .where(eq(schema.telegramManagerRecipients.telegramChatId, chatId))
      .returning({ id: schema.telegramManagerRecipients.id });
    return rows.length === 1;
  }
}

class DrizzleTelegramManagerDeliveryRepository
  implements TelegramManagerDeliveryRepository
{
  constructor(private readonly database: DatabaseExecutor) {}

  async findByIdempotencyKey(
    key: string,
  ): Promise<TelegramManagerDelivery | null> {
    const rows = await this.database
      .select()
      .from(schema.telegramManagerDeliveries)
      .where(eq(schema.telegramManagerDeliveries.idempotencyKey, key))
      .limit(1);
    return rows[0] ?? null;
  }

  async insertIfAbsent(delivery: TelegramManagerDelivery): Promise<boolean> {
    const rows = await this.database
      .insert(schema.telegramManagerDeliveries)
      .values(delivery)
      .onConflictDoNothing()
      .returning({ id: schema.telegramManagerDeliveries.id });
    return rows.length === 1;
  }

  async tryClaim(
    id: string,
    expectedAttempts: number,
    updatedAt: Date,
    staleBefore: Date,
  ): Promise<boolean> {
    const rows = await this.database
      .update(schema.telegramManagerDeliveries)
      .set({
        deliveryStatus: "PENDING",
        deliveryAttempts: expectedAttempts + 1,
        deliveryRetryable: false,
        lastDeliveryErrorCode: null,
        updatedAt,
      })
      .where(
        and(
          eq(schema.telegramManagerDeliveries.id, id),
          eq(
            schema.telegramManagerDeliveries.deliveryAttempts,
            expectedAttempts,
          ),
          or(
            and(
              eq(schema.telegramManagerDeliveries.deliveryStatus, "PENDING"),
              isNull(schema.telegramManagerDeliveries.deliveryRetryable),
            ),
            and(
              eq(schema.telegramManagerDeliveries.deliveryStatus, "FAILED"),
              eq(schema.telegramManagerDeliveries.deliveryRetryable, true),
            ),
            and(
              eq(schema.telegramManagerDeliveries.deliveryStatus, "PENDING"),
              eq(schema.telegramManagerDeliveries.deliveryRetryable, false),
              lt(schema.telegramManagerDeliveries.updatedAt, staleBefore),
            ),
          ),
        ),
      )
      .returning({ id: schema.telegramManagerDeliveries.id });
    return rows.length === 1;
  }

  async update(delivery: TelegramManagerDelivery): Promise<void> {
    await this.database
      .update(schema.telegramManagerDeliveries)
      .set(delivery)
      .where(eq(schema.telegramManagerDeliveries.id, delivery.id));
  }
}

class DrizzleTelegramBotUpdateRepository
  implements TelegramBotUpdateRepository
{
  constructor(private readonly database: DatabaseExecutor) {}

  async tryClaim(updateId: string, createdAt: Date): Promise<boolean> {
    const rows = await this.database
      .insert(schema.telegramBotUpdates)
      .values({ updateId, createdAt })
      .onConflictDoNothing()
      .returning({ updateId: schema.telegramBotUpdates.updateId });
    return rows.length === 1;
  }

  async release(updateId: string): Promise<void> {
    await this.database
      .delete(schema.telegramBotUpdates)
      .where(eq(schema.telegramBotUpdates.updateId, updateId));
  }
}

class DrizzleIncomingEventRepository implements IncomingEventRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async register(event: IncomingEvent): Promise<IncomingEventRegistration> {
    const inserted = await this.database
      .insert(schema.incomingEvents)
      .values(event)
      .onConflictDoNothing({
        target: [
          schema.incomingEvents.source,
          schema.incomingEvents.externalEventId,
        ],
      })
      .returning();

    if (inserted[0]) return { event: inserted[0], created: true };

    const existing = await this.findByIdentity(
      event.source,
      event.externalEventId,
    );
    if (!existing) {
      throw new Error("Incoming event registration conflict without stored event");
    }
    return { event: existing, created: false };
  }

  async listRecoverable(
    now: Date,
    staleBefore: Date,
    maxAttempts: number,
    limit: number,
  ): Promise<IncomingEvent[]> {
    return this.database
      .select()
      .from(schema.incomingEvents)
      .where(
        and(
          lte(schema.incomingEvents.receivedAt, now),
          lt(
            schema.incomingEvents.processingAttempts,
            maxAttempts,
          ),
          or(
            eq(schema.incomingEvents.status, "RECEIVED"),
            and(
              eq(schema.incomingEvents.status, "FAILED"),
              eq(schema.incomingEvents.processingRetryable, true),
            ),
            and(
              eq(schema.incomingEvents.status, "PROCESSING"),
              or(
                isNull(schema.incomingEvents.processingStartedAt),
                lt(schema.incomingEvents.processingStartedAt, staleBefore),
              ),
            ),
          ),
        ),
      )
      .orderBy(asc(schema.incomingEvents.receivedAt))
      .limit(Math.max(1, Math.min(100, limit)));
  }

  async findByIdentity(
    source: string,
    externalEventId: string,
  ): Promise<IncomingEvent | null> {
    const rows = await this.database
      .select()
      .from(schema.incomingEvents)
      .where(
        and(
          eq(schema.incomingEvents.source, source),
          eq(schema.incomingEvents.externalEventId, externalEventId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async tryClaim(
    id: string,
    startedAt: Date,
    staleBefore: Date,
    maxAttempts: number,
  ): Promise<{ claimed: boolean; recoveredStale: boolean }> {
    const previous = await this.database
      .select({ status: schema.incomingEvents.status })
      .from(schema.incomingEvents)
      .where(eq(schema.incomingEvents.id, id))
      .limit(1);
    const claimed = await this.database
      .update(schema.incomingEvents)
      .set({
        status: "PROCESSING",
        processingStartedAt: startedAt,
        processingAttempts: sql`${schema.incomingEvents.processingAttempts} + 1`,
        processingRetryable: null,
        error: null,
      })
      .where(
        and(
          eq(schema.incomingEvents.id, id),
          lt(schema.incomingEvents.processingAttempts, maxAttempts),
          or(
            eq(schema.incomingEvents.status, "RECEIVED"),
            and(
              eq(schema.incomingEvents.status, "FAILED"),
              or(
                isNull(schema.incomingEvents.processingRetryable),
                eq(schema.incomingEvents.processingRetryable, true),
              ),
            ),
            and(
              eq(schema.incomingEvents.status, "PROCESSING"),
              or(
                isNull(schema.incomingEvents.processingStartedAt),
                lt(schema.incomingEvents.processingStartedAt, staleBefore),
              ),
            ),
          ),
        ),
      )
      .returning({ id: schema.incomingEvents.id });
    return {
      claimed: claimed.length === 1,
      recoveredStale:
        claimed.length === 1 && previous[0]?.status === "PROCESSING",
    };
  }

  async markProcessed(
    id: string,
    details: ProcessedEventDetails,
  ): Promise<void> {
    await this.database
      .update(schema.incomingEvents)
      .set({ status: "PROCESSED", error: null, ...details })
      .where(eq(schema.incomingEvents.id, id));
  }

  async markFailed(
    id: string,
    error: string,
    retryable: boolean,
  ): Promise<void> {
    await this.database
      .update(schema.incomingEvents)
      .set({ status: "FAILED", error, processingRetryable: retryable })
      .where(
        and(
          eq(schema.incomingEvents.id, id),
          inArray(schema.incomingEvents.status, [
            "RECEIVED",
            "PROCESSING",
            "FAILED",
          ]),
        ),
      );
  }
}

function createRepositoryContext(database: DatabaseExecutor): RepositoryContext {
  return {
    leads: new DrizzleLeadRepository(database),
    conversations: new DrizzleConversationRepository(database),
    messages: new DrizzleMessageRepository(database),
    incomingEvents: new DrizzleIncomingEventRepository(database),
    managerNotifications: new DrizzleManagerNotificationRepository(database),
    telegramManagerRecipients: new DrizzleTelegramManagerRecipientRepository(
      database,
    ),
    telegramManagerDeliveries: new DrizzleTelegramManagerDeliveryRepository(
      database,
    ),
    telegramBotUpdates: new DrizzleTelegramBotUpdateRepository(database),
    crm: new DrizzleCrmReadRepository(database),
  };
}

function serializeRepository<T extends object>(
  repository: T,
  serialize: <Result>(operation: () => Promise<Result>) => Promise<Result>,
): T {
  return new Proxy(repository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) =>
        serialize(() =>
          Promise.resolve(
            Reflect.apply(
              value as (...parameters: unknown[]) => unknown,
              target,
              args,
            ),
          ),
        );
    },
  });
}

export class SqlitePersistence implements Persistence {
  readonly leads: LeadRepository;
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly incomingEvents: IncomingEventRepository;
  readonly managerNotifications: ManagerNotificationRepository;
  readonly telegramManagerRecipients: TelegramManagerRecipientRepository;
  readonly telegramManagerDeliveries: TelegramManagerDeliveryRepository;
  readonly telegramBotUpdates: TelegramBotUpdateRepository;
  readonly crm: CrmReadRepository;
  private operationTail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly client: Client,
    private readonly database: Database,
  ) {
    const repositories = createRepositoryContext(database);
    const serialize = <Result>(operation: () => Promise<Result>) =>
      this.serialize(operation);
    this.leads = serializeRepository(repositories.leads, serialize);
    this.conversations = serializeRepository(repositories.conversations, serialize);
    this.messages = serializeRepository(repositories.messages, serialize);
    this.incomingEvents = serializeRepository(
      repositories.incomingEvents,
      serialize,
    );
    this.managerNotifications = serializeRepository(
      repositories.managerNotifications,
      serialize,
    );
    this.telegramManagerRecipients = serializeRepository(
      repositories.telegramManagerRecipients,
      serialize,
    );
    this.telegramManagerDeliveries = serializeRepository(
      repositories.telegramManagerDeliveries,
      serialize,
    );
    this.telegramBotUpdates = serializeRepository(
      repositories.telegramBotUpdates,
      serialize,
    );
    this.crm = serializeRepository(repositories.crm, serialize);
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  static create(databaseUrl = "file:./data/local.db"): SqlitePersistence {
    const client = createClient({ url: databaseUrl });
    return new SqlitePersistence(client, drizzle(client, { schema }));
  }

  static async createMigrated(
    databaseUrl = "file:./data/local.db",
    migrationsFolder = "./drizzle",
  ): Promise<SqlitePersistence> {
    const persistence = SqlitePersistence.create(databaseUrl);
    await migrate(persistence.database, { migrationsFolder });
    return persistence;
  }

  async transaction<T>(
    operation: (repositories: RepositoryContext) => Promise<T>,
  ): Promise<T> {
    return this.serialize(() =>
      this.database.transaction((transaction) =>
        operation(createRepositoryContext(transaction)),
      ),
    );
  }

  async checkHealth(): Promise<void> {
    await this.serialize(() => this.database.run(sql`select 1`));
  }

  async checkReadiness(): Promise<void> {
    await this.serialize(async () => {
      await this.database.run(sql`select 1`);
      await this.database
        .select({ id: schema.leads.id })
        .from(schema.leads)
        .limit(1);
      await this.database
        .select({ id: schema.incomingEvents.id })
        .from(schema.incomingEvents)
        .limit(1);
      await this.database
        .select({ id: schema.managerNotifications.id })
        .from(schema.managerNotifications)
        .limit(1);
      await this.database
        .select({ id: schema.telegramManagerRecipients.id })
        .from(schema.telegramManagerRecipients)
        .limit(1);
    });
  }

  close(): void {
    this.client.close();
  }
}
