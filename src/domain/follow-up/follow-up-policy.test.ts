import { describe, expect, it } from "vitest";

import type { Conversation } from "../conversation/conversation";
import type { Lead } from "../lead/lead";
import {
  buildQualificationFollowUp,
  evaluateFollowUpEligibility,
  followUpEligibleAt,
} from "./follow-up-policy";

const sentAt = new Date("2026-09-01T10:00:00.000Z");

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "lead-1",
    source: "test",
    externalLeadId: "external-1",
    name: null,
    contact: null,
    city: null,
    serviceability: "NEEDS_REVIEW",
    budget: null,
    budgetConfirmed: false,
    startingUnits: null,
    scalingPotentialUnits: null,
    hasFreeTime: null,
    availableTimeDetails: null,
    businessExperience: null,
    shortTermRentalExperience: null,
    ownsProperty: null,
    desiredIncome: null,
    primaryGoal: null,
    primaryFear: null,
    secondaryFear: null,
    launchTiming: null,
    managementReadiness: null,
    requiresGuaranteedIncome: null,
    rejectsBusinessModel: null,
    questions: [],
    objections: [],
    buyingIntent: null,
    qualificationStatus: "NEEDS_MORE_INFO",
    qualificationReason: "BUDGET_UNKNOWN",
    conversationSummary: null,
    createdAt: sentAt,
    updatedAt: sentAt,
    handoffAt: null,
    ...overrides,
  };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conversation-1",
    leadId: "lead-1",
    state: "WAITING_BUDGET",
    summary: null,
    pendingInformationNeed: "BUDGET",
    lastInboundAt: sentAt,
    lastOutboundAt: sentAt,
    awaitingUserReply: true,
    qualificationCompleted: false,
    followUpEligibleAt: followUpEligibleAt(sentAt),
    followUpCount: 0,
    lastFollowUpAt: null,
    nextInboundSequence: 0,
    lastAppliedInboundSequence: 0,
    createdAt: sentAt,
    updatedAt: sentAt,
    closedAt: null,
    ...overrides,
  };
}

describe("qualification follow-up policy", () => {
  it("does not become eligible at 23 hours 59 minutes", () => {
    expect(
      evaluateFollowUpEligibility(
        conversation(),
        lead(),
        new Date("2026-09-02T09:59:00.000Z"),
      ),
    ).toEqual({ eligible: false, reason: "NOT_DUE" });
  });

  it("becomes eligible exactly after 24 hours", () => {
    expect(
      evaluateFollowUpEligibility(
        conversation(),
        lead(),
        new Date("2026-09-02T10:00:00.000Z"),
      ),
    ).toEqual({ eligible: true, reason: "ELIGIBLE" });
  });

  it("is cancelled when the user replied after the outbound message", () => {
    expect(
      evaluateFollowUpEligibility(
        conversation({
          lastInboundAt: new Date("2026-09-01T11:00:00.000Z"),
          awaitingUserReply: false,
          followUpEligibleAt: null,
        }),
        lead(),
        new Date("2026-09-02T12:00:00.000Z"),
      ).eligible,
    ).toBe(false);
  });

  it.each([
    ["NO_FIT", null],
    ["NEEDS_MORE_INFO", "DECLINED"],
    ["HANDOFF", null],
  ] as const)("forbids terminal lead status %s", (qualificationStatus, buyingIntent) => {
    expect(
      evaluateFollowUpEligibility(
        conversation(),
        lead({ qualificationStatus, buyingIntent }),
        new Date("2026-09-02T10:00:00.000Z"),
      ).eligible,
    ).toBe(false);
  });

  it("forbids a handoff-ready or completed conversation", () => {
    expect(
      evaluateFollowUpEligibility(
        conversation({ state: "QUALIFIED", qualificationCompleted: true }),
        lead({ qualificationStatus: "PRIORITY" }),
        new Date("2026-09-02T10:00:00.000Z"),
      ).eligible,
    ).toBe(false);
  });

  it("forbids a second qualification follow-up", () => {
    expect(
      evaluateFollowUpEligibility(
        conversation({ followUpCount: 1 }),
        lead(),
        new Date("2026-09-02T10:00:00.000Z"),
      ),
    ).toEqual({ eligible: false, reason: "ALREADY_FOLLOWED_UP" });
  });

  it("continues the unresolved budget context", () => {
    const text = buildQualificationFollowUp(conversation(), "Какой у вас бюджет?");
    expect(text.toLocaleLowerCase("ru-RU")).toContain("бюджет");
    expect(text).not.toContain("Вы ещё заинтересованы");
  });
});
