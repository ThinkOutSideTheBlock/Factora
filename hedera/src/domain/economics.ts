const GRADE_RANK: Record<string, number> = {
  "A+": 1,
  A: 2,
  "A-": 3,
  "B+": 4,
  B: 5,
  "B-": 6,
  "C+": 7,
  C: 8,
};

export function discountUsd(
  faceValueUsd: number,
  purchasePriceUsd: number,
): number {
  if (!Number.isFinite(faceValueUsd) || !Number.isFinite(purchasePriceUsd)) {
    throw new Error("Amounts must be finite numbers.");
  }
  if (faceValueUsd <= 0) throw new Error("Face value must be positive.");
  if (purchasePriceUsd <= 0) throw new Error("Purchase price must be positive.");
  if (purchasePriceUsd >= faceValueUsd) {
    throw new Error("Purchase price must be below face value.");
  }
  return faceValueUsd - purchasePriceUsd;
}

export function simpleReturnPercent(
  faceValueUsd: number,
  purchasePriceUsd: number,
): number {
  return (discountUsd(faceValueUsd, purchasePriceUsd) / purchasePriceUsd) * 100;
}

export function annualizedSimpleReturnPercent(
  faceValueUsd: number,
  purchasePriceUsd: number,
  maturityDays: number,
): number {
  if (!Number.isFinite(maturityDays) || maturityDays <= 0) {
    throw new Error("Maturity must be positive.");
  }
  return simpleReturnPercent(faceValueUsd, purchasePriceUsd) * (365 / maturityDays);
}

export function isRiskWithinLimit(candidate: string, maximum: string): boolean {
  const candidateRank = GRADE_RANK[candidate];
  const maximumRank = GRADE_RANK[maximum];
  if (!candidateRank || !maximumRank) throw new Error("Unknown risk grade.");
  return candidateRank <= maximumRank;
}

export function riskRank(grade: string): number {
  const rank = GRADE_RANK[grade];
  if (!rank) throw new Error(`Unknown risk grade: ${grade}`);
  return rank;
}
