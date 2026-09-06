export const serviceabilityStatuses = [
  "SUPPORTED",
  "NEEDS_REVIEW",
  "UNSUPPORTED",
] as const;

export type ServiceabilityStatus = (typeof serviceabilityStatuses)[number];

export const SERVICEABILITY_POLICY = Object.freeze({
  supportedCities: [
    "Видное",
    "Подольск",
    "Домодедово",
    "Балашиха",
    "Химки",
    "Волгоград",
  ] as const,
  // The business has not defined any explicitly unsupported city yet.
  unsupportedCities: [] as readonly string[],
});

function normalizeCity(city: string): string {
  return city
    .trim()
    .toLocaleLowerCase("ru-RU")
    .replace(/^г(?:ород)?[.\s-]*/u, "");
}

function includesCity(cities: readonly string[], city: string): boolean {
  const normalized = normalizeCity(city);
  return cities.some((candidate) => normalizeCity(candidate) === normalized);
}

export function evaluateServiceability(
  city: string | null,
): ServiceabilityStatus {
  if (!city) return "NEEDS_REVIEW";
  if (includesCity(SERVICEABILITY_POLICY.supportedCities, city)) {
    return "SUPPORTED";
  }
  if (includesCity(SERVICEABILITY_POLICY.unsupportedCities, city)) {
    return "UNSUPPORTED";
  }
  return "NEEDS_REVIEW";
}
