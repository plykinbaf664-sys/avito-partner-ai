import { z } from "zod";

export const TEST_CHAT_LAB_SOURCE = "TEST_CHAT_LAB";

export const testChatLabScenarios = [
  {
    id: "manager-phone",
    title: "Дмитрий просит телефон",
    steps: [
      { actor: "MANAGER", text: "Оставьте номер, я вам сегодня наберу." },
      { actor: "USER", text: "89049163020" },
    ],
  },
  {
    id: "economics-two-units",
    title: "Экономика двух объектов",
    steps: [
      { actor: "USER", text: "А сколько понадобится на старт с двух квартир?" },
      { actor: "USER", text: "Москва, хочу начать в октябре." },
    ],
  },
  {
    id: "correction",
    title: "Коррекция ранее сказанного",
    steps: [
      { actor: "USER", text: "Денег пока нет." },
      { actor: "USER", text: "Уточню: есть 300 тысяч и готова финансировать аренду и залог." },
    ],
  },
] as const;

export type TestChatLabScenario = (typeof testChatLabScenarios)[number];

export const testChatLabActionSchema = z.object({
  action: z.enum(["client_message", "manager_message", "advance_time", "run_scenario"]),
  sessionId: z.string().trim().min(1).max(100),
  text: z.string().trim().min(1).max(4_000).optional(),
  virtualNow: z.string().datetime({ offset: true }),
  turnId: z.string().trim().min(1).max(100).optional(),
  scenarioId: z.string().trim().min(1).max(100).optional(),
}).strict();

export type TestChatLabAction = z.infer<typeof testChatLabActionSchema>;

export interface TestChatLabSnapshot {
  sessionId: string;
  virtualNow: string;
  lead: unknown;
  conversation: unknown;
  messages: Array<{
    id: string;
    direction: "INBOUND" | "OUTBOUND";
    actor: "USER" | "AI" | "MANAGER";
    content: string;
    createdAt: Date | string;
    deliveryStatus: string | null;
  }>;
  qualification: {
    status: string | null;
    reason: string | null;
    shouldHandoffToManager: boolean;
    nextAction: string | null;
    knownFacts: string[];
    missingCriticalFacts: string[];
  };
  phone: string | null;
  currentNextStep: string | null;
  replyAction: "SEND_REPLY" | "NO_REPLY";
  handoff: {
    decision: "HANDOFF" | "NONE";
    notificationStatus: string | null;
    notificationId: string | null;
  };
  followUp: {
    eligibleAt: string | null;
    lastFollowUpAt: string | null;
    followUpCount: number;
    awaitingUserReply: boolean;
  };
  lastProcessing: {
    outboundMessage: string | null;
    replyAction: "SEND_REPLY" | "NO_REPLY";
    eventStatus: string | null;
  } | null;
}

export interface TestChatLabActionResult {
  snapshot: TestChatLabSnapshot;
  followUp: { scanned: number; created: number; sent: number; failed: number; skipped: number } | null;
}
