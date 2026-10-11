import type { Message } from "@/domain/message/message";

export function hasLaterManagerMessage(history: Message[], reference: Message): boolean {
  const referenceIndex = history.findIndex(item => item.id === reference.id);
  return history.some((item, index) => item.actor === "MANAGER" &&
    (item.createdAt > reference.createdAt || item.createdAt.getTime() === reference.createdAt.getTime() && index > referenceIndex));
}

/** Technical causality only: no interpretation of customer or manager language. */
export function outboundCancellationReason(message: Message, history: Message[]): string | null {
  if (message.actor !== "AI") return null;
  if (message.deduplicationKey === `chat-opening:${message.conversationId}`) {
    if (history.some(item => item.actor === "MANAGER")) return "CANCELLED_BY_HUMAN_MESSAGE";
    if (history.some(item => item.direction === "INBOUND")) return "CANCELLED_BY_INBOUND";
    if (history.some(item => item.id !== message.id && item.actor === "AI" && item.deliveryStatus === "SENT")) {
      return "CANCELLED_BY_EXISTING_DIALOGUE";
    }
    return null;
  }
  const turnPrefix = `turn-response:${message.conversationId}:`;
  const turnSequence = message.deduplicationKey?.startsWith(turnPrefix)
    ? Number(message.deduplicationKey.slice(turnPrefix.length)) : null;
  const inbound = message.incomingEventId
    ? history.find(item => item.direction === "INBOUND" && item.incomingEventId === message.incomingEventId)
    : history.find(item => item.direction === "INBOUND" && item.conversationId === message.conversationId && item.sequence === turnSequence);
  if (hasLaterManagerMessage(history, inbound ?? message)) return "CANCELLED_BY_HUMAN_MESSAGE";
  if (history.some(item => item.direction === "INBOUND" &&
      (inbound?.sequence != null && item.conversationId === message.conversationId
        ? (item.sequence ?? 0) > inbound.sequence : item.createdAt > message.createdAt))) return "CANCELLED_BY_INBOUND";
  return null;
}
