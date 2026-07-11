// Reference implementation of the program's fixed-point math
// (programs/bethehouse/src/math.rs) — keep the two in sync; the property
// tests compare them. BigInt everywhere; floor rounding.
//
// Conventions: odds x1000, bps /10_000, USDC 6dp.

export const ODDS_SCALE = 1000n;
export const BPS = 10_000n;

/** Worst-case collateral reserved at commit: floor(stake * odds_cap / 1000). */
export function reserved(stake: bigint, oddsCap: number): bigint {
  return (stake * BigInt(oddsCap)) / ODDS_SCALE;
}

/** Payout at fill: floor(stake * fill_odds / 1000). */
export function payout(stake: bigint, fillOdds: number): bigint {
  return (stake * BigInt(fillOdds)) / ODDS_SCALE;
}

/** Netted lock for one fixture: max(liability) - stakes_collected, floor 0. */
export function locked(liability: [bigint, bigint, bigint], stakesCollected: bigint): bigint {
  const max = liability.reduce((a, b) => (b > a ? b : a), 0n);
  return max > stakesCollected ? max - stakesCollected : 0n;
}

/** Inventory-skew widening (bps) for `outcome`. */
export function skewBps(
  skewCoeffBps: number,
  liability: [bigint, bigint, bigint],
  outcome: 0 | 1 | 2,
  maxRiskPerFixture: bigint,
): bigint {
  if (maxRiskPerFixture === 0n) return 0n;
  const min = liability.reduce((a, b) => (b < a ? b : a));
  const heavy = liability[outcome] > min ? liability[outcome] - min : 0n;
  return (BigInt(skewCoeffBps) * heavy) / maxRiskPerFixture;
}

/** House quote: fair * (10000 - spread - skew) / 10000, discount capped at 100%. */
export function effOdds(fairOdds: number, spreadBps: number, skew: bigint): number {
  let discount = BigInt(spreadBps) + skew;
  if (discount > BPS) discount = BPS;
  return Number((BigInt(fairOdds) * (BPS - discount)) / BPS);
}

/** Final fill odds: worse-of-two -> house quote -> odds_cap clamp. */
export function fillOdds(
  commitFair: number,
  targetFair: number,
  spreadBps: number,
  skew: bigint,
  oddsCap: number,
): number {
  const fair = Math.min(commitFair, targetFair);
  return Math.min(effOdds(fair, spreadBps, skew), oddsCap);
}
