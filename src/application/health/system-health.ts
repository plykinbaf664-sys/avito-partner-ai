import type { Persistence } from "../ports/repositories";
import { readOperationalStatus, type OperationalStatus } from "./operational-health";

export interface SystemHealth {
  status: "ok" | "not_ready";
  database: "ok" | "unavailable";
  operations?: OperationalStatus;
}

export async function checkReadiness(
  persistence: Persistence,
  options: { avitoEnabled?: boolean; now?: Date } = {},
): Promise<SystemHealth> {
  try {
    await persistence.checkReadiness();
    if (options.avitoEnabled) {
      const operations = await readOperationalStatus(persistence, options.now ?? new Date());
      return { status: operations.ready ? "ok" : "not_ready", database: "ok", operations };
    }
    return { status: "ok", database: "ok" };
  } catch {
    return { status: "not_ready", database: "unavailable" };
  }
}
