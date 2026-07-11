// M3: exact fee distribution over a full lifecycle (every micro-USDC
// accounted) and the void path. The void test travels the clock forward,
// so it runs last in this file.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { startSurfnet, type Surfnet } from "./harness/surfpool.js";
import { loadOddsPair, loadStatProof } from "./harness/fixtures.js";
import {
  commitOnPair,
  fillIx,
  provePair,
  settleIx,
  setupMarket,
  type Market,
} from "./harness/flow.js";
import { usdcBalance } from "./harness/setup.js";
import { timeTravel } from "./harness/cheats.js";

let surfnet: Surfnet;
let m: Market;

const HOME = { pair: loadOddsPair(18218149), stat: loadStatProof(18218149) };
const PAIR = loadOddsPair(18213979);
const CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");

async function nowMs(): Promise<number> {
  const info = await surfnet.connection.getAccountInfo(CLOCK);
  return Number(info!.data.readBigInt64LE(32)) * 1000;
}

beforeAll(async () => {
  surfnet = await startSurfnet();
  m = await setupMarket(surfnet); // frontend 200 bps, protocol 100 bps, reward 1 USDC
  await provePair(surfnet, m, HOME.pair);
  await provePair(surfnet, m, PAIR);
});

afterAll(async () => {
  await surfnet?.stop();
});

async function snapshot() {
  return {
    bettor: await usdcBalance(surfnet, m.bettor.usdc),
    escrow: await usdcBalance(surfnet, m.protocol.escrow),
    house: await usdcBalance(surfnet, m.houseVault),
    frontend: await usdcBalance(surfnet, m.frontendFeeVault),
    treasury: await usdcBalance(surfnet, m.protocol.treasury),
    cranker: await usdcBalance(surfnet, m.cranker.usdc),
  };
}

describe("fee distribution — full lifecycle balance sheet", () => {
  it("commit -> fill -> settle(win): every micro-USDC accounted", async () => {
    const b0 = await snapshot();

    // stake 10; frontend 2% = 0.2; protocol 1% = 0.1; keeper 2 x 1
    const c = await commitOnPair(surfnet, m, HOME.pair, { outcome: 0, stakeUsdc: 10 });
    const b1 = await snapshot();
    expect(b0.bettor - b1.bettor).toBe(12_300_000n);
    expect(b1.escrow - b0.escrow).toBe(12_300_000n);

    await fillIx(m, c, HOME.pair).rpc();
    const b2 = await snapshot();
    expect(b2.house - b1.house).toBe(10_000_000n); // stake
    expect(b2.frontend - b1.frontend).toBe(200_000n); // 2%
    expect(b2.treasury - b1.treasury).toBe(100_000n); // 1%
    expect(b2.cranker - b1.cranker).toBe(1_000_000n); // fill reward
    expect(b1.escrow - b2.escrow).toBe(11_300_000n); // all but the settle reward

    await settleIx(m, c, HOME.stat.payload).rpc();
    const b3 = await snapshot();
    // payout 16.69 (fair 1686, spread 100bps -> 1669)
    expect(b3.bettor - b2.bettor).toBe(16_690_000n);
    expect(b2.house - b3.house).toBe(16_690_000n);
    expect(b3.cranker - b2.cranker).toBe(1_000_000n); // settle reward
    expect(b3.escrow).toBe(b0.escrow); // escrow fully drained for this bet

    // conservation: all balance deltas sum to zero
    const deltas =
      b3.bettor - b0.bettor + (b3.escrow - b0.escrow) + (b3.house - b0.house) +
      (b3.frontend - b0.frontend) + (b3.treasury - b0.treasury) + (b3.cranker - b0.cranker);
    expect(deltas).toBe(0n);
  });
});

describe("void_bet (travels the clock forward — keep last)", () => {
  it("rejects void before the window, voids after, stake returned", async () => {
    // kickoff 1h from now: fill still passes (prints are older), and the
    // 3-day void window only opens after we travel forward
    const c = await commitOnPair(surfnet, m, PAIR, {
      outcome: 0,
      stakeUsdc: 10,
      startTimeMs: (await nowMs()) + 3_600_000,
    });
    await fillIx(m, c, PAIR).rpc();

    const voidCall = () =>
      m.cranker.program.methods
        .voidBet()
        .accounts({
          cranker: m.cranker.pubkey,
          crankerToken: m.cranker.usdc,
          escrowVault: m.protocol.escrow,
          bet: c.bet,
          house: m.house,
          houseVault: m.houseVault,
          exposure: c.exposure,
          bettorToken: m.bettor.usdc,
        })
        .rpc();

    await expect(voidCall()).rejects.toThrow(/NotVoidable/);

    // void_after = 3 days past kickoff (start_time is in the recent past)
    await timeTravel(surfnet.connection, (await nowMs()) + 5 * 86_400_000);

    const bettorBefore = await usdcBalance(surfnet, m.bettor.usdc);
    const houseBefore = await usdcBalance(surfnet, m.houseVault);
    await voidCall();

    const bet = await m.bettor.program.account.bet.fetch(c.bet);
    expect(bet.state.voided).toBeDefined();
    expect((await usdcBalance(surfnet, m.bettor.usdc)) - bettorBefore).toBe(10_000_000n);
    expect(houseBefore - (await usdcBalance(surfnet, m.houseVault))).toBe(10_000_000n);

    const exp = await m.bettor.program.account.fixtureExposure.fetch(c.exposure);
    expect(exp.locked.toNumber()).toBe(0);

    // rent reclaim on the voided bet
    await m.bettor.program.methods
      .closeBet()
      .accounts({ bettor: m.bettor.pubkey, bet: c.bet })
      .rpc();
    expect(await surfnet.connection.getAccountInfo(c.bet)).toBeNull();
  });
});
