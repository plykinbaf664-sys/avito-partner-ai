import { InvalidEnvironmentError, readInboundEnvironment } from "@/config/environment";

export function qwenApiBase(host: string): string {
  try {
    const url = new URL(host.includes("://") ? host : `https://${host}`);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
      !/^[a-z0-9-]+\.ap-southeast-1\.maas\.aliyuncs\.com$/u.test(url.hostname) ||
      !["", "/", "/compatible-mode/v1", "/compatible-mode/v1/"].includes(url.pathname)) throw new Error();
    return `${url.origin}/compatible-mode/v1`;
  } catch { throw new InvalidEnvironmentError(["QWEN_API_HOST"]); }
}

export function readQwenConfig(environment: NodeJS.ProcessEnv) {
  const parsed = readInboundEnvironment({ ...environment, LLM_PROVIDER: "qwen" });
  return { apiKey: parsed.QWEN_API_KEY!, baseUrl: qwenApiBase(parsed.QWEN_API_HOST!), model: parsed.QWEN_MODEL,
    timeoutMs: parsed.QWEN_TIMEOUT_MS, cacheMode: parsed.QWEN_CACHE_MODE, structuredOutput: parsed.QWEN_STRUCTURED_OUTPUT,
    thinkingMode: parsed.QWEN_THINKING_MODE, thinkingBudget: parsed.QWEN_THINKING_BUDGET };
}
export type QwenConfig = ReturnType<typeof readQwenConfig>;
