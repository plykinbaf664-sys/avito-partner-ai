export const PARTNER_MONTHLY_INCOME_PER_UNIT_REFERENCE = 20_000;

export interface LaunchCostReference {
  serviceFeeReference: number;
  rentReference: number;
  depositReference: number;
  baseLaunchReference: number;
  furnishingReserveReference: number;
  isExact: false;
}

export const LAUNCH_COST_REFERENCE: LaunchCostReference = Object.freeze({
  serviceFeeReference: 50_000,
  rentReference: 35_000,
  depositReference: 35_000,
  baseLaunchReference: 120_000,
  furnishingReserveReference: 20_000,
  isExact: false,
});

// TODO(business): confirm object-specific ranges for rent, deposit, furnishing
// and other launch costs before adding any capital-to-units calculation.
export const UNCONFIRMED_LAUNCH_ECONOMICS = Object.freeze({
  fullLaunchCostPerUnit: null,
  capitalToUnitsConversion: null,
});

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
      "Это ориентир, а не гарантия: фактический результат зависит от конкретного объекта и условий.",
  };
}
