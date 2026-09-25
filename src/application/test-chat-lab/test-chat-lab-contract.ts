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
  {
    id: "question-about-qualification",
    title: "Встречный вопрос о смысле квалификации",
    steps: [
      { actor: "USER", text: "Здравствуйте, я из Москвы." },
      { actor: "USER", text: "А почему Вам важно это знать?" },
      { actor: "USER", text: "Хорошо, на запуск есть 300 тысяч, хочу начать в ближайшую неделю." },
      { actor: "USER", text: "А какая разница, когда именно?" },
    ],
  },
  {
    id: "why-budget-was-asked",
    title: "Встречный вопрос о бюджете",
    steps: [
      { actor: "MANAGER", text: "Какой бюджет Вы готовы выделить на запуск?" },
      { actor: "USER", text: "А че это важно?" },
    ],
  },
  {
    id: "why-timing-was-asked",
    title: "Встречный вопрос о сроке запуска",
    steps: [
      { actor: "MANAGER", text: "Когда Вы планируете запуск?" },
      { actor: "USER", text: "Какая разница?" },
    ],
  },
  {
    id: "identity-and-goal",
    title: "Прямой вопрос об AI и разговорный ответ о цели",
    steps: [
      { actor: "USER", text: "Я с ботом разговариваю?" },
      { actor: "USER", text: "Да я не знаю даже, хочу деньги зарабатывать." },
    ],
  },
  {
    id: "identity-question",
    title: "Прямой вопрос об AI",
    steps: [{ actor: "USER", text: "Я с ботом разговариваю?" }],
  },
  {
    id: "partner-time-question",
    title: "Вопрос о личном времени партнёра",
    steps: [{ actor: "USER", text: "Какой объём участия потребуется лично от меня?" }],
  },
  {
    id: "recommendation-from-context",
    title: "Делегирование выбора масштаба при известном капитале",
    steps: [
      { actor: "USER", text: "Я в Москве, на старт готов выделить 400 тысяч." },
      { actor: "USER", text: "Это Вы мне скажите, со скольких можно при таком раскладе?" },
    ],
  },
  {
    id: "short-referential-time-question",
    title: "Короткий вопрос о требуемом времени",
    steps: [
      { actor: "MANAGER", text: "Сколько часов в день сможете уделять проекту?" },
      { actor: "USER", text: "А сколько надо?" },
    ],
  },
  {
    id: "city-and-insufficient-capital",
    title: "Три коротких сообщения о городе и капитале",
    burst: true,
    steps: [
      { actor: "USER", text: "Здравствуйте" },
      { actor: "USER", text: "Нижний Новгород" },
      { actor: "USER", text: "100т.₽" },
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
    responseFailureCode?: string | null;
    responseGenerationSource?: string | null;
  } | null;
}

export interface TestChatLabActionResult {
  snapshot: TestChatLabSnapshot;
  followUp: { scanned: number; created: number; sent: number; failed: number; skipped: number } | null;
}
