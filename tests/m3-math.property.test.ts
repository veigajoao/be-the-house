// M3: property tests over the TS reference math (packages/sdk/src/math.ts,
// a 1:1 mirror of programs/bethehouse/src/math.rs). The rust side is pinned
// to the same values by the exact-value assertions in the integration suites
// (m3-fill: 2033/3743/2023/2500; m3-settle: 1669) — these properties assert
// the invariants the protocol's solvency rests on.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  effOdds,
  fillOdds,
  locked,
  payout,
  reserved,
  skewBps,
} from "@bethehouse/sdk/math";

const stakeArb = fc.bigInt(1n, 10_000_000_000_000n); // up to 10M USDC
const oddsArb = fc.integer({ min: 1, max: 1_000_000 }); // up to 1000.0x
const capArb = fc.integer({ min: 1_000, max: 100_000 });
const bpsArb = fc.integer({ min: 0, max: 9_999 });
const liabArb = fc.tuple(
  fc.bigInt(0n, 1_000_000_000_000n),
  fc.bigInt(0n, 1_000_000_000_000n),
  fc.bigInt(0n, 1_000_000_000_000n),
) as fc.Arbitrary<[bigint, bigint, bigint]>;

describe("solvency invariants", () => {
  it("payout never exceeds the commit-time reservation", () => {
    fc.assert(
      fc.property(stakeArb, capArb, bpsArb, oddsArb, oddsArb, liabArb, fc.integer({ min: 0, max: 100_000 }),
        (stake, cap, spread, fair1, fair2, liab, skewCoeff) => {
          const skew = skewBps(skewCoeff, liab, 0, 1_000_000_000n);
          const odds = fillOdds(fair1, fair2, spread, skew, cap);
          return payout(stake, odds) <= reserved(stake, cap);
        }),
    );
  });

  it("worse-of-two: the fill never beats either print", () => {
    fc.assert(
      fc.property(oddsArb, oddsArb, bpsArb, capArb, (fair1, fair2, spread, cap) => {
        const odds = fillOdds(fair1, fair2, spread, 0n, cap);
        return odds <= fair1 && odds <= fair2;
      }),
    );
  });

  it("spread/skew only ever degrade the quote", () => {
    fc.assert(
      fc.property(oddsArb, bpsArb, fc.bigInt(0n, 20_000n), (fair, spread, skew) => {
        return effOdds(fair, spread, skew) <= fair;
      }),
    );
  });

  it("skew widens only the heavy side and is zero on the lightest", () => {
    fc.assert(
      fc.property(liabArb, fc.integer({ min: 0, max: 100_000 }), (liab, coeff) => {
        const min = liab.reduce((a, b) => (b < a ? b : a));
        const lightest = liab.indexOf(min) as 0 | 1 | 2;
        return skewBps(coeff, liab, lightest, 1_000_000_000n) === 0n;
      }),
    );
  });

  it("netting: a perfectly balanced filled book locks nothing", () => {
    fc.assert(
      fc.property(fc.bigInt(0n, 1_000_000_000_000n), (x) => {
        // equal liabilities on all outcomes, stakes collected >= liability
        return locked([x, x, x], x) === 0n;
      }),
    );
  });

  it("locked is monotone in liability and antitone in stakes", () => {
    fc.assert(
      fc.property(liabArb, fc.bigInt(0n, 1_000_000_000_000n), fc.bigInt(1n, 1_000_000n),
        (liab, stakes, extra) => {
          const base = locked(liab, stakes);
          const moreLiab: [bigint, bigint, bigint] = [liab[0] + extra, liab[1], liab[2]];
          return locked(moreLiab, stakes) >= base && locked(liab, stakes + extra) <= base;
        }),
    );
  });

  // pinned vectors — the exact values the rust program produced on-chain in
  // the m3 integration suites
  it("matches the on-chain fills bit-for-bit", () => {
    expect(fillOdds(2140, 2054, 100, 0n, 15_000)).toBe(2033);
    expect(fillOdds(3781, 4001, 100, 0n, 15_000)).toBe(3743);
    expect(fillOdds(3781, 4001, 100, 0n, 2_500)).toBe(2500);
    expect(fillOdds(1690, 1686, 100, 0n, 15_000)).toBe(1669);
    // skew case: liability 20.33 on outcome 2, coeff 5000, max_risk 2000 USDC
    const skew = skewBps(5_000, [0n, 0n, 20_330_000n], 2, 2_000_000_000n);
    expect(skew).toBe(50n);
    expect(fillOdds(2140, 2054, 100, skew, 15_000)).toBe(2023);
    expect(payout(10_000_000n, 2033)).toBe(20_330_000n);
  });
});
