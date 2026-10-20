import { PARTNER_KNOWLEDGE_BASE } from "../knowledge/knowledge-base";

export const CUSTOMER_REPLY_LIMIT = 1_000;

/** Compress only authored approved facts, never rewrite numbers or cut a caveat. */
export function boundedApprovedReply(parts: readonly string[]): string {
  const full = parts.join(" ").trim();
  if (full.length <= CUSTOMER_REPLY_LIMIT) return full;
  const compact = [...new Set(parts.map(part =>
    PARTNER_KNOWLEDGE_BASE.find(entry => entry.answer === part)?.shortAnswer ?? part))];
  const joined = compact.join(" ").trim();
  if (joined.length <= CUSTOMER_REPLY_LIMIT) return joined;
  const notice = "Это часть ответа; остальные вопросы пока остаются неразобранными.";
  const retained: string[] = [];
  for (const part of compact) {
    if ([...retained, part, notice].join(" ").length <= CUSTOMER_REPLY_LIMIT) retained.push(part);
  }
  return [...retained, notice].join(" ");
}
