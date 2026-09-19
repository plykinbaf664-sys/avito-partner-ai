import { describe, expect, it } from "vitest";

import { createInitialLead } from "@/application/workflows/process-incoming-event";
import { assessInformationNeeds } from "./information-needs";

describe("conversation information needs", () => {
  it("offers discovery directions before capital for a new general-interest lead", () => {
    const lead = {
      ...createInitialLead(
        "lead-discovery",
        "TEST",
        "external-discovery",
        new Date("2026-09-19T10:00:00.000Z"),
      ),
      buyingIntent: "EXPLORING",
    } as const;

    const needs = assessInformationNeeds(lead);

    expect(needs.allowedNextInformationNeeds).toEqual(
      expect.arrayContaining(["CITY", "EXPERIENCE", "AVAILABLE_CAPITAL"]),
    );
    expect(needs.suggestedNextInformationNeed).toBe("CITY");
  });

  it("keeps soft discovery optional when only the phone remains critical", () => {
    const lead = {
      ...createInitialLead(
        "lead-ready",
        "TEST",
        "external-ready",
        new Date("2026-09-19T10:00:00.000Z"),
      ),
      segment: "SMALL_BUSINESS" as const,
      city: "Химки",
      availableCapital: 300_000,
      availableCapitalConfirmed: true,
      startingUnits: 1,
      scalingPotentialUnits: 3,
      launchTiming: "WITHIN_MONTH" as const,
      primaryGoal: "MAIN_BUSINESS" as const,
      businessModelReadiness: "ACCEPTS" as const,
      managementReadiness: "READY" as const,
      qualificationStatus: "HOT" as const,
      qualificationReason: "PHONE_UNKNOWN" as const,
    };

    const needs = assessInformationNeeds(lead);

    expect(needs.allowedNextInformationNeeds).toEqual(["PHONE_NUMBER"]);
    expect(needs.suggestedNextInformationNeed).toBe("PHONE_NUMBER");
  });

  it("keeps discovery choices available after a user question without forcing the top checklist gap", () => {
    const lead = {
      ...createInitialLead(
        "lead-question",
        "TEST",
        "external-question",
        new Date("2026-09-19T10:00:00.000Z"),
      ),
      buyingIntent: "CONSIDERING",
    } as const;

    const needs = assessInformationNeeds(lead);

    expect(needs.allowedNextInformationNeeds).toEqual(expect.arrayContaining([
      "CITY",
      "GOAL",
      "EXPERIENCE",
      "AVAILABLE_CAPITAL",
    ]));
    expect(needs.allowedNextInformationNeeds).not.toContain("PHONE_NUMBER");
  });
});
