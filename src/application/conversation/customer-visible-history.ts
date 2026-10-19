import type { Message } from "@/domain/message/message";

/** Persistence contains drafts too; a draft cannot close a customer's request. */
export function customerVisibleHistory(messages: Message[], draftOnlyMode = false) {
  const visible = (message: Message) => message.direction === "INBOUND" ||
    message.deliveryStatus === "SENT" || message.deliveryStatus === null ||
    (draftOnlyMode && message.deliveryStatus === "PENDING");
  const latestTeamMessage = messages.findLast(message => message.direction === "OUTBOUND");
  return {
    messages: messages.filter(visible),
    // Existing notes are saved with the draft. If its delivery failed, they may
    // falsely claim that we answered/asked something. Reconstruct from history.
    notesReliable: !latestTeamMessage || visible(latestTeamMessage),
  };
}
