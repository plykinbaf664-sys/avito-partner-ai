/** Legacy summaries are not promoted to verified facts or conversational instructions. */
export function readConversationalNotes(summary: string | null): string | undefined {
  try {
    const memory = JSON.parse(summary ?? "null");
    return memory && typeof memory.conversationalNotes === "string" ? memory.conversationalNotes.slice(0, 700) : undefined;
  } catch { return undefined; }
}
