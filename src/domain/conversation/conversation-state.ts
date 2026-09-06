export const conversationStates = [
  "NEW",
  "DISCOVERY",
  "QUALIFYING",
  "WAITING_CITY",
  "WAITING_GOAL",
  "WAITING_EXPERIENCE",
  "WAITING_BARRIER",
  "WAITING_BUDGET",
  "WAITING_TIME",
  "WAITING_LAUNCH_TIMING",
  "QUALIFIED",
  "HANDOFF",
  "CLOSED",
] as const;

export type ConversationState = (typeof conversationStates)[number];

const activeQualificationStates = new Set<ConversationState>([
  "DISCOVERY",
  "QUALIFYING",
  "WAITING_CITY",
  "WAITING_GOAL",
  "WAITING_EXPERIENCE",
  "WAITING_BARRIER",
  "WAITING_BUDGET",
  "WAITING_TIME",
  "WAITING_LAUNCH_TIMING",
]);

export function canTransitionConversation(
  from: ConversationState,
  to: ConversationState,
): boolean {
  if (from === to) return true;
  if (from === "CLOSED") return false;
  if (to === "CLOSED") return true;
  if (from === "NEW") return to === "DISCOVERY" || to === "HANDOFF";
  if (from === "HANDOFF") return false;
  if (to === "HANDOFF") return true;
  if (activeQualificationStates.has(from)) {
    return activeQualificationStates.has(to) || to === "QUALIFIED";
  }
  if (from === "QUALIFIED") {
    return activeQualificationStates.has(to);
  }
  return false;
}

export function transitionConversation(
  from: ConversationState,
  to: ConversationState,
): ConversationState {
  if (!canTransitionConversation(from, to)) {
    throw new Error(`Invalid conversation state transition: ${from} -> ${to}`);
  }
  return to;
}
