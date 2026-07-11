// M5: fixture-replay version of the demo — two houses with different
// spreads quote the same fixture; the bettor routes to the best quote,
// fills at the worse-of-two prints, and settles on the real final score.
// (The live-data version of this flow is scripts/demo.ts / live-e2e.ts.)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSurfnet, type Surfnet } from "./harness/surfpool.js";
import { loadOddsPair, loadStatProof } from "./harness/fixtures.js";
import {
  addHouse,
  commitOnPair,
  fillIx,
  provePair,
  settleIx,
  setupMarket,
  type Market,
} from "./harness/flow.js";
import { usdcBalance } from "./harness/setup.js";
import { math } from "@bethehouse/sdk";

let surfnet: Surfnet;
let m: Market; // house 1: "sharp", spread 80 bps
let wide: { house: any; vault: any }; // house 2: "wide", spread 300 bps

const FX = { pair: loadOddsPair(18218149), stat: loadStatProof(18218149) }; // Spain 2-1 Belgium

beforeAll(async () => {
  surfnet = await startSurfnet();
  m = await setupMarket(surfnet, { spreadBps: 80 });
  wide = await addHouse(m, 2, { spreadBps: 300 }, 2_000);
  await provePair(surfnet, m, FX.pair);
});

afterAll(async () => {
  await surfnet?.stop();
});

describe("demo flow (two houses, best-quote routing, full lifecycle)", () => {
  it("the sharp house quotes better than the wide house", () => {
    const fair = FX.pair.commitPrint.raw.odds.Prices[0];
    const sharpQuote = math.effOdds(fair, 80, 0n);
    const wideQuote = math.effOdds(fair, 300, 0n);
    expect(sharpQuote).toBeGreaterThan(wideQuote);
  });

  it("commit -> fill via the sharp house at worse-of-two, settle on the real result", async () => {
    const bettorStart = await usdcBalance(surfnet, m.bettor.usdc);

    // SDK routing would pick the sharp house (m.house); commit there
    const c = await commitOnPair(surfnet, m, FX.pair, { outcome: 0, stakeUsdc: 10 });
    await fillIx(m, c, FX.pair).rpc();

    const bet = await m.bettor.program.account.bet.fetch(c.bet);
    // fair = min(1690, 1686) = 1686; sharp spread 80 bps -> floor(1686*0.992) = 1672
    expect(bet.fillOdds).toBe(1672);

    // Spain won -> bet on outcome 0 wins
    await settleIx(m, c, FX.stat.payload).rpc();
    const settled = await m.bettor.program.account.bet.fetch(c.bet);
    expect(settled.state.won).toBeDefined();

    // bettor net: -stake -fees -2 keeper rewards + payout
    const payout = BigInt(settled.payout.toString());
    const bettorEnd = await usdcBalance(surfnet, m.bettor.usdc);
    expect(bettorEnd - bettorStart).toBe(payout - 12_300_000n);
  });

  it("the same bet via the wide house fills at visibly worse odds", async () => {
    const c = await commitOnPair(surfnet, m, FX.pair, {
      outcome: 0,
      stakeUsdc: 10,
      house: wide.house,
      houseVault: wide.vault,
    });
    await fillIx(m, c, FX.pair, { house: wide.house, houseVault: wide.vault }).rpc();
    const bet = await m.bettor.program.account.bet.fetch(c.bet);
    // fair 1686; wide spread 300 bps -> floor(1686*0.97) = 1635
    expect(bet.fillOdds).toBe(1635);
    expect(bet.fillOdds).toBeLessThan(1672);
  });
});
