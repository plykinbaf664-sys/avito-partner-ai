import { readCrmEnvironment } from "@/config/environment";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";
import { createCrmService } from "./crm-service";

export async function withCrmService<T>(
  operation: (service: ReturnType<typeof createCrmService>) => Promise<T>,
): Promise<T> {
  const config = readCrmEnvironment(process.env);
  if (!config.enabled) throw new Error("CRM is disabled");
  const persistence = SqlitePersistence.create(config.databaseUrl);
  try {
    return await operation(createCrmService(persistence));
  } finally {
    persistence.close();
  }
}

