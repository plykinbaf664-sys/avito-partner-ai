import { afterEach, describe, expect, it } from "vitest";

import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";
import { GET as healthCheck } from "@/app/api/health/route";

import { checkReadiness } from "./system-health";

describe("system health", () => {
  let persistence: SqlitePersistence | undefined;

  afterEach(() => persistence?.close());

  it("exposes a lightweight liveness response without external API calls", async () => {
    const response = await healthCheck();
    await expect(response.json()).resolves.toEqual({ status: "ok" });
    expect(response.status).toBe(200);
  });

  it("reports a migrated SQLite database as ready", async () => {
    persistence = await SqlitePersistence.createMigrated("file::memory:");
    await expect(checkReadiness(persistence)).resolves.toEqual({
      status: "ok",
      database: "ok",
    });
  });

  it("reports an unmigrated database as unavailable", async () => {
    persistence = SqlitePersistence.create("file::memory:");
    await expect(checkReadiness(persistence)).resolves.toEqual({
      status: "not_ready",
      database: "unavailable",
    });
  });
});
