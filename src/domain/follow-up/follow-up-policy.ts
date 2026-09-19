import type { Conversation } from "../conversation/conversation";
import type { Lead } from "../lead/lead";

export const FOLLOW_UP_POLICY = Object.freeze({
  delayMs: 2 * 60 * 60 * 1_000,
  maximumQualificationFollowUps: 1,
});

export interface FollowUpEligibility {
  eligible: boolean;
  reason:
    | "ELIGIBLE"
    | "NOT_DUE"
    | "NOT_AWAITING_REPLY"
    | "QUALIFICATION_COMPLETED"
    | "TERMINAL_LEAD"
    | "USER_REPLIED"
    | "ALREADY_FOLLOWED_UP"
    | "NO_OUTBOUND_MESSAGE";
}

export function followUpEligibleAt(lastOutboundAt: Date): Date {
  return new Date(lastOutboundAt.getTime() + FOLLOW_UP_POLICY.delayMs);
}

export function evaluateFollowUpEligibility(
  conversation: Conversation,
  lead: Lead,
  now: Date,
): FollowUpEligibility {
  if (conversation.followUpCount >= FOLLOW_UP_POLICY.maximumQualificationFollowUps) {
    return { eligible: false, reason: "ALREADY_FOLLOWED_UP" };
  }
  if (
    conversation.qualificationCompleted ||
    conversation.state === "QUALIFIED" ||
    conversation.state === "HANDOFF" ||
    conversation.state === "CLOSED"
  ) {
    return { eligible: false, reason: "QUALIFICATION_COMPLETED" };
  }
  if (
    lead.qualificationStatus === "NO_FIT" ||
    lead.qualificationStatus === "HANDOFF" ||
    lead.qualificationStatus === "CLOSED" ||
    lead.buyingIntent === "DECLINED"
  ) {
    return { eligible: false, reason: "TERMINAL_LEAD" };
  }
  if (!conversation.awaitingUserReply) {
    return { eligible: false, reason: "NOT_AWAITING_REPLY" };
  }
  if (!conversation.lastOutboundAt || !conversation.followUpEligibleAt) {
    return { eligible: false, reason: "NO_OUTBOUND_MESSAGE" };
  }
  if (
    conversation.lastInboundAt !== null &&
    conversation.lastInboundAt.getTime() > conversation.lastOutboundAt.getTime()
  ) {
    return { eligible: false, reason: "USER_REPLIED" };
  }
  if (conversation.followUpEligibleAt.getTime() > now.getTime()) {
    return { eligible: false, reason: "NOT_DUE" };
  }
  return { eligible: true, reason: "ELIGIBLE" };
}

export function buildQualificationFollowUp(
  conversation: Conversation,
  lastOutboundText: string | null,
): string {
  // A deterministic fallback must never turn an unresolved field into a
  // questionnaire prompt. The natural-response layer receives all allowed
  // directions and owns the conversational move; if it is unavailable, keep
  // the follow-up neutral and preserve the conversation for a later retry.
  void conversation;
  void lastOutboundText;
  return lastOutboundText?.trim()
    ? "Возвращаюсь к нашему разговору. Если тема ещё актуальна, можем продолжить с того места, где остановились."
    : "Если тема запуска ещё актуальна, можем спокойно продолжить разговор.";
}
