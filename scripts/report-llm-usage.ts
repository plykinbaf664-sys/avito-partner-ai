import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { SqlitePersistence } from "../src/infrastructure/database/sqlite-persistence";
import type { LlmCallRecord } from "../src/application/observability/llm-usage";
import { buildLlmUsageReport } from "../src/application/observability/llm-usage-report";

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const jsonl = option("--usage-jsonl");
  const workload = option("--workload") ?? (jsonl ? "EVAL" : "PRODUCTION");
  if (!["PRODUCTION", "EVAL", "TEST_LAB", "DEVELOPMENT"].includes(workload)) throw new Error("INVALID_WORKLOAD");
  const since = option("--since") ? new Date(option("--since")!) : undefined;
  if (since && !Number.isFinite(since.getTime())) throw new Error("INVALID_SINCE");
  let rows: LlmCallRecord[];
  if (jsonl) {
    const records = new Map<string, LlmCallRecord>();
    for (const line of (await readFile(jsonl, "utf8")).split(/\r?\n/u).filter(Boolean)) {
      const row = JSON.parse(line) as LlmCallRecord;
      records.set(row.id, { ...row, startedAt: new Date(row.startedAt), completedAt: row.completedAt ? new Date(row.completedAt) : null });
    }
    rows = [...records.values()].filter(row => row.workload === workload && (!since || row.startedAt >= since));
  } else {
    const url = option("--database-url") ?? process.env.DATABASE_URL ?? "file:./data/local.db";
    if (!url.startsWith("file:")) throw new Error("LOCAL_DATABASE_REQUIRED");
    await access(resolve(url.slice(5))); // Do not silently create a database.
    const persistence = SqlitePersistence.create(url); // No migrations or mutations.
    try { rows = await persistence.llmUsage.list({ workload: workload as LlmCallRecord["workload"], since, limit: 100_000 }); }
    finally { persistence.close(); }
    if (rows.length === 100_000) throw new Error("REPORT_LIMIT_REACHED_USE_SINCE");
  }
  console.log(JSON.stringify(buildLlmUsageReport(rows), null, 2));
}
main().catch(() => { console.error("LLM_USAGE_REPORT_FAILED: check arguments, migration and input file."); process.exitCode = 1; });
