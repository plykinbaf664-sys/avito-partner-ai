import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { conversationStates } from "@/domain/conversation/conversation-state";
import { informationNeeds } from "@/domain/conversation/information-needs";
import { incomingEventStatuses } from "@/domain/event/incoming-event";
import { deliveryStatuses } from "@/domain/delivery/delivery-state";
import {
  additionalExpensesReadinessValues,
  businessBarriers,
  businessModelReadinessValues,
  capitalScopes,
  launchTimings,
  managementReadinessValues,
  primaryGoals,
  type ExtractedMessage,
} from "@/domain/extraction/extracted-message";
import { qualificationStatuses } from "@/domain/lead/qualification-status";
import { leadSegments } from "@/domain/lead/lead-segment";
import { serviceabilityStatuses } from "@/domain/lead/serviceability";
import { messageDirections } from "@/domain/message/message";
import type { ManagerSummary } from "@/domain/handoff/manager-summary";

export const leads = sqliteTable(
  "leads",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    externalLeadId: text("external_lead_id").notNull(),
    name: text("name"),
    contact: text("contact"),
    city: text("city"),
    serviceability: text("serviceability", { enum: serviceabilityStatuses })
      .notNull()
      .default("NEEDS_REVIEW"),
    budget: integer("budget"),
    budgetConfirmed: integer("budget_confirmed", { mode: "boolean" })
      .notNull()
      .default(false),
    availableCapital: integer("available_capital"),
    availableCapitalConfirmed: integer("available_capital_confirmed", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    entryBudget: integer("entry_budget"),
    additionalLaunchCapital: integer("additional_launch_capital"),
    capitalScope: text("capital_scope", { enum: capitalScopes })
      .notNull()
      .default("UNKNOWN"),
    additionalExpensesReadiness: text("additional_expenses_readiness", {
      enum: additionalExpensesReadinessValues,
    })
      .notNull()
      .default("UNKNOWN"),
    businessModelReadiness: text("business_model_readiness", {
      enum: businessModelReadinessValues,
    })
      .notNull()
      .default("UNKNOWN"),
    segment: text("segment", { enum: leadSegments })
      .notNull()
      .default("UNDETERMINED"),
    segmentConfidence: real("segment_confidence")
      .notNull()
      .default(0),
    legacyPotentialUnits: integer("potential_units"),
    startingUnits: integer("starting_units"),
    scalingPotentialUnits: integer("scaling_potential_units"),
    hasFreeTime: integer("has_free_time", { mode: "boolean" }),
    availableTimeDetails: text("available_time_details"),
    businessExperience: text("business_experience"),
    shortTermRentalExperience: text("short_term_rental_experience"),
    ownsProperty: integer("owns_property", { mode: "boolean" }),
    desiredIncome: integer("desired_income"),
    primaryGoal: text("primary_goal", { enum: primaryGoals }),
    primaryFear: text("primary_fear", { enum: businessBarriers }),
    secondaryFear: text("secondary_fear", { enum: businessBarriers }),
    launchTiming: text("launch_timing", { enum: launchTimings }),
    managementReadiness: text("management_readiness", {
      enum: managementReadinessValues,
    }),
    requiresGuaranteedIncome: integer("requires_guaranteed_income", {
      mode: "boolean",
    }),
    rejectsBusinessModel: integer("rejects_business_model", {
      mode: "boolean",
    }),
    questions: text("questions", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default([]),
    objections: text("objections", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default([]),
    buyingIntent: text("buying_intent"),
    qualificationStatus: text("qualification_status", {
      enum: qualificationStatuses,
    })
      .notNull()
      .default("NEW"),
    qualificationReason: text("qualification_reason"),
    conversationSummary: text("conversation_summary"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    handoffAt: integer("handoff_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("leads_source_external_id_unique").on(
      table.source,
      table.externalLeadId,
    ),
    index("leads_qualification_status_idx").on(table.qualificationStatus),
  ],
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    leadId: text("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    state: text("state", { enum: conversationStates })
      .notNull()
      .default("NEW"),
    summary: text("summary"),
    pendingInformationNeed: text("pending_information_need", {
      enum: informationNeeds,
    }),
    lastInboundAt: integer("last_inbound_at", { mode: "timestamp_ms" }),
    lastOutboundAt: integer("last_outbound_at", { mode: "timestamp_ms" }),
    awaitingUserReply: integer("awaiting_user_reply", { mode: "boolean" })
      .notNull()
      .default(false),
    qualificationCompleted: integer("qualification_completed", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    followUpEligibleAt: integer("follow_up_eligible_at", {
      mode: "timestamp_ms",
    }),
    followUpCount: integer("follow_up_count").notNull().default(0),
    lastFollowUpAt: integer("last_follow_up_at", { mode: "timestamp_ms" }),
    nextInboundSequence: integer("next_inbound_sequence").notNull().default(0),
    lastAppliedInboundSequence: integer("last_applied_inbound_sequence")
      .notNull()
      .default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    closedAt: integer("closed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("conversations_lead_id_idx").on(table.leadId),
    index("conversations_state_idx").on(table.state),
    index("conversations_follow_up_due_idx").on(table.followUpEligibleAt),
  ],
);

export const incomingEvents = sqliteTable(
  "incoming_events",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    externalEventId: text("external_event_id").notNull(),
    externalLeadId: text("external_lead_id").notNull(),
    payload: text("payload", { mode: "json" }).$type<unknown>().notNull(),
    status: text("status", { enum: incomingEventStatuses })
      .notNull()
      .default("RECEIVED"),
    error: text("error"),
    processingAttempts: integer("processing_attempts").notNull().default(0),
    processingRetryable: integer("processing_retryable", { mode: "boolean" }),
    extraction: text("extraction", { mode: "json" }).$type<ExtractedMessage>(),
    llmModel: text("llm_model"),
    llmInputTokens: integer("llm_input_tokens"),
    llmOutputTokens: integer("llm_output_tokens"),
    llmLatencyMs: integer("llm_latency_ms"),
    totalProcessingLatencyMs: integer("total_processing_latency_ms"),
    receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
    processingStartedAt: integer("processing_started_at", {
      mode: "timestamp_ms",
    }),
    processedAt: integer("processed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("incoming_events_source_external_id_unique").on(
      table.source,
      table.externalEventId,
    ),
    index("incoming_events_status_idx").on(table.status),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    leadId: text("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    incomingEventId: text("incoming_event_id").references(
      () => incomingEvents.id,
      { onDelete: "restrict" },
    ),
    externalMessageId: text("external_message_id"),
    deduplicationKey: text("deduplication_key"),
    sequence: integer("sequence"),
    direction: text("direction", { enum: messageDirections }).notNull(),
    content: text("content").notNull(),
    deliveryStatus: text("delivery_status", { enum: deliveryStatuses }),
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    deliveryRetryable: integer("delivery_retryable", { mode: "boolean" }),
    lastDeliveryErrorCode: text("last_delivery_error_code"),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("messages_incoming_event_id_unique").on(table.incomingEventId),
    uniqueIndex("messages_deduplication_key_unique").on(table.deduplicationKey),
    index("messages_conversation_id_idx").on(table.conversationId),
    index("messages_lead_id_idx").on(table.leadId),
  ],
);

export const managerNotifications = sqliteTable(
  "manager_notifications",
  {
    id: text("id").primaryKey(),
    leadId: text("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    qualificationStatus: text("qualification_status", {
      enum: qualificationStatuses,
    }).notNull(),
    summary: text("summary", { mode: "json" }).$type<ManagerSummary>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    deliveryStatus: text("delivery_status", { enum: deliveryStatuses })
      .notNull()
      .default("PENDING"),
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    deliveryRetryable: integer("delivery_retryable", { mode: "boolean" }),
    lastDeliveryErrorCode: text("last_delivery_error_code"),
    externalNotificationId: text("external_notification_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("manager_notifications_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
    index("manager_notifications_delivery_status_idx").on(table.deliveryStatus),
    index("manager_notifications_lead_id_idx").on(table.leadId),
  ],
);
