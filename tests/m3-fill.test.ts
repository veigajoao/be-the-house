// M3: fill_bet — worse-of-two pricing, spread/skew, odds_cap clamp,
// reservation true-down + netting, window/kickoff guards. Replays the real
// captured print pair for fixture 18213979:
//   commit prices [3781, 3729, 2140] -> target [4001, 3798, 2054]
//   direction per outcome: [favorable, favorable, adverse]
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSurfnet, type Surfnet } from "./harness/surfpool.js";
import { loadOddsPair } from "./harness/fixtures.js";
import {
  addHouse,
  commitOnPair,
  fillIx,
  provePair,
  setupMarket,
  USDC,
  type Market,
} from "./harness/flow.js";
import { usdcBalance } from "./harness/setup.js";

let surfnet: Surfnet;
let m: Market;

const PAIR = loadOddsPair(18213979);
const P1 = PAIR.commitPrint.raw.odds; // prices [3781, 3729, 2140]
const P2 = PAIR.targetPrint.raw.odds; // prices [4001, 3798, 2054]

beforeAll(async () => {
  surfnet = await startSurfnet();
  // default market: spread 100 bps, no skew, cap 15.0
  m = await setupMarket(surfnet);
  await provePair(surfnet, m, PAIR);
});

afterAll(async () => {
  await surfnet?.stop();
});

describe("fill_bet (worse-of-two + house quote)", () => {
  it("adverse move: fills at the (worse) target print", async () => {
    const c = await commitOnPair(surfnet, m, PAIR, { outcome: 2, stakeUsdc: 10 });
    const crankerBefore = await usdcBalance(surfnet, m.cranker.usdc);
    await fillIx(m, c, PAIR).rpc();

    const bet = await m.bettor.program.account.bet.fetch(c.bet);
    expect(bet.state.active).toBeDefined();
    // fair = min(2140, 2054) = 2054; spread 100 bps -> floor(2054 * 0.99) = 2033
    expect(bet.fillOdds).toBe(2033);
    expect(bet.payout.toNumber()).toBe(20_330_000);
    expect(bet.fillTsMs.toNumber()).toBe(P2.Ts);

    // reservation trued down: liability[2] == payout for this lone bet
    const exp = await m.bettor.program.account.fixtureExposure.fetch(c.exposure);
    expect(exp.liability[2].toNumber()).toBe(20_330_000);
    expect(exp.stakesCollected.toNumber()).toBe(10_000_000);
    // locked = max(liab) - stakes = 20.33 - 10 = 10.33
    expect(exp.locked.toNumber()).toBe(10_330_000);

    // fill crank reward paid
    expect((await usdcBalance(surfnet, m.cranker.usdc)) - crankerBefore).toBe(1_000_000n);

    // stake landed in the house vault
    expect(await usdcBalance(surfnet, m.houseVault)).toBe(4_010_000_000n);
  });

  it("favorable move: fills at the (worse) commit print — never improves", async () => {
    const c = await commitOnPair(surfnet, m, PAIR, { outcome: 0, stakeUsdc: 10 });
    await fillIx(m, c, PAIR).rpc();
    const bet = await m.bettor.program.account.bet.fetch(c.bet);
    // fair = min(3781, 4001) = 3781 -> floor(3781 * 0.99) = 3743
    expect(bet.fillOdds).toBe(3743);
    expect(bet.payout.toNumber()).toBe(37_430_000);
  });

  it("clamps at odds_cap and releases the over-reservation", async () => {
    const capped = await addHouse(m, 2, { oddsCap: 2_500 }, 500);
    const c = await commitOnPair(surfnet, m, PAIR, {
      outcome: 0,
      stakeUsdc: 10,
      house: capped.house,
      houseVault: capped.vault,
    });
    await fillIx(m, c, PAIR, { house: capped.house, houseVault: capped.vault }).rpc();
    const bet = await m.bettor.program.account.bet.fetch(c.bet);
    // eff 3743 clamped to cap 2500
    expect(bet.fillOdds).toBe(2_500);
    expect(bet.payout.toNumber()).toBe(25_000_000);
    expect(bet.reserved.toNumber()).toBe(25_000_000); // = stake x cap

    const exp = await m.bettor.program.account.fixtureExposure.fetch(c.exposure);
    expect(exp.liability[0].toNumber()).toBe(25_000_000);
  });

  it("skew widens the heavy side (and ignores the bet's own reservation)", async () => {
    // skew_coeff 5000, max_risk 2000 USDC
    const skewed = await addHouse(m, 3, { skewCoeffBps: 5_000 }, 2_000);
    const h = { house: skewed.house, houseVault: skewed.vault };

    // First bet: book is empty net of its own reservation -> zero skew
    const c1 = await commitOnPair(surfnet, m, PAIR, { outcome: 2, stakeUsdc: 10, ...h });
    await fillIx(m, c1, PAIR, h).rpc();
    const bet1 = await m.bettor.program.account.bet.fetch(c1.bet);
    expect(bet1.fillOdds).toBe(2033); // same as no-skew house

    // Second bet, same outcome: heavy = liability[2] = payout1 = 20.33 USDC
    // skew = floor(5000 * 20_330_000 / 2_000_000_000) = 50 bps
    // eff = floor(2054 * (10000-100-50)/10000) = floor(2023.19) = 2023
    const c2 = await commitOnPair(surfnet, m, PAIR, { outcome: 2, stakeUsdc: 10, ...h });
    await fillIx(m, c2, PAIR, h).rpc();
    const bet2 = await m.bettor.program.account.bet.fetch(c2.bet);
    expect(bet2.fillOdds).toBe(2023);
    expect(bet2.payout.toNumber()).toBe(20_230_000);
  });

  it("netting: opposing filled bets nearly cancel", async () => {
    const net = await addHouse(m, 4, {}, 500);
    const h = { house: net.house, houseVault: net.vault };
    const c1 = await commitOnPair(surfnet, m, PAIR, { outcome: 0, stakeUsdc: 10, ...h });
    await fillIx(m, c1, PAIR, h).rpc();
    const c2 = await commitOnPair(surfnet, m, PAIR, { outcome: 2, stakeUsdc: 10, ...h });
    await fillIx(m, c2, PAIR, h).rpc();

    const exp = await m.bettor.program.account.fixtureExposure.fetch(c1.exposure);
    // liab [37.43, 0, 20.33], stakes 20 -> locked = 37.43 - 20 = 17.43
    expect(exp.liability[0].toNumber()).toBe(37_430_000);
    expect(exp.liability[2].toNumber()).toBe(20_330_000);
    expect(exp.locked.toNumber()).toBe(17_430_000);
    const houseAcc = await m.bettor.program.account.house.fetch(net.house);
    expect(houseAcc.totalLocked.toNumber()).toBe(17_430_000);
  });
});

describe("fill_bet fallback (last proven price during a feed lull)", () => {
  it("fills at the commit print when no fresher target print exists", async () => {
    // Feed silent through the 15s window -> the keeper supplies the commit
    // print as the target too. Commit AT the later print P2 so it's the last
    // proven price; worse-of-two(P2, P2) = P2. No post-target print needed.
    const c = await commitOnPair(surfnet, m, PAIR, {
      outcome: 2,
      stakeUsdc: 10,
      commitTsMs: P2.Ts,
    });
    await fillIx(m, c, PAIR, { commitPrintTs: P2.Ts, targetPrintTs: P2.Ts }).rpc();

    const bet = await m.bettor.program.account.bet.fetch(c.bet);
    expect(bet.state.active).toBeDefined();
    // fair = min(2054, 2054) = 2054; spread 100 bps -> floor(2054 * 0.99) = 2033
    expect(bet.fillOdds).toBe(2033);
    expect(bet.fillTsMs.toNumber()).toBe(P2.Ts);
  });

  it("still rejects a target print OLDER than the commit print", async () => {
    // The fallback relaxes the target's lower bound to commit_print.ts — never
    // below it. A target staler than commit can never be used.
    const c = await commitOnPair(surfnet, m, PAIR, { outcome: 0, commitTsMs: P2.Ts });
    await expect(
      fillIx(m, c, PAIR, { commitPrintTs: P2.Ts, targetPrintTs: P1.Ts }).rpc(),
    ).rejects.toThrow(/OutsideTargetWindow/);
  });
});

describe("fill_bet guards", () => {
  it("rejects a commit print outside the staleness window", async () => {
    const c = await commitOnPair(surfnet, m, PAIR, {
      outcome: 0,
      commitTsMs: P1.Ts + 200_000, // print 200s before commit > 120s window
    });
    await expect(fillIx(m, c, PAIR).rpc()).rejects.toThrow(/OutsideCommitWindow/);
  });

  it("rejects a target print outside the tolerance window", async () => {
    // commit right at print1: target = +15s; print2 is +${PAIR.gapMs}ms > 105s
    const c = await commitOnPair(surfnet, m, PAIR, { outcome: 0, commitTsMs: P1.Ts });
    await expect(fillIx(m, c, PAIR).rpc()).rejects.toThrow(/OutsideTargetWindow/);
  });

  it("rejects prints at/after kickoff", async () => {
    const c = await commitOnPair(surfnet, m, PAIR, {
      outcome: 0,
      startTimeMs: P2.Ts - 1_000,
    });
    await expect(fillIx(m, c, PAIR).rpc()).rejects.toThrow(/PastKickoff/);
  });

  it("rejects double-fill and refund-after-fill", async () => {
    const c = await commitOnPair(surfnet, m, PAIR, { outcome: 1, stakeUsdc: 5 });
    await fillIx(m, c, PAIR).rpc();
    await expect(fillIx(m, c, PAIR).rpc()).rejects.toThrow(/WrongBetState/);
    await expect(
      m.bettor.program.methods
        .refundCommit()
        .accounts({
          cranker: m.bettor.pubkey,
          escrowVault: m.protocol.escrow,
          bet: c.bet,
          house: m.house,
          exposure: c.exposure,
          bettorToken: m.bettor.usdc,
        })
        .rpc(),
    ).rejects.toThrow(/WrongBetState/);
  });

  it("rejects prints of a different fixture", async () => {
    const other = loadOddsPair(18218149);
    await provePair(surfnet, m, other);
    const c = await commitOnPair(surfnet, m, PAIR, { outcome: 0 });
    await expect(fillIx(m, c, other).rpc()).rejects.toThrow(/FixtureMismatch/);
  });
});
