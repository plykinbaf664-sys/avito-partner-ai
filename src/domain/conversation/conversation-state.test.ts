import { describe, expect, it } from "vitest";

import {
  canTransitionConversation,
  transitionConversation,
} from "./conversation-state";

describe("conversation state transitions", () => {
  it("starts discovery from a new conversation", () => {
    expect(transitionConversation("NEW", "DISCOVERY")).toBe("DISCOVERY");
  });

  it("allows non-linear movement while learning about the lead", () => {
    expect(canTransitionConversation("WAITING_BUDGET", "DISCOVERY")).toBe(true);
    expect(canTransitionConversation("WAITING_CITY", "WAITING_GOAL")).toBe(true);
    expect(canTransitionConversation("QUALIFIED", "QUALIFYING")).toBe(true);
  });

  it("does not resume automated qualification after handoff", () => {
    expect(canTransitionConversation("HANDOFF", "QUALIFYING")).toBe(false);
    expect(() => transitionConversation("HANDOFF", "DISCOVERY")).toThrow(
      "Invalid conversation state transition",
    );
  });

  it("treats a closed conversation as terminal", () => {
    expect(canTransitionConversation("CLOSED", "DISCOVERY")).toBe(false);
  });
});
