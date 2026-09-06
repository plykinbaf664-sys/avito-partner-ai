import { checkReadiness } from "@/application/health/system-health";
import { readBaseEnvironment } from "@/config/environment";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const environment = readBaseEnvironment(process.env);
  const persistence = SqlitePersistence.create(environment.DATABASE_URL);
  try {
    const result = await checkReadiness(persistence);
    return Response.json(result, {
      status: result.status === "ok" ? 200 : 503,
    });
  } finally {
    persistence.close();
  }
}
