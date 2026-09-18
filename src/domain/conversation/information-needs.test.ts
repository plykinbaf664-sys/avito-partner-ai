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
});
