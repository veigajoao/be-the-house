// House offer policy (HouseFilters): allow/deny lists over fixtures with
// ON-CHAIN enforcement at commit (fixture_id is a commit argument), plus
// owner gating and list-length caps. Competition rules are router-level and
// covered by the app's market lib, not here.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as anchor from "@coral-xyz/anchor";
import { startSurfnet, type Surfnet } from "./harness/surfpool.js";
import {
  fundActor,
  initProtocol,
  pda,
  USDC_MINT,
  type Actor,
  type Protocol,
} from "./harness/setup.js";

let surfnet: Surfnet;
let protocol: Protocol;
let owner: Actor;
let bettor: Actor;

const USDC = (n: number) => new anchor.BN(Math.round(n * 1_000_000));
const FIXTURE_A = 111n;
const FIXTURE_B = 222n;

let nonce = 5000n;
async function commit(fixture: bigint) {
  const n = ++nonce;
  const now = Date.now();
  return bettor.program.methods
    .commitBet(new anchor.BN(fixture.toString()), 0, USDC(5), new anchor.BN(n.toString()), new anchor.BN(now + 86_400_000))
    .accounts({
      bettor: bettor.pubkey,
      escrowVault: protocol.escrow,
      bettorToken: bettor.usdc,
      frontend: pda.frontend(owner.pubkey),
      house: pda.house(owner.pubkey, 1),
      houseVault: pda.houseVault(owner.pubkey, 1),
      exposure: pda.exposure(pda.house(owner.pubkey, 1), fixture),
      bet: pda.bet(bettor.pubkey, n),
    })
    .rpc();
}

function setFilters(
  competitionAllow: boolean,
  competitions: number[],
  fixtureAllow: boolean,
  fixtures: bigint[],
  as: Actor = owner,
) {
  return as.program.methods
    .setHouseFilters(
      competitionAllow,
      competitions,
      fixtureAllow,
      fixtures.map((f) => new anchor.BN(f.toString())),
    )
    .accounts({ owner: as.pubkey, house: pda.house(owner.pubkey, 1) })
    .rpc();
}

beforeAll(async () => {
  surfnet = await startSurfnet();
  protocol = await initProtocol(surfnet);
  owner = await fundActor(surfnet, 5_000_000_000n);
  bettor = await fundActor(surfnet, 1_000_000_000n);

  await owner.program.methods
    .registerFrontend(100)
    .accounts({ owner: owner.pubkey, usdcMint: USDC_MINT })
    .rpc();
  await owner.program.methods
    .createHouse(1, {
      spreadBps: 100,
      skewCoeffBps: 0,
      oddsCap: 15_000,
      maxRiskPerFixture: USDC(1_000),
      maxTotalRisk: USDC(2_000),
    })
    .accounts({ owner: owner.pubkey, usdcMint: USDC_MINT })
    .rpc();
  await owner.program.methods
    .deposit(USDC(2_000))
    .accounts({
      depositor: owner.pubkey,
      house: pda.house(owner.pubkey, 1),
      vault: pda.houseVault(owner.pubkey, 1),
      depositorToken: owner.usdc,
    })
    .rpc();
});

afterAll(async () => {
  await surfnet?.stop();
});

describe("house filters (on-chain fixture rule)", () => {
  it("no filters account -> everything is offered", async () => {
    await commit(FIXTURE_A); // succeeds with empty filters PDA
  });

  it("deny-list blocks the listed fixture, allows others", async () => {
    await setFilters(false, [], false, [FIXTURE_B]);
    const f = await owner.program.account.houseFilters.fetch(
      pda.houseFilters(pda.house(owner.pubkey, 1)),
    );
    expect(f.fixtureAllow).toBe(false);
    expect(f.fixtures.map((x: anchor.BN) => x.toString())).toEqual(["222"]);

    await expect(commit(FIXTURE_B)).rejects.toThrow(/FixtureNotOffered/);
    await commit(FIXTURE_A); // not listed -> offered
  });

  it("allow-list offers ONLY the listed fixture", async () => {
    await setFilters(false, [], true, [FIXTURE_B]);
    await expect(commit(FIXTURE_A)).rejects.toThrow(/FixtureNotOffered/);
    await commit(FIXTURE_B);
  });

  it("resetting to empty deny-list re-opens everything", async () => {
    await setFilters(false, [], false, []);
    await commit(FIXTURE_A);
    await commit(FIXTURE_B);
  });

  it("only the house owner can set filters", async () => {
    await expect(setFilters(false, [], false, [], bettor)).rejects.toThrow(); // has_one = owner
  });

  it("rejects oversized lists", async () => {
    const many = Array.from({ length: 33 }, (_, i) => BigInt(1000 + i));
    await expect(setFilters(false, [], false, many)).rejects.toThrow(
      /FilterListTooLong|Failed to serialize|encoding overruns/,
    );
  });
});
