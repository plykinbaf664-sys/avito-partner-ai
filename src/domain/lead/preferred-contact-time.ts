const PREFERRED_CONTACT_TIME_PREFIX = "Удобное время связи:";

export function asksForPreferredCallbackTime(text: string): boolean {
  return /(?:(?:какой|когда|во\s+сколько|удобн|день|время).{0,80}(?:звон|связ|созвон|принять)|(?:звон|связ|созвон).{0,80}(?:когда|во\s+сколько|удобн|день|время))/iu.test(
    text,
  );
}

export function preferredContactTimeFromQuestions(
  questions: readonly string[],
): string | null {
  const note = questions.findLast((question) =>
    question.startsWith(PREFERRED_CONTACT_TIME_PREFIX),
  );
  return note?.slice(PREFERRED_CONTACT_TIME_PREFIX.length).trim() || null;
}

export function recordPreferredContactTime(
  questions: readonly string[],
  value: string,
): string[] {
  const normalized = value.trim();
  if (!normalized) return [...questions];
  return [
    ...questions.filter(
      (question) => !question.startsWith(PREFERRED_CONTACT_TIME_PREFIX),
    ),
    `${PREFERRED_CONTACT_TIME_PREFIX} ${normalized}`,
  ];
}
