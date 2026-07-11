import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { startSurfnet, type Surfnet } from "./harness/surfpool.js";
import { timeTravel } from "./harness/cheats.js";
import {
  fundActor,
  initProtocol,
  pda,
  usdcBalance,
  USDC_MINT,
  type Actor,
  type Protocol,
} from "./harness/setup.js";

let surfnet: Surfnet;
let protocol: Protocol;
let houseOwner: Actor;
let frontendOwner: Actor;
let bettor: Actor;

const FIXTURE = 18_213_979n;
const CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");

const USDC = (n: number) => new anchor.BN(Math.round(n * 1_000_000));
const KEEPER_ESCROW = 3_000_000n; // 3 cranks x 1 USDC

async function nowMs(): Promise<number> {
  const info = await surfnet.connection.getAccountInfo(CLOCK);
  return Number(info!.data.readBigInt64LE(32)) * 1000;
}

interface HouseSetup {
  house: PublicKey;
  vault: PublicKey;
}

async function makeHouse(
  id: number,
  deposit: number,
  params: Partial<{
    spreadBps: number;
    skewCoeffBps: number;
    oddsCap: number;
    maxRiskPerFixture: anchor.BN;
    maxTotalRisk: anchor.BN;
  }> = {},
): Promise<HouseSetup> {
  const p = {
    spreadBps: 100,
    skewCoeffBps: 0,
    oddsCap: 15_000,
    maxRiskPerFixture: USDC(500),
    maxTotalRisk: USDC(800),
    ...params,
  };
  await houseOwner.program.methods
    .createHouse(id, p)
    .accounts({ owner: houseOwner.pubkey, usdcMint: USDC_MINT })
    .rpc();
  const house = pda.house(houseOwner.pubkey, id);
  const vault = pda.houseVault(houseOwner.pubkey, id);
  if (deposit > 0) {
    await houseOwner.program.methods
      .deposit(USDC(deposit))
      .accounts({
        depositor: houseOwner.pubkey,
        house,
        vault,
        depositorToken: houseOwner.usdc,
      })
      .rpc();
  }
  return { house, vault };
}

let nonce = 0n;
async function commit(
  h: HouseSetup,
  opts: Partial<{
    fixture: bigint;
    outcome: number;
    stakeUsdc: number;
    startTimeMs: number;
    bettor: Actor;
  }> = {},
): Promise<{ bet: PublicKey; exposure: PublicKey; nonce: bigint }> {
  const b = opts.bettor ?? bettor;
  const fixture = opts.fixture ?? FIXTURE;
  const n = ++nonce;
  const startTime = opts.startTimeMs ?? (await nowMs()) + 24 * 3600 * 1000;
  await b.program.methods
    .commitBet(
      new anchor.BN(fixture.toString()),
      opts.outcome ?? 0,
      USDC(opts.stakeUsdc ?? 10),
      new anchor.BN(n.toString()),
      new anchor.BN(startTime),
    )
    .accounts({
      bettor: b.pubkey,
      escrowVault: protocol.escrow,
      bettorToken: b.usdc,
      frontend: pda.frontend(frontendOwner.pubkey),
      house: h.house,
      houseVault: h.vault,
      exposure: pda.exposure(h.house, fixture),
      bet: pda.bet(b.pubkey, n),
    })
    .rpc();
  return { bet: pda.bet(b.pubkey, n), exposure: pda.exposure(h.house, fixture), nonce: n };
}

beforeAll(async () => {
  surfnet = await startSurfnet();
  protocol = await initProtocol(surfnet);
  houseOwner = await fundActor(surfnet, 5_000_000_000n); // 5000 USDC
  frontendOwner = await fundActor(surfnet, 0n);
  bettor = await fundActor(surfnet, 1_000_000_000n); // 1000 USDC

  await frontendOwner.program.methods
    .registerFrontend(200) // 2%
    .accounts({ owner: frontendOwner.pubkey, usdcMint: USDC_MINT })
    .rpc();
});

afterAll(async () => {
  await surfnet?.stop();
});

describe("frontend registration", () => {
  it("rejects fee above protocol max", async () => {
    const other = await fundActor(surfnet, 0n);
    await expect(
      other.program.methods
        .registerFrontend(501)
        .accounts({ owner: other.pubkey, usdcMint: USDC_MINT })
        .rpc(),
    ).rejects.toThrow(/FrontendFeeTooHigh/);
  });
});

describe("commit_bet", () => {
  it("happy path: escrow, reservation, exposure and caps all account correctly", async () => {
    const h = await makeHouse(1, 500);
    const bettorBefore = await usdcBalance(surfnet, bettor.usdc);

    const { bet, exposure } = await commit(h, { stakeUsdc: 10, outcome: 0 });

    // escrow = stake 10 + frontend 2% (0.2) + protocol 1% (0.1) + 3 keeper USDC
    const escrowBal = await usdcBalance(surfnet, protocol.escrow);
    expect(escrowBal).toBe(10_000_000n + 200_000n + 100_000n + KEEPER_ESCROW);
    expect(bettorBefore - (await usdcBalance(surfnet, bettor.usdc))).toBe(escrowBal);

    // reserved = 10 * 15.0 = 150
    const betAcc = await bettor.program.account.bet.fetch(bet);
    expect(betAcc.reserved.toNumber()).toBe(150_000_000);
    expect(betAcc.state.pending).toBeDefined();
    expect(betAcc.targetTsMs.sub(betAcc.commitTsMs).toNumber()).toBe(15_000);

    const exp = await bettor.program.account.fixtureExposure.fetch(exposure);
    expect(exp.liability[0].toNumber()).toBe(150_000_000);
    expect(exp.locked.toNumber()).toBe(150_000_000);
    const houseAcc = await bettor.program.account.house.fetch(h.house);
    expect(houseAcc.totalLocked.toNumber()).toBe(150_000_000);
  });

  it("netting: opposing commits lock max(liability), not the sum", async () => {
    const h = await makeHouse(2, 500);
    await commit(h, { stakeUsdc: 10, outcome: 0 });
    await commit(h, { stakeUsdc: 10, outcome: 1 });

    const exp = await bettor.program.account.fixtureExposure.fetch(
      pda.exposure(h.house, FIXTURE),
    );
    expect(exp.liability[0].toNumber()).toBe(150_000_000);
    expect(exp.liability[1].toNumber()).toBe(150_000_000);
    // max(150, 150, 0) = 150 — a balanced book locks one side, not two
    expect(exp.locked.toNumber()).toBe(150_000_000);
    const houseAcc = await bettor.program.account.house.fetch(h.house);
    expect(houseAcc.totalLocked.toNumber()).toBe(150_000_000);
  });

  it("fails when the house cannot collateralize (vault < locked)", async () => {
    const h = await makeHouse(3, 100, {
      maxRiskPerFixture: USDC(10_000),
      maxTotalRisk: USDC(10_000),
    });
    // stake 10 -> reserved 150 > vault 100
    await expect(commit(h, { stakeUsdc: 10 })).rejects.toThrow(
      /InsufficientHouseCollateral/,
    );
  });

  it("fails past the per-fixture risk cap", async () => {
    const h = await makeHouse(4, 700, { maxRiskPerFixture: USDC(200) });
    await commit(h, { stakeUsdc: 10 }); // locked 150 <= 200
    await expect(commit(h, { stakeUsdc: 10 })).rejects.toThrow(/FixtureRiskExceeded/);
  });

  it("fails past the house total risk cap", async () => {
    const h = await makeHouse(5, 700, {
      maxRiskPerFixture: USDC(200),
      maxTotalRisk: USDC(250),
    });
    await commit(h, { stakeUsdc: 10, fixture: 111n }); // total 150
    await expect(commit(h, { stakeUsdc: 10, fixture: 222n })).rejects.toThrow(
      /TotalRiskExceeded/,
    );
  });

  it("racing commits: first-come-first-served on free collateral", async () => {
    const h = await makeHouse(6, 160, {
      maxRiskPerFixture: USDC(10_000),
      maxTotalRisk: USDC(10_000),
    });
    await commit(h, { stakeUsdc: 10 }); // reserved 150 <= 160
    await expect(commit(h, { stakeUsdc: 10 })).rejects.toThrow(
      /InsufficientHouseCollateral/,
    );
  });

  it("fails after kickoff", async () => {
    const h = await makeHouse(7, 500);
    await expect(
      commit(h, { startTimeMs: (await nowMs()) - 1_000 }),
    ).rejects.toThrow(/PastKickoff/);
  });

  it("fails when the house is paused", async () => {
    const h = await makeHouse(8, 500);
    await houseOwner.program.methods
      .setPaused(true)
      .accounts({ owner: houseOwner.pubkey, house: h.house })
      .rpc();
    await expect(commit(h)).rejects.toThrow(/HousePaused/);
  });

  it("rejects invalid outcome", async () => {
    const h = await makeHouse(9, 500);
    await expect(commit(h, { outcome: 3 })).rejects.toThrow(/InvalidOutcome/);
  });
});

describe("refund_commit (expiry path) — travels the clock forward, keep last", () => {
  it("rejects refund before expiry, then refunds in full after expiry", async () => {
    const h = await makeHouse(10, 500);
    const bettorBefore = await usdcBalance(surfnet, bettor.usdc);
    const { bet, exposure } = await commit(h, { stakeUsdc: 10, outcome: 2 });

    const refundAccounts = {
      cranker: bettor.pubkey,
      escrowVault: protocol.escrow,
      bet,
      house: h.house,
      exposure,
      bettorToken: bettor.usdc,
    };

    await expect(
      bettor.program.methods.refundCommit().accounts(refundAccounts).rpc(),
    ).rejects.toThrow(/NotExpired/);

    // commit_expiry_ms = 1h after target_ts
    await timeTravel(surfnet.connection, (await nowMs()) + 2 * 3600 * 1000);

    await bettor.program.methods.refundCommit().accounts(refundAccounts).rpc();

    // full escrow back — bettor made whole
    expect(await usdcBalance(surfnet, bettor.usdc)).toBe(bettorBefore);

    const betAcc = await bettor.program.account.bet.fetch(bet);
    expect(betAcc.state.refunded).toBeDefined();

    const exp = await bettor.program.account.fixtureExposure.fetch(exposure);
    expect(exp.liability[2].toNumber()).toBe(0);
    expect(exp.locked.toNumber()).toBe(0);
    expect(exp.openBets).toBe(0);
    const houseAcc = await bettor.program.account.house.fetch(h.house);
    expect(houseAcc.totalLocked.toNumber()).toBe(0);

    // double refund rejected
    await expect(
      bettor.program.methods.refundCommit().accounts(refundAccounts).rpc(),
    ).rejects.toThrow(/WrongBetState/);
  });

  it("close_bet reclaims rent on the refunded bet; close_exposure frees the book", async () => {
    // previous test left a refunded bet at nonce (find it by state)
    const bets = await bettor.program.account.bet.all();
    const refunded = bets.find((b: any) => b.account.state.refunded);
    expect(refunded).toBeDefined();

    await bettor.program.methods
      .closeBet()
      .accounts({ bettor: bettor.pubkey, bet: refunded!.publicKey })
      .rpc();
    expect(await surfnet.connection.getAccountInfo(refunded!.publicKey)).toBeNull();

    const exposure = pda.exposure(pda.house(houseOwner.pubkey, 10), FIXTURE);
    await houseOwner.program.methods
      .closeExposure()
      .accounts({
        owner: houseOwner.pubkey,
        house: pda.house(houseOwner.pubkey, 10),
        exposure,
      })
      .rpc();
    expect(await surfnet.connection.getAccountInfo(exposure)).toBeNull();
  });
});
