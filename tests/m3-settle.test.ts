// M3: settle_bet against REAL final-score Merkle proofs (game_finalised
// events, period 100) for three real World Cup results:
//   18218149 Spain 2-1 Belgium  (home win)
//   18192996 Mexico 2-3 England (away win)
//   18202783 Switzerland 0-0 Colombia (draw)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSurfnet, type Surfnet } from "./harness/surfpool.js";
import { loadOddsPair, loadStatProof } from "./harness/fixtures.js";
import {
  commitOnPair,
  fillIx,
  provePair,
  settleIx,
  setupMarket,
  type CommittedBet,
  type Market,
} from "./harness/flow.js";
import { usdcBalance } from "./harness/setup.js";

let surfnet: Surfnet;
let m: Market;

const HOME = { pair: loadOddsPair(18218149), stat: loadStatProof(18218149) };
const AWAY = { pair: loadOddsPair(18192996), stat: loadStatProof(18192996) };
const DRAW = { pair: loadOddsPair(18202783), stat: loadStatProof(18202783) };

beforeAll(async () => {
  surfnet = await startSurfnet();
  m = await setupMarket(surfnet);
  await provePair(surfnet, m, HOME.pair);
  await provePair(surfnet, m, AWAY.pair);
  await provePair(surfnet, m, DRAW.pair);
});

afterAll(async () => {
  await surfnet?.stop();
});

async function activeBet(
  fx: { pair: ReturnType<typeof loadOddsPair> },
  outcome: number,
  stakeUsdc = 10,
): Promise<CommittedBet> {
  const c = await commitOnPair(surfnet, m, fx.pair, { outcome, stakeUsdc });
  await fillIx(m, c, fx.pair).rpc();
  return c;
}

describe("settle_bet (real final-score proofs)", () => {
  it("home win pays the winning bettor from the house vault", async () => {
    const c = await activeBet(HOME, 0); // bet on home (Spain) — wins
    const bettorBefore = await usdcBalance(surfnet, m.bettor.usdc);
    const houseBefore = await usdcBalance(surfnet, m.houseVault);

    await settleIx(m, c, HOME.stat.payload).rpc();

    const bet = await m.bettor.program.account.bet.fetch(c.bet);
    expect(bet.state.won).toBeDefined();
    // pair prices commit [1690,4177,5922] target [1686,4390,5585]:
    // fair=min(1690,1686)=1686, spread 100bps -> floor(1686*0.99)=1669
    expect(bet.fillOdds).toBe(1669);
    expect(bet.payout.toNumber()).toBe(16_690_000);

    expect((await usdcBalance(surfnet, m.bettor.usdc)) - bettorBefore).toBe(16_690_000n);
    expect(houseBefore - (await usdcBalance(surfnet, m.houseVault))).toBe(16_690_000n);

    // exposure fully released for this lone bet
    const exp = await m.bettor.program.account.fixtureExposure.fetch(c.exposure);
    expect(exp.liability[0].toNumber()).toBe(0);
    expect(exp.stakesCollected.toNumber()).toBe(0);
    expect(exp.locked.toNumber()).toBe(0);
    expect(exp.openBets).toBe(0);
  });

  it("losing bet pays nothing — stake stays with the house", async () => {
    const c = await activeBet(AWAY, 0); // bet on home (Mexico) — loses 2-3
    const bettorBefore = await usdcBalance(surfnet, m.bettor.usdc);
    const houseBefore = await usdcBalance(surfnet, m.houseVault);

    await settleIx(m, c, AWAY.stat.payload).rpc();

    const bet = await m.bettor.program.account.bet.fetch(c.bet);
    expect(bet.state.lost).toBeDefined();
    expect(await usdcBalance(surfnet, m.bettor.usdc)).toBe(bettorBefore);
    expect(await usdcBalance(surfnet, m.houseVault)).toBe(houseBefore);
  });

  it("away win settles outcome 2 as the winner", async () => {
    const c = await activeBet(AWAY, 2); // bet on away (England) — wins
    await settleIx(m, c, AWAY.stat.payload).rpc();
    const bet = await m.bettor.program.account.bet.fetch(c.bet);
    expect(bet.state.won).toBeDefined();
  });

  it("draw settles outcome 1 as the winner (and 0 as loser)", async () => {
    const cDraw = await activeBet(DRAW, 1);
    const cHome = await activeBet(DRAW, 0);
    await settleIx(m, cDraw, DRAW.stat.payload).rpc();
    await settleIx(m, cHome, DRAW.stat.payload).rpc();
    expect(
      (await m.bettor.program.account.bet.fetch(cDraw.bet)).state.won,
    ).toBeDefined();
    expect(
      (await m.bettor.program.account.bet.fetch(cHome.bet)).state.lost,
    ).toBeDefined();
  });

  it("keeper reward paid per settle crank; double-settle rejected", async () => {
    const c = await activeBet(HOME, 1);
    const crankerBefore = await usdcBalance(surfnet, m.cranker.usdc);
    await settleIx(m, c, HOME.stat.payload).rpc();
    expect((await usdcBalance(surfnet, m.cranker.usdc)) - crankerBefore).toBe(1_000_000n);
    await expect(settleIx(m, c, HOME.stat.payload).rpc()).rejects.toThrow(/WrongBetState/);
  });
});

describe("settle_bet guards", () => {
  it("rejects a proof for a different fixture", async () => {
    const c = await activeBet(HOME, 0);
    await expect(settleIx(m, c, AWAY.stat.payload).rpc()).rejects.toThrow(
      /FixtureMismatch/,
    );
  });

  it("rejects non-final stats (period != 100)", async () => {
    const c = await activeBet(HOME, 0);
    // fresh load (payload holds BN instances — structuredClone would break them)
    const tampered = loadStatProof(18218149).payload;
    tampered.stats[0].stat.period = 0;
    tampered.stats[1].stat.period = 0;
    await expect(settleIx(m, c, tampered).rpc()).rejects.toThrow(/NotFinalStats/);
  });

  it("rejects tampered score values (Merkle mismatch)", async () => {
    const c = await activeBet(HOME, 2); // would win if Belgium had won
    const tampered = loadStatProof(18218149).payload;
    tampered.stats[0].stat.value = 0; // claim Spain scored 0 (real: 2)
    tampered.stats[1].stat.value = 1;
    await expect(settleIx(m, c, tampered).rpc()).rejects.toThrow(
      /StatProofInvalid|InvalidStatProof|Invalid.*[Pp]roof/,
    );
  });
});
