/**
 * Splits an integer amount (centavos) across weights so that the parts are
 * proportional to the weights and always sum to exactly `total`.
 *
 * Largest-remainder method: every part gets floor(total × w / W); the leftover
 * centavos go one each to the parts with the largest fractional remainders.
 * Ties go to the earlier index, so the result is deterministic.
 * If every weight is zero, the amount is split evenly (by count).
 */
export function allocate(total: number, weights: readonly number[]): number[] {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error(`allocate: total must be a non-negative integer, got ${total}`);
  if (weights.length === 0) {
    if (total === 0) return [];
    throw new Error("allocate: cannot split a non-zero amount across zero parts");
  }
  for (const w of weights) {
    if (!Number.isSafeInteger(w) || w < 0) throw new Error(`allocate: weights must be non-negative integers, got ${w}`);
  }

  let effective = weights;
  let weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum === 0) {
    effective = weights.map(() => 1);
    weightSum = weights.length;
  }

  // BigInt keeps total × weight exact even for large amounts.
  const T = BigInt(total);
  const W = BigInt(weightSum);
  const parts: number[] = [];
  const remainders: { index: number; rem: bigint }[] = [];
  let assigned = 0;
  effective.forEach((w, index) => {
    const product = T * BigInt(w);
    const base = product / W;
    parts.push(Number(base));
    assigned += Number(base);
    remainders.push({ index, rem: product % W });
  });

  let leftover = total - assigned;
  remainders.sort((a, b) => (a.rem === b.rem ? a.index - b.index : a.rem > b.rem ? -1 : 1));
  for (let i = 0; leftover > 0; i++, leftover--) parts[remainders[i].index] += 1;
  return parts;
}
