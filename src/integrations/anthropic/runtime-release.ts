import { execFileSync } from "node:child_process";

let cached: string | null | undefined;
/** Metadata only: no shell, no credentials, no repository mutations. */
export function runtimeRelease(): string | null {
  if (cached !== undefined) return cached;
  if (process.env.APP_RELEASE_SHA && /^[A-Za-z0-9.+_-]+$/u.test(process.env.APP_RELEASE_SHA)) return cached = process.env.APP_RELEASE_SHA;
  try {
    const options = { cwd: process.cwd(), encoding: "utf8" as const, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
      timeout: 2_000, windowsHide: true };
    const revision = execFileSync("git", ["rev-parse", "HEAD"], options).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], options).trim().length > 0;
    return cached = /^[a-f0-9]{40}$/u.test(revision) ? revision + (dirty ? "+dirty" : "") : null;
  } catch { return cached = null; }
}
