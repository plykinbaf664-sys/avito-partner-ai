/**
 * Canonical operational geography.  Serviceability and city-specific
 * capabilities must resolve city names through this catalogue instead of
 * maintaining separate lists and aliases in each layer.
 */
export const APPROVED_GEOGRAPHY = Object.freeze([
  { name: "Москва", aliases: ["москва", "москве", "московская область"] },
  { name: "Видное", aliases: ["видное"] },
  { name: "Подольск", aliases: ["подольск"] },
  { name: "Домодедово", aliases: ["домодедово"] },
  { name: "Балашиха", aliases: ["балашиха"] },
  { name: "Химки", aliases: ["химки"] },
  { name: "Волгоград", aliases: ["волгоград"] },
] as const);

export const APPROVED_WORKING_CITIES = Object.freeze(
  APPROVED_GEOGRAPHY.map(({ name }) => name),
);

export function normalizeCityName(city: string): string {
  return city
    .trim()
    .toLocaleLowerCase("ru-RU")
    .replaceAll("ё", "е")
    .replace(/^г(?:ород)?[.\s-]*/u, "");
}

export function canonicalApprovedCity(city: string): string | null {
  const normalized = normalizeCityName(city);
  return APPROVED_GEOGRAPHY.find((entry) =>
    entry.aliases.some((alias) => normalizeCityName(alias) === normalized),
  )?.name ?? null;
}
