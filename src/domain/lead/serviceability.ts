import {
  APPROVED_WORKING_CITIES,
  canonicalApprovedCity,
  normalizeCityName,
} from "./approved-geography";

export const serviceabilityStatuses = [
  "SUPPORTED",
  "NEEDS_REVIEW",
  "UNSUPPORTED",
] as const;

export type ServiceabilityStatus = (typeof serviceabilityStatuses)[number];

export const SERVICEABILITY_POLICY = Object.freeze({
  // This is the canonical operational geography. The approved knowledge
  // entry is rendered from this list, so it cannot silently drift.
  supportedCities: APPROVED_WORKING_CITIES,
  // The business has not defined any explicitly unsupported city yet.
  unsupportedCities: [] as readonly string[],
});

function includesCity(cities: readonly string[], city: string): boolean {
  const canonical = canonicalApprovedCity(city);
  return cities.some((candidate) =>
    canonical !== null
      ? canonicalApprovedCity(candidate) === canonical
      : normalizeCityName(candidate) === normalizeCityName(city),
  );
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
