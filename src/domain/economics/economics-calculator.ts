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

// These are approved calculation scenarios, not live market quotes.  They
// make the economics capability explicit for the conversation brain while
// keeping all business numbers in the deterministic layer.
export const APPROVED_REGIONAL_RENT_REFERENCE: RentRangeReference = Object.freeze({
  city: null,
  region: "Региональный ориентир",
  rentMin: 35_000,
  rentMax: 35_000,
  updatedAt: GENERAL_RENT_RANGE_REFERENCE.updatedAt,
  source: GENERAL_RENT_RANGE_REFERENCE.source,
});

export const APPROVED_MOSCOW_RENT_REFERENCE: RentRangeReference = Object.freeze({
  city: "Москва",
  region: "Москва",
  rentMin: 50_000,
  rentMax: 50_000,
  updatedAt: GENERAL_RENT_RANGE_REFERENCE.updatedAt,
  source: GENERAL_RENT_RANGE_REFERENCE.source,
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

export interface AffordableObjectCount {
  availableCapital: number;
  serviceFee: number;
  costPerObjectMin: number;
  costPerObjectMax: number;
  maxUnitsAtMinCost: number;
  maxUnitsAtMaxCost: number;
  totalStartupCostAtMinCost: number;
  totalStartupCostAtMaxCost: number;
  remainingReserveAtMinCost: number;
  remainingReserveAtMaxCost: number;
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

export function findApprovedRentReference(
  city: string | null,
): RentRangeReference | null {
  const normalized = city?.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е");
  if (normalized === "москва" || normalized === "москве" || normalized === "московская область") {
    return APPROVED_MOSCOW_RENT_REFERENCE;
  }
  return findRegionalRentReference(city);
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

/**
 * Calculates how many complete objects fit into a confirmed capital amount.
 * The service fee is paid once per launch; rent, one-month deposit and
 * preparation are repeated for every object.
 */
export function calculateAffordableObjectCount(input: {
  availableCapital: number;
  rentReference?: RentRangeReference;
  depositMonths?: number;
}): AffordableObjectCount | null {
  const {
    availableCapital,
    rentReference = GENERAL_RENT_RANGE_REFERENCE,
    depositMonths = 1,
  } = input;
  if (
    !Number.isFinite(availableCapital) ||
    availableCapital < 0 ||
    !Number.isFinite(depositMonths) ||
    depositMonths < 0
  ) {
    return null;
  }
  const depositMin = rentReference.rentMin * depositMonths;
  const depositMax = rentReference.rentMax * depositMonths;
  const costPerObjectMin = rentReference.rentMin + depositMin + PARTNER_PREPARATION_PER_UNIT_REFERENCE;
  const costPerObjectMax = rentReference.rentMax + depositMax + PARTNER_PREPARATION_PER_UNIT_REFERENCE;
  const remaining = Math.max(0, availableCapital - PARTNER_SERVICE_FEE_REFERENCE);
  const maxUnitsAtMinCost = Math.floor(remaining / costPerObjectMin);
  const maxUnitsAtMaxCost = Math.floor(remaining / costPerObjectMax);
  return {
    availableCapital,
    serviceFee: PARTNER_SERVICE_FEE_REFERENCE,
    costPerObjectMin,
    costPerObjectMax,
    maxUnitsAtMinCost,
    maxUnitsAtMaxCost,
    totalStartupCostAtMinCost:
      PARTNER_SERVICE_FEE_REFERENCE + maxUnitsAtMinCost * costPerObjectMin,
    totalStartupCostAtMaxCost:
      PARTNER_SERVICE_FEE_REFERENCE + maxUnitsAtMaxCost * costPerObjectMax,
    remainingReserveAtMinCost:
      Math.max(0, availableCapital - (
        PARTNER_SERVICE_FEE_REFERENCE + maxUnitsAtMinCost * costPerObjectMin
      )),
    remainingReserveAtMaxCost:
      Math.max(0, availableCapital - (
        PARTNER_SERVICE_FEE_REFERENCE + maxUnitsAtMaxCost * costPerObjectMax
      )),
    reference: rentReference,
    isExact: false,
  };
}

export interface EconomicsEstimate {
  units: number;
  estimatedMonthlyIncome: number;
  incomePerUnitReference: number;
  isGuaranteed: false;
  disclaimer: string;
}

export interface ApprovedEconomicsScenario {
  label: string;
  rentReference: RentRangeReference;
  affordableObjectCount: AffordableObjectCount | null;
  oneObjectLaunch: LaunchBudgetRange | null;
  requestedUnitsLaunch: LaunchBudgetRange | null;
}

export interface ApprovedEconomicsContext {
  launchFee: number;
  preparationPerObject: number;
  incomePerObject: number;
  depositMonths: number;
  availableCapital: number | null;
  requestedUnits: number | null;
  requestedUnitsIncome: EconomicsEstimate | null;
  scenarios: ApprovedEconomicsScenario[];
  limitations: readonly string[];
}

/**
 * Builds the bounded, deterministic economics context supplied to Claude.
 * The model may explain or compare these values, but it cannot choose new
 * prices or inputs outside the approved scenarios.
 */
export function buildApprovedEconomicsContext(input: {
  availableCapital?: number | null;
  requestedUnits?: number | null;
  city?: string | null;
  rentReference?: RentRangeReference;
} = {}): ApprovedEconomicsContext {
  const explicitReference = input.rentReference;
  const cityReference = findApprovedRentReference(input.city ?? null);
  const references = explicitReference
    ? [explicitReference]
    : cityReference
      ? [cityReference]
      : [APPROVED_REGIONAL_RENT_REFERENCE, APPROVED_MOSCOW_RENT_REFERENCE];
  const uniqueReferences = [...new Map(references.map((reference) => [
    `${reference.city ?? reference.region}:${reference.rentMin}:${reference.rentMax}`,
    reference,
  ])).values()];
  const requestedUnits = input.requestedUnits ?? null;
  return {
    launchFee: PARTNER_SERVICE_FEE_REFERENCE,
    preparationPerObject: PARTNER_PREPARATION_PER_UNIT_REFERENCE,
    incomePerObject: PARTNER_MONTHLY_INCOME_PER_UNIT_REFERENCE,
    depositMonths: 1,
    availableCapital: input.availableCapital ?? null,
    requestedUnits,
    requestedUnitsIncome: calculateEconomicsEstimate(requestedUnits),
    scenarios: uniqueReferences.map((reference) => ({
      label: reference.city === "Москва" ? "Москва" : reference.region,
      rentReference: reference,
      affordableObjectCount: input.availableCapital == null
        ? null
        : calculateAffordableObjectCount({
            availableCapital: input.availableCapital,
            rentReference: reference,
          }),
      oneObjectLaunch: calculateLaunchBudgetRange({ units: 1, rentReference: reference }),
      requestedUnitsLaunch: requestedUnits === null
        ? null
        : calculateLaunchBudgetRange({ units: requestedUnits, rentReference: reference }),
    })),
    limitations: [
      "Суммы являются утверждёнными ориентировочными сценариями, а не live-ценой конкретного объекта.",
      "Доход около 20 000 ₽ на объект в месяц не гарантируется.",
      "Точная аренда, залог и подготовка зависят от выбранного объекта.",
    ],
  };
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
