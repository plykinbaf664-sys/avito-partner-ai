import { describe, expect, it } from "vitest";

import { normalizePhoneNumber } from "./phone-number";

describe("phone number normalization", () => {
  it.each([
    ["+7 999 123-45-67", "+79991234567"],
    ["8 (999) 123-45-67", "+79991234567"],
    ["+4915112345678", "+4915112345678"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizePhoneNumber(input)).toBe(expected);
  });

  it.each(["телефон потом дам", "50000", "+00000000", "123"])(
    "rejects non-phone input %s",
    (input) => expect(normalizePhoneNumber(input)).toBeNull(),
  );
});

