import { checkReadiness } from "@/application/health/system-health";
import { readBaseEnvironment } from "@/config/environment";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function createReadinessHandler(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return async function readiness(): Promise<Response> {
    let persistence: SqlitePersistence | null = null;
    try {
      const config = readBaseEnvironment(environment);
      persistence = SqlitePersistence.create(config.DATABASE_URL);
      const result = await checkReadiness(persistence);
      return Response.json(result, {
        status: result.status === "ok" ? 200 : 503,
      });
    } catch {
      return Response.json(
        { status: "not_ready", database: "unavailable" },
        { status: 503 },
      );
    } finally {
      persistence?.close();
    }
  };
}

export async function GET(): Promise<Response> {
  return createReadinessHandler()();
}
