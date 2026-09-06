export const qualificationStatuses = [
  "NEW",
  "QUALIFYING",
  "NEEDS_MORE_INFO",
  "BORDERLINE",
  "QUALIFIED",
  "PRIORITY",
  "HOT",
  "WARM",
  "NURTURE",
  "NO_FIT",
  "HANDOFF",
  "CLOSED",
] as const;

export type QualificationStatus = (typeof qualificationStatuses)[number];
