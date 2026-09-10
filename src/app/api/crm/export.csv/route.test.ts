import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

describe("CRM CSV route protection", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is not public when CRM is disabled", async () => {
    vi.stubEnv("CRM_ENABLED", "false");
    expect((await GET(new Request("http://localhost/api/crm/export.csv"))).status).toBe(404);
  });

  it("requires authorization when CRM is enabled", async () => {
    vi.stubEnv("CRM_ENABLED", "true");
    vi.stubEnv("CRM_ACCESS_TOKEN", "long-random-test-token");
    const response = await GET(new Request("http://localhost/api/crm/export.csv"));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Basic");
  });
});

