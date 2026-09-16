export const PARTNER_MONTHLY_INCOME_PER_UNIT_REFERENCE = 20_000;
export const PARTNER_SERVICE_FEE_REFERENCE = 50_000;
export const PARTNER_PREPARATION_PER_UNIT_REFERENCE = 30_000;

export interface RentRangeReference {
  city: string | null;
  region: string;
  rentMin: number;
  rentMax: number;
  updatedAt: string;
  source: string;
}

// Approved calculation examples, not a market quote for a specific city.
// City-specific references may be added only with a source and update date.
export const GENERAL_RENT_RANGE_REFERENCE: RentRangeReference = Object.freeze({
  city: null,
  region: "GENERAL_CALCULATION_REFERENCE",
  rentMin: 35_000,
  rentMax: 50_000,
  updatedAt: "2026-09-16",
  source: "Утверждённые владельцем проекта примеры расчёта",
});

export const REGIONAL_RENT_REFERENCES: readonly RentRangeReference[] = [];

export interface LaunchCostReference {
  serviceFeeReference: number;
  rentReference: number;
  depositReference: number;
  baseLaunchReference: number;
  furnishingReserveReference: number;
  isExact: false;
}

// Compatibility view. 150k is the lower one-unit example, not a universal
// qualification threshold.
export const LAUNCH_COST_REFERENCE: LaunchCostReference = Object.freeze({
  serviceFeeReference: PARTNER_SERVICE_FEE_REFERENCE,
  rentReference: GENERAL_RENT_RANGE_REFERENCE.rentMin,
  depositReference: GENERAL_RENT_RANGE_REFERENCE.rentMin,
  baseLaunchReference:
    PARTNER_SERVICE_FEE_REFERENCE +
    GENERAL_RENT_RANGE_REFERENCE.rentMin * 2 +
    PARTNER_PREPARATION_PER_UNIT_REFERENCE,
  furnishingReserveReference: PARTNER_PREPARATION_PER_UNIT_REFERENCE,
  isExact: false,
});

export interface LaunchBudgetRange {
  units: number;
  rentMin: number;
  rentMax: number;
  depositMin: number;
  depositMax: number;
  serviceFee: number;
  preparationPerUnit: number;
  totalMin: number;
  totalMax: number;
  reference: RentRangeReference;
  isExact: false;
}

export function findRegionalRentReference(
  city: string | null,
): RentRangeReference | null {
  if (!city) return null;
  const normalized = city.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е");
  return REGIONAL_RENT_REFERENCES.find((reference) =>
    reference.city?.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е") ===
      normalized,
  ) ?? null;
}

export function calculateLaunchBudgetRange(input: {
  units: number;
  rentReference?: RentRangeReference;
  depositMonths?: number;
}): LaunchBudgetRange | null {
  const {
    units,
    rentReference = GENERAL_RENT_RANGE_REFERENCE,
    depositMonths = 1,
  } = input;
  if (!Number.isInteger(units) || units <= 0 || !Number.isFinite(depositMonths) || depositMonths < 0) {
    return null;
  }
  const depositMin = Math.round(rentReference.rentMin * depositMonths);
  const depositMax = Math.round(rentReference.rentMax * depositMonths);
  return {
    units,
    rentMin: rentReference.rentMin,
    rentMax: rentReference.rentMax,
    depositMin,
    depositMax,
    serviceFee: PARTNER_SERVICE_FEE_REFERENCE,
    preparationPerUnit: PARTNER_PREPARATION_PER_UNIT_REFERENCE,
    totalMin: PARTNER_SERVICE_FEE_REFERENCE + units * (
      rentReference.rentMin + depositMin + PARTNER_PREPARATION_PER_UNIT_REFERENCE
    ),
    totalMax: PARTNER_SERVICE_FEE_REFERENCE + units * (
      rentReference.rentMax + depositMax + PARTNER_PREPARATION_PER_UNIT_REFERENCE
    ),
    reference: rentReference,
    isExact: false,
  };
}

export function calculateLaunchBudgetForCity(
  city: string | null,
  units: number,
): LaunchBudgetRange | null {
  const reference = findRegionalRentReference(city);
  return reference ? calculateLaunchBudgetRange({ units, rentReference: reference }) : null;
}

export interface EconomicsEstimate {
  units: number;
  estimatedMonthlyIncome: number;
  incomePerUnitReference: number;
  isGuaranteed: false;
  disclaimer: string;
}

export function calculateEconomicsEstimate(
  units: number | null,
): EconomicsEstimate | null {
  if (units === null || !Number.isInteger(units) || units <= 0) return null;
  return {
    units,
    estimatedMonthlyIncome:
      units * PARTNER_MONTHLY_INCOME_PER_UNIT_REFERENCE,
    incomePerUnitReference: PARTNER_MONTHLY_INCOME_PER_UNIT_REFERENCE,
    isGuaranteed: false,
    disclaimer:
      "Это ориентир, а не гарантия: фактический результат зависит от конкретного объекта, загрузки и расходов.",
  };
}
