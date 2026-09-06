import type { Persistence } from "../ports/repositories";

export interface SystemHealth {
  status: "ok" | "not_ready";
  database: "ok" | "unavailable";
}

export async function checkReadiness(
  persistence: Persistence,
): Promise<SystemHealth> {
  try {
    await persistence.checkReadiness();
    return { status: "ok", database: "ok" };
  } catch {
    return { status: "not_ready", database: "unavailable" };
  }
}
