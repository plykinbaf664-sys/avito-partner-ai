import type { InformationNeed } from "@/domain/conversation/information-needs";

/** Durable execution state, never customer speech or qualification facts. */
export interface ChatOpening {
  conversationId: string;
  leadId: string;
  chatCreatedAt: Date;
  eligibleAt: Date;
  status: "WAITING" | "PROCESSING" | "DONE";
  attempts: number;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  reason: string | null;
  response: { awaitingUserReply: boolean; nextInformationNeed: InformationNeed | null; notes?: string } | null;
}

export interface ChatOpeningRepository {
  insertIfAbsent(job: ChatOpening): Promise<boolean>;
  find(conversationId: string): Promise<ChatOpening | null>;
  listDue(now: Date, limit: number): Promise<ChatOpening[]>;
  claim(conversationId: string, owner: string, now: Date, until: Date): Promise<ChatOpening | null>;
  updateOwned(job: ChatOpening, owner: string): Promise<boolean>;
}
