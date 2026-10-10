/** Legacy summaries are not promoted to verified facts or conversational instructions. */
export function readConversationalNotes(summary: string | null): string | undefined {
  try {
    const memory = JSON.parse(summary ?? "null");
    return memory && typeof memory.conversationalNotes === "string" ? memory.conversationalNotes.slice(0, 700) : undefined;
  } catch { return undefined; }
}

export function mergeConversationalNotes(summary: string | null, notes: string | undefined): string | null {
  if (notes === undefined) return summary;
  let memory: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(summary ?? "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) memory = parsed;
  } catch { /* Legacy prose is not promoted to instructions. */ }
  return JSON.stringify({ ...memory, conversationalNotes: notes.slice(0, 700) });
}
