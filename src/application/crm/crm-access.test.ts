import { describe, expect, it } from "vitest";

import { checkCrmAccess, crmAccessResponse } from "./crm-access";

const token = "long-random-test-token";
const enabled = {
  NODE_ENV: "test",
  CRM_ENABLED: "true",
  CRM_ACCESS_TOKEN: token,
} as NodeJS.ProcessEnv;

describe("CRM access guard", () => {
  it("is unavailable when disabled", () => {
    const decision = checkCrmAccess(null, {
      NODE_ENV: "test",
      CRM_ENABLED: "false",
    } as NodeJS.ProcessEnv);
    expect(decision).toBe("DISABLED");
    expect(crmAccessResponse(decision)?.status).toBe(404);
  });

  it("requires valid server-side Basic credentials", () => {
    expect(checkCrmAccess(null, enabled)).toBe("UNAUTHORIZED");
    expect(checkCrmAccess("Basic invalid", enabled)).toBe("UNAUTHORIZED");
    const authorization = `Basic ${Buffer.from(`crm:${token}`).toString("base64")}`;
    expect(checkCrmAccess(authorization, enabled)).toBe("AUTHORIZED");
  });

  it("fails closed when enabled without a configured token", () => {
    expect(
      checkCrmAccess(null, {
        NODE_ENV: "test",
        CRM_ENABLED: "true",
      } as NodeJS.ProcessEnv),
    ).toBe("MISCONFIGURED");
  });
});

