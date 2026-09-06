import type { Conversation } from "@/domain/conversation/conversation";
import type { ConversationState } from "@/domain/conversation/conversation-state";
import type { IncomingEvent } from "@/domain/event/incoming-event";
import type { Lead } from "@/domain/lead/lead";
import type { Message } from "@/domain/message/message";
import type { ManagerNotification } from "@/domain/notification/manager-notification";

export interface LeadRepository {
  findById(id: string): Promise<Lead | null>;
  findByExternalIdentity(
    source: string,
    externalLeadId: string,
  ): Promise<Lead | null>;
  insert(lead: Lead): Promise<void>;
  update(lead: Lead): Promise<void>;
}

export interface ConversationRepository {
  findById(id: string): Promise<Conversation | null>;
  findOpenByLeadId(leadId: string): Promise<Conversation | null>;
  listDueFollowUps(now: Date, limit: number): Promise<Conversation[]>;
  insert(conversation: Conversation): Promise<void>;
  update(conversation: Conversation): Promise<void>;
  updateState(
    id: string,
    state: ConversationState,
    updatedAt: Date,
  ): Promise<void>;
}

export interface MessageRepository {
  findById(id: string): Promise<Message | null>;
  findByDeduplicationKey(key: string): Promise<Message | null>;
  insert(message: Message): Promise<void>;
  insertIfAbsent(message: Message): Promise<boolean>;
  update(message: Message): Promise<void>;
  findByIncomingEventId(incomingEventId: string): Promise<Message | null>;
  listByConversationId(conversationId: string): Promise<Message[]>;
}

export interface ManagerNotificationRepository {
  findById(id: string): Promise<ManagerNotification | null>;
  findByIdempotencyKey(key: string): Promise<ManagerNotification | null>;
  insertIfAbsent(notification: ManagerNotification): Promise<boolean>;
  update(notification: ManagerNotification): Promise<void>;
}

export interface ProcessedEventDetails {
  extraction: IncomingEvent["extraction"];
  llmModel: string;
  llmInputTokens: number;
  llmOutputTokens: number;
  llmLatencyMs: number;
  totalProcessingLatencyMs: number;
  processedAt: Date;
}

export interface IncomingEventRegistration {
  event: IncomingEvent;
  created: boolean;
}

export interface IncomingEventRepository {
  register(event: IncomingEvent): Promise<IncomingEventRegistration>;
  findByIdentity(
    source: string,
    externalEventId: string,
  ): Promise<IncomingEvent | null>;
  tryClaim(
    id: string,
    startedAt: Date,
    staleBefore: Date,
  ): Promise<{ claimed: boolean; recoveredStale: boolean }>;
  markProcessed(id: string, details: ProcessedEventDetails): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
}

export interface RepositoryContext {
  leads: LeadRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  incomingEvents: IncomingEventRepository;
  managerNotifications: ManagerNotificationRepository;
}

export interface Persistence extends RepositoryContext {
  transaction<T>(
    operation: (repositories: RepositoryContext) => Promise<T>,
  ): Promise<T>;
  checkHealth(): Promise<void>;
  checkReadiness(): Promise<void>;
}
