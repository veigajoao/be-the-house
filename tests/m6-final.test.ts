// England v Argentina (fixture 18241006, the World Cup final) — captured
// pre-match pair ~1.7h before kickoff:
//   commit [2704, 3264, 3088] -> target [2653, 3259, 3162]
//   direction per outcome: [adverse, adverse, favorable]
// This suite runs the fill paths on the final and covers paths the earlier
// suites didn't: oracle-silence refund after prints are proven, withdraw
// against locked collateral, config update auth, params-affect-future-fills,
// wrong scores root at settle, multi-frontend fee routing, netting release
// order across settles.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { startSurfnet, type Surfnet } from "./harness/surfpool.js";
import { loadOddsPair, loadStatProof, scoresRootPda } from "./harness/fixtures.js";
import {
  addHouse,
  commitOnPair,
  CU,
  fillIx,
  provePair,
  settleIx,
  setupMarket,
  USDC,
  type Market,
} from "./harness/flow.js";

/** BN from a micro-USDC integer (BN.iaddn caps at 2^26 — unusable here). */
const micro = (n: number) => USDC(n / 1_000_000);
import { fundActor, pda, usdcBalance, USDC_MINT, TXORACLE_PROGRAM, DEFAULT_CONFIG } from "./harness/setup.js";
import { timeTravel } from "./harness/cheats.js";

let surfnet: Surfnet;
let m: Market;

const FINAL = loadOddsPair(18241006); // England v Argentina
const P1 = FINAL.commitPrint.raw.odds; // [2704, 3264, 3088]
const P2 = FINAL.targetPrint.raw.odds; // [2653, 3259, 3162]
const HOME = { pair: loadOddsPair(18218149), stat: loadStatProof(18218149) }; // Spain 2-1 Belgium

const CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");
async function nowMs(): Promise<number> {
  const info = await surfnet.connection.getAccountInfo(CLOCK);
  return Number(info!.data.readBigInt64LE(32)) * 1000;
}

beforeAll(async () => {
  surfnet = await startSurfnet();
  m = await setupMarket(surfnet); // spread 100 bps, no skew, cap 15.0, frontend 200 bps
  await provePair(surfnet, m, FINAL);
  await provePair(surfnet, m, HOME.pair);
});

afterAll(async () => {
  await surfnet?.stop();
});

describe("fill on the final (worse-of-two, both directions)", () => {
  it("England (outcome 0) moved adverse: fills at the target print", async () => {
    const c = await commitOnPair(surfnet, m, FINAL, { outcome: 0, stakeUsdc: 10 });
    await fillIx(m, c, FINAL).rpc();
    const bet = await m.bettor.program.account.bet.fetch(c.bet);
    // fair = min(2704, 2653) = 2653; floor(2653 * 0.99) = 2626
    expect(bet.fillOdds).toBe(2626);
    expect(bet.payout.toNumber()).toBe(26_260_000);
  });

  it("Argentina (outcome 2) moved favorable: fills at the commit print", async () => {
    const c = await commitOnPair(surfnet, m, FINAL, { outcome: 2, stakeUsdc: 10 });
    await fillIx(m, c, FINAL).rpc();
    const bet = await m.bettor.program.account.bet.fetch(c.bet);
    // fair = min(3088, 3162) = 3088; floor(3088 * 0.99) = 3057
    expect(bet.fillOdds).toBe(3057);
    expect(bet.payout.toNumber()).toBe(30_570_000);
  });
});

describe("uncovered paths", () => {
  it("house params updated between commit and fill apply at fill; reservation is immutable", async () => {
    const h = await addHouse(m, 5, { spreadBps: 100 }, 500);
    const c = await commitOnPair(surfnet, m, FINAL, {
      outcome: 0,
      stakeUsdc: 10,
      house: h.house,
      houseVault: h.vault,
    });
    const before = await m.bettor.program.account.bet.fetch(c.bet);
    expect(before.reserved.toNumber()).toBe(150_000_000); // 10 x cap 15.0

    await m.houseOwner.program.methods
      .updateHouseParams({
        spreadBps: 500, // widen after the commit
        skewCoeffBps: 0,
        oddsCap: 15_000,
        maxRiskPerFixture: USDC(2_000),
        maxTotalRisk: USDC(4_000),
      })
      .accounts({ owner: m.houseOwner.pubkey, house: h.house })
      .rpc();

    await fillIx(m, c, FINAL, { house: h.house, houseVault: h.vault }).rpc();
    const bet = await m.bettor.program.account.bet.fetch(c.bet);
    // fill uses params AT FILL TIME: floor(2653 * 0.95) = 2520
    expect(bet.fillOdds).toBe(2520);
    // the commit-time reservation was untouched by the param change
    expect(bet.reserved.toNumber()).toBe(150_000_000);
  });

  it("fees route to the bet's own frontend, not another registered one", async () => {
    const otherFe = await fundActor(surfnet, 0n);
    await otherFe.program.methods
      .registerFrontend(300) // 3%
      .accounts({ owner: otherFe.pubkey, usdcMint: USDC_MINT })
      .rpc();
    const otherFrontend = pda.frontend(otherFe.pubkey);
    const otherVault = pda.frontendVault(otherFe.pubkey);

    const c = await commitOnPair(surfnet, m, FINAL, {
      outcome: 0,
      stakeUsdc: 10,
      frontend: otherFrontend,
    });
    // the bet's frontend is enforced by has_one: filling with the WRONG
    // frontend account fails...
    await expect(fillIx(m, c, FINAL).rpc()).rejects.toThrow(); // has_one = frontend
    // ...and with the right one, its 3% fee lands in ITS vault
    const mainBefore = await usdcBalance(surfnet, m.frontendFeeVault);
    await fillIx(m, c, FINAL, {
      frontend: otherFrontend,
      frontendFeeVault: otherVault,
    }).rpc();
    expect(await usdcBalance(surfnet, otherVault)).toBe(300_000n); // 3% of 10
    expect(await usdcBalance(surfnet, m.frontendFeeVault)).toBe(mainBefore);
  });

  it("settle rejects the wrong scores root account", async () => {
    const c = await commitOnPair(surfnet, m, HOME.pair, { outcome: 0, stakeUsdc: 5 });
    await fillIx(m, c, HOME.pair).rpc();
    const wrongRoot = scoresRootPda(
      HOME.stat.raw.proof.summary.updateStats.minTimestamp + 86_400_000, // next day
    );
    await expect(
      m.cranker.program.methods
        .settleBet(HOME.stat.payload)
        .accounts({
          cranker: m.cranker.pubkey,
          crankerToken: m.cranker.usdc,
          escrowVault: m.protocol.escrow,
          bet: c.bet,
          house: m.house,
          houseVault: m.houseVault,
          exposure: c.exposure,
          bettorToken: m.bettor.usdc,
          scoresRoot: wrongRoot,
          txoracleProgram: TXORACLE_PROGRAM,
        })
        .preInstructions([CU])
        .rpc(),
    ).rejects.toThrow(/WrongRootAccount/);
    // clean settle afterwards so exposure isn't left hanging
    await settleIx(m, c, HOME.stat.payload).rpc();
  });

  it("netting releases in settle order: opposing bets unwind correctly", async () => {
    const h = await addHouse(m, 6, {}, 500);
    const opts = { house: h.house, houseVault: h.vault };
    const cWin = await commitOnPair(surfnet, m, HOME.pair, { outcome: 0, stakeUsdc: 10, ...opts });
    await fillIx(m, cWin, HOME.pair, opts).rpc();
    const cLose = await commitOnPair(surfnet, m, HOME.pair, { outcome: 2, stakeUsdc: 10, ...opts });
    await fillIx(m, cLose, HOME.pair, opts).rpc();

    const payoutWin = (await m.bettor.program.account.bet.fetch(cWin.bet)).payout.toNumber();
    const payoutLose = (await m.bettor.program.account.bet.fetch(cLose.bet)).payout.toNumber();

    // settle the WINNING bet first (Spain won): pays payoutWin, releases its leg
    await settleIx(m, cWin, HOME.stat.payload, opts).rpc();
    let exp = await m.bettor.program.account.fixtureExposure.fetch(cWin.exposure);
    expect(exp.liability[0].toNumber()).toBe(0);
    expect(exp.liability[2].toNumber()).toBe(payoutLose);
    // remaining book: max(0,0,payoutLose) - stakes(10) locked
    expect(exp.locked.toNumber()).toBe(payoutLose - 10_000_000);

    // settle the LOSING bet: nothing moves, exposure fully unwinds
    await settleIx(m, cLose, HOME.stat.payload, opts).rpc();
    exp = await m.bettor.program.account.fixtureExposure.fetch(cWin.exposure);
    expect(exp.locked.toNumber()).toBe(0);
    expect(exp.stakesCollected.toNumber()).toBe(0);
    expect(exp.openBets).toBe(0);
    const house = await m.bettor.program.account.house.fetch(h.house);
    expect(house.totalLocked.toNumber()).toBe(0);
  });

  it("update_config: admin can, others cannot", async () => {
    await m.protocol.program.methods
      .updateConfig({ ...DEFAULT_CONFIG, keeperReward: USDC(2) })
      .accounts({ admin: m.protocol.admin.publicKey, config: m.protocol.config })
      .rpc();
    let cfg = await m.protocol.program.account.config.fetch(m.protocol.config);
    expect(cfg.keeperReward.toNumber()).toBe(2_000_000);
    // restore
    await m.protocol.program.methods
      .updateConfig({ ...DEFAULT_CONFIG })
      .accounts({ admin: m.protocol.admin.publicKey, config: m.protocol.config })
      .rpc();

    await expect(
      m.bettor.program.methods
        .updateConfig({ ...DEFAULT_CONFIG })
        .accounts({ admin: m.bettor.pubkey, config: m.protocol.config })
        .rpc(),
    ).rejects.toThrow(); // has_one = admin
  });

  it("withdraw is capped at free collateral while bets are locked", async () => {
    const h = await addHouse(m, 7, {}, 100);
    const c = await commitOnPair(surfnet, m, FINAL, {
      outcome: 0,
      stakeUsdc: 5,
      house: h.house,
      houseVault: h.vault,
    });
    await fillIx(m, c, FINAL, { house: h.house, houseVault: h.vault }).rpc();

    const house = await m.bettor.program.account.house.fetch(h.house);
    const vaultBal = Number(await usdcBalance(surfnet, h.vault));
    const locked = house.totalLocked.toNumber();
    expect(locked).toBeGreaterThan(0);
    const free = vaultBal - locked;

    await expect(
      m.houseOwner.program.methods
        .withdraw(micro(free + 1))
        .accounts({
          owner: m.houseOwner.pubkey,
          house: h.house,
          vault: h.vault,
          destination: m.houseOwner.usdc,
        })
        .rpc(),
    ).rejects.toThrow(/InsufficientFreeCollateral/);

    await m.houseOwner.program.methods
      .withdraw(micro(free))
      .accounts({
        owner: m.houseOwner.pubkey,
        house: h.house,
        vault: h.vault,
        destination: m.houseOwner.usdc,
      })
      .rpc();
    expect(Number(await usdcBalance(surfnet, h.vault))).toBe(locked); // exactly the invariant floor
  });
});

describe("oracle silence at target (travels the clock — keep last)", () => {
  it("prints proven but no target-window print: bet expires and refunds in full", async () => {
    // commit placed so the commit window holds but NO print exists at/after
    // target: commit right at the target print, so target = P2.Ts + 15s and
    // the next print in the fixture file is... none we proved.
    const c = await commitOnPair(surfnet, m, FINAL, {
      outcome: 1,
      stakeUsdc: 10,
      commitTsMs: P2.Ts + 1_000, // P2 inside commit window; nothing proven after
    });
    // fill with the pair fails: P2 is now a commit-window print, no target
    await expect(fillIx(m, c, FINAL).rpc()).rejects.toThrow(
      /OutsideCommitWindow|OutsideTargetWindow/,
    );

    const bettorBefore = await usdcBalance(surfnet, m.bettor.usdc);
    await timeTravel(surfnet.connection, (await nowMs()) + 2 * 3600_000);
    await m.bettor.program.methods
      .refundCommit()
      .accounts({
        cranker: m.bettor.pubkey,
        escrowVault: m.protocol.escrow,
        bet: c.bet,
        house: m.house,
        exposure: c.exposure,
        bettorToken: m.bettor.usdc,
      })
      .rpc();

    // full escrow back: stake + fees + BOTH keeper rewards (none were spent)
    expect((await usdcBalance(surfnet, m.bettor.usdc)) - bettorBefore).toBe(
      10_000_000n + 200_000n + 100_000n + 2_000_000n,
    );
    const bet = await m.bettor.program.account.bet.fetch(c.bet);
    expect(bet.state.refunded).toBeDefined();
    // reservation released
    const exp = await m.bettor.program.account.fixtureExposure.fetch(c.exposure);
    expect(exp.locked.toNumber()).toBeLessThanOrEqual(
      // remaining locked comes only from other suites' bets on this exposure
      exp.liability.reduce((a: number, b: any) => Math.max(a, b.toNumber()), 0),
    );
  });
});
