import type { ConversationState } from "./conversation-state";
import type { InformationNeed } from "./information-needs";

export interface Conversation {
  id: string;
  leadId: string;
  state: ConversationState;
  summary: string | null;
  pendingInformationNeed: InformationNeed | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  awaitingUserReply: boolean;
  qualificationCompleted: boolean;
  followUpEligibleAt: Date | null;
  followUpCount: number;
  lastFollowUpAt: Date | null;
  /** Last non-reminder team message: reminders never move this anchor. */
  followUpAnchorAt: Date | null;
  /** Recoverable silence outcome, independent of business qualification. */
  missedAt: Date | null;
  nextInboundSequence: number;
  lastAppliedInboundSequence: number;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}
